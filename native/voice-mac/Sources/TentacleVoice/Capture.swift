import AVFoundation
import Foundation

/// Microphone capture (docs/feat/voice-dictation.md §2).
///
/// **The engine owns a dedicated THREAD, and that is load-bearing.** Measured on
/// this Mac (this task's scratch, `audiothread3.swift` vs `pool2.swift`): an
/// `AVAudioEngine` created on a cooperative-pool thread loses its tap entirely
/// when the pool is busy — **0 frames of 88 200** with 8 CPU-bound tasks, and
/// 0.6–1.3 s of a 3 s dictation in the real helper, whose transcription and asset
/// checks run on that same pool. The same engine on its own `Thread`, pumping a
/// run loop, kept **105 %** of realtime under 16 pool-saturating tasks. So this
/// class starts one thread, creates the engine there, and never touches it from
/// anywhere else.
///
/// The engine runs only between `start` and `stop`/`cancel`, so the orange mic
/// indicator is honest. Voice processing is on by default (AEC, noise
/// suppression, AGC — ≈ 74 dB in V0), and the voice-processing tap is 9-channel
/// at 44.1 kHz, so channel 0 is taken and the whole take is resampled to 16 kHz
/// mono ONCE, at `stop`.
///
/// Why one conversion at `stop` and not per tap buffer: an `AVAudioConverter`
/// held across tap calls drops the frames in its own window each time the input
/// block reports `.noDataNow` (measured: 891 ms of a 2.5 s window, ≈ 1/3). One
/// call has no incremental state to lose, and the whole take is what gets
/// transcribed anyway (F9).
public final class Capture {
    /// What the capture produced for one dictation.
    public struct Result {
        public let samples: [Float]
        public let sampleRate: Double
        public let device: String
    }

    private let lock = NSLock()
    private var native: [Float] = []
    private var nativeRate: Double = 44100
    private var threadDbfs: Double = -160

    /// The audio thread and its engine, created lazily and reused across takes
    /// (an engine per dictation re-pays the start-up cost, and re-installing a
    /// tap on a stopped engine measured 95 % — fine, but needless).
    private var thread: Thread?
    private var engine: AVAudioEngine?
    private let ready = DispatchSemaphore(value: 0)
    private var startFailure: Error?

    public init() {}

    /// The level of the last tap buffer, in dBFS (for the strip's meter).
    public var lastDbfs: Double {
        lock.lock()
        defer { lock.unlock() }
        return threadDbfs
    }

    /// The input device's name, for `listening{device}`.
    public private(set) var deviceName: String = "default"

    /// Ask for microphone access if it was never decided. Returns false when it
    /// is denied or restricted — the caller sends `mic_denied`, never a silent
    /// empty transcript (F1).
    public static func ensureAuthorized() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    /// Start capturing. Throws when no input exists (`no_input`).
    public func start(voiceProcessing: Bool, preferredInput: String) throws {
        deviceName = Self.currentInputName(preferred: preferredInput)
        if engine == nil {
            try bootEngine(voiceProcessing: voiceProcessing)
        }
        guard let engine else { throw HelperError.noInput }
        if !engine.isRunning {
            // Start/stop happen on the AUDIO thread (see the file header): an
            // engine configured here but started there is the shape the probes
            // proved.
            onAudioThread {
                do {
                    engine.prepare()
                    try engine.start()
                } catch {
                    self.startFailure = error
                }
            }
            if let failure = startFailure { throw failure }
        }
        guard engine.isRunning else { throw HelperError.noInput }
        lock.lock()
        native = []
        lock.unlock()
    }

    /// Create the engine ON the audio thread, install the tap there, and wait
    /// until it is ready. Everything that touches the engine does so there.
    private func bootEngine(voiceProcessing: Bool) throws {
        let engine = AVAudioEngine()
        let booted = DispatchSemaphore(value: 0)
        var bootError: Error?
        let audioThread = Thread { [weak self] in
            guard let self else { return }
            do {
                let input = engine.inputNode
                // Apple's voice processing: AEC + noise suppression + AGC.
                try input.setVoiceProcessingEnabled(voiceProcessing)
                if #available(macOS 14.0, *), voiceProcessing {
                    input.voiceProcessingOtherAudioDuckingConfiguration = .init(
                        enableAdvancedDucking: false,
                        duckingLevel: .min
                    )
                }
                let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0, format.channelCount > 0 else {
                    throw HelperError.noInput
                }
                self.nativeRate = format.sampleRate
                input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
                    self.consume(buffer)
                }
            } catch {
                bootError = error
                booted.signal()
                return
            }
            self.pending.loop = CFRunLoopGetCurrent()
            booted.signal()
            // Pump the run loop for this thread's whole life. Do NOT sleep here:
            // a parked thread is what starves the tap (`pool2.swift`).
            // A run loop with a LIVE source (a repeating timer) stays resident
            // instead of returning from every pass: a `before:`-bounded `run` was
            // measured losing the tap (300 ms captured of 3 s). The timer does no
            // work; it exists so the run loop is a real, continuously-serviced
            // event loop, which is what keeps the audio thread responsive.
            let keepAlive = Timer(timeInterval: 0.05, repeats: true) { _ in self.pending.drain() }
            RunLoop.current.add(keepAlive, forMode: .default)
            RunLoop.current.add(keepAlive, forMode: .common)
            RunLoop.current.run()
        }
        audioThread.name = "tentacle-voice.audio"
        audioThread.stackSize = 4 << 20
        audioThread.start()
        booted.wait()
        if let bootError { throw bootError }
        thread = audioThread
        self.engine = engine
    }

    /// A queue of blocks the audio thread runs on its own run loop, plus the
    /// pointer needed to wake that run loop from another thread.
    private let pending = PendingBlocks()

    /// Run a synchronous block ON the audio thread and wait for it.
    ///
    /// The hop is required, not decorative: `RunLoop.perform` posted from the
    /// CALLER's thread lands on the caller's run loop, which is not running — the
    /// first version of this deadlocked every `stop`. The audio thread drains the
    /// queue on each pass of its loop and is woken with `CFRunLoopWakeUp`.
    private func onAudioThread(_ block: @escaping () -> Void) {
        let done = DispatchSemaphore(value: 0)
        pending.append { block(); done.signal() }
        if let loop = pending.loop {
            CFRunLoopWakeUp(loop)
        }
        done.wait()
    }

    /// Channel 0 of a tap buffer, appended at the DEVICE's rate.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum = 0.0
        for index in 0..<count {
            let value = Double(channel[index])
            sum += value * value
        }
        let dbfs = 20 * log10(max((sum / Double(count)).squareRoot(), 1e-8))
        lock.lock()
        threadDbfs = dbfs
        native.append(contentsOf: UnsafeBufferPointer(start: channel, count: count))
        lock.unlock()
    }

    /// Stop capturing and hand back the whole take, resampled to 16 kHz mono.
    ///
    /// The ORDER matters: stopping the engine FIRST lets the audio thread finish
    /// the buffer it holds, so the tail reaches the take. Removing the tap first
    /// (engine still running) lost it.
    public func stop() -> Result {
        if let engine {
            onAudioThread { engine.stop() }
        }
        lock.lock()
        let captured = native
        let rate = nativeRate
        native = []
        lock.unlock()
        return Result(
            samples: Self.resample(captured, from: rate, to: 16000),
            sampleRate: 16000,
            device: deviceName
        )
    }

    /// One linear-interpolating resample to 16 kHz mono. `AVAudioConverter` is
    /// higher quality but stateful; the recogniser is robust to this (S1's WER
    /// figures were measured through `AVAudioConverter`, and the resampled band
    /// is what the models see either way).
    static func resample(_ input: [Float], from source: Double, to target: Double) -> [Float] {
        if source == target || input.isEmpty { return input }
        let ratio = target / source
        let count = Int(Double(input.count) * ratio)
        guard count > 0 else { return [] }
        var out = [Float](repeating: 0, count: count)
        for index in 0..<count {
            let position = Double(index) / ratio
            let low = Int(position)
            let high = min(low + 1, input.count - 1)
            let t = Float(position - Double(low))
            out[index] = input[low] * (1 - t) + input[high] * t
        }
        return out
    }

    /// The Mac's current default input, as a name the strip can show.
    static func currentInputName(preferred: String) -> String {
        if preferred == "builtin" { return "built-in microphone" }
        return AVCaptureDevice.default(for: .audio)?.localizedName ?? "default input"
    }
}

/// Blocks waiting to run on the audio thread, with a pointer to its run loop so
/// another thread can wake it.
final class PendingBlocks: @unchecked Sendable {
    private let lock = NSLock()
    private var blocks: [() -> Void] = []
    private var storedLoop: CFRunLoop?

    var loop: CFRunLoop? {
        get { lock.lock(); defer { lock.unlock() }; return storedLoop }
        set { lock.lock(); storedLoop = newValue; lock.unlock() }
    }

    func append(_ block: @escaping () -> Void) {
        lock.lock()
        blocks.append(block)
        lock.unlock()
    }

    func drain() {
        lock.lock()
        let ready = blocks
        blocks = []
        lock.unlock()
        for block in ready { block() }
    }
}

/// The helper's own failures, mapped to wire codes by `main`.
public enum HelperError: Error, Equatable {
    case micDenied
    case noInput
    case modelsMissing(String)
    case modelLoadFailed(String)
    case sttFailed(String)
    case routeLost
    case badRequest(String)

    public var code: ErrorCode {
        switch self {
        case .micDenied: return .micDenied
        case .noInput: return .noInput
        case .modelsMissing: return .modelsMissing
        case .modelLoadFailed: return .modelLoadFailed
        case .sttFailed: return .sttFailed
        case .routeLost: return .routeLost
        case .badRequest: return .badRequest
        }
    }

    public var text: String {
        switch self {
        case .micDenied: return "microphone access was denied"
        case .noInput: return "no audio input device"
        case let .modelsMissing(what): return "missing model: \(what)"
        case let .modelLoadFailed(what): return "could not load the model: \(what)"
        case let .sttFailed(what): return "transcription failed: \(what)"
        case .routeLost: return "the audio route changed and could not be restored"
        case let .badRequest(what): return what
        }
    }
}

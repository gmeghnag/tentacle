import AVFoundation
import Foundation

/// The helper's front door (docs/feat/voice-dictation.md §2, §3).
///
/// `tentacle-voice` with no arguments speaks protocol v1 on stdin/stdout until
/// stdin reaches EOF — and stdin EOF is the LIFETIME rule: the TUI owns this
/// child, so no orphan can keep the microphone open (F13).
///
/// Three non-protocol modes, all of which print plain lines and exit:
/// `setup [--yes] [--models-dir DIR]`, `status [--engine E]`, and
/// `trace <wav>…` (replays a file instead of the mic, for a fixture or a test).

// MARK: - the protocol loop

/// One live dictation: the buffer id, and what has been captured for it.
struct Session {
    var id: Int
    var startedAt: Date
    /// The language THIS dictation asked for (`start{lang}`). Never a global:
    /// two dictations may differ, and `auto` is resolved per dictation.
    var language: Language
}

func write(_ message: Message) {
    FileHandle.standardOutput.write(Data(encode(message).utf8))
}

func fail(_ error: HelperError, id: Int?) {
    write(.error(id: id, code: error.code, message: error.text))
}

/// A blocking stdin reader on its OWN thread.
///
/// **This indirection is load-bearing, not style.** AVAudioEngine's tap stops
/// delivering buffers while the MAIN thread is blocked in a synchronous read:
/// measured on this Mac as 0 frames during a 2 s `availableData` call, against
/// 83 790 frames during a 2 s free period. A protocol loop that blocked the main
/// thread therefore captured NOTHING (600–800 ms of a 2.5 s dictation, from
/// startup only), which is exactly the bug this shape fixes. The main thread
/// stays in `Task.sleep` instead, which the audio thread does not care about.
final class LineSource: @unchecked Sendable {
    private let queue = DispatchQueue(label: "tentacle-voice.stdin")
    private let pipe = Pipe()
    private var lines: [String] = []
    private var partial = ""
    private let lock = NSLock()
    private var finished = false

    init() {
        let handle = FileHandle.standardInput
        // A readabilityHandler on the main queue would be Starved by the same
        // block, so read on a dedicated queue with a plain loop.
        queue.async { [weak self] in
            guard let self else { return }
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                self.lock.lock()
                self.partial += String(decoding: chunk, as: UTF8.self)
                while let newline = self.partial.firstIndex(of: "\n") {
                    self.lines.append(String(self.partial[self.partial.startIndex..<newline]))
                    self.partial = String(self.partial[self.partial.index(after: newline)...])
                }
                self.lock.unlock()
                self.arrival.signal()
            }
            self.lock.lock()
            self.finished = true
            self.lock.unlock()
            self.arrival.signal()
        }
    }

    private let arrival = DispatchSemaphore(value: 0)

    /// Park the caller for up to `timeout` seconds, waking as soon as a line
    /// lands (or at EOF, so the loop notices the exit).
    func waitForLine(timeout: Double) -> Bool {
        lock.lock()
        let ready = !lines.isEmpty || finished
        lock.unlock()
        if ready { return true }
        _ = arrival.wait(timeout: .now() + timeout)
        return true
    }

    /// The lines that arrived since the last call, or nil at EOF with none left.
    func drain() -> [String]? {
        lock.lock()
        defer { lock.unlock() }
        if lines.isEmpty {
            return finished ? nil : []
        }
        let out = lines
        lines = []
        return out
    }
}

/// Run the protocol loop on a BACKGROUND thread, keeping the main thread parked
/// in a real run loop.
///
/// **This is the load-bearing shape of the helper, and it was measured the hard
/// way.** `AVAudioEngine`'s tap needs the main thread genuinely idle: blocking it
/// in `availableData` captured 0 frames over 2 s; a `Task.sleep` poll captured
/// 900 ms of a 3 s take; a semaphore park captured 0. The shape that delivers
/// 100 % is what a normal Cocoa app does — the main thread runs a run loop and
/// the blocking work lives on its own thread (`blocked2.swift`,
/// `taprate-async.swift` in this task's scratch: 83 790 frames of 88 200 in 2 s).
func runProtocolOffMain() -> Int32 {
    let result = DispatchSemaphore(value: 0)
    let box = CodeBox()
    // A DEDICATED THREAD (a serial DispatchQueue), never the cooperative pool.
    //
    // **Measured, and it cost a long hunt.** With the protocol loop on
    // `Task.detached`, `AVAudioEngine`'s tap is starved whenever the cooperative
    // pool is busy: a probe with 8 CPU-bound tasks on the pool captured **0
    // frames of 88 200** (`pool2.swift`), and the real helper captured 0.6–1.3 s
    // of 3 s because transcription and asset checks run on that same pool. A
    // dedicated queue is not a cooperative thread, so it is always serviced —
    // the same probe answers 95 % there (`bgthread.swift`).
    DispatchQueue(label: "tentacle-voice.protocol").async {
        let code = runProtocolSync()
        box.value = code
        result.signal()
    }
    // Park the MAIN thread in a run loop so the audio thread is free, waking
    // every 20 ms just to notice the exit.
    while result.wait(timeout: .now() + 0.02) == .timedOut {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005))
    }
    return box.value
}

/// Run an async throwing operation and block the calling thread for its result.
///
/// Used ONLY by the protocol loop, which must stay on a dedicated thread so the
/// audio tap keeps being serviced (`runProtocolOffMain`). `Task {}` puts the work
/// on the cooperative pool where asynchronous code belongs; the semaphore hands
/// the answer back. This is the standard sync->async bridge.
func runBlocking<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ThrowBox<T>()
    Task.detached(priority: .userInitiated) {
        let result: Result<T, Error>
        do { result = .success(try await operation()) } catch { result = .failure(error) }
        box.value = result
        semaphore.signal()
    }
    semaphore.wait()
    guard let value = box.value else { throw HelperError.sttFailed("the operation never returned") }
    return try value.get()
}

/// A tiny box so a non-async thread can hand its result back (no lock needed:
/// the semaphore orders the write before the read).
final class ThrowBox<T>: @unchecked Sendable {
    var value: Result<T, Error>?
}

final class CodeBox: @unchecked Sendable {
    var value: Int32 = 1
}

/// The protocol loop: read stdin line by line, act, reply. Returns the exit code.
func runProtocolSync() -> Int32 {
    let capture = Capture()
    let transcriber = Transcriber()
    var session: Session?
    var audioMs = 0
    // A `stop` needs the audio the capture produced; the transcription itself is
    // awaited before the next line is read, so two dictations never interleave.
    let audioQueue = DispatchQueue(label: "tentacle-voice.audio")
    var captured: [Float] = []

    write(.ready(engine: Transcriber.engineName(), device: Capture.currentInputName(preferred: "default")))

    let source = LineSource()
    poll: while true {
        guard let batch = source.drain() else { break poll }  // EOF: the TUI is gone.
        if batch.isEmpty {
            // The tap needs the MAIN thread genuinely parked, not merely
            // suspended in `Task.sleep`: measured, a `Task.sleep` loop still
            // starved it (900 ms of a 3 s take). A short blocking wait on a
            // dedicated queue parks the main thread the way an idle run loop
            // does, and returns the moment a line arrives.
            _ = source.waitForLine(timeout: 0.05)
            continue poll
            continue poll
        }
        for line in batch {
            switch decodeCommand(line) {
            case let .failure(error):
                switch error {
                case .lineTooLong:
                    fail(.badRequest("line over 64 KiB"), id: nil)
                case let .badRequest(what):
                    fail(.badRequest(what), id: nil)
                }
            case let .success(command):
                switch command {
                case let .start(id, lang):
                    guard (try? runBlocking { await Capture.ensureAuthorized() }) ?? false else {
                        fail(.micDenied, id: id)
                        continue
                    }
                    do {
                        try capture.start(voiceProcessing: true, preferredInput: "default")
                    } catch {
                        fail(.noInput, id: id)
                        continue
                    }
                    session = Session(id: id, startedAt: Date(), language: lang)
                    audioMs = 0
                    audioQueue.sync { captured = [] }
                    write(.listening(id: id, device: capture.deviceName))

                case let .turn(id):
                    // Auto-stop only: the endpointing decision is the TUI's pure
                    // fold (`voice-endpoint.ts`), so the helper just reports the
                    // level it already has. Nothing to answer here yet.
                    write(.turnp(id: id, p: 0))

                case let .stop(id):
                    guard let live = session, live.id == id else {
                        fail(.badRequest("stop for an unknown dictation"), id: id)
                        continue
                    }
                    let result = capture.stop()
                    let language = live.language
                    session = nil
                    audioMs = result.samples.count * 1000 / 16000
                    let started = Date()
                    do {
                        let output = try runBlocking {
                            try await transcriber.transcribe(
                                samples: result.samples,
                                sampleRate: result.sampleRate,
                                language: language
                            )
                        }
                        _ = started
                        write(
                            .final(
                                id: id,
                                text: output.text,
                                lang: output.lang,
                                audioMs: audioMs,
                                sttMs: output.sttMs
                            )
                        )
                    } catch let error as HelperError {
                        fail(error, id: id)
                    } catch {
                        fail(.sttFailed("\(error)"), id: id)
                    }

                case let .cancel(id):
                    if let live = session, live.id == id {
                        _ = capture.stop()
                        session = nil
                        audioQueue.sync { captured = [] }
                    }
                    // A cancel is silent by design: the TUI already moved to idle.
                }
            }
        }
    }
    // stdin EOF: stop the engine, which turns the orange mic dot off.
    if session != nil { _ = capture.stop() }
    return 0
}

// MARK: - status / setup

func runStatus(modelsDir: String, engine: String) async -> Int32 {
    print("engine: \(engine)")
    if !Transcriber.available() {
        print("speech recogniser: NOT available on this Mac")
        return 1
    }
    let report = await Transcriber.localeReport()
    print("supported locales: \(report.supported.count)")
    print("installed locales: \(report.installed.joined(separator: ", "))")
    let missingItalian = report.supported.contains("it_IT") && !report.installed.contains("it_IT")
    if missingItalian { print("italian (it_IT): supported, not installed - first use downloads it") }
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    let name: String
    switch status {
    case .authorized: name = "granted"
    case .denied: name = "DENIED (System Settings > Privacy & Security > Microphone)"
    case .restricted: name = "restricted"
    case .notDetermined: name = "not asked yet (the first Ctrl+R asks)"
    @unknown default: name = "unknown"
    }
    print("microphone: \(name)")
    print("models dir: \(modelsDir)")
    return 0
}

func runSetup(modelsDir: String, yes: Bool) async -> Int32 {
    print("voice setup")
    print("  engine: apple (built in; no download)")
    print("  models dir: \(modelsDir)")
    // Apple's own asset is the only thing there is to install, and only for a
    // language this Mac supports but has not installed. It is small: S1 measured
    // it_IT at 8.3 s.
    let report = await Transcriber.localeReport()
    let wanted = ["it_IT", "en_US"].filter { report.supported.contains($0) && !report.installed.contains($0) }
    if wanted.isEmpty {
        print("  nothing to install: every locale this Mac supports is installed")
        print("ok")
        return 0
    }
    print("  will install the speech asset for: \(wanted.joined(separator: ", "))")
    if !yes {
        print("  continue? [y/N] ", terminator: "")
        guard let answer = readLine()?.lowercased(), answer == "y" || answer == "yes" else {
            print("cancelled")
            return 1
        }
    }
    for localeId in wanted {
        print("  installing \(localeId)… ", terminator: "")
        do {
            try await Transcriber.ensureAsset(for: localeId)
            print("ok")
        } catch {
            print("FAILED: \(error)")
            return 1
        }
    }
    print("ok")
    return 0
}

// MARK: - trace (a WAV instead of the mic)

func runTrace(paths: [String], language: Language) async -> Int32 {
    for path in paths {
        // A FRESH transcriber per file: `SpeechAnalyzer` traps when the same
        // `SpeechTranscriber` drives a second analyzer (S1 finding, reproduced
        // here on the second `trace` argument).
        let transcriber = Transcriber()
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
            print("\(path): cannot read")
            return 1
        }
        let frames = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)
        else {
            print("\(path): cannot allocate")
            return 1
        }
        do {
            try file.read(into: buffer)
        } catch {
            print("\(path): read failed: \(error)")
            return 1
        }
        guard let channel = buffer.floatChannelData?[0] else {
            print("\(path): no float channel data")
            return 1
        }
        var samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        let rate = file.processingFormat.sampleRate
        if Int(rate) != 16000 {
            print("\(path): WARNING \(Int(rate)) Hz, not 16 kHz")
        }
        // Kotlin-free resample would need AVFoundation; a V0 file is already 16 kHz.
        if Int(rate) != 16000, let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false
        ), let converter = AVAudioConverter(from: file.processingFormat, to: format),
           let out = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(Double(samples.count) * 16000 / rate) + 64
           ) {
            var supplied = false
            var conversionError: NSError?
            converter.convert(to: out, error: &conversionError) { _, status in
                if supplied {
                    status.pointee = .endOfStream
                    return nil
                }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            if let outChannel = out.floatChannelData?[0] {
                samples = Array(UnsafeBufferPointer(start: outChannel, count: Int(out.frameLength)))
            }
        }
        do {
            let output = try await transcriber.transcribe(
                samples: samples,
                sampleRate: 16000,
                language: language
            )
            let audioMs = samples.count * 1000 / 16000
            print(
                "\(path)\taudioMs=\(audioMs)\tsttMs=\(output.sttMs)\tlang=\(output.lang)\t\(output.text)"
            )
        } catch let error as HelperError {
            print("\(path)\tERROR=\(error.text)")
        } catch {
            print("\(path)\tERROR=\(error)")
        }
    }
    return 0
}

// MARK: - entry

@main
struct TentacleVoice {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        // `--models-dir DIR` is accepted by every mode (the TUI passes it).
        var modelsDir = NSString(string: "~/.config/tentacle/voice/models").expandingTildeInPath
        if let index = args.firstIndex(of: "--models-dir"), index + 1 < args.count {
            modelsDir = args[index + 1]
            args.removeSubrange(index...(index + 1))
        }
        var engine = "apple"
        if let index = args.firstIndex(of: "--engine"), index + 1 < args.count {
            engine = args[index + 1]
            args.removeSubrange(index...(index + 1))
        }
        // `--lang auto|it|en`: what `trace` transcribes as (`voice.language`).
        var language = Language.auto
        if let index = args.firstIndex(of: "--lang"), index + 1 < args.count {
            language = Language(rawValue: args[index + 1]) ?? .auto
            args.removeSubrange(index...(index + 1))
        }
        let yes = args.contains("--yes") || args.contains("-y")
        args.removeAll { $0 == "--yes" || $0 == "-y" }

        let code: Int32
        switch args.first {
        case nil:
            code = runProtocolOffMain()
        case "status":
            code = await runStatus(modelsDir: modelsDir, engine: engine)
        case "setup":
            code = await runSetup(modelsDir: modelsDir, yes: yes)
        case "trace":
            code = await runTrace(paths: Array(args.dropFirst()), language: language)
        case let other?:
            FileHandle.standardError.write(Data("unknown mode \(other)\n".utf8))
            code = 2
        }
        exit(code)
    }
}

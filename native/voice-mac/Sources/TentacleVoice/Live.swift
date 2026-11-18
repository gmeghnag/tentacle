import AVFoundation
import Foundation
import Speech

/// Live dictation (docs/feat/voice-live-transcript.md): the analyzer is fed
/// WHILE the user speaks, its volatile results go to the TUI as `partial`
/// lines, and `stop` only has to finalize the tail.
///
/// The three value types first are pure (no Speech, no audio device), so the
/// decisions — when a partial goes out, how results merge, how a chunked take
/// is resampled — are unit-tested in `LiveTests.swift`.

// MARK: - pure pieces

/// When a partial may go out: only when its text CHANGED and at least
/// `minIntervalMs` after the previous one (≤ 10/s at the default 100 ms), so a
/// chatty recogniser cannot flood the pipe or the TUI's renderer.
public struct PartialThrottle: Equatable {
    public let minIntervalMs: Double
    public private(set) var lastSent: String = ""
    public private(set) var lastAtMs: Double?

    public init(minIntervalMs: Double = 100) {
        self.minIntervalMs = minIntervalMs
    }

    /// The text to send now, or nil (unchanged, empty, or too soon). A text held
    /// back for being too soon is not lost: the caller offers the CURRENT text on
    /// every pass, so the latest one goes out on the first pass after the gap.
    public mutating func offer(_ text: String, nowMs: Double) -> String? {
        if text == lastSent { return nil }
        // An empty text before anything was said is not news; a non-empty text
        // going back to empty (the recogniser retracted it) is.
        if text.isEmpty, lastAtMs == nil { return nil }
        if let last = lastAtMs, nowMs - last < minIntervalMs { return nil }
        lastSent = text
        lastAtMs = nowMs
        return text
    }
}

/// The running transcript: the FINALIZED results in order, plus the one
/// volatile result that may still change (each new volatile one replaces it; a
/// final one is appended and clears it). Segments carry their own spacing, as
/// the batch path's plain concatenation already relied on.
public struct TranscriptAccumulator: Equatable {
    public private(set) var finalized: String = ""
    public private(set) var volatile: String = ""

    public init() {}

    public mutating func apply(_ text: String, isFinal: Bool) {
        if isFinal {
            finalized += text
            volatile = ""
        } else {
            volatile = text
        }
    }

    /// What the user should see right now.
    public var current: String { finalized + volatile }
}

/// A linear-interpolating resampler that can be fed in CHUNKS and produces
/// exactly what `Capture.resample` produces for the whole take at once (pinned
/// by a test), so streaming the audio cannot change what the recogniser hears.
public struct StreamResampler {
    public let source: Double
    public let target: Double
    /// Input samples not yet fully consumed, starting at absolute index `base`.
    private var carry: [Float] = []
    private var base = 0
    /// Total input samples seen, and output samples produced.
    private var seen = 0
    private var produced = 0

    public init(from source: Double, to target: Double) {
        self.source = source
        self.target = target
    }

    /// Resample what `chunk` makes computable; the last input sample is held
    /// back until the next chunk (or `finish`) supplies its right neighbour.
    public mutating func push(_ chunk: [Float]) -> [Float] {
        carry.append(contentsOf: chunk)
        seen += chunk.count
        return emit(final: false)
    }

    /// Everything left, ending exactly where the one-shot resample ends.
    public mutating func finish() -> [Float] {
        emit(final: true)
    }

    private mutating func emit(final: Bool) -> [Float] {
        if source == target {
            let out = carry
            base += carry.count
            carry = []
            produced += out.count
            return out
        }
        let ratio = target / source
        let total = Int(Double(seen) * ratio)
        var out: [Float] = []
        while true {
            if final, produced >= total { break }
            let position = Double(produced) / ratio
            let low = Int(position)
            if low >= seen { break }
            let high: Int
            if low + 1 < seen {
                high = low + 1
            } else if final {
                high = seen - 1
            } else {
                break  // wait for the right neighbour
            }
            let t = Float(position - Double(low))
            out.append(carry[low - base] * (1 - t) + carry[high - base] * t)
            produced += 1
        }
        // Drop what no future output can reference.
        let keepFrom = Int(Double(produced) / ratio)
        if keepFrom > base {
            let drop = min(keepFrom - base, carry.count)
            carry.removeFirst(drop)
            base += drop
        }
        return out
    }
}

// MARK: - the streaming session

/// One recogniser fed the live take: its own transcriber + analyzer + input
/// stream, and the transcript its results build. A live session runs TWO
/// (`LiveTranscription`), each in its OWN analyzer — a `SpeechTranscriber` must
/// never drive a second analyzer (S1), and two modules in ONE analyzer gave an
/// unstable final (docs/feat/voice-live-transcript.md, Fix round 1 (a)).
final class LiveLane: @unchecked Sendable {
    private let lock = NSLock()
    private var transcript = TranscriptAccumulator()
    private var failure: Error?
    let format: AVAudioFormat
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var collectorTask: Task<Void, Never>?

    private init(
        format: AVAudioFormat,
        analyzer: SpeechAnalyzer,
        continuation: AsyncStream<AnalyzerInput>.Continuation
    ) {
        self.format = format
        self.analyzer = analyzer
        self.continuation = continuation
    }

    /// Build and start a lane. Throws `sttFailed` when the analyzer's format is
    /// one this path does not feed.
    static func open(
        locale: Locale,
        reportingOptions: Set<SpeechTranscriber.ReportingOption>
    ) async throws -> LiveLane {
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: reportingOptions,
            attributeOptions: []
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              format.channelCount == 1, format.sampleRate > 0,
              format.commonFormat == .pcmFormatFloat32 || format.commonFormat == .pcmFormatInt16
        else {
            // Measured on macOS 26: 16 kHz/1ch/Int16. Mono float32 or int16 is
            // written here sample by sample; anything else would need a stateful
            // `AVAudioConverter` (which drops frames across calls, Capture.swift)
            // — the batch path handles it instead.
            throw HelperError.sttFailed("the recogniser's format is not streamable")
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let lane = LiveLane(format: format, analyzer: analyzer, continuation: continuation)
        lane.collectorTask = Task { [lane] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    lane.lock.withLock { lane.transcript.apply(text, isFinal: result.isFinal) }
                }
            } catch {
                lane.lock.withLock { lane.failure = error }
            }
        }
        try await analyzer.start(inputSequence: stream)
        return lane
    }

    /// Finalized + volatile so far.
    var current: String { lock.withLock { transcript.current } }

    /// Hand the analyzer samples already at `format.sampleRate`.
    func yield(_ samples: [Float]) {
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))
        else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        if format.commonFormat == .pcmFormatInt16 {
            guard let channel = buffer.int16ChannelData?[0] else { return }
            for (index, sample) in samples.enumerated() {
                channel[index] = int16Sample(sample)
            }
        } else {
            guard let channel = buffer.floatChannelData?[0] else { return }
            samples.withUnsafeBufferPointer { source in
                guard let base = source.baseAddress else { return }
                channel.update(from: base, count: samples.count)
            }
        }
        // The analyzer's OWN format, never another shape: `AnalyzerInput` traps
        // on a mismatched buffer (S1), which is a crash, not an error.
        continuation.yield(AnalyzerInput(buffer: buffer))
    }

    /// End the input, wait for the last results, return the transcript.
    func finish() async throws -> String {
        continuation.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        await collectorTask?.value
        let (failed, text) = lock.withLock { (failure, transcript.current) }
        if let failed { throw failed }
        // After finalization every result is final; `current` also covers a
        // volatile one the recogniser never finalized.
        return text
    }

    func cancel() async {
        continuation.finish()
        await analyzer.cancelAndFinishNow()
        collectorTask?.cancel()
    }
}

/// One dictation's live recognition, fed while the user speaks.
///
/// Two lanes on the same audio (docs/fix/voice-live-volatile.md):
///  - the FINAL lane, opened exactly as before (`finalReportingOptions`): its
///    transcript is what `finish()` returns and what lands in the draft, so it
///    stays the batch path's answer (no `.fastResults`, Fix round 1);
///  - the PARTIAL lane, with `.fastResults`: without it the recogniser holds
///    every volatile result until the end of input (measured: 24 volatile
///    results, all in the 50 ms after the last chunk ⇒ 0 partials on a 5.3 s
///    take), so it is the only one that reports WHILE the user speaks. Its text
///    is preview only and is never returned.
///
/// Built per dictation, opened with the SAME preflight as the batch path, so a
/// missing asset is the same `models_missing`. Any failure here is not reported
/// by itself: the caller falls back to the batch path at `stop`, which owns
/// every error the TUI knows how to explain.
public final class LiveTranscription: @unchecked Sendable {
    private let lock = NSLock()
    private var resampler: StreamResampler
    private let finalLane: LiveLane
    private let partialLane: LiveLane
    public let lang: String

    private init(nativeRate: Double, finalLane: LiveLane, partialLane: LiveLane, lang: String) {
        self.finalLane = finalLane
        self.partialLane = partialLane
        self.lang = lang
        resampler = StreamResampler(from: nativeRate, to: finalLane.format.sampleRate)
    }

    /// The final lane's reporting options: the decision Fix round 1 pinned —
    /// `.fastResults` made the live final differ from the batch transcript of the
    /// same take ("Zorblack's quaintively" vs "Zorblack squintively", 5/5 runs).
    public static let finalReportingOptions: Set<SpeechTranscriber.ReportingOption> = [.volatileResults]

    /// The partial lane's: `.fastResults` is what makes the recogniser report
    /// before the end of input (≈ 1 partial per second of speech). Preview only.
    public static let partialReportingOptions: Set<SpeechTranscriber.ReportingOption> = [
        .volatileResults, .fastResults,
    ]

    /// Open a live session for a take captured at `nativeRate`. Throws a
    /// `HelperError` for what the batch path would report the same way, and
    /// `sttFailed` when the analyzer's format is one this path does not feed.
    public static func open(language: Language, nativeRate: Double) async throws -> LiveTranscription {
        let (localeId, locale) = try await Transcriber.preflight(language: language)
        let finalLane = try await LiveLane.open(locale: locale, reportingOptions: finalReportingOptions)
        let partialLane: LiveLane
        do {
            partialLane = try await LiveLane.open(locale: locale, reportingOptions: partialReportingOptions)
        } catch {
            await finalLane.cancel()
            throw error
        }
        // One resampler feeds both: the lanes must want the same rate.
        guard partialLane.format.sampleRate == finalLane.format.sampleRate else {
            await finalLane.cancel()
            await partialLane.cancel()
            throw HelperError.sttFailed("the live recognisers want different sample rates")
        }
        let lang = language == .auto ? String(localeId.prefix(2)) : language.rawValue
        return LiveTranscription(nativeRate: nativeRate, finalLane: finalLane, partialLane: partialLane, lang: lang)
    }

    /// What the user should see now, for a `partial`: the partial lane's text.
    public var current: String { partialLane.current }

    /// Feed native-rate samples (resampled here, statefully, once for both).
    public func feed(_ native: [Float]) {
        let samples = lock.withLock { resampler.push(native) }
        finalLane.yield(samples)
        partialLane.yield(samples)
    }

    /// Finalize: feed the resampler's tail, end the input, wait for the last
    /// results. Returns the FINAL lane's transcript (the batch path's answer).
    public func finish() async throws -> String {
        let tail = lock.withLock { resampler.finish() }
        finalLane.yield(tail)
        partialLane.yield(tail)
        // The preview is over: its tail is not worth waiting for.
        async let dropped: Void = partialLane.cancel()
        let text = try await finalLane.finish()
        await dropped
        return text
    }

    /// Abandon the session (cancel, EOF, or a fallback to batch).
    public func cancel() async {
        await finalLane.cancel()
        await partialLane.cancel()
    }
}

/// A float sample as 16-bit PCM: clamped to [-1, 1], scaled, rounded.
public func int16Sample(_ value: Float) -> Int16 {
    let clamped = max(-1, min(1, value))
    return Int16((clamped * 32767).rounded())
}

/// Drives one live session from a growing native take: the ONE code path the
/// protocol loop (mic) and `trace --live` (a WAV) both use, so the file-fed
/// test exercises what the mic does.
public final class LiveFeed: @unchecked Sendable {
    public let live: LiveTranscription
    private var fed = 0
    private var throttle: PartialThrottle

    public init(live: LiveTranscription, minIntervalMs: Double = 100) {
        self.live = live
        throttle = PartialThrottle(minIntervalMs: minIntervalMs)
    }

    /// Feed the take's samples from the first unfed one on (`since(fed)` hands
    /// back only that part), then return the partial to send now, if any.
    public func pump(since: (Int) -> [Float], nowMs: Double) -> String? {
        feedRest(since)
        return throttle.offer(live.current, nowMs: nowMs)
    }

    /// Feed the rest of the take and finalize.
    public func finish(since: (Int) -> [Float]) async throws -> String {
        feedRest(since)
        return try await live.finish()
    }

    private func feedRest(_ since: (Int) -> [Float]) {
        let fresh = since(fed)
        if fresh.isEmpty { return }
        live.feed(fresh)
        fed += fresh.count
    }
}

/// Replay a recorded take through the live path as the mic would deliver it:
/// `chunkMs` of audio at a time, paced at `speed`× real time, partials through
/// the same `LiveFeed` + throttle, then the same finalize. `trace --live` and
/// `LiveTests` use it — the mic itself cannot be exercised in a test.
public func replayLive(
    native: [Float],
    nativeRate: Double,
    language: Language,
    chunkMs: Int = 100,
    speed: Double = 1,
    onPartial: (_ audioMs: Int, _ text: String) -> Void
) async throws -> Transcriber.Output {
    guard !native.isEmpty else { throw HelperError.sttFailed("no audio") }
    let live = try await LiveTranscription.open(language: language, nativeRate: nativeRate)
    let feed = LiveFeed(live: live)
    let step = max(1, Int(nativeRate * Double(chunkMs) / 1000))
    var available = 0
    let since: (Int) -> [Float] = { index in
        index < available ? Array(native[index..<available]) : []
    }
    while available < native.count {
        available = min(native.count, available + step)
        let now = Date().timeIntervalSince1970 * 1000
        if let text = feed.pump(since: since, nowMs: now) {
            onPartial(Int(Double(available) / nativeRate * 1000), text)
        }
        try await Task.sleep(nanoseconds: UInt64(Double(chunkMs) / speed * 1_000_000))
    }
    let started = Date()
    let text = try await feed.finish(since: since)
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    return Transcriber.Output(text: text, lang: live.lang, sttMs: ms)
}

import AVFoundation
import Foundation
import Speech

/// On-device transcription (docs/feat/voice-dictation.md §2, §8).
///
/// Apple's `SpeechTranscriber` is the DEFAULT engine (owner decision 3): nothing
/// to download for the Mac's own language, and S1 measured it at WER 0.082 /
/// 79 ms p50 on the V0 set — better WER than V0's endpointed Parakeet (0.101).
///
/// Two S1 findings are encoded here because both are silent failures otherwise:
///  - a `SpeechTranscriber` must NOT be reused across analyzers (the second run
///    traps), so a transcriber is built per dictation;
///  - a supported-but-not-installed locale (`it_IT` on a bare Mac) transcribes
///    nothing, so the asset status is checked and reported as `models_missing`
///    with the sizes, never as an empty transcript.
public final class Transcriber {
    /// The transcript plus what the strip and the log want to know about it.
    public struct Output {
        public let text: String
        public let lang: String
        public let sttMs: Int
    }

    public init() {}

    /// Which engine is actually in use, for the first `ready` line.
    public static func engineName() -> String {
        "apple-speechanalyzer"
    }

    /// Is the recogniser available on this Mac at all?
    public static func available() -> Bool {
        SpeechTranscriber.isAvailable
    }

    /// The locales this Mac supports and which of them are installed, for
    /// `voice status`. `supported` minus `installed` is the set that needs a
    /// one-time asset download (S1: `it_IT` took 8.3 s).
    public static func localeReport() async -> (supported: [String], installed: [String]) {
        let supported = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted()
        let installed = await SpeechTranscriber.installedLocales.map(\.identifier).sorted()
        return (supported, installed)
    }

    /// Install the asset a locale needs, if it is missing. Only ever called from
    /// `setup` — never a background download from a keypress.
    public static func ensureAsset(for localeId: String) async throws {
        let locale = Locale(identifier: localeId)
        let transcriber = makeTranscriber(locale: locale)
        // A reservation is what makes the inventory answer for this locale at
        // all (`AssetInventory` keeps at most 5), so reserve first, then ask.
        _ = try? await AssetInventory.reserve(locale: locale)
        if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    /// The locale a language setting maps to: `it`/`en` force one, `auto` follows
    /// the Mac's own locale when the engine supports it.
    ///
    /// **`auto` is NOT language detection.** S1 measured this: Apple's
    /// recogniser transcribes in the LOCALE IT WAS BUILT WITH, so an Italian
    /// utterance on an English Mac came back as "Fai pasar el dipicate…". It has
    /// no per-utterance language identification in this API, so `auto` means
    /// "the Mac's language", and a user who dictates in another language sets
    /// `voice.language` (the plan's "Parakeet auto-detects 25 languages" does not
    /// hold for the Apple engine — see Execution).
    public static func localeId(for language: Language) -> String {
        switch language {
        case .it: return "it_IT"
        case .en: return "en_US"
        case .auto:
            let current = Locale.current.identifier
            let supported = ["it_IT", "en_US"]
            // `it_CH`/`en_GB` and friends are supported too; match on the prefix.
            if let match = supported.first(where: { current.hasPrefix(String($0.prefix(2))) }) {
                return match
            }
            return "en_US"
        }
    }

    /// Transcribe a whole buffer ONCE. The caller sends the entire dictation, so
    /// no segmentation choice can cut a clause across a comma (F9).
    public func transcribe(
        samples: [Float],
        sampleRate: Double,
        language: Language
    ) async throws -> Output {
        guard SpeechTranscriber.isAvailable else {
            throw HelperError.modelLoadFailed("this Mac has no on-device speech recogniser")
        }
        guard !samples.isEmpty else { throw HelperError.sttFailed("no audio") }

        let localeId = Self.localeId(for: language)
        let locale = Locale(identifier: localeId)
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { $0.identifier == localeId }) else {
            throw HelperError.modelsMissing("no speech model for \(localeId)")
        }
        // A supported-but-uninstalled locale yields an EMPTY transcript, which
        // would read as "didn't catch anything" — say what is wrong instead.
        //
        // Checked against `installedLocales` (the system's own truth) and not
        // `AssetInventory.status(forModules:)`: that one answers for locales
        // RESERVED IN THIS PROCESS, so a healthy Mac reports "not installed"
        // until something reserves one (S1 hit exactly this in `trace`).
        let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
        guard installed.contains(localeId) else {
            throw HelperError.modelsMissing("the speech asset for \(localeId) is not installed")
        }

        // A FRESH transcriber per call: reusing one across analyzers traps (S1).
        let transcriber = Self.makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        // The analyzer's OWN format, asked for rather than assumed: handing
        // `AnalyzerInput` a buffer of any other shape traps inside Speech
        // (`AnalyzerInput.init(buffer:)`), which is a crash, not an error to
        // report. S1 established this is 16 kHz/1ch/float32 here.
        let format =
            await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            ?? AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            )!
        let pcm: AVAudioPCMBuffer
        if format.sampleRate == sampleRate, format.channelCount == 1,
           format.commonFormat == .pcmFormatFloat32, !format.isInterleaved {
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(samples.count)
            ) else { throw HelperError.sttFailed("could not build an audio buffer") }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { source in
                buffer.floatChannelData?[0].update(from: source.baseAddress!, count: samples.count)
            }
            pcm = buffer
        } else {
            // Resample into the analyzer's format before it ever sees a buffer.
            guard let source = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            ), let input = AVAudioPCMBuffer(
                pcmFormat: source,
                frameCapacity: AVAudioFrameCount(samples.count)
            ) else { throw HelperError.sttFailed("could not build an audio buffer") }
            input.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { buffer in
                input.floatChannelData?[0].update(from: buffer.baseAddress!, count: samples.count)
            }
            guard let converter = AVAudioConverter(from: source, to: format),
                  let output = AVAudioPCMBuffer(
                    pcmFormat: format,
                    frameCapacity: AVAudioFrameCount(
                        Double(samples.count) * format.sampleRate / sampleRate
                    ) + 64
                  )
            else { throw HelperError.sttFailed("could not convert to the recogniser's format") }
            var supplied = false
            var conversionError: NSError?
            converter.convert(to: output, error: &conversionError) { _, status in
                if supplied {
                    status.pointee = .endOfStream
                    return nil
                }
                supplied = true
                status.pointee = .haveData
                return input
            }
            if let conversionError { throw HelperError.sttFailed("\(conversionError)") }
            pcm = output
        }

        let collector = Task { () -> String in
            var text = ""
            for try await result in transcriber.results {
                text += String(result.text.characters)
            }
            return text
        }
        let started = Date()
        try await analyzer.start(inputSequence: AsyncStream<AnalyzerInput> { continuation in
            continuation.yield(AnalyzerInput(buffer: pcm))
            continuation.finish()
        })
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let text = try await collector.value
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        return Output(text: text, lang: language == .auto ? localeId.prefix(2).description : language.rawValue, sttMs: ms)
    }

    static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: []
        )
    }
}

import AVFoundation
import Speech
import XCTest

@testable import tentacle_voice

/// The live path (docs/feat/voice-live-transcript.md): the pure pieces, then a
/// recorded take replayed through the SAME `LiveFeed` the mic uses.
final class LiveTests: XCTestCase {
    // MARK: PartialThrottle

    func testTheFirstNonEmptyTextGoesOutAtOnce() {
        var throttle = PartialThrottle(minIntervalMs: 100)
        XCTAssertEqual(throttle.offer("ciao", nowMs: 0), "ciao")
    }

    func testAnUnchangedTextIsNeverResent() {
        var throttle = PartialThrottle(minIntervalMs: 100)
        _ = throttle.offer("ciao", nowMs: 0)
        XCTAssertNil(throttle.offer("ciao", nowMs: 500))
    }

    func testAChangeWithinTheIntervalIsHeldThenTheLatestGoesOut() {
        var throttle = PartialThrottle(minIntervalMs: 100)
        _ = throttle.offer("a", nowMs: 0)
        XCTAssertNil(throttle.offer("a b", nowMs: 40))
        XCTAssertNil(throttle.offer("a b c", nowMs: 99))
        // Nothing is lost: the CURRENT text goes out once the gap has passed.
        XCTAssertEqual(throttle.offer("a b c", nowMs: 100), "a b c")
    }

    func testAtMostTenPerSecondUnderAFlood() {
        var throttle = PartialThrottle(minIntervalMs: 100)
        var sent = 0
        for ms in stride(from: 0, to: 1000, by: 5) {
            if throttle.offer("t\(ms)", nowMs: Double(ms)) != nil { sent += 1 }
        }
        XCTAssertLessThanOrEqual(sent, 10)
        XCTAssertGreaterThanOrEqual(sent, 9)
    }

    func testAnEmptyTextBeforeAnythingIsNotSentButARetractionIs() {
        var throttle = PartialThrottle(minIntervalMs: 100)
        XCTAssertNil(throttle.offer("", nowMs: 0))
        _ = throttle.offer("uh", nowMs: 10)
        XCTAssertEqual(throttle.offer("", nowMs: 200), "")
    }

    // MARK: TranscriptAccumulator

    func testAVolatileResultIsReplacedAndAFinalOneIsKept() {
        var transcript = TranscriptAccumulator()
        transcript.apply("Hel", isFinal: false)
        transcript.apply("Hello,", isFinal: false)
        XCTAssertEqual(transcript.current, "Hello,")
        transcript.apply("Hello,", isFinal: true)
        XCTAssertEqual(transcript.current, "Hello,")
        transcript.apply(" this is", isFinal: false)
        XCTAssertEqual(transcript.current, "Hello, this is")
        transcript.apply(" this is a test.", isFinal: true)
        XCTAssertEqual(transcript.current, "Hello, this is a test.")
        XCTAssertEqual(transcript.volatile, "")
    }

    // MARK: StreamResampler

    func testChunkedResamplingEqualsTheOneShotResample() {
        let input = (0..<44100).map { Float(sin(Double($0) * 0.031)) }
        let expected = Capture.resample(input, from: 44100, to: 16000)
        for chunk in [1, 7, 512, 4096, 44100] {
            var resampler = StreamResampler(from: 44100, to: 16000)
            var out: [Float] = []
            var index = 0
            while index < input.count {
                let end = min(input.count, index + chunk)
                out += resampler.push(Array(input[index..<end]))
                index = end
            }
            out += resampler.finish()
            XCTAssertEqual(out.count, expected.count, "chunk \(chunk)")
            XCTAssertEqual(out, expected, "chunk \(chunk)")
        }
    }

    func testUpsamplingAndPassThroughAlsoMatch() {
        let input = (0..<16000).map { Float($0 % 97) / 97 }
        for (source, target) in [(16000.0, 48000.0), (16000.0, 16000.0), (48000.0, 16000.0)] {
            let expected = Capture.resample(input, from: source, to: target)
            var resampler = StreamResampler(from: source, to: target)
            var out: [Float] = []
            for start in stride(from: 0, to: input.count, by: 333) {
                out += resampler.push(Array(input[start..<min(input.count, start + 333)]))
            }
            out += resampler.finish()
            XCTAssertEqual(out, expected, "\(source)→\(target)")
        }
    }

    func testAnEmptyTakeResamplesToNothing() {
        var resampler = StreamResampler(from: 48000, to: 16000)
        XCTAssertEqual(resampler.push([]), [])
        XCTAssertEqual(resampler.finish(), [])
    }

    func testInt16SamplesClampAndScale() {
        XCTAssertEqual(int16Sample(0), 0)
        XCTAssertEqual(int16Sample(1), 32767)
        XCTAssertEqual(int16Sample(-1), -32767)
        XCTAssertEqual(int16Sample(3), 32767)
        XCTAssertEqual(int16Sample(-3), -32767)
    }

    // MARK: a recorded take through the live path

    /// The mic cannot be driven from a test, so a synthesized take goes through
    /// `replayLive` — the same `LiveTranscription` + `LiveFeed` + throttle the
    /// protocol loop uses, paced like the tap. Asserts the property the feature
    /// stands on: partials arrive BEFORE the end of the take, and the final
    /// matches the batch transcript of the same audio.
    func testARecordedTakeYieldsPartialsWhileFedThenTheFinal() async throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/say") else {
            throw XCTSkip("no /usr/bin/say to synthesize a take")
        }
        let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
        guard installed.contains("en_US") else { throw XCTSkip("en_US speech asset not installed") }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tentacle-voice-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("take.wav")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = [
            "-o", wav.path, "--data-format=LEF32@16000",
            "Hello, this is a test of live dictation. The words appear while I am still speaking.",
        ]
        try say.run()
        say.waitUntilExit()
        let file = try AVAudioFile(forReading: wav)
        let buffer = try XCTUnwrap(
            AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
        )
        try file.read(into: buffer)
        let channel = try XCTUnwrap(buffer.floatChannelData?[0])
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        let takeMs = samples.count * 1000 / 16000

        // 48 kHz like a device take, so the streaming resampler does real work.
        let native = Capture.resample(samples, from: 16000, to: 48000)
        var partials: [(ms: Int, text: String)] = []
        let output = try await replayLive(
            native: native, nativeRate: 48000, language: .en, speed: 2
        ) { ms, text in partials.append((ms, text)) }

        XCTAssertFalse(partials.isEmpty, "no partial while the take was fed")
        let first = try XCTUnwrap(partials.first)
        XCTAssertLessThan(first.ms, takeMs, "the first partial came only at the end")
        XCTAssertTrue(first.text.lowercased().contains("hello"), "first partial: \(first.text)")
        XCTAssertTrue(output.text.lowercased().contains("still speaking"), "final: \(output.text)")
        XCTAssertEqual(output.lang, "en")

        let batch = try await Transcriber().transcribe(samples: samples, sampleRate: 16000, language: .en)
        XCTAssertEqual(output.text, batch.text)
    }
}

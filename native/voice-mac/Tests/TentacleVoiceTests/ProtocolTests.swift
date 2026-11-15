import XCTest

@testable import tentacle_voice

/// The helper's protocol (docs/feat/voice-dictation.md, "Swift tests"): encoding
/// and decoding, and the framing guarantees the TUI's parser relies on.
final class ProtocolTests: XCTestCase {
    func testEveryCommandRoundTrips() {
        let cases: [Command] = [
            .start(id: 1, lang: .auto),
            .start(id: 2, lang: .it),
            .turn(id: 3),
            .stop(id: 4),
            .cancel(id: 5),
        ]
        for command in cases {
            let line = encodeCommandForTest(command)
            XCTAssertEqual(decodeCommand(line), .success(command))
        }
    }

    func testAMissingIdIsBadRequestNotACrash() {
        let result = decodeCommand("{\"t\":\"start\",\"lang\":\"it\"}")
        guard case .failure(.badRequest) = result else {
            return XCTFail("expected badRequest, got \(result)")
        }
    }

    func testAnUnknownCommandIsBadRequest() {
        let result = decodeCommand("{\"t\":\"teleport\",\"id\":1}")
        guard case .failure(.badRequest) = result else {
            return XCTFail("expected badRequest, got \(result)")
        }
    }

    func testBrokenJsonIsBadRequest() {
        guard case .failure(.badRequest) = decodeCommand("{\"t\": ") else {
            return XCTFail("expected badRequest")
        }
    }

    func testAnOverlongLineIsLineTooLong() {
        let padding = String(repeating: "x", count: MAX_LINE_BYTES + 1)
        guard case .failure(.lineTooLong) = decodeCommand("{\"t\":\"turn\",\"id\":1,\(padding)}")
        else {
            return XCTFail("expected lineTooLong")
        }
    }

    func testAnEmptyLineIsBadRequest() {
        guard case .failure(.badRequest) = decodeCommand("   \n") else {
            return XCTFail("expected badRequest")
        }
    }

    // MARK: the messages the TUI parses

    func testReadyCarriesTheVersion() {
        let line = encode(.ready(engine: "apple-speechanalyzer", device: "MacBook Pro Microphone"))
        XCTAssertTrue(line.hasSuffix("\n"))
        XCTAssertEqual(line.filter { $0 == "\n" }.count, 1)
        XCTAssertTrue(line.contains("\"t\":\"ready\""))
        XCTAssertTrue(line.contains("\"v\":1"))
    }

    func testATranscriptWithNewlinesAndQuotesStaysOneLine() {
        // A `final` carries arbitrary text; the TUI's framing assumes one object
        // per line, so the encoder must escape, never emit.
        let text = "line one\nline two \"quoted\" \\ back\ttab"
        let line = encode(.final(id: 1, text: text, lang: "it", audioMs: 1000, sttMs: 10))
        XCTAssertEqual(line.filter { $0 == "\n" }.count, 1, "the line must contain no raw newline")
        // And it must still parse as JSON with the text intact.
        let data = Data(line.dropLast().utf8)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return XCTFail("not JSON: \(line)")
        }
        XCTAssertEqual(object["text"] as? String, text)
    }

    func testAControlCharacterIsEscapedNotEmitted() {
        let line = encode(.partial(id: 1, text: "a\u{07}b"))
        XCTAssertFalse(line.contains("\u{07}"))
        let data = Data(line.dropLast().utf8)
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["text"] as? String, "a\u{07}b")
    }

    func testAnErrorWithoutAnIdIsLegal() {
        let line = encode(.error(id: nil, code: .modelsMissing, message: "none"))
        XCTAssertFalse(line.contains("\"id\""))
        XCTAssertTrue(line.contains("\"code\":\"models_missing\""))
    }

    func testProbabilitiesAreFourDecimalsSoALogIsDiffable() {
        let line = encode(.vad(id: 1, ms: 1024, p: 0.93123456))
        XCTAssertTrue(line.contains("\"p\":0.9312"))
    }
}

/// The helper's locale mapping (`voice.language`), which decides what a bare
/// `auto` means for the recogniser.
final class LanguageTests: XCTestCase {
    func testExplicitLanguagesMapToTheirLocales() {
        XCTAssertEqual(Transcriber.localeId(for: .it), "it_IT")
        XCTAssertEqual(Transcriber.localeId(for: .en), "en_US")
    }

    func testAutoAlwaysAnswersALocaleTheEngineSupports() {
        let auto = Transcriber.localeId(for: .auto)
        XCTAssertTrue(["it_IT", "en_US"].contains(auto))
    }
}

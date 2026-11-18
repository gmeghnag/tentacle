import Foundation

/// The helper's wire protocol, v1 (docs/feat/voice-dictation.md §3): ONE JSON
/// object per line over stdin/stdout. This file is the encoding/decoding half and
/// nothing else, so it is testable without a microphone or a model.
///
/// The TUI (`packages/tui/src/voice-protocol.ts`) is the other end of exactly
/// these shapes. A line over 64 KiB is a protocol error, never an unbounded read.

public let VOICE_PROTOCOL_VERSION = 1
public let MAX_LINE_BYTES = 64 * 1024

/// A command from the TUI.
public enum Command: Equatable {
    case start(id: Int, lang: Language)
    case turn(id: Int)
    case stop(id: Int)
    case cancel(id: Int)
}

public enum Language: String, Equatable {
    case auto
    case it
    case en
}

/// A message to the TUI. Encoded by `encode`, one line each.
public enum Message: Equatable {
    case ready(engine: String, device: String)
    case listening(id: Int, device: String)
    case vad(id: Int, ms: Int, p: Double)
    case level(id: Int, dbfs: Double)
    case turnp(id: Int, p: Double)
    case partial(id: Int, text: String)
    case final(id: Int, text: String, lang: String, audioMs: Int, sttMs: Int)
    case error(id: Int?, code: ErrorCode, message: String)
}

/// The error codes the TUI knows how to turn into an actionable notice.
public enum ErrorCode: String, Equatable {
    case micDenied = "mic_denied"
    case noInput = "no_input"
    case modelsMissing = "models_missing"
    case modelLoadFailed = "model_load_failed"
    case sttFailed = "stt_failed"
    case routeLost = "route_lost"
    case badRequest = "bad_request"
}

public enum ProtocolError: Error, Equatable {
    /// The line is over `MAX_LINE_BYTES`.
    case lineTooLong
    /// The line is not a JSON object, or not a command this version knows.
    case badRequest(String)
}

/// Decode one line the TUI sent. Total: anything unreadable is a `ProtocolError`.
public func decodeCommand(_ line: String) -> Result<Command, ProtocolError> {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return .failure(.badRequest("empty line")) }
    if trimmed.utf8.count > MAX_LINE_BYTES { return .failure(.lineTooLong) }
    guard let data = trimmed.data(using: .utf8) else {
        return .failure(.badRequest("line is not UTF-8"))
    }
    guard let raw = try? JSONSerialization.jsonObject(with: data) else {
        return .failure(.badRequest("line is not JSON"))
    }
    guard let object = raw as? [String: Any] else {
        return .failure(.badRequest("line is not a JSON object"))
    }
    guard let id = object["id"] as? Int else {
        return .failure(.badRequest("command without an id"))
    }
    switch object["t"] as? String {
    case "start":
        guard let tag = object["lang"] as? String, let lang = Language(rawValue: tag) else {
            return .failure(.badRequest("start without a language"))
        }
        return .success(.start(id: id, lang: lang))
    case "turn":
        return .success(.turn(id: id))
    case "stop":
        return .success(.stop(id: id))
    case "cancel":
        return .success(.cancel(id: id))
    case let other:
        return .failure(.badRequest("unknown command \(other ?? "nil")"))
    }
}

/// Encode one message as ONE wire line, newline included.
///
/// Built by hand rather than with `JSONSerialization` so key order is stable (a
/// `trace` replay is diffable) and a transcript's newlines are escaped here, not
/// by luck: a transcript may contain anything at all.
public func encode(_ message: Message) -> String {
    var fields: [(String, String)] = []
    func str(_ key: String, _ value: String) {
        fields.append((key, "\"\(key)\":\(quote(value))"))
    }
    func num(_ key: String, _ value: Int) {
        fields.append((key, "\"\(key)\":\(value)"))
    }
    func dbl(_ key: String, _ value: Double) {
        // 4 decimals: enough for a probability, short enough to read in a log.
        fields.append((key, "\"\(key)\":\(String(format: "%.4f", value))"))
    }
    switch message {
    case let .ready(engine, device):
        fields.append(("t", "\"t\":\"ready\""))
        num("v", VOICE_PROTOCOL_VERSION)
        str("engine", engine)
        str("device", device)
    case let .listening(id, device):
        fields.append(("t", "\"t\":\"listening\""))
        num("id", id)
        str("device", device)
    case let .vad(id, ms, p):
        fields.append(("t", "\"t\":\"vad\""))
        num("id", id)
        num("ms", ms)
        dbl("p", p)
    case let .level(id, dbfs):
        fields.append(("t", "\"t\":\"level\""))
        num("id", id)
        dbl("dbfs", dbfs)
    case let .turnp(id, p):
        fields.append(("t", "\"t\":\"turnp\""))
        num("id", id)
        dbl("p", p)
    case let .partial(id, text):
        fields.append(("t", "\"t\":\"partial\""))
        num("id", id)
        str("text", text)
    case let .final(id, text, lang, audioMs, sttMs):
        fields.append(("t", "\"t\":\"final\""))
        num("id", id)
        str("text", text)
        str("lang", lang)
        num("audioMs", audioMs)
        num("sttMs", sttMs)
    case let .error(id, code, text):
        fields.append(("t", "\"t\":\"error\""))
        if let id { num("id", id) }
        str("code", code.rawValue)
        str("message", text)
    }
    return "{" + fields.map(\.1).joined(separator: ",") + "}\n"
}

/// Encode one command as one wire line — the TUI's direction. Used by the tests
/// and by a future self-test; the helper itself only DECODES commands.
public func encodeCommandForTest(_ command: Command) -> String {
    switch command {
    case let .start(id, lang):
        return "{\"t\":\"start\",\"id\":\(id),\"lang\":\"\(lang.rawValue)\"}"
    case let .turn(id):
        return "{\"t\":\"turn\",\"id\":\(id)}"
    case let .stop(id):
        return "{\"t\":\"stop\",\"id\":\(id)}"
    case let .cancel(id):
        return "{\"t\":\"cancel\",\"id\":\(id)}"
    }
}

/// A JSON string literal, escaped per RFC 8259. Everything below 0x20 is escaped,
/// so a control character a transcript somehow carried cannot break the framing.
public func quote(_ value: String) -> String {    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

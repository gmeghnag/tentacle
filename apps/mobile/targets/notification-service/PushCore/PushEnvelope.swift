// PushEnvelope.swift — the wire shapes the Notification Service Extension reads
// (docs/feat/mobile-notifications.md Design 2 / N5), mirroring
// packages/protocol/src/push.ts. Pure Foundation: this file compiles in the
// SwiftPM test package too, so the decoding rules are tested under `swift test`.
//
// Deliberately NOT strict about extra keys (the wire's strip schemas), and
// deliberately strict about the ones it names: an envelope this build cannot
// read shows the placeholder, never a half-parsed banner (F11).

import Foundation

/// `userInfo.tp` — the one custom key of an APNs payload (protocol/push.ts).
public struct PushEnvelope: Equatable {
    public let keyId: String        // `k`: 12 base64url chars, also the AEAD's `aad`
    public let ephemeral: Data      // `e`: the sender's ephemeral X25519 public key
    public let ciphertext: Data     // `c`: bucket + 16-byte tag

    public init(keyId: String, ephemeral: Data, ciphertext: Data) {
        self.keyId = keyId
        self.ephemeral = ephemeral
        self.ciphertext = ciphertext
    }
}

/// The plaintext's version this build renders (`PushMessage.v`).
public let pushRenderVersion = 1

public enum PushKind: String, Equatable {
    case ask
    case askResolved = "ask_resolved"
    case turnDone = "turn_done"
    case turnFailed = "turn_failed"
    // Slice 9 of docs/feat/agent-workflows.md (owner Q5): a workflow run's end.
    // A build that predates them REFUSES the string and shows the placeholder
    // (`PushEnvelope.parse`), which is why they were additive on `v: 1`.
    case runDone = "run_done"
    case runStopped = "run_stopped"
}

/// The workflow run a push is about (`PushRunSchema`): its id, its name, and the
/// one line it stopped with. Absent on every other kind.
public struct PushRun: Equatable {
    public let runId: String
    public let name: String
    public let reason: String?

    public init(runId: String, name: String, reason: String? = nil) {
        self.runId = runId
        self.name = name
        self.reason = reason
    }
}

public struct PushAskOption: Equatable {
    public let optionId: String
    public let kind: String
    public let name: String

    public init(optionId: String, kind: String, name: String) {
        self.optionId = optionId
        self.kind = kind
        self.name = name
    }
}

public struct PushAsk: Equatable {
    public let requestId: String
    public let tool: String
    public let title: String
    public let preview: String?
    public let options: [PushAskOption]
    public let replyMaxChars: Int?
    public let more: Int?

    public init(
        requestId: String,
        tool: String,
        title: String,
        preview: String? = nil,
        options: [PushAskOption],
        replyMaxChars: Int? = nil,
        more: Int? = nil
    ) {
        self.requestId = requestId
        self.tool = tool
        self.title = title
        self.preview = preview
        self.options = options
        self.replyMaxChars = replyMaxChars
        self.more = more
    }
}

public struct PushTurn: Equatable {
    public let turnId: String
    public let error: String?

    public init(turnId: String, error: String? = nil) {
        self.turnId = turnId
        self.error = error
    }
}

/// The sealed plaintext (`PushMessageSchema`). Fields the extension does not use
/// are absent on purpose: it renders, it never answers (Design 2).
public struct PushMessage: Equatable {
    public let v: Int
    public let id: String
    public let at: Int
    public let kind: PushKind
    public let computer: String
    public let cwd: String
    public let sessionId: String
    public let title: String
    public let ask: PushAsk?
    public let turn: PushTurn?
    public let run: PushRun?

    public init(
        v: Int,
        id: String,
        at: Int,
        kind: PushKind,
        computer: String,
        cwd: String,
        sessionId: String,
        title: String,
        ask: PushAsk? = nil,
        turn: PushTurn? = nil,
        run: PushRun? = nil
    ) {
        self.v = v
        self.id = id
        self.at = at
        self.kind = kind
        self.computer = computer
        self.cwd = cwd
        self.sessionId = sessionId
        self.title = title
        self.ask = ask
        self.turn = turn
        self.run = run
    }
}

/// The keys of an APNs payload this extension looks at. `aps` is never read:
/// the relay builds it and may rewrite it, and the extension rewrites the parts
/// that matter (`categoryIdentifier`, Design 2 step 6).
public enum PushPayloadKey {
    public static let envelope = "tp"
}

/// Decode base64url (unpadded). Returns nil for anything else — the wire's own
/// alphabet (protocol/pairing.ts `decodeBase64Url`), never a lenient fallback.
public func decodeBase64Url(_ text: String) -> Data? {
    var normalized = text.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    let remainder = normalized.count % 4
    if remainder == 1 { return nil }
    if remainder > 0 {
        normalized += String(repeating: "=", count: 4 - remainder)
    }
    guard let data = Data(base64Encoded: normalized) else { return nil }
    return data
}

/// The envelope inside a notification's `userInfo`, or nil when it is missing,
/// of another version, or not decodable.
public func envelopeFrom(userInfo: [AnyHashable: Any]) -> PushEnvelope? {
    guard let raw = userInfo[PushPayloadKey.envelope] as? [AnyHashable: Any] else { return nil }
    guard let version = raw["v"] as? Int, version == 1 else { return nil }
    guard let keyId = raw["k"] as? String, keyId.count == 12 else { return nil }
    guard let e = raw["e"] as? String, let ephemeral = decodeBase64Url(e), ephemeral.count == 32 else {
        return nil
    }
    guard let c = raw["c"] as? String, let ciphertext = decodeBase64Url(c) else { return nil }
    return PushEnvelope(keyId: keyId, ephemeral: ephemeral, ciphertext: ciphertext)
}

/// Parse an opened plaintext into a `PushMessage`, or nil when it is not one this
/// build knows (a future `v`, a missing field, an unknown `kind` — F11).
public func parsePushMessage(_ data: Data) -> PushMessage? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    // Structurally parsed for ANY `v`: `render` refuses a future version (the
    // shared vector table pins that), so the two implementations agree on
    // "unrenderable → placeholder" rather than on where the refusal happens.
    guard let v = object["v"] as? Int else { return nil }
    guard let id = object["id"] as? String,
          let at = object["at"] as? Int,
          let kindText = object["kind"] as? String,
          let kind = PushKind(rawValue: kindText),
          let computer = object["computer"] as? String,
          let cwd = object["cwd"] as? String,
          let sessionId = object["sessionId"] as? String,
          let title = object["title"] as? String
    else { return nil }
    var ask: PushAsk?
    if let rawAsk = object["ask"] as? [String: Any] {
        guard let requestId = rawAsk["requestId"] as? String,
              let tool = rawAsk["tool"] as? String,
              let askTitle = rawAsk["title"] as? String,
              let rawOptions = rawAsk["options"] as? [[String: Any]]
        else { return nil }
        var options: [PushAskOption] = []
        for raw in rawOptions {
            guard let optionId = raw["optionId"] as? String,
                  let optionKind = raw["kind"] as? String,
                  let name = raw["name"] as? String
            else { return nil }
            options.append(PushAskOption(optionId: optionId, kind: optionKind, name: name))
        }
        let reply = (rawAsk["reply"] as? [String: Any])?["maxChars"] as? Int
        ask = PushAsk(
            requestId: requestId,
            tool: tool,
            title: askTitle,
            preview: rawAsk["preview"] as? String,
            options: options,
            replyMaxChars: reply,
            more: rawAsk["more"] as? Int
        )
    }
    var turn: PushTurn?
    if let rawTurn = object["turn"] as? [String: Any] {
        guard let turnId = rawTurn["turnId"] as? String else { return nil }
        turn = PushTurn(turnId: turnId, error: rawTurn["error"] as? String)
    }
    var run: PushRun?
    if let rawRun = object["run"] as? [String: Any] {
        guard let runId = rawRun["runId"] as? String, let name = rawRun["name"] as? String else {
            return nil
        }
        run = PushRun(runId: runId, name: name, reason: rawRun["reason"] as? String)
    }
    return PushMessage(
        v: v,
        id: id,
        at: at,
        kind: kind,
        computer: computer,
        cwd: cwd,
        sessionId: sessionId,
        title: title,
        ask: ask,
        turn: turn,
        run: run
    )
}

// LACore.swift — the widget's LOGIC, pure and UIKit-free so `swift test` runs it
// on macOS (docs/feat/mobile-live-activity.md Design 6/7, L10).
//
// Two responsibilities, and they are the two halves `la-render.ts` specifies:
//
//  1. **open** one content-state: HPKE Auth with task 17's `PushCore`
//     (`openPush` is the envelope path; here the `info` and `aad` differ), so a
//     blob sealed on the laptop decrypts inside the widget. `info` is
//     "tentacle-la/1" and `aad` is `kid ‖ slot`, which is what binds a state to
//     ITS activity: a relay that re-addresses one session's state to another
//     activity gets a tag failure, not content (F7).
//  2. **render** it into the view-model the SwiftUI views draw — the Swift twin
//     of `apps/mobile/src/la-render.ts`, asserted against the SAME
//     `la-render-v1.json` vectors so the two cannot drift (decision 20).
//
// Anything unrenderable — an unknown kid, a bad tag, an unknown `v` or `kind`, a
// missing ask — is the PLACEHOLDER: "tentacle — open to see", no buttons. A view
// that threw would make iOS drop the update and leave the PREVIOUS state on the
// screen, which is exactly what a hostile relay wants (F6, F22).

import CryptoKit
import Foundation
// The SAME sources build twice: as the SwiftPM module `PushCore`
// (native-tests/PushCoreTests, where `import` resolves) and as part of this
// target's OWN module in the generated Xcode project, which has no `PushCore`
// module — an unguarded `import PushCore` there failed the archive with
// "Unable to resolve module dependency: 'PushCore'" while `swift test` stayed
// green. `apps/mobile/test/app-config.test.ts` pins both halves.
#if canImport(PushCore)
import PushCore
#endif

/// The HPKE `info` of an activity content-state (`@tentacle/transport/push`'s `LA_INFO`).
public let laInfo = "tentacle-la/1"

/// What the placeholder says. The same words `la-render.ts` hard-codes.
public let laPlaceholderText = "tentacle — open to see"

/// The clip caps, in UTF-8 bytes — `@tentacle/protocol`'s `ACTIVITY_*_MAX`.
private let projectMax = 120
private let titleMax = 120
private let toolMax = 80
private let previewMax = 160

/// A button the activity may offer. Only these two actions exist (Owner Q6).
public struct LaButton: Codable, Equatable {
    public let action: String   // "approve" | "deny"
    public let optionId: String

    /// Explicit: a `public` struct's memberwise init is `internal`, and the views
    /// (in the extension target) and the tests both construct these.
    public init(action: String, optionId: String) {
        self.action = action
        self.optionId = optionId
    }
}

/// What a widget view draws. `placeholder == true` means: show `text`, draw no
/// content and NO buttons. The optional fields are nil ON PURPOSE in that case,
/// so a view that ignored the flag would still leak nothing.
public struct LaViewModel: Codable, Equatable {
    public let placeholder: Bool
    public let text: String?
    public let slot: String?
    public let project: String?
    public let phase: String?
    public let startedAt: Int64?
    public let tool: String?
    public let title: String?
    public let preview: String?
    public let privateFields: [String]
    public let buttons: [LaButton]
    public let error: String?
}

/// Open one sealed content-state as the widget does. Throws on every failure
/// path (the caller shows the placeholder).
///
/// The suite is task 16's (`pushCiphersuite()` from `PushCore`), so ONE crypto
/// profile covers both channels and CryptoKit is the only implementation on the
/// phone. `aad` is `kid ‖ slot`, and `info` is `laInfo` — the two differences from
/// a push notification, each with its own property (domain separation, F7).
public func openActivityState(
    contentState: TentacleActivityContentState,
    attributes: TentacleActivityAttributes,
    recipientPrivateKey: Data,
    senderPublicKey: Data
) throws -> Data {
    guard contentState.v == 1, attributes.v == 1 else {
        throw PushOpenError.cannotOpen
    }
    // The kid must name the computer we are about to try: a foreign one is
    // refused BEFORE any decryption (the same rule `openPush` applies).
    guard attributes.k == pushKeyId(computerPublicKey: senderPublicKey) else {
        throw PushOpenError.wrongKeyId
    }
    guard
        let enc = base64UrlDecode(contentState.e),
        let ciphertext = base64UrlDecode(contentState.c),
        recipientPrivateKey.count == 32,
        senderPublicKey.count == 32
    else { throw PushOpenError.cannotOpen }

    let recipientKey: Curve25519.KeyAgreement.PrivateKey
    let senderKey: Curve25519.KeyAgreement.PublicKey
    let ephemeralKey: Curve25519.KeyAgreement.PublicKey
    do {
        recipientKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipientPrivateKey)
        senderKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderPublicKey)
        ephemeralKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: enc)
    } catch {
        throw PushOpenError.cannotOpen
    }
    // The ACTIVITY's own slot is the aad's second half: a state sealed for
    // activity A cannot be rendered inside activity B (F7).
    let aad = Data((attributes.k + attributes.slot).utf8)
    let info = Data(laInfo.utf8)
    do {
        var recipient = try HPKE.Recipient(
            privateKey: recipientKey,
            ciphersuite: pushCiphersuite(),
            info: info,
            // CryptoKit's labels are the opposite way round from the RFC's prose:
            // `encapsulatedKey` is the sender's ephemeral key BYTES (design 2's
            // `e`), `authenticatedBy` the sender's STATIC public key (`PushCore`).
            encapsulatedKey: ephemeralKey.rawRepresentation,
            authenticatedBy: senderKey
        )
        return try recipient.open(ciphertext, authenticating: aad)
    } catch {
        throw PushOpenError.cannotOpen
    }
}

/// Padded-free base64url ENCODE — the vectors carry hex, the wire carries this, so
/// a Swift test re-encodes them with the same rule the daemon uses.
public func base64UrlEncode(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// Unpadded base64url decode (the wire's alphabet; `PushCore` only encodes).
public func base64UrlDecode(_ text: String) -> Data? {
    var padded = text.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while padded.count % 4 != 0 {
        padded.append("=")
    }
    return Data(base64Encoded: padded)
}

/// `text` cleaned for a lock screen: no ANSI escapes, no control characters,
/// bounded — the second belt after the content was already clipped on the daemon,
/// because a daemon may be a pod (AGENTS §7).
private func clean(_ text: Any?, max: Int) -> String? {
    guard let raw = text as? String else { return nil }
    var out = ""
    var index = raw.startIndex
    while index < raw.endIndex {
        let character = raw[index]
        // Drop a CSI escape (`ESC [ … letter`) whole, so no fragments survive.
        if character == "\u{1B}" {
            var scan = raw.index(after: index)
            if scan < raw.endIndex, raw[scan] == "[" {
                scan = raw.index(after: scan)
                while scan < raw.endIndex, !("A"..."Z").contains(raw[scan]), !("a"..."z").contains(raw[scan]) {
                    scan = raw.index(after: scan)
                }
                if scan < raw.endIndex { scan = raw.index(after: scan) }
                index = scan
                continue
            }
            index = raw.index(after: index)
            continue
        }
        if let scalar = character.unicodeScalars.first, scalar.value < 0x20 || (scalar.value >= 0x7f && scalar.value <= 0x9f) {
            index = raw.index(after: index)
            continue
        }
        out.append(character)
        index = raw.index(after: index)
    }
    out = out.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !out.isEmpty else { return nil }
    return String(out.prefix(max))
}

/// Approve / Deny for the options an ask OFFERS. `allow_once` → Approve,
/// `reject_once` → Deny, and a LASTING rule (`allow_always` / `reject_always`)
/// produces NO button: it needs the in-app sheet, where the person sees the full
/// request (decision 8, Owner Q6).
private func buttonsOf(_ options: [[String: Any]]) -> [LaButton] {
    var buttons: [LaButton] = []
    for option in options {
        guard let kind = option["kind"] as? String, let optionId = option["optionId"] as? String else { continue }
        if kind == "allow_once", !buttons.contains(where: { $0.action == "approve" }) {
            buttons.append(LaButton(action: "approve", optionId: optionId))
        }
        if kind == "reject_once", !buttons.contains(where: { $0.action == "deny" }) {
            buttons.append(LaButton(action: "deny", optionId: optionId))
        }
    }
    return buttons
}

/// The placeholder: no identity, no content, no buttons.
public func laPlaceholder() -> LaViewModel {
    LaViewModel(
        placeholder: true, text: laPlaceholderText, slot: nil, project: nil, phase: nil,
        startedAt: nil, tool: nil, title: nil, preview: nil, privateFields: [], buttons: [], error: nil
    )
}

/// The view-model for one OPENED content-state (`PLACEHOLDER` on anything it
/// cannot draw). TOTAL: never throws, for the reason in the header comment.
public func renderActivity(json: Data) -> LaViewModel {
    guard
        let object = try? JSONSerialization.jsonObject(with: json),
        let value = object as? [String: Any]
    else { return laPlaceholder() }
    // The version gate FIRST: a newer daemon's plaintext is not ours to interpret.
    guard let version = value["v"] as? Int, version == 1 else { return laPlaceholder() }
    guard let phase = value["kind"] as? String,
          ["running", "asking", "done", "failed", "cancelled"].contains(phase)
    else { return laPlaceholder() }
    guard let slot = value["slot"] as? String,
          let project = clean(value["project"], max: projectMax),
          let startedAtNumber = value["startedAt"] as? NSNumber
    else { return laPlaceholder() }
    let startedAt = startedAtNumber.int64Value

    let title = clean(value["title"], max: titleMax)
    var privateFields: [String] = []
    if title != nil { privateFields.append("title") }

    if phase == "asking" {
        guard let ask = value["ask"] as? [String: Any],
              ask["requestId"] is String,
              let options = ask["options"] as? [[String: Any]],
              !options.isEmpty
        else { return laPlaceholder() }
        let preview = clean(ask["preview"], max: previewMax)
        if preview != nil { privateFields.append("preview") }
        // While an ask waits, the tool to judge is the ASK's own, not the turn's
        // last finished call (the same rule `la-render.ts` learned by test).
        let askTool = clean(ask["tool"], max: toolMax)
        return LaViewModel(
            placeholder: false, text: nil, slot: slot, project: project, phase: phase,
            startedAt: startedAt, tool: askTool, title: title, preview: preview,
            privateFields: privateFields, buttons: buttonsOf(options), error: nil
        )
    }

    let error = phase == "failed" ? clean(value["error"], max: previewMax) : nil
    return LaViewModel(
        placeholder: false, text: nil, slot: slot, project: project, phase: phase,
        startedAt: startedAt, tool: clean(value["tool"], max: toolMax), title: title,
        preview: nil, privateFields: privateFields, buttons: [], error: error
    )
}

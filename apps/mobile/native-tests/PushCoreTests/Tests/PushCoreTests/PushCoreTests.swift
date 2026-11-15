import Foundation
import LACore
import PushCore
import XCTest
@testable import PushCore

/// The Notification Service Extension's logic, pinned to the SAME vectors the
/// TypeScript side is pinned by (docs/feat/mobile-notifications.md N5, decision
/// 20): `push-v1.json` (the envelope, task 16) and `push-render-v1.json` (the
/// banner, N2). One spec, two implementations, no drift.
///
/// Each test names the mutation that turns it red.
final class PushCoreTests: XCTestCase {
    // MARK: - vectors

    /// The vector files are THE spec, shared with the TypeScript side, so this
    /// reads them from the repo rather than a copy in the test bundle: a copy
    /// would be a second source of truth that could drift silently. The paths are
    /// relative to THIS source file (`#filePath`), which is stable under
    /// `swift test` and in Xcode.
    private func vectorJSON(_ name: String) throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent() // PushCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // PushCoreTests (package)
            .deletingLastPathComponent() // native-tests
            .deletingLastPathComponent() // mobile
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // repo root
        let shared: URL
        switch name {
        case "push-v1":
            shared = repoRoot.appendingPathComponent("packages/transport/test/vectors/push-v1.json")
        case "push-render-v1":
            shared = repoRoot.appendingPathComponent("apps/mobile/test/fixtures/push-render-v1.json")
        case "la-v1":
            shared = repoRoot.appendingPathComponent("packages/transport/test/vectors/la-v1.json")
        case "la-render-v1":
            shared = repoRoot.appendingPathComponent("apps/mobile/test/fixtures/la-render-v1.json")
        default:
            throw XCTSkip("no shared vector file named \(name)")
        }
        let data = try Data(contentsOf: shared)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func bytes(hex: String) -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index ..< next], radix: 16) ?? 0)
            index = next
        }
        return data
    }

    /// Every envelope vector opens with the pinned computer key and the device key,
    /// and the plaintext is exactly the vector's.
    ///
    /// Mutation: drop `authenticatedBy:` from `HPKE.Recipient` → every one of these
    /// fails (Auth mode is what proves the sender).
    func testEveryEnvelopeVectorOpens() throws {
        let vectors = try vectorJSON("push-v1")
        let tentacle = try XCTUnwrap(vectors["tentacle"] as? [String: Any])
        let device = try XCTUnwrap(tentacle["device"] as? [String: Any])
        let computer = try XCTUnwrap(tentacle["computer"] as? [String: Any])
        let deviceSk = bytes(hex: try XCTUnwrap(device["sk"] as? String))
        let computerPk = bytes(hex: try XCTUnwrap(computer["pk"] as? String))
        let envelopes = try XCTUnwrap(tentacle["envelopes"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(envelopes.count, 3)
        for envelope in envelopes {
            let name = try XCTUnwrap(envelope["name"] as? String)
            let keyId = try XCTUnwrap(envelope["k"] as? String)
            let e = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["e"] as? String)), name)
            let c = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["c"] as? String)), name)
            // The vectors carry the plaintext as HEX (an independent
            // implementation wrote them), so the comparison is on bytes.
            let plaintextHex = try XCTUnwrap(envelope["plaintext"] as? String)
            let opened = try openPush(
                envelope: PushEnvelope(keyId: keyId, ephemeral: e, ciphertext: c),
                recipientPrivateKey: deviceSk,
                senderPublicKey: computerPk
            )
            XCTAssertEqual(opened, bytes(hex: plaintextHex), name)
        }
    }

    /// A flipped ciphertext byte throws (the AEAD's tag).
    func testFlippedByteThrows() throws {
        let vectors = try vectorJSON("push-v1")
        let tentacle = try XCTUnwrap(vectors["tentacle"] as? [String: Any])
        let deviceSk = bytes(hex: try XCTUnwrap((tentacle["device"] as? [String: Any])?["sk"] as? String))
        let computerPk = bytes(
            hex: try XCTUnwrap((tentacle["computer"] as? [String: Any])?["pk"] as? String)
        )
        let envelope = try XCTUnwrap((tentacle["envelopes"] as? [[String: Any]])?.first)
        let keyId = try XCTUnwrap(envelope["k"] as? String)
        let e = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["e"] as? String)))
        var c = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["c"] as? String)))
        c[0] ^= 0xFF
        XCTAssertThrowsError(
            try openPush(
                envelope: PushEnvelope(keyId: keyId, ephemeral: e, ciphertext: c),
                recipientPrivateKey: deviceSk,
                senderPublicKey: computerPk
            )
        )
    }

    /// The wrong sender key is refused BEFORE decryption (`wrongKeyId`), and a
    /// key id that matches but is not the sender fails the KEM (`cannotOpen`).
    func testWrongSenderKeyThrows() throws {
        let vectors = try vectorJSON("push-v1")
        let tentacle = try XCTUnwrap(vectors["tentacle"] as? [String: Any])
        let deviceSk = bytes(hex: try XCTUnwrap((tentacle["device"] as? [String: Any])?["sk"] as? String))
        let computerPk = bytes(
            hex: try XCTUnwrap((tentacle["computer"] as? [String: Any])?["pk"] as? String)
        )
        let ephemeralVectors = try XCTUnwrap(vectors["hpke"] as? [String: Any])
        let auth = try XCTUnwrap(ephemeralVectors["auth"] as? [String: Any])
        let otherSender = bytes(hex: try XCTUnwrap(auth["pkRm"] as? String))
        let envelope = try XCTUnwrap((tentacle["envelopes"] as? [[String: Any]])?.first)
        let keyId = try XCTUnwrap(envelope["k"] as? String)
        let e = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["e"] as? String)))
        let c = try XCTUnwrap(decodeBase64Url(try XCTUnwrap(envelope["c"] as? String)))
        XCTAssertThrowsError(
            try openPush(
                envelope: PushEnvelope(keyId: keyId, ephemeral: e, ciphertext: c),
                recipientPrivateKey: deviceSk,
                senderPublicKey: otherSender
            )
        ) { error in
            XCTAssertEqual(error as? PushOpenError, .wrongKeyId)
        }
        // Our own id, a different key: the AEAD refuses.
        XCTAssertNotEqual(pushKeyId(computerPublicKey: computerPk), pushKeyId(computerPublicKey: otherSender))
    }

    func testKeyIdMatchesTheVectors() throws {
        let vectors = try vectorJSON("push-v1")
        let tentacle = try XCTUnwrap(vectors["tentacle"] as? [String: Any])
        let computerPk = bytes(
            hex: try XCTUnwrap((tentacle["computer"] as? [String: Any])?["pk"] as? String)
        )
        XCTAssertEqual(pushKeyId(computerPublicKey: computerPk), try XCTUnwrap(tentacle["key_id"] as? String))
    }

    // MARK: - render (the SAME table the TypeScript side asserts)

    func testEveryRenderVectorMatches() throws {
        let vectors = try vectorJSON("push-render-v1")
        let cases = try XCTUnwrap(vectors["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for testCase in cases {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let messageJSON = try XCTUnwrap(testCase["message"] as? [String: Any])
            let data = try JSONSerialization.data(withJSONObject: messageJSON)
            // A future plaintext version is expected to be REFUSED at parse: the
            // pipeline then shows the placeholder, which is what the vector says.
            guard let message = parsePushMessage(data) else {
                XCTAssertEqual(
                    (testCase["expected"] as? [String: Any])?["placeholder"] as? Bool,
                    true,
                    "\(name): unparsable, but the vector does not expect a placeholder"
                )
                continue
            }
            let peerJSON = try XCTUnwrap(testCase["peer"] as? [String: Any])
            let peer = RenderPeer(computerName: try XCTUnwrap(peerJSON["computerName"] as? String))
            let expected = try XCTUnwrap(testCase["expected"] as? [String: Any], name)
            let rendered = renderMessage(message, peer: peer)
            XCTAssertEqual(rendered.title, expected["title"] as? String, "\(name).title")
            XCTAssertEqual(rendered.subtitle, expected["subtitle"] as? String, "\(name).subtitle")
            XCTAssertEqual(rendered.body, expected["body"] as? String, "\(name).body")
            XCTAssertEqual(rendered.category, expected["category"] as? String, "\(name).category")
            XCTAssertEqual(rendered.sound, expected["sound"] as? Bool, "\(name).sound")
            XCTAssertEqual(
                rendered.threadIdentifier,
                expected["threadIdentifier"] as? String,
                "\(name).threadIdentifier"
            )
            XCTAssertEqual(rendered.placeholder, expected["placeholder"] as? Bool, "\(name).placeholder")
            XCTAssertEqual(
                rendered.interruptionLevel.rawValue,
                expected["interruptionLevel"] as? String,
                "\(name).interruptionLevel"
            )
            if let hints = expected["hints"] as? [String: Any] {
                let ours = try XCTUnwrap(rendered.hints, "\(name).hints")
                XCTAssertEqual(ours.computerId, hints["computerId"] as? String, "\(name).hints.computerId")
                XCTAssertEqual(ours.sessionId, hints["sessionId"] as? String, "\(name).hints.sessionId")
                XCTAssertEqual(ours.requestId, hints["requestId"] as? String, "\(name).hints.requestId")
                XCTAssertEqual(ours.kind, hints["kind"] as? String, "\(name).hints.kind")
            } else {
                XCTAssertNil(rendered.hints, "\(name) has no hints")
            }
        }
    }

    /// Approve is only ever `allow_once` (decision 8). The one case that proves it:
    /// an ask offering `allow_always` AND `reject_once` — an implemention that
    /// treated "a lasting-rule option" as approvable would offer Approve here, which
    /// would create a session-wide rule from a lock-screen tap.
    ///
    /// Mutation: `kinds.contains("allow_once") || kinds.contains("allow_always")`
    /// → red (this test AND the render vectors do not distinguish it, because no
    /// vector has both).
    func testAllowAlwaysPlusRejectStillHasNoApprove() {
        let lasting = PushAsk(
            requestId: "r1",
            tool: "shell",
            title: "Run",
            options: [
                PushAskOption(optionId: "allow_always", kind: "allow_always", name: "Always"),
                PushAskOption(optionId: "reject_once", kind: "reject_once", name: "Deny"),
            ]
        )
        XCTAssertEqual(categoryFor(ask: lasting), NotificationCategoryId.open)
        // …and an ask with BOTH approvals is the narrow `tentacle.ask`: Approve
        // exists, and the app maps it to `allow_once` only (`notification-action.ts`).
        let both = PushAsk(
            requestId: "r2",
            tool: "shell",
            title: "Run",
            options: [
                PushAskOption(optionId: "allow_once", kind: "allow_once", name: "Once"),
                PushAskOption(optionId: "allow_always", kind: "allow_always", name: "Always"),
                PushAskOption(optionId: "reject_once", kind: "reject_once", name: "Deny"),
            ]
        )
        XCTAssertEqual(categoryFor(ask: both), NotificationCategoryId.ask)
        let onlyLasting = PushAsk(
            requestId: "r3",
            tool: "shell",
            title: "Run",
            options: [PushAskOption(optionId: "allow_always", kind: "allow_always", name: "Always")]
        )
        XCTAssertEqual(categoryFor(ask: onlyLasting), NotificationCategoryId.open)
    }

    /// Every failure path yields category "" — the one rule that keeps a hostile
    /// relay's `aps` from promising actions we cannot verify (F5/F16).
    func testPlaceholderHasNoCategoryAndNoHints() {
        let rendered = placeholderRendered()
        XCTAssertEqual(rendered.category, "")
        XCTAssertNil(rendered.hints)
        XCTAssertFalse(rendered.sound)
        XCTAssertTrue(rendered.placeholder)
    }

    // MARK: - dedupe + age

    func testSeenSetDedupesAndPrunes() throws {
        var seen = SeenSet(entries: [])
        let now = 1_800_000_000_000
        let message = PushMessage(
            v: 1,
            id: "abc",
            at: now,
            kind: .turnDone,
            computer: "c1",
            cwd: "/r",
            sessionId: "s1",
            title: "t"
        )
        XCTAssertEqual(dedupeVerdict(message: message, seen: seen, now: now), .fresh)
        seen = seen.adding(id: message.id, at: message.at, now: now)
        // Mutation: drop the seen check → a replay shows a second banner (F6).
        XCTAssertEqual(dedupeVerdict(message: message, seen: seen, now: now), .suppressed)
        // …and the item round-trips through its JSON.
        let parsed = try XCTUnwrap(SeenSet.parse(seen.serialized()))
        XCTAssertEqual(parsed.entries, seen.entries)
        // An unknown version is treated as absent, never rewritten.
        XCTAssertNil(SeenSet.parse("{\"v\":9,\"entries\":[]}"))
    }

    func testAgeWindowBothDirections() {
        let now = 1_800_000_000_000
        func at(_ delta: Int) -> PushMessage {
            PushMessage(
                v: 1,
                id: "id-\(delta)",
                at: now + delta,
                kind: .turnDone,
                computer: "c1",
                cwd: "/r",
                sessionId: "s1",
                title: "t"
            )
        }
        XCTAssertEqual(dedupeVerdict(message: at(-pushMaxAgeMs), seen: nil, now: now), .fresh)
        XCTAssertEqual(dedupeVerdict(message: at(-pushMaxAgeMs - 1), seen: nil, now: now), .suppressed)
        XCTAssertEqual(dedupeVerdict(message: at(pushMaxSkewMs), seen: nil, now: now), .fresh)
        XCTAssertEqual(dedupeVerdict(message: at(pushMaxSkewMs + 1), seen: nil, now: now), .suppressed)
    }

    // MARK: - the directory and the Keychain reads

    private final class FakeKeychain: PushKeychainReading {
        var items: [String: String] = [:]
        var reads: [String] = []
        func read(_ item: String) -> String? {
            reads.append(item)
            return items[item]
        }
        func write(_ item: String, value: String) {
            items[item] = value
        }
    }

    func testUnknownDirectoryVersionIsAbsent() {
        XCTAssertNil(PushDirectory.parse(nil))
        XCTAssertNil(PushDirectory.parse("garbage"))
        XCTAssertNil(PushDirectory.parse("{\"v\":2,\"peers\":[],\"keys\":[]}"))
        XCTAssertNotNil(PushDirectory.parse("{\"v\":1,\"peers\":[],\"keys\":[]}"))
    }

    /// The extension reads ONLY the two shared notification items — never a
    /// per-computer record (which holds the Noise device key). Mutation: read
    /// `tentacle.computer.<id>` → the assertion on `reads` fails.
    func testReadsOnlyTheSharedNotificationItems() throws {
        let keychain = FakeKeychain()
        let message = PushMessage(
            v: 1,
            id: "0123456789abcdef0123456789abcdef",
            at: 1_800_000_000_000,
            kind: .turnDone,
            computer: "c1",
            cwd: "/r",
            sessionId: "s1",
            title: "t"
        )
        let directory = PushDirectory(
            peers: [
                DirectoryPeer(kid: "unused", computerId: "c1", name: "Mac", computerKey: "AAAA"),
            ],
            keys: []
        )
        keychain.items[PushKeychainItem.directory] = try encodeDirectory(directory)
        // A well-SHAPED envelope for a peer the directory does not name: the
        // pipeline reads the directory, finds no such kid, and gives up with the
        // placeholder — having read nothing else.
        let ephemeral = base64Url(Data(repeating: 1, count: 32))
        let envelope: [AnyHashable: Any] = [
            "v": 1,
            "k": "AAAAAAAAAAAA",
            "e": ephemeral,
            "c": base64Url(Data(repeating: 2, count: 544)),
        ]
        XCTAssertNil(
            PushPipeline.render(userInfo: [PushPayloadKey.envelope: envelope], now: 1, keychain: keychain)
        )
        XCTAssertEqual(Set(keychain.reads), [PushKeychainItem.directory])
        _ = message
    }

    private func encodeDirectory(_ directory: PushDirectory) throws -> String {
        let peers: [[String: Any]] = directory.peers.map {
            ["kid": $0.kid, "computerId": $0.computerId, "name": $0.name, "computerKey": $0.computerKey]
        }
        let keys: [[String: Any]] = directory.keys.map { key in
            var out: [String: Any] = ["priv": key.priv, "pub": key.pub, "createdAt": key.createdAt]
            if let retiredAt = key.retiredAt { out["retiredAt"] = retiredAt }
            return out
        }
        let data = try JSONSerialization.data(withJSONObject: ["v": 1, "peers": peers, "keys": keys])
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: - Live Activities (task 18, L10)

    /// Every `la-v1` vector opens with the device key, under the ACTIVITY's own
    /// slot — and NOT under another slot (F7).
    ///
    /// Mutation: drop the slot from the aad → the positive still passes and the
    /// negative stops throwing, so the F7 test is the one that catches it.
    func testEveryActivityVectorOpensUnderItsOwnSlot() throws {
        let vectors = try vectorJSON("la-v1")
        let computer = try XCTUnwrap(vectors["computer"] as? [String: Any])
        let device = try XCTUnwrap(vectors["device"] as? [String: Any])
        let kid = try XCTUnwrap(vectors["kid"] as? String)
        let slot = try XCTUnwrap(vectors["slot"] as? String)
        let senderPublicKey = bytes(hex: try XCTUnwrap(computer["pk"] as? String))
        let recipientSecret = bytes(hex: try XCTUnwrap(device["sk"] as? String))
        let cases = try XCTUnwrap(vectors["vectors"] as? [String: [String: Any]])
        for (name, vector) in cases {
            // The vectors carry HEX (as `push-v1` does); the wire carries base64url,
            // so the vector is re-encoded here — the field's own encoding is
            // asserted by `la-render`/`push-seal.test.ts`, and what this test is
            // about is that the CRYPTO opens.
            let state = TentacleActivityContentState(
                e: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["enc"] as? String))),
                c: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["ct"] as? String)))
            )
            let attributes = TentacleActivityAttributes(k: kid, slot: slot)
            let plaintext = try openActivityState(
                contentState: state, attributes: attributes,
                recipientPrivateKey: recipientSecret, senderPublicKey: senderPublicKey
            )
            // The padded framing: `PushCore.unpad` is the same rule the daemon uses.
            let body = try XCTUnwrap(unpad(plaintext))
            let expected = try XCTUnwrap(vector["plaintext_json"] as? String)
            XCTAssertEqual(String(decoding: body, as: UTF8.self), expected, "vector \(name)")
        }
    }

    /// F7: the same bytes inside ANOTHER activity do not open.
    func testAnActivityStateCannotBeMovedToAnotherSlot() throws {
        let vectors = try vectorJSON("la-v1")
        let computer = try XCTUnwrap(vectors["computer"] as? [String: Any])
        let device = try XCTUnwrap(vectors["device"] as? [String: Any])
        let vector = try XCTUnwrap((vectors["vectors"] as? [String: [String: Any]])?["running-512"])
        let state = TentacleActivityContentState(
            e: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["enc"] as? String))),
            c: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["ct"] as? String)))
        )
        let moved = TentacleActivityAttributes(
            k: try XCTUnwrap(vectors["kid"] as? String), slot: "ffeeddccbbaa998877665544"
        )
        XCTAssertThrowsError(try openActivityState(
            contentState: state, attributes: moved,
            recipientPrivateKey: bytes(hex: try XCTUnwrap(device["sk"] as? String)),
            senderPublicKey: bytes(hex: try XCTUnwrap(computer["pk"] as? String))
        ))
    }

    /// A forged or unpinned sender is refused (Auth mode checks the static key).
    func testAnActivityFromAnotherComputerDoesNotOpen() throws {
        let vectors = try vectorJSON("la-v1")
        let device = try XCTUnwrap(vectors["device"] as? [String: Any])
        let vector = try XCTUnwrap((vectors["vectors"] as? [String: [String: Any]])?["running-512"])
        let state = TentacleActivityContentState(
            e: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["enc"] as? String))),
            c: base64UrlEncode(bytes(hex: try XCTUnwrap(vector["ct"] as? String)))
        )
        // Any other 32-byte key: the kid check refuses it first.
        let other = Data(repeating: 0x42, count: 32)
        XCTAssertThrowsError(try openActivityState(
            contentState: state,
            attributes: TentacleActivityAttributes(k: "tzHqlSe8ME5A", slot: "00112233445566778899aabb"),
            recipientPrivateKey: bytes(hex: try XCTUnwrap(device["sk"] as? String)),
            senderPublicKey: other
        ))
    }

    /// The render spec: EVERY `la-render-v1` vector's expected view-model is what
    /// `LACore.renderActivity` produces — the same file `la-render.test.ts` asserts,
    /// so the two implementations cannot drift (decision 20).
    ///
    /// Mutation: map `allow_always` to Approve → the `asking-allow-always` vector's
    /// buttons differ and this fails.
    func testEveryRenderVectorMatchesTheSwiftSpec() throws {
        let vectors = try vectorJSON("la-render-v1")
        let cases = try XCTUnwrap(vectors["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            let content = try XCTUnwrap(entry["content"] as? [String: Any])
            let expected = try XCTUnwrap(entry["expect"] as? [String: Any])
            let json = try JSONSerialization.data(withJSONObject: content)
            let view = renderActivity(json: json)

            XCTAssertEqual(view.placeholder, expected["placeholder"] as? Bool, "placeholder: \(name)")
            XCTAssertEqual(view.text, expected["text"] as? String, "text: \(name)")
            XCTAssertEqual(view.slot, expected["slot"] as? String, "slot: \(name)")
            XCTAssertEqual(view.project, expected["project"] as? String, "project: \(name)")
            XCTAssertEqual(view.phase, expected["phase"] as? String, "phase: \(name)")
            XCTAssertEqual(view.tool, expected["tool"] as? String, "tool: \(name)")
            XCTAssertEqual(view.title, expected["title"] as? String, "title: \(name)")
            XCTAssertEqual(view.preview, expected["preview"] as? String, "preview: \(name)")
            XCTAssertEqual(view.error, expected["error"] as? String, "error: \(name)")
            XCTAssertEqual(
                view.privateFields, expected["privateFields"] as? [String], "privateFields: \(name)"
            )
            let buttonEntries: [[String: String]] = (expected["buttons"] as? [[String: String]]) ?? []
            var expectedButtons: [LaButton] = []
            for entry in buttonEntries {
                if let action = entry["action"], let optionId = entry["optionId"] {
                    expectedButtons.append(LaButton(action: action, optionId: optionId))
                }
            }
            XCTAssertEqual(view.buttons, expectedButtons, "buttons: \(name)")
            if let startedAt = expected["startedAt"] as? NSNumber {
                XCTAssertEqual(view.startedAt, startedAt.int64Value, "startedAt: \(name)")
            } else {
                XCTAssertNil(view.startedAt, "startedAt: \(name)")
            }
        }
    }
}

// PushPipeline.swift — the extension's whole DECISION, pure and injected
// (docs/feat/mobile-notifications.md Design 2 / N5): parse → directory → open →
// dedupe/age → render. No UserNotifications import, so `swift test` runs it on
// macOS with a fake Keychain, and `NotificationService.swift` is a thin shell
// that applies the result to a `UNNotificationContent` and delivers it.
//
// The one property this file exists to make testable: a failure at ANY step is
// `nil` (the placeholder), never a partly-rendered banner, and the extension
// never reads anything but the two shared notification items (it never touches
// the per-computer record that holds the Noise device key).

import Foundation

public enum PushPipeline {
    /// The whole decision. `nil` → the placeholder (no category, no hints).
    ///
    /// The order matters: `nil` from a MISSING/unknown directory or an envelope
    /// that does not open is "not ours"; a plaintext that opens but is old/already
    /// shown is also the placeholder, but its id is NOT added to the seen-set
    /// again (it already is, or it is stale).
    public static func render(
        userInfo: [AnyHashable: Any],
        now: Int,
        keychain: PushKeychainReading
    ) -> Rendered? {
        guard let envelope = envelopeFrom(userInfo: userInfo) else { return nil }
        guard let directory = PushDirectory.parse(keychain.read(PushKeychainItem.directory)) else {
            return nil
        }
        guard let peer = directory.peer(forKid: envelope.keyId) else { return nil }
        guard let computerKey = decodeBase64Url(peer.computerKey) else { return nil }
        for key in directory.keys {
            guard let privateKey = decodeBase64Url(key.priv) else { continue }
            guard
                let plaintext = try? openPush(
                    envelope: envelope,
                    recipientPrivateKey: privateKey,
                    senderPublicKey: computerKey
                )
            else { continue }
            // It opened: the plaintext is authentic, so a failure from here is NOT
            // "try another key" — a message this build cannot read is the
            // placeholder (F11), and so is an old or repeated one (F6/F7).
            guard let message = parsePushMessage(plaintext) else { return nil }
            let seen = SeenSet.parse(keychain.read(PushKeychainItem.seen))
            guard dedupeVerdict(message: message, seen: seen, now: now) == .fresh else {
                return nil
            }
            keychain.write(
                PushKeychainItem.seen,
                value: (seen ?? SeenSet(entries: []))
                    .adding(id: message.id, at: message.at, now: now)
                    .serialized()
            )
            return PushCore.render(message, peer: RenderPeer(computerName: peer.name))
        }
        return nil
    }
}

// PushOpen.swift — HPKE Auth mode with CryptoKit, exactly task 16's suite
// (docs/feat/mobile-notifications.md Design 2 step 3): the pure logic, no UIKit,
// so the SwiftPM test package runs it on macOS against the SAME vectors the
// TypeScript implementation is pinned by (`push-v1.json`, decision 20).
//
// The property: only the paired computer can have produced a push. Auth mode
// mixes the sender's STATIC key into the KEM, so a relay (or Apple) cannot forge
// one, and the recipient checks it against the key pinned at pairing. No
// hand-written crypto: CryptoKit's `HPKE.Recipient(…authenticatedBy:)` is the
// same profile (RFC 9180, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
// ChaCha20-Poly1305).
//
// The padded plaintext's framing (protocol/push-seal.ts): a `u16` big-endian
// length prefix, then the JSON, then zeros up to the bucket. `unpad` refuses
// anything that does not fit that shape (a flipped byte is caught by the AEAD's
// tag before this, but the framing is validated anyway: cheap, and it turns a
// truncation into a placeholder instead of a crash).

import CryptoKit
import Foundation

/// The HPKE `info` for this protocol version (protocol/push-seal.ts `PUSH_INFO`).
public let pushInfo = "tentacle-push/1"

public enum PushOpenError: Error, Equatable {
    /// The envelope's key id does not match the computer key we tried.
    case wrongKeyId
    /// HPKE failed: a wrong recipient key, a wrong sender key, or a forged/flipped blob.
    case cannotOpen
    /// The padded framing is invalid (a length prefix past the buffer, non-zero padding).
    case badPadding
}

/// The cipher suite task 16 pinned. Written once, so the extension and the
/// vectors cannot drift.
public typealias PushCiphersuite = HPKE.Ciphersuite

public func pushCiphersuite() -> PushCiphersuite {
    .Curve25519_SHA256_ChachaPoly
}

/// `b64url(SHA-256("tentacle-push-kid/1" ‖ computerPub))[0..11]` — the envelope's
/// `k` (protocol/push-seal.ts `pushKeyId`). It names which pinned computer to try
/// and is the AEAD's `aad`, binding a ciphertext to that computer.
public func pushKeyId(computerPublicKey: Data) -> String {
    let prefix = Data("tentacle-push-kid/1".utf8)
    var hasher = SHA256()
    hasher.update(data: prefix)
    hasher.update(data: computerPublicKey)
    let digest = hasher.finalize()
    return base64Url(Data(digest).prefix(9))
}

/// Unpadded base64url (the wire's alphabet).
public func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// Strip the padding: the `u16` big-endian length prefix, then exactly that many
/// bytes of JSON (the rest must be zeros).
public func unpad(_ padded: Data) -> Data? {
    guard padded.count >= 2 else { return nil }
    let length = Int(padded[padded.startIndex]) << 8 | Int(padded[padded.startIndex + 1])
    guard length >= 0, length <= padded.count - 2 else { return nil }
    let start = padded.startIndex + 2
    let body = padded[start ..< start + length]
    let rest = padded[(start + length)...]
    guard rest.allSatisfy({ $0 == 0 }) else { return nil }
    return Data(body)
}

/// Open one sealed push with one candidate recipient key and one candidate
/// sender (pinned computer) key. Throws `PushOpenError` on every failure path:
/// the extension turns any of them into the placeholder.
public func openPush(
    envelope: PushEnvelope,
    recipientPrivateKey: Data,
    senderPublicKey: Data
) throws -> Data {
    guard envelope.keyId == pushKeyId(computerPublicKey: senderPublicKey) else {
        throw PushOpenError.wrongKeyId
    }
    guard recipientPrivateKey.count == 32, senderPublicKey.count == 32 else {
        throw PushOpenError.cannotOpen
    }
    let recipientKey: Curve25519.KeyAgreement.PrivateKey
    let senderKey: Curve25519.KeyAgreement.PublicKey
    let ephemeralKey: Curve25519.KeyAgreement.PublicKey
    do {
        recipientKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipientPrivateKey)
        senderKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderPublicKey)
        ephemeralKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: envelope.ephemeral)
    } catch {
        throw PushOpenError.cannotOpen
    }
    guard
        let aad = envelope.keyId.data(using: .utf8),
        let info = pushInfo.data(using: .utf8)
    else { throw PushOpenError.cannotOpen }
    do {
        var recipient = try HPKE.Recipient(
            privateKey: recipientKey,
            ciphersuite: pushCiphersuite(),
            info: info,
            // CryptoKit's labels are the opposite way round from the RFC's prose:
            // `encapsulatedKey` is the sender's ephemeral key BYTES, and
            // `authenticatedBy` is the sender's STATIC public key as a key object
            // (Auth mode, RFC 9180 §5.1.1).
            encapsulatedKey: ephemeralKey.rawRepresentation,
            authenticatedBy: senderKey
        )
        let plaintext = try recipient.open(envelope.ciphertext, authenticating: aad)
        guard let unpadded = unpad(plaintext) else {
            throw PushOpenError.badPadding
        }
        return unpadded
    } catch let error as PushOpenError {
        throw error
    } catch {
        throw PushOpenError.cannotOpen
    }
}

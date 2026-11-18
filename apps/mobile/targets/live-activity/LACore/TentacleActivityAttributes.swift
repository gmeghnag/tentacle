// TentacleActivityAttributes.swift — the activity's CLEAR attributes and its
// ContentState (docs/feat/mobile-live-activity.md Design 2, L10).
//
// This ONE file is compiled into BOTH the app module (so it can start an
// activity with the same type) and the widget extension (so iOS can decode an
// incoming push into it). The `attributes-type` the relay sends is a fixed
// string, `TentacleActivityAttributes`, which must equal this type's NAME: a
// rename is a silent break of the whole channel, so the name never changes and
// fields are only ever ADDED as optionals (an older widget ignores an unknown
// key; a removed one makes iOS drop the update — F22).
//
// No content lives here: `ContentState` is the sealed blob, and what the widget
// DRAWS comes from opening it (`LACore.open`). `ActivityContentStateSchema` in
// `@tentacle/protocol` is this type on the wire, and the field names are the
// contract between them.

import Foundation

/// The clear `attributes` of an activity: sealed content's key id and the slot
/// the state is bound to (the AEAD's aad half — a state cannot cross activities).
public struct TentacleActivityAttributes: Codable, Hashable {
    public let v: Int
    /// The computer's push key id (`tentacle-push-kid/1`), so the widget picks
    /// which pinned computer to try before it decrypts anything.
    public let k: String
    /// The daemon's handle on THIS activity object: 24 hex characters.
    public let slot: String

    public init(v: Int = 1, k: String, slot: String) {
        self.v = v
        self.k = k
        self.slot = slot
    }
}

/// The CLEAR `aps.content-state`: the sealed blob and nothing else. Apple, the
/// relay and anything reading a stored activity see this and cannot open it.
public struct TentacleActivityContentState: Codable, Hashable {
    public let v: Int
    /// The sender's ephemeral public key, base64url (43 characters).
    public let e: String
    /// The ChaCha20-Poly1305 ciphertext, base64url (704 or 1387 characters).
    public let c: String

    public init(v: Int = 1, e: String, c: String) {
        self.v = v
        self.e = e
        self.c = c
    }
}

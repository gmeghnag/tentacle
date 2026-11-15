// PushDirectory.swift — read the item the app shares with this extension
// (docs/feat/mobile-notifications.md Design 6 / N5), in shared-group Keychain form.
//
// The extension reads TWO items, both written by the app and both named here:
//  - `tentacle.push.directory`: the paired computers (id, name, PINNED key) and
//    this phone's push private keys (current, then ≤ 24 h retired ones, F8);
//  - `tentacle.push.seen`: the seen ids it writes itself (PushDedupe.swift).
//
// It NEVER reads `tentacle.computer.<id>` (the per-computer record, which holds
// the Noise device key that authenticates the phone): task 16 Design 2 — "the
// extension never holds the key that authenticates the device". That is also why
// this file names only these two constants.
//
// The Keychain access is behind a protocol so the rules (parsing, the peer/key
// selection, an unknown version → placeholder) run under `swift test` with a fake.

import Foundation
import Security

/// The item names (mirrors `push-directory.ts` / `push-key.ts`).
public enum PushKeychainItem {
    public static let directory = "tentacle.push.directory"
    public static let seen = "tentacle.push.seen"
}

public struct DirectoryPeer: Equatable {
    public let kid: String
    public let computerId: String
    public let name: String
    public let computerKey: String

    public init(kid: String, computerId: String, name: String, computerKey: String) {
        self.kid = kid
        self.computerId = computerId
        self.name = name
        self.computerKey = computerKey
    }
}

public struct DirectoryKey: Equatable {
    public let priv: String
    public let pub: String
    public let createdAt: Int
    public let retiredAt: Int?

    public init(priv: String, pub: String, createdAt: Int, retiredAt: Int? = nil) {
        self.priv = priv
        self.pub = pub
        self.createdAt = createdAt
        self.retiredAt = retiredAt
    }
}

/// The directory the app writes (`push-directory.ts`'s `PushDirectory`).
public struct PushDirectory: Equatable {
    public static let version = 1
    public let v: Int
    public let peers: [DirectoryPeer]
    public let keys: [DirectoryKey]

    public init(v: Int = PushDirectory.version, peers: [DirectoryPeer], keys: [DirectoryKey]) {
        self.v = v
        self.peers = peers
        self.keys = keys
    }

    /// Decode; nil when absent, unreadable, or of an UNKNOWN version (the caller
    /// shows the placeholder — this build's rules never apply to another's data).
    public static func parse(_ raw: String?) -> PushDirectory? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard let v = object["v"] as? Int, v == PushDirectory.version else { return nil }
        guard let rawPeers = object["peers"] as? [[String: Any]],
              let rawKeys = object["keys"] as? [[String: Any]]
        else { return nil }
        var peers: [DirectoryPeer] = []
        for raw in rawPeers {
            guard let kid = raw["kid"] as? String,
                  let computerId = raw["computerId"] as? String,
                  let name = raw["name"] as? String,
                  let computerKey = raw["computerKey"] as? String
            else { return nil }
            peers.append(
                DirectoryPeer(kid: kid, computerId: computerId, name: name, computerKey: computerKey)
            )
        }
        var keys: [DirectoryKey] = []
        for raw in rawKeys {
            guard let priv = raw["priv"] as? String,
                  let pub = raw["pub"] as? String,
                  let createdAt = raw["createdAt"] as? Int
            else { return nil }
            keys.append(
                DirectoryKey(
                    priv: priv,
                    pub: pub,
                    createdAt: createdAt,
                    retiredAt: raw["retiredAt"] as? Int
                )
            )
        }
        return PushDirectory(v: v, peers: peers, keys: keys)
    }

    /// The pair a sealed envelope should be tried against: the peer its `kid`
    /// names, if any (nil → the placeholder, no actions).
    public func peer(forKid kid: String) -> DirectoryPeer? {
        peers.first { $0.kid == kid }
    }
}

/// The one Keychain surface the extension uses: a shared-group generic password.
public protocol PushKeychainReading {
    func read(_ item: String) -> String?
    func write(_ item: String, value: String)
}

/// The real one: `kSecClassGenericPassword` with the attributes
/// `expo-secure-store` writes (`kSecAttrService = "<group>:no-auth"`,
/// `kSecAttrAccount = kSecAttrGeneric = utf8(key)`, `kSecAttrAccessGroup`), so
/// the app's items are found — pinned against the module's own Swift source in
/// `apps/mobile/test/push-directory.test.ts`'s comment and exercised on a
/// simulator by N0(f).
public final class SharedKeychain: PushKeychainReading {
    private let service: String
    private let accessGroup: String?

    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(_ item: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    public func read(_ item: String) -> String? {
        var query = baseQuery(item)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ item: String, value: String) {
        let data = Data(value.utf8)
        let query = baseQuery(item)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(insert as CFDictionary, nil)
        }
    }
}

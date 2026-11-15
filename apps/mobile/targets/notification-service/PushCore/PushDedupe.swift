// PushDedupe.swift — the NSE's seen-set and age window (docs/feat/mobile-notifications.md
// Design 2 step 4 / N5), pure so the rules run under `swift test`.
//
// Two guards, both against a relay that replays or delays a GENUINE push (F6/F7):
//  - the seen-set: the last 256 ids, 24 h, kept in the shared Keychain item
//    `tentacle.push.seen` (the app reads the same item to refuse a second answer);
//  - the age window: `at` older than 24 h, or more than 10 min in the future, is
//    not rendered — the same numbers `notification-action.ts` uses, so the NSE
//    and the app cannot disagree about what "too old" means.

import Foundation

/// The age window (mirrors `notification-action.ts`'s `ACTION_MAX_AGE_MS`).
public let pushMaxAgeMs = 24 * 60 * 60 * 1000
/// How far ahead of the phone's clock a push may be.
public let pushMaxSkewMs = 10 * 60 * 1000
/// How many ids the seen-set keeps.
public let pushSeenLimit = 256

/// One entry of the seen-set: the plaintext's `id` (`at` is its own timestamp).
public struct SeenEntry: Equatable {
    public let id: String
    public let at: Int

    public init(id: String, at: Int) {
        self.id = id
        self.at = at
    }
}

/// The Keychain item's shape. An unknown `v` is treated as ABSENT by this reader
/// (a newer build's item is never rewritten by an older extension — AGENTS §7).
public struct SeenSet: Equatable {
    public static let version = 1
    public let v: Int
    public let entries: [SeenEntry]

    public init(v: Int = SeenSet.version, entries: [SeenEntry]) {
        self.v = v
        self.entries = entries
    }

    /// Decode the item's JSON; nil when absent, unreadable, or of an unknown version.
    public static func parse(_ raw: String?) -> SeenSet? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard let v = object["v"] as? Int, v == SeenSet.version else { return nil }
        guard let rawEntries = object["entries"] as? [[String: Any]] else { return nil }
        var entries: [SeenEntry] = []
        for raw in rawEntries {
            guard let id = raw["id"] as? String, let at = raw["at"] as? Int else { return nil }
            entries.append(SeenEntry(id: id, at: at))
        }
        return SeenSet(entries: entries)
    }

    public func serialized() -> String {
        let items = entries.map { ["id": $0.id, "at": $0.at] as [String: Any] }
        let object: [String: Any] = ["v": v, "entries": items]
        guard
            let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else { return "{\"entries\":[],\"v\":1}" }
        return text
    }

    public func contains(_ id: String) -> Bool {
        entries.contains { $0.id == id }
    }

    /// The set with `id` added, pruned to the last `pushSeenLimit` entries (newest
    /// by `at`), dropping anything past the age window.
    public func adding(id: String, at: Int, now: Int) -> SeenSet {
        let kept = entries.filter { now - $0.at <= pushMaxAgeMs && $0.id != id }
        let all = kept + [SeenEntry(id: id, at: at)]
        let ordered = all.sorted { $0.at < $1.at }
        let trimmed = ordered.suffix(pushSeenLimit)
        return SeenSet(v: v, entries: Array(trimmed))
    }
}

/// What the NSE should do with a decrypted message, before rendering.
public enum DedupeVerdict: Equatable {
    /// Render it, and add its id to the seen-set.
    case fresh
    /// Already shown, too old, or from the future: the placeholder with category "".
    case suppressed
}

/// The age window and the seen-set, in the order the extension applies them.
public func dedupeVerdict(
    message: PushMessage,
    seen: SeenSet?,
    now: Int
) -> DedupeVerdict {
    let age = now - message.at
    if age > pushMaxAgeMs || age < -pushMaxSkewMs {
        return .suppressed
    }
    if seen?.contains(message.id) == true {
        return .suppressed
    }
    return .fresh
}

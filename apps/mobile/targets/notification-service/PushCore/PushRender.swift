// PushRender.swift — the banner's content, mirroring
// apps/mobile/src/push-render.ts byte for byte (docs/feat/mobile-notifications.md
// Design 1 / N5). The shared vector file `push-render-v1.json` is THE spec: the
// TypeScript test asserts it, and `PushCoreTests` asserts it again here, so the
// two implementations cannot drift (decision 20).
//
// The rules that are security-relevant, not cosmetic:
//  - Approve is only ever `allow_once`: an ask that offers no `allow_once`
//    gets no ask category at all, just Open (a lasting rule is the sheet's);
//  - anything unrenderable is the PLACEHOLDER: category "" and no routing hints,
//    so a hostile relay's `aps` is never dressed up with actions of ours (F5);
//  - every shown string is stripped of ANSI and control characters (the text came
//    from a daemon that may be a pod).

import Foundation

public enum NotificationCategoryId {
    public static let ask = "tentacle.ask"
    public static let askReply = "tentacle.ask.reply"
    public static let open = "tentacle.open"
}

public enum InterruptionLevel: String, Equatable {
    case passive
    case active
    case timeSensitive
}

/// The routing hints an Open tap and a dismissal use — never an answer (Design 3).
public struct NotificationHints: Equatable {
    public let kind: String
    public let computerId: String
    public let sessionId: String
    public let requestId: String?

    public init(kind: String, computerId: String, sessionId: String, requestId: String? = nil) {
        self.kind = kind
        self.computerId = computerId
        self.sessionId = sessionId
        self.requestId = requestId
    }

    /// `userInfo.tn` as the app reads it (`push-render.ts`'s `NotificationHints`).
    public func dictionary() -> [String: Any] {
        var out: [String: Any] = [
            "v": 1,
            "kind": kind,
            "computerId": computerId,
            "sessionId": sessionId,
        ]
        if let requestId {
            out["requestId"] = requestId
        }
        return out
    }
}

/// What the extension sets on a notification's content.
public struct Rendered: Equatable {
    public let title: String
    public let subtitle: String?
    public let body: String
    public let category: String
    public let interruptionLevel: InterruptionLevel
    public let sound: Bool
    public let threadIdentifier: String
    public let hints: NotificationHints?
    public let placeholder: Bool

    public init(
        title: String,
        subtitle: String? = nil,
        body: String,
        category: String,
        interruptionLevel: InterruptionLevel,
        sound: Bool,
        threadIdentifier: String,
        hints: NotificationHints? = nil,
        placeholder: Bool
    ) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.category = category
        self.interruptionLevel = interruptionLevel
        self.sound = sound
        self.threadIdentifier = threadIdentifier
        self.hints = hints
        self.placeholder = placeholder
    }
}

/// The relay's outer `aps` text, shown when nothing could be rendered (task 16 P4).
public let placeholderText = "Open tentacle to see what's new"

/// The placeholder: no category (no actions), no hints, quiet.
public func placeholderRendered() -> Rendered {
    Rendered(
        title: "",
        body: placeholderText,
        category: "",
        interruptionLevel: .active,
        sound: false,
        threadIdentifier: "",
        placeholder: true
    )
}

/// ANSI CSI/OSC sequences, and the control characters to drop.
private func stripped(_ text: String) -> String {
    var out = ""
    var iterator = Array(text.unicodeScalars)
    var index = 0
    while index < iterator.count {
        let scalar = iterator[index]
        if scalar == "\u{1B}" {
            // CSI: ESC [ … final byte 0x40-0x7E. OSC: ESC ] … BEL or ST.
            var cursor = index + 1
            if cursor < iterator.count, iterator[cursor] == "[" {
                cursor += 1
                while cursor < iterator.count, !(0x40 ... 0x7E).contains(iterator[cursor].value) {
                    cursor += 1
                }
                index = min(cursor + 1, iterator.count)
                continue
            }
            if cursor < iterator.count, iterator[cursor] == "]" {
                cursor += 1
                while cursor < iterator.count, iterator[cursor] != "\u{7}", iterator[cursor] != "\\" {
                    cursor += 1
                }
                index = min(cursor + 1, iterator.count)
                continue
            }
            index += 1
            continue
        }
        let value = scalar.value
        let drop = value < 0x20 || value == 0x7F || (value >= 0x80 && value <= 0x9F)
        if !drop {
            out.unicodeScalars.append(scalar)
        }
        index += 1
    }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// `basename(cwd)` (`push-render.ts`'s `projectName`).
public func projectName(_ cwd: String) -> String {
    let parts = cwd.split(separator: "/").map(String.init)
    return parts.last ?? cwd
}

/// The category an ask gets, from the KINDS it offers (never from its text).
public func categoryFor(ask: PushAsk) -> String {
    let kinds = Set(ask.options.map(\.kind))
    guard kinds.contains("allow_once"), kinds.contains("reject_once") else {
        return NotificationCategoryId.open
    }
    return ask.replyMaxChars != nil ? NotificationCategoryId.askReply : NotificationCategoryId.ask
}

/// The peer a push came from, as far as display goes.
public struct RenderPeer: Equatable {
    public let computerName: String

    public init(computerName: String) {
        self.computerName = computerName
    }
}

/// Render one opened plaintext. Mirrors `render(msg, peer, now)` in
/// `apps/mobile/src/push-render.ts`; the age guard is the extension's own
/// (`PushDedupe.swift`), and the version check is here so both implementations
/// refuse a future plaintext identically.
public func render(_ message: PushMessage, peer: RenderPeer) -> Rendered {
    guard message.v == pushRenderVersion else {
        return placeholderRendered()
    }
    let computer = stripped(peer.computerName)
    let project = projectName(stripped(message.cwd))
    let title = stripped(message.title)
    let thread = "s:\(message.sessionId)"
    let heading = computer.isEmpty ? project : "\(computer) · \(project)"
    func hints(_ requestId: String? = nil) -> NotificationHints {
        NotificationHints(
            kind: message.kind.rawValue,
            computerId: message.computer,
            sessionId: message.sessionId,
            requestId: requestId
        )
    }
    func subtitle() -> String? {
        title.isEmpty ? nil : title
    }

    switch message.kind {
    case .ask:
        guard let ask = message.ask else {
            return placeholderRendered()
        }
        let what = stripped(ask.title)
        let preview = ask.preview.map(stripped) ?? ""
        let more = (ask.more ?? 0) > 0 ? " · +\(ask.more ?? 0) more waiting" : ""
        let subject = preview.isEmpty ? what : "\(what): \(preview)"
        return Rendered(
            title: heading,
            subtitle: subtitle(),
            body: "\(subject)\(more)",
            category: categoryFor(ask: ask),
            interruptionLevel: .timeSensitive,
            sound: true,
            threadIdentifier: thread,
            hints: hints(ask.requestId),
            placeholder: false
        )
    case .askResolved:
        return Rendered(
            title: heading,
            subtitle: subtitle(),
            body: "Answered on another device",
            category: NotificationCategoryId.open,
            interruptionLevel: .passive,
            sound: false,
            threadIdentifier: thread,
            hints: hints(),
            placeholder: false
        )
    case .turnFailed:
        let why = message.turn?.error.map(stripped) ?? ""
        return Rendered(
            title: heading,
            subtitle: subtitle(),
            body: why.isEmpty ? "Turn failed" : "Turn failed: \(why)",
            category: NotificationCategoryId.open,
            interruptionLevel: .passive,
            sound: false,
            threadIdentifier: thread,
            hints: hints(),
            placeholder: false
        )
    case .turnDone:
        return Rendered(
            title: heading,
            subtitle: subtitle(),
            body: "Turn finished",
            category: NotificationCategoryId.open,
            interruptionLevel: .passive,
            sound: false,
            threadIdentifier: thread,
            hints: hints(),
            placeholder: false
        )
    }
}

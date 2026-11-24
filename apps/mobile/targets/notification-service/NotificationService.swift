// NotificationService.swift — the Notification Service Extension entry point
// (docs/feat/mobile-notifications.md Design 2 / slice N5).
//
// A THIN shell (AGENTS §7): every decision lives in `PushCore/`
// (`PushPipeline.render`, `PushRender`, `PushDedupe`), which has no
// UserNotifications import and runs under `swift test`. What is here is what
// needs iOS:
//  - the six steps' ORCHESTRATION and the content handler;
//  - `apply(_:to:)`: the rendered values onto a `UNMutableNotificationContent`,
//    with `categoryIdentifier` ALWAYS overwritten — with "" on every failure path
//    — so a `category` a hostile relay put in `aps` never survives (F5);
//  - `serviceExtensionTimeWillExpire`: deliver the PLACEHOLDER, never the
//    half-built content (Design 2 step 6).
//
// It never reads the per-computer store items (the Noise device key), never
// dials, never answers: display only.

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    /// `expo-secure-store`'s service name for a no-auth generic password
    /// (`SecureStoreModule.swift`): `<keychainService>:no-auth`, where the app
    /// passes `PUSH_KEYCHAIN_SERVICE` ("app", `src/push-access-group.ts`). Pinned
    /// by `test/push-keychain-service.test.ts` — change both or neither.
    private static let keychainService = "app:no-auth"

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNMutableNotificationContent?
    private var delivered = false

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let original = request.content.mutableCopy() as? UNMutableNotificationContent
            ?? UNMutableNotificationContent()
        self.original = original
        // No access group: this target is entitled to the shared
        // `...so.tentacle.app.push` group and its own app ID, and a query
        // WITHOUT a group "matches any of your app's groups" (Apple, *Sharing
        // access to keychain items*). It is never entitled to the app's own
        // group, so the Noise device key is out of reach (plan C1); and naming
        // a group here would need the build-time TEAMID prefix, which a Swift
        // literal cannot get right without a second source of truth.
        let keychain = SharedKeychain(service: Self.keychainService, accessGroup: nil)
        let rendered = PushPipeline.render(
            userInfo: original.userInfo,
            now: Int(Date().timeIntervalSince1970 * 1000),
            keychain: keychain
        )
        let content = rendered.map { Self.apply($0, to: original) }
            ?? Self.applyPlaceholder(to: original)
        deliver(content)
    }

    /// iOS is about to suspend us: the placeholder, never a banner whose actions
    /// we could not verify.
    override func serviceExtensionTimeWillExpire() {
        guard let original else { return }
        deliver(Self.applyPlaceholder(to: original))
    }

    private func deliver(_ content: UNNotificationContent) {
        guard !delivered else { return }
        delivered = true
        contentHandler?(content)
    }

    // MARK: - UNNotificationContent projection (the only iOS-specific bit)

    /// The placeholder applied to the relay's content: its own text, no category,
    /// no hints — nothing here may be trusted for routing or an answer.
    static func applyPlaceholder(
        to content: UNMutableNotificationContent
    ) -> UNNotificationContent {
        let safe = UNMutableNotificationContent()
        safe.title = content.title
        safe.body = content.body
        safe.categoryIdentifier = ""
        safe.userInfo = [:]
        safe.interruptionLevel = .active
        safe.threadIdentifier = ""
        return safe
    }

    /// The rendered content: category, level, thread, sound and `userInfo.tn` plus
    /// the envelope (so the APP can re-open and verify it before an answer —
    /// Design 3; without `tp`, a tap could not be answered at all).
    static func apply(
        _ rendered: Rendered,
        to original: UNMutableNotificationContent
    ) -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = rendered.title
        if let subtitle = rendered.subtitle {
            content.subtitle = subtitle
        }
        content.body = rendered.body
        content.categoryIdentifier = rendered.category
        content.threadIdentifier = rendered.threadIdentifier
        content.sound = rendered.sound ? .default : nil
        switch rendered.interruptionLevel {
        case .passive:
            content.interruptionLevel = .passive
        case .active:
            content.interruptionLevel = .active
        case .timeSensitive:
            content.interruptionLevel = .timeSensitive
        }
        var userInfo: [AnyHashable: Any] = [:]
        if let hints = rendered.hints {
            userInfo["tn"] = hints.dictionary()
            if let raw = original.userInfo[PushPayloadKey.envelope] {
                userInfo[PushPayloadKey.envelope] = raw
            }
        }
        content.userInfo = userInfo
        return content
    }
}

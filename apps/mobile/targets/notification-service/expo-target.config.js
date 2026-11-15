/**
 * The Notification Service Extension target (docs/feat/mobile-notifications.md
 * Design 2 / slice N5), generated under Continuous Native Generation by
 * `@bacons/apple-targets` (the tool's own convention: one folder per target).
 *
 * Two decisions here are load-bearing:
 *  - **the bundle id** is `.NotificationService`, i.e.
 *    `so.tentacle.app.NotificationService` — the App ID the owner registers in
 *    D3a, with keychain sharing on both ids;
 *  - **the entitlement order (plan C1)**: the APP's own group first, the
 *    extension's copy of it second. iOS writes an item without an explicit
 *    access group into the FIRST listed group, and the app's Noise device key is
 *    written that way — with the shared group first, every device key would land
 *    where this extension can read it. `app.json`'s app-side list is the source
 *    of truth for the ORDER; `apps/mobile/test/app-config.test.ts` pins it.
 *    Here the extension lists the same ONE group, because both
 *    `so.tentacle.app` and `so.tentacle.app.NotificationService` must be in the
 *    same `keychain-access-groups` set to share items.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "notification-service",
  // `so.tentacle.app` + `.NotificationService` (D3a's App ID).
  bundleIdentifier: ".NotificationService",
  displayName: "tentacle",
  // CryptoKit's HPKE (iOS 17+) needs no framework link, but the extension does
  // read the shared Keychain and needs no other capability.
  deploymentTarget: "18.0",
  entitlements: {
    // Only the shared group: the extension has no keychain item of its own, and
    // an item written WITH this group is readable from both ids.
    "keychain-access-groups": [`$(AppIdentifierPrefix)${config.ios.bundleIdentifier}`],
  },
});

/**
 * The Notification Service Extension target (docs/feat/mobile-notifications.md
 * Design 2 / slice N5), generated under Continuous Native Generation by
 * `@bacons/apple-targets` (the tool's own convention: one folder per target).
 *
 * Three decisions here are load-bearing:
 *  - **the bundle id** is `.NotificationService`, i.e.
 *    `so.tentacle.app.NotificationService` — the App ID the owner registers in
 *    D3a, with keychain sharing on both ids;
 *  - **the extension gets the SHARED group only**, i.e. the separate
 *    `...so.tentacle.app.push` group (plan C1, fix round 1 finding #3). It is
 *    NOT entitled to the app's own group, so it can never read
 *    `tentacle.computer.*` — the Noise device key that authenticates the phone.
 *    `app.json`'s app-side list holds both, its own first, so a group-less write
 *    (the device key) stays out of the extension's reach;
 *  - **the runtime group is build-expanded**, not the bare literal (fix round 1
 *    finding #4): `kSecAttrAccessGroup` must equal a BUILT entitlement, and
 *    `$(AppIdentifierPrefix)` expands to `TEAMID.`. The Swift reads the expanded
 *    value out of `Info.plist` (`TentaclePushAccessGroup`), and
 *    `apps/mobile/test/app-config.test.ts` pins both halves.
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
    // ONLY the shared group. The app's own group is deliberately absent: an
    // entitlement to it would hand the extension the device key.
    "keychain-access-groups": ["$(AppIdentifierPrefix)so.tentacle.app.push"],
  },
});

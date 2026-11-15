/**
 * The Live Activity (widget) target (docs/feat/mobile-live-activity.md Design 6,
 * slice L10), generated under Continuous Native Generation by
 * `@bacons/apple-targets` — the same tooling as task 17's Notification Service
 * Extension, one folder per target.
 *
 * Four decisions here are load-bearing:
 *  - **`type: "widget"`.** The extension point is what makes the target a Live
 *    Activity host: iOS links an incoming `liveactivity` push to it by
 *    `attributes-type` (see `TentacleActivityAttributes.swift`), and a
 *    notification-service target would refuse the payload.
 *  - **the bundle id** is `.LiveActivity`, i.e. `so.tentacle.app.LiveActivity` —
 *    the App ID the owner registers in task 18's **D4a**, with keychain sharing
 *    on both ids. Regenerating profiles without it makes the build fail with a
 *    provisioning error, not a Swift error.
 *  - **the extension gets the SHARED group only**, exactly as task 17's NSE does:
 *    the widget must open a content-state (it reads the PINNED computer keys and
 *    the per-device push key from `tentacle.push.directory`), and it must never
 *    be entitled to the app's own group, which holds the Noise device key. The
 *    ordering rule in `app.json` (the app's own group FIRST) is what keeps a
 *    group-less write out of this extension's reach, and
 *    `apps/mobile/test/app-config.test.ts` pins both halves.
 *  - **deployment target 18.0**, the app's own floor: push-to-start needs 17.2
 *    and interactive buttons 17, so every supported phone has them (the plan's
 *    "Minimum iOS 18" section).
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  // A WIDGET target: Apple's Live Activity extension point, not a
  // notification-service one (which would refuse a `liveactivity` payload).
  type: "widget",
  // `so.tentacle.app` + `.LiveActivity` (D4a's App ID).
  bundleIdentifier: ".LiveActivity",
  displayName: "tentacle",
  deploymentTarget: "18.0",
  entitlements: {
    // ONLY the shared group — the same rule as the NSE (task 17, fix round 1
    // finding #3): an entitlement to the app's own group would hand this
    // extension the device's Noise key.
    "keychain-access-groups": ["$(AppIdentifierPrefix)so.tentacle.app.push"],
  },
});

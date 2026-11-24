# fix/mobile-push-tap-open — the push shows the placeholder text and a tap lands on the home screen, not the session

Type: fix · Size: — (triage first) · Blast: cross-module (daemon push envelope ↔ relay ↔ iOS notification-service extension ↔ app tap routing) · Suited: Sonnet triage + plan

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23 ~11:00*

Owner 23/11, after the build of 10:11 (dc1c4b86, fix/mobile-push-not-registered merged): push now REACHES the phone, but
1. the banner shows only the relay placeholder «Open tentacle to see what's new» (`apps/relay/src/apns.ts:29`), not the rendered turn text, and
2. tapping it opens the app's landing page (the computer/Mac view), NOT the session. Same result with the app in background AND fully closed (cold start).

Evidence (read-only, orchestrator):
- `~/assistant/.tentacle/serve.log`: `[daemon] push-registered a3b1d932 sandbox` (10:29) then `[daemon] push-sent turn_done a3b1d932`; no `gone`/BadDeviceToken afterwards; `~/.config/tentacle/devices/push/a3b1d9320694285b.json` still present (env sandbox). So APNs delivery works.
- The placeholder is what the phone shows when the notification-service extension does NOT replace the body (`apps/mobile/targets/notification-service/PushCore/PushRender.swift:94`, `apps/mobile/src/push-render.ts:76`). Symptom 1 therefore suggests the extension cannot open the envelope (keys not shared with the extension — keychain access group / app group — or key material mismatch with what the daemon encrypts with, or the extension not running at all: `mutable-content`, target embedding/signing in the build).
- Tap path: `apps/mobile/src/notifications-expo.ts` (`toNotificationResponse` :82, `drainColdStartResponse` :105, `onNotificationResponse` :117) → `openInApp` (:~131) re-opens the envelope with the app's own keys and returns `undefined` when it does not open. If the same key problem hits here, the tap has no session to route to → landing. Hypothesis: ONE root cause for both symptoms (envelope not openable on the device). Falsify it first.
- e2e: `apps/mobile/e2e/flows/22-notify-render.yaml` taps the placeholder — check what it actually asserts after the tap and whether it is quarantined (Maestro cannot see SpringBoard banners on the iOS 26 simulator).

Question: why does neither the extension nor the app open the delivered envelope (or, if they do, why does the tap not route to the session)? Give the root cause or the exact remaining unknown plus the one on-device check the owner must do.

## Implementation

*— claude-sonnet-5-5, 2026-11-23*

### Evidence (read-only; what was and was not checked)

- Delivery is fine: `serve.log` `push-registered a3b1d932 sandbox` → `push-sent turn_done|ask|ask_resolved`, no `gone`. Not a candidate.
- The 10:11 build (`.tentacle/tmp/mobile-ota/export/tentacle.ipa`, `unzip -l`) **does embed** `PlugIns/notificationservice.appex` (binary + `embedded.mobileprovision` + Info.plist). So "extension missing from the build" is falsified. NOT checked (extraction needs an approval I did not have): the appex's entitlements, `mutable-content` on the wire. → owner/orchestrator check C1 below.
- **Mismatch found by static reading (strongest lead for symptom 1):**
  - extension reads `kSecAttrService = "so.tentacle.app:no-auth"` (`targets/notification-service/NotificationService.swift:23`), group `nil`;
  - the app writes through `pushKeychain` (`src/secure-kv.ts:48-55`), which passes **only** `accessGroup` + `keychainAccessible`, never `keychainService` (grep: no `keychainService` anywhere in `apps/mobile`);
  - the repo's own design doc records expo-secure-store's service as `(keychainService ?? "app") + ":no-auth"` (`docs/feat/mobile-notifications.md:162`) ⇒ the app's items are `app:no-auth`; the extension looks for a different service ⇒ `SecItemCopyMatching` → not found ⇒ `PushPipeline.render` → nil ⇒ placeholder. Nothing tests the two agree (`test/app-config.test.ts:120-121` pins only `accessGroup: nil`; the Swift is only unit-tested with a fake keychain).
  - Still UNVERIFIED against the library's real source (`node_modules/expo-secure-store/ios/SecureStoreModule.swift` is not installed in this worktree). Cheapest decider: C2.
- **Hypothesis "one root cause for both symptoms" — falsified.** The app-side open (`openInApp` / `decideAction`) reads keys through the SAME `pushKeychain` adapter that wrote them (`push-directory-expo.ts:42-51`, `App.tsx:2277-2284`), so a service mismatch with the *extension* cannot make the *app* fail. Symptom 2 has its own cause(s):
  - **Cold start (survives, certain from code):** `navigate` returns silently when `!navigationRef.isReady()` (`App.tsx:2303-2305`) and the cold-start response is cleared by `drainColdStartResponse` (`notifications-expo.ts:111`) before that, so it is lost; the app then shows its default landing. Pairing links already solved the same race (`pending-link.ts`, `onReady={replayPendingLink}` `App.tsx:2547`); notifications did not reuse it. The `"computers"` branch (`:2293`) is not guarded either.
  - **Background tap (unexplained):** app is ready, so a refusal → `navigate("computers")` (`notification-dispatch.ts:86-89`) or a no-op when the app was already on Computers both look like "landing". Remaining candidates, each decided by one app-log line (C3): (a) `decideAction` refuses (`refused unverified` logged, `App.tsx:2310`) e.g. directory empty/stale, kid mismatch; (b) expo-notifications does not expose the custom APNs key `tp` under `content.data` for a remote notification, so `userInfo.tp` is undefined (`toNotificationResponse` `:82-96`) — unverified, library source not available here; (c) no response at all (listener registered late).
  - The extension replaced nothing, so in this build `userInfo` is the relay's raw payload, not the NSE's `{tn,tp}` — (b)/(a) must be judged on that payload shape too: the relay/daemon envelope key is `tp` (`PushPayloadKey.envelope`), check it is top-level in the APNs JSON.
- e2e `22-notify-render.yaml` is `quarantine`, taps the placeholder and asserts only `computers-list` + payload shape (L47-57): it cannot catch either symptom, and it states it does not prove the NSE (L14-22).

### Load-bearing assumption

"The extension and the app address the SAME Keychain item" (service + access group). Today nothing enforces it.

### Remaining unknown + on-device/owner checks (do these BEFORE/with the fix; ≤ 5 min)

- **C1 (orchestrator, no phone):** `unzip -p export/tentacle.ipa Payload/tentacle.app/PlugIns/notificationservice.appex/embedded.mobileprovision | strings | grep -A3 keychain-access-groups` and the same on `Payload/tentacle.app/embedded.mobileprovision`: both must list `8L24B2DUU2.so.tentacle.app.push`; and `plutil -p` the appex Info.plist (`NSExtensionPointIdentifier` = `com.apple.usernotifications.service`).
- **C2 (orchestrator, no phone):** `unzip -p … Payload/tentacle.app/tentacle | strings | grep -n ':no-auth'` and `rg 'no-auth' node_modules/expo-secure-store/ios` after `bun install`: shows the real service prefix the app writes. If it is `app`, symptom 1 is proven.
- **C3 (owner, phone):** send one push, tap it in background, then open the app's log screen (`APP_LOG`, tag `notify`): `refused unverified|expired|…` ⇒ envelope not opened in-app; `notice`/nothing ⇒ the response never reached `decideAction` or `tp` missing. Report the one `notify` line (kind only, it never contains text).

### Design

1. **Pin the service on both sides to ONE constant** (`push-access-group.ts` neighbour: `PUSH_KEYCHAIN_SERVICE`). App: `pushKeychain` passes `keychainService: PUSH_KEYCHAIN_SERVICE`; extension: reads it from `Info.plist` (`TentaclePushKeychainService`, same pattern as `TentaclePushAccessGroup`) — never a second literal. Pre-public, no shim; but changing the app's service orphans the existing `tentacle.push.key`/directory items: the keypair regenerates on next launch and the directory is rewritten — verify the app re-registers the new `pub` with the daemon (`ensurePushKeypair` rotate path) or the phone is deaf until re-pair. If C2 shows the default is `app`, the zero-migration alternative is the Swift constant `"app:no-auth"` (one-line) plus the contract test below; choose that if the re-registration check fails.
2. **Cold-start/early tap parked until navigation is ready:** new pure module `notification-route-queue.ts` (`park(route)` / `take(isReady)`), mirroring `pending-link.ts`; `navigate` in `App.tsx:2292` parks when not ready (both `"computers"` and session routes) and `NavigationContainer.onReady` replays it. Components stay dumb (§7).
3. Background-tap cause: decided by C3 before coding; if (b), read `tp` from the right place in `toNotificationResponse` (pure, tested with the real expo shape); if (a), fix the directory freshness.

### Files (dependency order)

`apps/mobile/src/push-access-group.ts` (+constant) → `src/secure-kv.ts` (pass it) → `targets/notification-service/NotificationService.swift` + `Info.plist`/`expo-target.config.js` (read it) → `src/notification-route-queue.ts` (new) → `App.tsx` (navigate/onReady) → [`src/notifications-expo.ts` only if C3 says (b)] → tests → `changelog.d/mobile-push-tap-open.fixed.md`. No protocol/daemon/relay change.

### Failure modes

Old items under the old service (key regenerates ⇒ re-register or deaf: see Design 1); a tap while locked/Face ID (queue replays after ready; lock overlay unchanged); two taps before ready (last wins, one replay, never two navigations); route for a session the store does not know yet (existing Session screen handles it); version skew none (no wire change).

### Tests (red first, each shown failing on today's code, then mutation-checked)

1. `apps/mobile/test/push-keychain-service.test.ts`: the Swift file's service string / Info.plist value **equals** the service the app's `pushKeychain` passes to `SecureStore` (spy on `SecureStore.getItemAsync` options). Red today: the app passes no `keychainService`, the Swift has a hard-coded literal. Plus a guard that reads the installed `expo-secure-store` Swift source and checks `<service>:no-auth` composition (red if the default ≠ the literal).
2. `notification-route-queue.test.ts`: `navigate` before ready ⇒ not lost, replayed once at ready; before-ready `"computers"` too; second park replaces first. Red today: `App.tsx:2303` drops it (assert on a wiring-level test of `startNotifications` with `navigate` gated by a fake ready flag: today `handle()` navigates once into a not-ready sink and nothing replays).
3. If (b): `toNotificationResponse` with the real expo remote shape (`data` holding `tp` under whichever key) returns `userInfo.tp`.

### Validation

Gate: `bun test apps/mobile/test/<files>`, then `bun run check`. Device: install the new TestFlight/OTA build, send a turn_done: (1) banner shows the rendered title/text (NSE opened it) — if still the placeholder, re-run C1/C2; (2) force-quit the app, tap the banner ⇒ the session opens (cold); (3) background tap ⇒ the session opens; `notify` log line absent of `refused`. Simulator cannot prove the NSE or the SpringBoard tap (flow 22 quarantined) — keep that stated.

Size: M · Blast: cross-module (Keychain contract + app navigation; not a §7 invariant) · Review: fresh-context recommended (Keychain key rotation).

#### Orchestrator approval (2026-11-24)

Owner «ok facciamoli partire» (24/11): execute **Design 1 + 2 now** (service pinned to ONE constant on both sides; cold-start/early tap parked until navigation is ready). FIRST run C1 and C2 yourself (unzip/strings on `.tentacle/tmp/mobile-ota/export/tentacle.ipa`, `rg 'no-auth'` in the installed expo-secure-store) and paste the output in Execution — if C2 shows the app's service is NOT `app:no-auth`, STOP and say so. **Design 3 is NOT in this round**: it waits the owner's C3 log line from the phone. Executor: Sonnet (owner: S/M → deepseek/sonnet).

*— orchestrator (claude-opus-5-5), 2026-11-24*

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

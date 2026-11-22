# fix/mobile-push-not-registered — the phone never registers for push on the owner's serve

Type: fix · Size: — (triage first) · Blast: cross-module (app push manager ↔ daemon `device/push_register` ↔ relay) · Suited: Opus triage + plan

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22 ~23:45*

Owner 22/11: «ma le notifiche mobile oggi funzionano?» — evidence gathered by the orchestrator (read-only):
- The owner's phone-facing `serve` (`~/assistant`, port 4001, started 21/11 16:56 by hand, relay ready `qbW3ackK`) logs the phone connecting repeatedly (`[daemon] device-open a3b1d932`, many times) but every unattended turn end is dropped: `[daemon] push-dropped empty turn_done with no registered device` (3× in `~/assistant/.tentacle/serve.log`). The rule is `packages/daemon/src/push-rules.ts:~352-361` (`options.registered()` empty).
- The push registration store `~/.config/tentacle/devices/push/` (serve's `storeDir`, `packages/cli/src/serve.ts:~344`; written by `SessionHost.registerPush`, `packages/daemon/src/session-host.ts:735`) is EMPTY, directory mtime **20/11 17:44**. On 20/11 several things landed: project pairing per `serve` (feat/project-pairing), iOS builds from detached refs (17:40 rebuild after the node:crypto bundle failure), `devices/registry.json` 13:33, `pairing/` 23:53.
- Owner confirms: iOS Settings → tentacle → Notifications are ENABLED.
- e2e cannot see it: flows `push-placeholder` and `22-notify-render` are quarantined (Maestro cannot see SpringBoard banners on the iOS 26 simulator).
- The relay server journal was NOT checked (ssh not permitted to the orchestrator).

Question: why does the app (connected as device `a3b1d932`) never complete `device/push_register` on this serve, and since when? App side: `apps/mobile/src/push-manager.ts` (`pushRegister` at :52/:85), `push-expo.ts` (`requestPermissionsAsync` :74, `getDevicePushTokenAsync` :109), `push-key.ts`. Candidates to falsify (cheapest first): the app never calls register (a gate/condition false — e.g. per-serve pairing changed the principal or the "which computer" bookkeeping); it calls and gets an error it swallows (MethodNotFound / push-store-failed / a principal mismatch); the token is never obtained (entitlement `aps-environment` missing in the builds since 20/11 — check `apps/mobile/app.json`, the build scripts' signing/entitlements, `push-access-group.ts`); the registration is written and later removed (`unregisterPush`, `session-host.ts:855` — who calls it, e.g. on pairing/adopt).

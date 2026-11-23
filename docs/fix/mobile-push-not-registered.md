# fix/mobile-push-not-registered — the phone never registers for push on the owner's serve

Type: fix · Size: M · Blast: cross-module (app push env + registrar; daemon audit lines; no wire/persisted-format change) · Suited: Opus triage + plan

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22 ~23:45*

Owner 22/11: «ma le notifiche mobile oggi funzionano?» — evidence gathered by the orchestrator (read-only):
- The owner's phone-facing `serve` (`~/assistant`, port 4001, started 21/11 16:56 by hand, relay ready `qbW3ackK`) logs the phone connecting repeatedly (`[daemon] device-open a3b1d932`, many times) but every unattended turn end is dropped: `[daemon] push-dropped empty turn_done with no registered device` (3× in `~/assistant/.tentacle/serve.log`). The rule is `packages/daemon/src/push-rules.ts:~352-361` (`options.registered()` empty).
- The push registration store `~/.config/tentacle/devices/push/` (serve's `storeDir`, `packages/cli/src/serve.ts:~344`; written by `SessionHost.registerPush`, `packages/daemon/src/session-host.ts:735`) is EMPTY, directory mtime **20/11 17:44**. On 20/11 several things landed: project pairing per `serve` (feat/project-pairing), iOS builds from detached refs (17:40 rebuild after the node:crypto bundle failure), `devices/registry.json` 13:33, `pairing/` 23:53.
- Owner confirms: iOS Settings → tentacle → Notifications are ENABLED.
- e2e cannot see it: flows `push-placeholder` and `22-notify-render` are quarantined (Maestro cannot see SpringBoard banners on the iOS 26 simulator).
- The relay server journal was NOT checked (ssh not permitted to the orchestrator).

Question: why does the app (connected as device `a3b1d932`) never complete `device/push_register` on this serve, and since when? App side: `apps/mobile/src/push-manager.ts` (`pushRegister` at :52/:85), `push-expo.ts` (`requestPermissionsAsync` :74, `getDevicePushTokenAsync` :109), `push-key.ts`. Candidates to falsify (cheapest first): the app never calls register (a gate/condition false — e.g. per-serve pairing changed the principal or the "which computer" bookkeeping); it calls and gets an error it swallows (MethodNotFound / push-store-failed / a principal mismatch); the token is never obtained (entitlement `aps-environment` missing in the builds since 20/11 — check `apps/mobile/app.json`, the build scripts' signing/entitlements, `push-access-group.ts`); the registration is written and later removed (`unregisterPush`, `session-host.ts:855` — who calls it, e.g. on pairing/adopt).

## Implementation

*— claude-opus-5-5 (triage + plan), 2026-11-22*

### Evidence (read-only, §1)

| # | Fact | Source |
|---|------|--------|
| E1 | `devices/push/` is empty, mtime 20/11 17:44. Since then the serve log shows dozens of `device-open a3b1d932` but **no write of any kind** reached the store: `writePushRegistration` is tmp + rename, so a success OR a failed write would bump the dir mtime. The app has sent NO `device/push_register` that reached `registerPush` since 20/11 17:44. | `ls -la ~/.config/tentacle/devices/push`; `~/assistant/.tentacle/serve.log` (starts 21/11; 3× `push-dropped … no registered device`, 0× `push-gone`) |
| E2 | Only three paths delete there: an APNs `gone` (`push-notifier.ts:311-315` → `serve.ts:307-309` `deletePushRegistration`), the phone's own toggle-off (`connection.ts:548-556` → `session-host.ts:855-862`), `devices reset` (`devices-cmd.ts:484`; ruled out: `identity.json` mtime 14/11). | `rg 'forgetPushRegistration\|clearPushRegistrations\|deletePushRegistration' packages` |
| E3 | The installed build is a **Release** archive (`.tentacle/tmp/mobile-ota/build.sh:7` `-configuration Release`; `archive.log`: `--dev false` ⇒ Metro inlines `process.env.NODE_ENV === "production"`) exported `method: debugging`, so it is signed **`aps-environment = development`** (sandbox tokens). | `codesign -d --entitlements - …/tentacle.xcarchive/…/tentacle.app` → `"aps-environment" => "development"`, `"get-task-allow" => true` (archive of 22/11 18:27); `export/DistributionSummary.plist:186-187` |
| E4 | The app declares the token's environment from the JS bundle mode, not from the signature: `env: pushEnvironmentOf(process.env.NODE_ENV)` → `"production"` for this build. | `apps/mobile/src/push-expo.ts:37-39,121` |
| E5 | The relay dials by that declared env (`api.push.apple.com` for `production`) and maps `400 BadDeviceToken` — what APNs answers for a sandbox token on the production host — to `gone`. | `apps/relay/src/apns.ts:55-58,228-262` |
| E6 | The phone dedupes ACROSS LAUNCHES on a Keychain fingerprint of `(token, env, key)`: once `on` was answered, every later connect is `skip: "same"`, silently (no state change → the row stays "Not checked yet"). A daemon-side delete is invisible to it, so it never re-registers. | `push-registration.ts:160-163,298-305,397-404`; `push-manager.ts:15-17` |
| E7 | Ruled out: the gate (device principal — `device-open` logs it; `connection.ts:537`); navigation (`PUSH.sync` still fires on `SessionsRoute` link-up, `App.tsx:1329-1331`, the only way into a session); missing entitlements (E3, and `keychain-access-groups` include `.push`); iOS permission (owner: enabled). | as cited |
| E8 | Old defect, not a 20/11 regression: `pushEnvironmentOf(process.env.NODE_ENV)`, `mode: "development"`, Release `build.sh` and `GONE_REASONS` all date from 15/11 (`c3867fc0`, `1b8da01c`, `build.sh` mtime 15/11). 20/11 17:44 is only the LAST register: the 17:36–17:43 rebuilds (`build-1735/1740.out`) → reinstall → plausibly a new token → hash changed → one register → first unattended push → `gone` → deleted. | `git log -S …`; `ls .tentacle/tmp/mobile-ota` |

Context candidates: *never calls register* — **survives, as the effect** (E1, E6), caused by the fingerprint; *calls and swallows an error* — **falsified** (the gate passes, E7; a `push-store-failed` would have bumped the mtime, E1); *no token / entitlement missing* — **falsified** (E3); *written then removed* — **survives** (E2: `gone` is the only live remover, and E3–E5 make it fire on every first push).

Repro: written to `.tentacle/tmp/mobile-push-not-registered/repro.ts` but **NOT executed** — running `bun` scripts and installing the worktree's `node_modules` were not permitted in this triage (`bun test` here fails on `Cannot find package 'zod'`). It is deterministic from E6: registrar syncs → fake daemon stores the token → delete it (`gone`) → a NEW registrar over the same Keychain map → 5× `sync` ⇒ expected `register calls 1, daemon has 0`. The first red test below is that repro, executable.

### Root cause

Two defects compose. **(1)** The app tells the relay its token is `production` because the bundle is Release, while the binary is signed with the sandbox `aps-environment` — APNs answers `BadDeviceToken`, the relay says `gone`, the daemon deletes the registration on the first push. **(2)** The phone's cross-launch fingerprint dedupe never notices a daemon-side delete, so it never registers again. (1) is why it breaks; (2) is why it stays broken.

### Remaining unknown + the one on-device check (owner)

Unverified: that the 20/11 17:44 delete was a `gone` (no serve log from that day; relay journal not readable here). Check, ≤ 2 min, nothing to install:
1. Phone, with the `~/assistant` serve running: Settings → **Notifications** row should read **"Not checked yet"** (= `skip "same"`, E6).
2. Toggle Notifications **off → on**. Expect the row to read **"On — this computer can send notifications"** and `~/.config/tentacle/devices/push/a3b1d9320694285b.json` to appear (`ls -la` only, do not open — it holds the token).
3. Background the app, let an unattended turn end. Expect in `~/assistant/.tentacle/serve.log`: **`push-gone a3b1d932`**, the file gone again, no banner. On the relay host: grep its journal for `BadDeviceToken`.
`push-gone` in step 3 confirms the root cause (and step 2 is the owner's workaround until the fix ships — it lasts only until the next push). A banner instead ⇒ (1) is wrong and only (2) holds (a one-off loss): tell the executor before it builds Fix A.

### Load-bearing assumption

The token's APNs environment is the RUNNING binary's provisioning-profile `aps-environment` (Apple's rule), and the app can read it at runtime. Verify first: `expo-application`'s `getIosPushNotificationServiceEnvironmentAsync()` (reads `embedded.mobileprovision`; `"development" | "production" | null`, null when no embedded profile — App Store/TestFlight, simulator). If the SDK-matched version lacks it, STOP and fix the plan (fallback: a small native read of `embedded.mobileprovision` in an existing local module).

Rejected: reading `expo-notifications`' `mode` from `Constants.expoConfig` (it IS embedded — `EXConstants.bundle/app.config` contains `"mode":"development"`): it is the *requested* entitlement, and an App Store export (`store-export.sh`, 22/11) re-signs to `production` while the config still says `development` — the same bug, mirrored.

### Preconditions (verified)

- The daemon write is idempotent and cheap: one atomic rename, no lock (`session-host.ts:730-753`), so re-registering once per launch costs one small file write.
- No protocol change: `env` is already on the wire (`DevicePushRegisterParams`), the relay already dials per env (E5). No `protocol.d/` note.
- `PushRegistration` (Keychain) keeps its shape; only its use for dedupe changes (persisted format untouched).

### Design

- **Fix A — env from the signature.** `push-expo.ts`: `env = pushEnvironmentOfAps(await apsEnvironment())`, the mapper in a pure React-free module: `"development" → "sandbox"`, `"production" → "production"`, `null → "production"` (no embedded profile on a device = store build; the simulator has no token anyway). `pushEnvironmentOf(NODE_ENV)` is deleted — it is the bug. A read error → `undefined` facts (nothing sent), never a guess.
- **Fix B — self-heal.** The registrar dedupes per *registrar lifetime* (process), not across launches: the first `sync` after launch registers whenever permission + facts exist, even if the Keychain hash matches; later syncs in the same process skip on `state.registeredHash === hash`. The Keychain record stays for the `off` debt (H2) and is still written on `on`. Any daemon-side loss (a `gone`, a hand-deleted file, a re-adoption) heals on the next launch; a reconnect storm still sends nothing.
- **Fix C — observability (daemon).** `registerPush` audits `push-registered <id8> <env>`. The `gone` line gains the relay's reason (`push-gone <id8> BadDeviceToken`) — **DEFERRED, see Design note C2**: the reason never leaves `relay-link.ts` (the plan's file list omitted it), so it is a wider change than this task's approved diff, and it is not needed to diagnose the bug (the `env` in `push-registered`, plus the relay host's own journal, already name it).

### Files (dependency order)

1. `apps/mobile/package.json` — add `expo-application` (SDK-matched, `expo install`). Native ⇒ a new build is needed anyway.
2. `apps/mobile/src/push-env.ts` (new, pure) — `pushEnvironmentOfAps`.
3. `apps/mobile/src/push-expo.ts:37-39,121` — use it; drop `pushEnvironmentOf`.
4. `apps/mobile/src/push-registration.ts:160-163` (`planPushRegistration`) — dedupe on the in-process `state.registeredHash`, not `last.hash`; `last` stays for the debt.
5. `apps/mobile/test/pairing-guards.test.ts:124-127` — fix the comment's assumption ("development build ⇒ sandbox" is false for a Release archive).
6. `packages/daemon/src/session-host.ts:735-753` (via its audit seam) and `packages/daemon/src/push-notifier.ts:311-315` — Fix C.
   - **Executed:** the `push-registered` half only (`session-host.ts`).
   - **Design note C2 — the `gone` reason is deferred (drift, discovered in
     Execution).** The plan assumed the relay's `push-result.reason` was
     available at `push-notifier.ts:416`; it is not. The reason is read in
     `relay-link.ts` (`entry.resolve(isPushDeliveryStatus(frame.status) ? …)`,
     ~:638) and DROPPED there: `RelayPushStatus` is a bare string union and
     `PushSink` is `(delivery) => Promise<string>`. Carrying it means shaping the
     resolved value through `RunningRelayLink.push` / `liveActivity`, the
     `pendingPushes`/`heldPushes` entries, `sendFrameOf`'s resolver and every
     audit caller — ~17 status assertions in `relay-link-push.test.ts` alone, a
     public-ish daemon seam, for a diagnostic that does not decide the bug (the
     `env` now logged by `push-registered` plus the relay host's journal already
     name `BadDeviceToken`). Not done here: it is outside the approved diff and
     belongs to its own task.
7. `changelog.d/mobile-push-not-registered.fixed.md` — user-visible.

### Failure modes

- **Store/TestFlight build** (`null` → production) ✓; **debugging export** (development → sandbox) ✓; **simulator** (no token → `undefined`, unchanged).
- **Token truly dead** (`gone` correct): deleted daemon-side; the next launch re-registers the same dead token → one more `gone` per launch. Bounded (per launch, not per connect); iOS issues a new token on reinstall. Accepted, noted as debt.
- **Toggle off**: unchanged — `state.enabled=false` ⇒ no facts ⇒ no register; the debt (H2) still drains first.
- **Daemon too old / relay without push**: unchanged (`daemon-too-old` terminal per session; `relay-*` never wrote a fingerprint).
- **Two computers**: registrars are per computer (`push-manager.ts:242-258`), so the per-process dedupe is too.
- **Concurrent link-ups at launch**: `serialise` (`push-registration.ts:284-288`) keeps it to one register.

### Tests (red first, §9)

- `apps/mobile/test/push-registration.test.ts` — **"a daemon-side delete heals on the next launch"**: registrar A syncs (1 register) → the fake daemon forgets → registrar B over the SAME memory syncs 3× ⇒ exactly 1 more register. **Red today** (0: `skip "same"`). Plus: B's 2nd/3rd sync send nothing (storm guard kept); a toggle-off debt still drains before the register.
- `apps/mobile/test/push-env.test.ts` — the mapping table; and a source guard that `push-expo.ts` no longer derives `env` from `process.env.NODE_ENV` (like `push-wiring-guards.test.ts`). **Red today** (module missing / scan finds `NODE_ENV`).
- `packages/daemon/test/push-notifier.test.ts` (next to :490) — `push-gone <id8> BadDeviceToken`; a `session-host` test for `push-registered`. Red today (no such lines).
  - **Executed:** `packages/daemon/test/push-registered-audit.test.ts` (new file — a `SessionHost` unit test, cheaper and more direct than driving the whole hook harness) pins `push-registered <id8> <env>`, red first. The `push-gone … <reason>` test is deferred with note C2.
- Non-vacuity: revert the `planPushRegistration` change ⇒ the heal test goes red; map `development → production` ⇒ the env table goes red.

### Validation (device)

A new `build.sh` archive on the owner's phone: launch → `devices/push/a3b1d9320694285b.json` appears with no toggle; `serve.log` shows `push-registered a3b1d932 sandbox`; background the app, end an unattended turn ⇒ a banner arrives, no `push-gone`, the file survives. Then delete the file by hand and relaunch ⇒ it reappears (Fix B). The simulator cannot prove Fix A (no APNs token; `push-placeholder` is quarantined) — only the device run does.

## Execution

*— claude-opus-5-5 (executor), 2026-11-23*

**Load-bearing check — PASSED (before any edit).** `expo-application@58.1.2` is
the version Expo's own `bundledNativeModules.json` pins for this SDK
(`apps/mobile/node_modules/expo/bundledNativeModules.json:23` → `~58.1.2`), and
it ships `getIosPushNotificationServiceEnvironmentAsync()`
(`package/build/Application.js:144`) → native
`ApplicationModule.swift:84` → `EXProvisioningProfile.m`'s
`notificationServiceEnvironment`, which reads `Entitlements.aps-environment` out
of `embedded.mobileprovision` and answers `"development" | "production" | null`.
No fallback native module needed. Repo-wide `rg expo-application apps/mobile`
had exactly one pre-existing hit, a comment in `App.tsx`.

**Repro (red → green).** `.tentacle/tmp/mobile-push-not-registered/repro-fix-b.ts`
(the plan's repro, written but never run in triage), on the unfixed tree:

```
launch 1: registers=1 daemonHas=true
launch 2: registers=1 daemonHas=false
launch 3: registers=1 daemonHas=false
Fix B: ... the daemon holds the registration? false (registers=1) — expected true
Fix A: push-expo derives env from NODE_ENV? true — expected false
```

The plan's `.tentacle/tmp/mobile-push-not-registered/` is outside this session's
writable workspace (the worktree is the root), so it lives at
`<worktree>/.tentacle/tmp/mobile-push-not-registered/` — same gitignored
convention, same slug. After the fixes: `registers=3 daemonHas=true` on every
launch, `NODE_ENV` false.

**As built, in dependency order.**

1. `apps/mobile/package.json` — `expo-application: ~58.1.2` (+ `bun.lock`).
2. `apps/mobile/src/push-env.ts` (new, pure) — `pushEnvironmentOfAps`:
   `development → sandbox`, `production → production`, `null → production`.
   The `null` reasoning is Apple's, and is in the file: no
   `embedded.mobileprovision` = App Store/TestFlight (re-signed at the store,
   production tokens); the simulator, the other `null`, has no token at all.
3. `apps/mobile/src/push-expo.ts` — `pushEnvironmentOf` DELETED;
   `signedPushEnvironment()` wraps the getter and returns `undefined` on a throw
   (a read that fails sends nothing, never a guess). `readPushFacts` reads the
   env **before** the token and returns `undefined` when it is unknown, so a
   build that cannot state its environment never spends a token read.
4. `apps/mobile/src/push-registration.ts` — `planPushRegistration` dedupes on
   `state.registeredHash` (in-process) instead of `last.hash` (Keychain). `last`
   keeps its one remaining job, the H2 toggle-off debt; its docblock says so.
   `PushPlanInput` keeps `last` in the destructure-free signature, and the
   module header's load-bearing-property list is updated (per-process dedupe).
5. `apps/mobile/test/pairing-guards.test.ts` — the comment asserting
   "development build ⇒ sandbox" (false for a Release archive) replaced with the
   signature rule.
6. `packages/daemon/src/session-host.ts` — `registerPush` audits
   `push-registered <id8> <env>` after a successful write (never a token, never a
   key). `options.onAudit` already reaches `serve.log` via `serve.ts:751` →
   `main.ts:1193`, so no wiring change was needed.
7. `changelog.d/mobile-push-not-registered.fixed.md`.

**Drift from the Implementation — one, and deliberately not forced.**

*Fix C's second half (`push-gone <id8> <reason>`) is NOT implemented; the plan
is corrected rather than the code.* The plan put that change at
`push-notifier.ts:311-315` "when `push-result` has one", assuming the relay's
reason reaches the notifier. It does not: the reason is read at
`relay-link.ts:638` (`isPushDeliveryStatus(frame.status) ? frame.status : …`) and
**dropped there** — `RelayPushStatus` (`relay-link.ts:225`) is a bare union and
`PushSink` (`push-notifier.ts:75`) is `(delivery) => Promise<string>`. Carrying it
means shaping the resolved value through `RunningRelayLink.push`/`liveActivity`,
the `pendingPushes` and `heldPushes` entries, `sendFrameOf`'s resolver and every
audit caller — ~17 status assertions in `relay-link-push.test.ts` alone — on a
daemon seam the plan's file list never named. It also does not decide the bug:
the `env` now in `push-registered`, plus the relay host's own journal, already
name `BadDeviceToken`. Per the brief ("if a step contradicts the code, STOP that
step and fix the plan"), Design note **C2** and the Files/Tests entries were
updated to record it as deferred debt. Nothing else drifted.

Two pre-existing tests pinned root cause 2 as *desired* behaviour and were
inverted, not deleted: `push-manager.test.ts` "the fingerprint survives a NEW
manager" (now "a relaunch REGISTERS again") and `push-registration.test.ts` "the
SAME fingerprint already accepted → skip `same`" (now "…registered in THIS run"),
plus `push-expo-rules.test.ts`'s `NODE_ENV` guard. `push-expo-rules.test.ts`
lost its local `environmentOf` transcription (and its `PushEnvironment` import)
because the rule moved to the pure module with its own table.

**Tests — red first, all listed failure modes.**

| Test | Red evidence (buggy tree) |
|---|---|
| `push-registration.test.ts` "a daemon-side delete heals on the next launch" | `Expected: 1, Received: 0` — the launch skipped `same` |
| "a toggle-off DEBT still drains before the launch's register" | new; debt + heal in ONE connect (unregisters 1, registers 1) |
| "a fingerprint only the KEYCHAIN knows does not skip" | `skip same` → `register` |
| `push-env.test.ts` mapping table + 2 source guards | `Cannot find module '../src/push-env.ts'` on the old tree; with the module added the guards failed on `process.env.NODE_ENV` (present) and `expo-application` (absent) — red on the property, not just an import |
| `push-registered-audit.test.ts` `push-registered 01234567 sandbox` | `Received: []` |
| `push-manager.test.ts` relaunch | `Expected: 1, Received: 2` under the fix (the inverse of the old pin) |

Failure modes covered: the store/`null`→production path (mapping table);
`development`→sandbox; a failed env read → no facts, nothing sent (the
`undefined` branch); a dead token (bounded, per launch — the heal test asserts
exactly ONE register per launch against three syncs); toggle-off unchanged (the
debt test, and `push-registration`'s off-with-no-link debt); `daemon-too-old`
still terminal (existing test, still green); two computers (per-computer
registrars, existing test); concurrent link-ups (`serialise`, existing test).
A daemon with no audit sink still registers and never throws (`push-registered-audit`
test 2).

**Mutations (non-vacuity, run and reverted).**

1. `planPushRegistration`: `state.registeredHash === hash` → `input.last?.hash === hash`
   ⇒ 2 fail ("a daemon-side delete heals", "a fingerprint only the KEYCHAIN knows
   does not skip").
2. `push-env.ts`: `apsEnvironment === "development" ? "sandbox" : "production"` →
   `return "production"` ⇒ 1 fail (the mapping table).
3. `session-host.ts`: audit line removed ⇒ 1 fail (`push-registered`).
4. `planPushRegistration`: dedupe disabled (`if (true)`) ⇒ 26 fail (the
   reconnect-storm guard and every off/on path that relies on it).

Sources restored after each (`grep -c` confirmed the original line back).

**Gate.** Not run here by instruction (the orchestrator's script owns the full
`bun run check`). Run instead, per §4's narrow rules: `bunx tsc --noEmit` (root,
clean), `bunx tsc -p apps/mobile --noEmit` (clean), `bunx biome check` on all 11
changed/added files (clean, no fixes), and the 10 touched/covering test files
(144 pass, 0 fail) plus `scripts/test/changelog{,-guard}.test.ts` (21 pass). No
protocol schema changed (`env` was already on the wire), so
`protocol.json` is untouched and no `protocol.d/` note is needed.

**Unverified here (one line).** The device run in *Validation*: no simulator can
prove Fix A (no APNs token; `push-placeholder` is quarantined), and the
`gone`-reason audit remains deferred (note C2). Verify Fix A on the owner's
phone with one `build.sh` archive — `serve.log` must show
`push-registered a3b1d932 sandbox`, and a banner must arrive with no `push-gone`.

## Review

*— claude-opus-5-5, 2026-11-23* (fresh context; SAME model as the executor and planner — shared blind spots possible)

**Verdict: APPROVE** — no HIGH/MEDIUM findings. Scope: `git diff main...HEAD` only.

**Gate (narrow, as instructed):** the 6 touched test files → 82 pass / 0 fail; `bun run lint` clean (2313 files); `bun run typecheck` clean (root + mobile + relay). Full `bun test` not run here (orchestrator's gate).

**Mutations (run, reverted, `git status --porcelain` empty after):**
1. `planPushRegistration` dedupe `state.registeredHash` → `input.last?.hash` ⇒ 3 fail (heal-on-launch, Keychain-only fingerprint, manager relaunch).
2. `pushEnvironmentOfAps(null)` → `sandbox` ⇒ 1 fail (store-build row).
3. `push-registered` audit hard-coded `production` instead of `params.env` ⇒ 1 fail.

**Attacks tried:**
- *Toggle off → on in the same process skips `same` and never re-registers?* No: the off path `set({ enabled: false, phase: "off" })` (`push-registration.ts:466`) drops `registeredHash`, so the next on registers. Holds.
- *Is the in-process hash secretly seeded from the Keychain (vacuous fix)?* No: `push-manager.ts:239` initial state carries no `registeredHash`; it is set only on an `on` answer (`push-registration.ts:322`). Holds.
- *`expo-application` uses `requireNativeModule` (throws at import), so a JS bundle on a binary without the native module would crash at load, outside the `try` in `signedPushEnvironment`.* Not reachable: no `expo-updates`/OTA in `apps/mobile` — JS always ships with its native build. Note only.
- *§7 trust/persistence:* the audit line carries only id8 + env (no token/key); pod/worker daemons throw `MethodNotFound` before it; no wire/on-disk format change, so no `protocol.d/` note needed. Holds.
- *Reconnect storm / dead token:* one register per launch (heal test asserts 1 across 3 syncs); a truly dead token costs one `gone` per launch — bounded, recorded as debt. Accepted.

**What does not hold / is unverified:** Fix A can only be proven on a device (no APNs token on the simulator); the `push-gone <reason>` half of Fix C is deferred (note C2), and that deferral is justified (`relay-link.ts` drops the reason). A loss *within* one long-lived app process heals only at the next launch — by design.

**Executor behaviour:** stuck to the plan, stopped and fixed the plan (C2) instead of forcing the code, inverted the two tests that pinned the bug as intended behaviour (it did not delete them), and recorded red evidence and its mutations honestly.

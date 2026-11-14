# feat/mobile-lock — Face ID app lock, app-switcher privacy, log export (mobile task 14)

> **Status:** implementation (plan written, **not approved** — see Owner questions)
> **Branch:** `feat/mobile-lock`
> **Size:** M (re-sized from the eval's S: three new native deps, a Settings screen, a blocking simulator Step 0, four Maestro flows) · **Blast:** contained (app only; no protocol, daemon, client or persistence-format change — but a fail-open lock is a security bug, so Review red-teams the lock table) · **Suited:** DeepSeek executes; one fresh-context Opus Review round
> **Changelog:** `changelog.d/mobile-lock.added.md` — one bullet: Face ID / passcode app lock (immediately / 5 min / 1 h / never), app-switcher privacy cover, Settings → Export logs.

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 14 (`docs/eval/mobile-app.md:330`, table "Face ID lock, switcher
privacy, log export"). It serves three owner decisions:

- **Decision 14** (`mobile-app.md:207-213`): the lock is ON by default;
  reopening after > 5 min in background asks Face ID (setting: immediately /
  5 min / 1 h / never); inside the unlocked app approving asks nothing more;
  Approve from a notification / Live Activity always asks Face ID (that is
  task 17/18's, not this task's); while locked, content is hidden in the app
  switcher snapshot too; fallback to the device passcode when Face ID is
  unavailable or fails.
- **Decision 19** (`mobile-app.md:275-281`): no third-party telemetry.
  Settings → "Export logs" writes a local file (connection state, errors,
  timings — **never conversation content or keys**) that the user chooses to
  share.
- **Decision 20** (`mobile-app.md:283-300`): pure logic under `bun test`;
  Maestro E2E on the simulator mandatory before merge; a short real-iPhone
  checklist (Face ID explicitly named) before every TestFlight build.
- **Mockups approved 2026-11-01** (`mobile-app.md:345`): one of the 10 screens
  is the Face ID lock. Native iOS look (decision 13): the Settings screen is an
  inset grouped list, not custom controls.

What exists on `main` (5f90188) today:

- No lock, no switcher cover, no Settings screen, no log buffer. The app's only
  logging is `console.log` (`apps/mobile/src/connection.ts:120`), fed by the
  socket diagnostics (`:69-85`) and the client's `onError` (`:137-139`).
- `AppState` is already wired twice in `App.tsx`: the foreground gate
  (`App.tsx:275-286` → `foreground-gate.ts:111-127`, suspend on any non-active
  state, resume on `active`) and the session list refresh (`App.tsx:219-226`).
- The app has no on-disk storage yet (`mobile-compose.md:176-180`, P10); 13c
  adds `expo-file-system` (`mobile-compose.md:339`).
- Phone-side keys: the device key lives in the Keychain, this-device-only
  (`device-pairing.md:23`); the phone side of pairing is task 11b
  (`feat/mobile-pairing-screen`, plan not yet written), not on `main`.

**Repro** (capability missing; 2026-11-14, worktree at `5f90188`): a search of
`apps/mobile` (excluding `node_modules`) for `expo-local-authentication`,
`expo-screen-capture`, `expo-secure-store`, `Share.share`,
`NSFaceIDUsageDescription`, `console.log`:

```
apps/mobile/src/connection.ts:120:  const log = (line: string) => console.log(`[tentacle] ${line}`);
apps/mobile/e2e/run.ts:184 / :226 / :239 / :272 / :299 / :305   (harness output only)
```

No lock module, no Face ID usage string, no share path; the app's one log line
goes to the console and is lost. `app.json` has no `NSFaceIDUsageDescription`
(read in full: only `NSLocalNetworkUsageDescription` and ATS). The executor
re-runs this search on current `main` before any edit.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**The lock never fails open: every path where the app cannot prove "recently
unlocked" shows the lock, and no app content (pixels, switcher snapshot,
accessibility tree) is visible while it does.** Three sub-facts carry it, each
proven in Step 0 (empirically — they are iOS/RN runtime behaviour, not code we
can cite) before any lock code is written:

1. **Elapsed background time is measurable without trusting a late
   `background` event.** RN delivers `AppState` changes over the bridge; if JS
   only runs again at resume, `background` and `active` arrive together and a
   timestamp taken on `background` reads ~0 s → no lock (fail-open). Design
   answer: a heartbeat `lastSeenActive` (below) — Step 0 confirms JS timers do
   not run while suspended, which is what makes the heartbeat correct.
2. **The switcher snapshot is taken after the cover is up.** A JS overlay
   rendered on `inactive` races the snapshot; a native cover does not. Step 0
   proves the chosen mechanism by inspecting the snapshot.
3. **The lock covers native presentations** (a `formSheet` from the native
   stack, an `Alert`, the share sheet) that live above the RN root view. Step 0
   proves the lock's container (RN `Modal`, `presentationStyle="fullScreen"`,
   no animation) is presented above them, or the design dismisses them first.

### Preconditions

- **P1 — app-only change, no protocol.** Nothing here crosses the wire; no
  `protocol.d/` note. The links keep their foreground-gate behaviour unchanged
  (`foreground-gate.ts:111-127`): the lock does not suspend or resume links.
- **P2 — one `AppState` truth per concern.** The gate's wiring
  (`App.tsx:275-286`) stays as is; the lock adds its own listener that only
  feeds the pure module. Two listeners on one event is how `App.tsx` already
  works (`:219-226`).
- **P3 — the WS URL carries the token** as `?token=` when it cannot send a
  header (`packages/client/src/ws-channel.ts:98-104`), i.e. on iOS. Any URL
  that reaches a log line is a key leak unless its query is dropped — the
  export's main hazard.
- **P4 — daemon-supplied text is untrusted for logs**: a ws close `reason`
  (`connection.ts:77-79`) and a client error `message` (`:137-138`) can carry
  daemon text, which may echo a title, a path or a prompt fragment.
- **P5 — Maestro sees testIDs only, iOS 26.5 only**
  (`mobile-session-view.md:170-174`, P9). Hooks (`apps/mobile/e2e/hooks.ts`,
  `runScript`) drive daemon/simulator-side actions. Every flow runs with
  `clearState: true` (`apps/mobile/e2e/README.md`, step 8).
- **P6 — the lock is a UI gate.** Keys stay where 11b puts them (Keychain,
  this-device-only, `device-pairing.md:23`); this task does not re-protect
  them (Owner Q4). Approve-from-notification's own Face ID is task 17's.
- **P7 — logic in pure modules** (AGENTS §7): the lock's decisions, the
  log's redaction and rotation are React-free and unit-tested; components only
  render.

### Design

**D1 — `app-lock.ts` (pure): the lock state machine.** Inputs, all with an
injected `now`:

| event | effect |
|---|---|
| `launch(setting \| "loading")` | `locked` unless setting is `never` (Owner Q1); while the setting is still `loading`, the view is **covered** (fail-closed: the first frame never shows content) |
| `tick(now)` (1 s interval while JS runs) | `lastSeenActive = now` while state is `active` |
| `appState("inactive")` | no timer change (Control Center, a call banner, **the Face ID prompt itself** all give `inactive → active`) |
| `appState("background")` | `immediately` → lock now; else mark `wentBackground = true` |
| `appState("active")` | if `wentBackground` and (`now − lastSeenActive > threshold` **or** `now < lastSeenActive`) → lock; clear the mark. Strictly greater: exactly 5:00 does not lock |
| `authResult(success)` | unlock; `lastSeenActive = now` |
| `authResult(cancel \| fail \| lockout \| not_interactive)` | stay locked; show the Unlock button; **no automatic re-prompt** (prevents the prompt → `inactive` → `active` → prompt loop) |
| `capability(none)` (no passcode, no biometrics) | cannot lock → unlocked + a persistent notice (Owner Q5) |
| `setSetting(weaker)` | requires a successful auth first (Owner Q6); stronger needs none |

Output view-model: `{ cover: "none" | "lock", prompt: boolean, notice? }`.
`prompt` is true once per lock episode, only when the app is `active`
(iOS fails an evaluation started while not active). The heartbeat closes the
late-event fail-open path: `lastSeenActive` stops advancing when iOS suspends
JS, so elapsed time is measured from the suspension, whatever order the
events arrive in. A clock moved backwards locks (fail-closed); forwards locks
(harmless).

**D2 — `lock-auth.ts` (adapter, thin):** `expo-local-authentication`
`authenticateAsync({ promptMessage: "Unlock tentacle", disableDeviceFallback:
false })` = iOS `deviceOwnerAuthentication` (Face ID, then passcode — decision
14's fallback, no app code). Maps its error strings onto D1's result kinds;
`getEnrolledLevelAsync` → `capability`. Re-enrolment ("Face ID changed") needs
no handling: with the passcode fallback, whoever can enrol a face can already
unlock (failure mode F4).

**D3 — `lock-settings-store.ts`:** the setting as a versioned value
(`{v:1, delay:"immediately"|"5m"|"1h"|"never"}`) behind an injected port; the
adapter is `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Unreadable,
missing, or an unknown `v` → default `5m`, **never** `never`; an unknown `v`
is left untouched on disk (the repo's versioned-record discipline).

**D4 — switcher cover.** Step 0 picks between (a) `expo-screen-capture`
`enableAppSwitcherProtectionAsync` (stock, a blur — verify it exists in the
SDK 58 version and that the snapshot is unreadable at max intensity) and
(b) a ~40-line local Expo module that adds an opaque branded view on
`sceneWillResignActive` and removes it on `didBecomeActive` (Owner Q3). It is
enabled whenever the setting is not `never` (Owner Q2). A JS overlay on
`inactive` is rejected (races the snapshot, load-bearing fact 2).

**D5 — `LockGate.tsx` (component, renders only):** wraps the
`NavigationContainer` in `App.tsx`. While `cover === "lock"`: the content tree
gets `accessibilityElementsHidden` + `importantForAccessibility=
"no-hide-descendants"` + `pointerEvents="none"` (VoiceOver and Maestro cannot
read it), and the lock screen (mockup: mascot, "tentacle is locked", Unlock
button; `testID="lock-screen"`, `"lock-unlock"`, `"lock-notice"`) renders in a
fullScreen `Modal` above everything. The navigator stays mounted (no lost
navigation or draft state). Links are not touched: they resume on `active` as
today, so content is fresh behind Face ID.

**D6 — Settings screen** (`SettingsScreen.tsx`, a native inset grouped list,
`testID="settings"`): "App lock" with four rows (`testID="lock-delay-<v>"`),
a notice row when D1 says the device cannot lock, "Export logs"
(`testID="export-logs"`). Reached from a gear in the Computers header
(`testID="open-settings"`), route `Settings` in `routes.ts`.

**D7 — `app-log.ts` (pure): structured, redacted at write time.** Entries are
`{t, level, kind, fields}` with `kind` from a closed union (`ws-open`,
`ws-close`, `ws-error`, `link-status`, `dial`, `gate-suspend`,
`gate-resume`, `client-error`, `lock`, `unlock`, `auth-fail`, `app-state`,
`timing`) and `fields` limited to numbers, booleans and short enums. The one
free-text field (`detail`, for an error message or close reason) passes
`redact()`: URLs reduced to `scheme://host:port` (no userinfo / path / query /
fragment), `Bearer …` and `token=…` removed, any run of ≥ 20 base64/hex/
base64url characters → `[redacted]`, capped at 160 chars. Never logged:
session titles, prompts, transcript text, computer or device names, paths;
session ids only as their first 8 characters (Owner Q8). Redaction happens
before an entry exists, so a secret never reaches memory-for-export or disk.
Storage: a bounded ring (Owner Q7: also a rotating 2 × 256 KB file,
backup-excluded, versioned header line). Export = a header (app version,
build, iOS version, device model, export time — no names) + the entries as
text, written to `tentacle-logs-<UTC stamp>.txt` in the caches dir and handed
to RN's `Share.share({ url })`; the file is deleted after the share sheet
closes. `connection.ts`'s `log` (`:120`) becomes typed calls into this sink;
`console.log` stays only under `__DEV__`.

**D8 — order of wiring in `App.tsx`:** one `<LockGate>` wrapper, one
`Stack.Screen name="Settings"`, the log sink passed to `openComputer`. Nothing
else in `App.tsx` changes (it is the file every parallel mobile branch
touches).

### Files

Step 0 first; then in dependency order.

| File | Change |
|---|---|
| `apps/mobile/package.json`, `bun.lock` | exact pins via `npx expo install`: `expo-local-authentication`, `expo-secure-store`, `expo-screen-capture` (or none, if D4(b)); `expo-file-system` from 13c, else added here |
| `apps/mobile/app.json` | `NSFaceIDUsageDescription` (via the local-authentication plugin's `faceIDPermission`); the D4(b) module's registration if chosen |
| `apps/mobile/src/app-lock.ts` (new) | D1 |
| `apps/mobile/src/lock-settings-store.ts` (new) | D3 (port + versioned codec) |
| `apps/mobile/src/app-log.ts` (new) | D7 (entries, `redact`, ring, rotation, export text) |
| `apps/mobile/src/lock-auth.ts`, `lock-settings-expo.ts`, `app-log-fs.ts` (new) | thin adapters over the expo modules / file system |
| `apps/mobile/src/connection.ts` | `log` → the injected `AppLog` sink (typed kinds; no URL, `reason` through `redact`) |
| `apps/mobile/src/routes.ts` | `Settings` route |
| `apps/mobile/src/screens/LockGate.tsx`, `SettingsScreen.tsx` (new) | D5, D6 |
| `apps/mobile/src/screens/ComputersScreen.tsx` | header gear (`open-settings`) |
| `apps/mobile/App.tsx` | D8 only |
| `apps/mobile/modules/privacy-cover/*` (new, only if D4(b)) | the native cover |
| `apps/mobile/test/app-lock.test.ts`, `lock-settings-store.test.ts`, `app-log.test.ts` (new); `connection.test.ts`, `routes.test.ts` | below |
| `apps/mobile/e2e/hooks.ts`, `run.ts` | hooks `faceid-enroll`, `faceid-match`, `faceid-nomatch`, `log-file` (reads the exported file from the app container); enrol once per boot |
| `apps/mobile/e2e/flows/_unlock.yaml` (new), `01…05-*.yaml` | the unlock sub-flow after every `launchApp` (the shipped default locks at cold start — no test-only branch in app code) |
| `apps/mobile/e2e/flows/06…09-*.yaml` (new) | below |
| `apps/mobile/e2e/README.md` | the new hooks and flows |
| `changelog.d/mobile-lock.added.md` | the fragment |

**Step 0 (blocking, two-strike rule; Release build on the iOS 26.5
simulator; scratch in `.tentacle/tmp/mobile-lock/`; results pasted in
Execution):**

1. `npx expo install` the three modules; confirm in the installed `.d.ts`
   that `enableAppSwitcherProtectionAsync` exists.
2. Face ID on the simulator from a script: `xcrun simctl spawn <udid>
   notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` + `-p` (enrol),
   `-p com.apple.BiometricKit_Sim.pearl.match` / `.nomatch` while the prompt
   is up → `authenticateAsync` resolves success / failure. If this cannot be
   scripted in two tries, the Face ID flows become real-device checklist items
   and Execution says so.
3. Record the `AppState` sequence for: Face ID prompt, Control Center, home →
   back, app switcher → back. Confirm a 1 s `setInterval` does not fire while
   backgrounded (fact 1).
4. Snapshot check (fact 2): seeded session list on screen, cover enabled,
   `pressKey: home`; read the snapshot from the app container
   (`Library/SplashBoard/Snapshots/`) or screenshot the switcher; content must
   be unreadable. Two failed tries at scripting it → real-device check by hand,
   said in Execution; the cover choice (Q3) is then made on the device.
5. Fact 3: open a native `formSheet` and an `Alert`, background with
   `immediately`, return: the lock is above both. If not: the lock dismisses
   presented controllers first (record what is lost) — STOP and report before
   choosing.

### Failure modes

| # | Case | Behaviour / convergence |
|---|---|---|
| F1 | **Face ID unavailable** (no enrolment, permission denied, sensor covered) | `deviceOwnerAuthentication` falls back to the passcode (decision 14); D1 sees only success/fail |
| F2 | **No passcode at all** (`getEnrolledLevelAsync` = none) | cannot lock: unlocked + `lock-notice` in Settings and once on launch (Q5); the switcher cover still runs |
| F3 | **Lockout** after repeated failures | iOS demands the passcode; D1 stays locked with the Unlock button |
| F4 | **Face ID changed** (face added / reset) | needs the passcode to do, which unlocks anyway: no extra handling. Not a key-binding event because keys are not bound to biometry (Q4) |
| F5 | **Auth cancelled / fails** | stays locked, Unlock button, no auto re-prompt (no loop) |
| F6 | **Prompt makes the app `inactive`** | `inactive` never starts the timer; `active` after it does not re-lock |
| F7 | **`background` delivered late** (JS suspended) | heartbeat: elapsed from the last tick, not from the event → locks |
| F8 | **Clock moved back / forward** | `now < lastSeenActive` → lock; forward → lock (fail-closed) |
| F9 | **Exactly at the threshold** | 5:00 does not lock, 5:00.001 does (strict `>`), tested |
| F10 | **Cold start / iOS killed the app** | locked (Q1); setting still loading → covered, never content |
| F11 | **Setting unreadable / unknown version** | default `5m`, never `never`; unknown version left untouched |
| F12 | **Screenshot in switcher** | native cover on resign-active (D4), proven in Step 0 + real device |
| F13 | **Native sheet / Alert open when locking** | fullScreen `Modal` above it (Step 0 fact 3) |
| F14 | **VoiceOver / Maestro reading under the lock** | content tree hidden from accessibility while locked; flow 06 asserts it |
| F15 | **Permission ask raised while locked** | sheet under the lock, untappable; after unlock, 12c's age guard must count from unlock (coordination note to 12c/13d: the guard takes a `visibleSince`) |
| F16 | **Export leaking secrets** | redaction at write (D7): URL query, bearer, long base64/hex runs, names, titles, prompts never logged; canary unit test + E2E file check (flow 09) |
| F17 | **Export with an empty log** | header-only file, still shareable |
| F18 | **Share sheet cancelled** | temp file deleted; the ring is untouched |
| F19 | **Log file corrupt / unknown version** | ignored for export, rotated away; never crashes launch |
| F20 | **Notification "Open" while locked** (task 17) | out of scope; D1 exposes `isLocked` so task 17 routes after unlock |

### Tests

Pure (`bun test`, in `bun run check`):

- `app-lock.test.ts` — one table of event sequences → expected view: cold
  start per setting; `loading` covered; inactive-only (prompt, Control
  Center) no lock; background < / = / > threshold per delay; `immediately`;
  late events (ticks stop, then `background`+`active` together, 10 min later →
  locked: **the F7 red test**); clock back/forward; one prompt per episode;
  cancel → no re-prompt; capability none; weakening requires auth, strengthening
  does not. Non-vacuity: mutate the elapsed source to the `background`
  timestamp → F7 must fail; mutate `>` to `>=` → F9 must fail.
- `lock-settings-store.test.ts` — round-trip; missing / garbage / `v:2` →
  `5m` and the bytes untouched.
- `app-log.test.ts` — **canaries**: a URL with `?token=CANARYTOKEN…`,
  `Bearer CANARY…`, a 32-byte hex and base64url key, an error message carrying
  a prompt `CANARY-PROMPT` and a title `CANARY-TITLE`, a computer name; none
  survives into the export text. Non-vacuity: replace `redact` with identity →
  the test fails. Ring bound, rotation at 256 KB, header fields, unknown file
  version ignored.
- `connection.test.ts` — the socket diagnostics reach the injected sink as
  typed entries; the dialled URL with `?token=` never appears.
- `routes.test.ts` — the `Settings` route.

Maestro (`bun run e2e:mobile`, iOS 26.5, mandatory before merge):

- `_unlock.yaml` (sub-flow): `lock-screen` visible, content ids not visible →
  hook `faceid-match` → `lock-screen` gone. Added after every `launchApp` in
  01–05.
- `06-lock-cold-start` — lock shown at launch, `computers-list` not visible
  under it (F14), match → list.
- `07-lock-nomatch` — `faceid-nomatch` → still locked, `lock-unlock` visible,
  no new prompt; tap Unlock + match → unlocked.
- `08-lock-immediately` — Settings → `lock-delay-immediately`; `pressKey:
  home`; `launchApp` (no clearState) → locked; match → back where it was.
- `09-export-logs` — open a session list (titles Alpha/Bravo/Charlie, the
  `HOLD` prompt seeded), Settings → `export-logs`; hook `log-file` reads the
  file and asserts it contains `ws-open` and does **not** contain the harness
  token, `Alpha`/`Bravo`/`Charlie`, the HOLD prompt text, or the computer name.

Real iPhone only (added to decision 20's checklist): passcode fallback with
Face ID denied in Settings; lockout → passcode; the switcher snapshot on
hardware (and with the 5-minute delay: background 6 min, return → locked);
Face ID re-enrolment; share to Files and Mail; VoiceOver cannot read under the
lock.

### Owner questions

1. **Cold start locks** whenever the setting is not `never` (iOS kills
   backgrounded apps often, so this may ask Face ID after 30 s away) — or
   persist the background time and apply the delay across launches?
   **Rec: lock on cold start** (fail-closed; Face ID is ~1 s).
2. **When the switcher cover applies:** whenever the lock is not `never`, or
   always, or literally "only while locked" (the snapshot taken at background
   would then show content for the whole 5-min window)? **Rec: whenever the
   lock is not `never`.**
3. **Cover look:** the stock `expo-screen-capture` blur (no native code of
   ours) if Step 0 shows the snapshot unreadable, else our own opaque branded
   cover (a small local Swift module)? **Rec: stock blur first, own module
   only if Step 0 or the device shows readable content.**
4. **The lock is a UI gate, not key-bound:** keys stay Keychain
   this-device-only without a user-presence flag (one would prompt on every
   foreground redial and block task 17's background NSE). **Rec: UI gate**;
   say so plainly in the privacy text.
5. **Device without a passcode:** run unlocked with a notice, or refuse to
   open? **Rec: run unlocked + notice in Settings and once on launch.**
6. **Weakening the lock** (a longer delay or `never`) asks Face ID first?
   **Rec: yes** — someone holding an unlocked phone cannot switch it off for
   later.
7. **Log storage:** a rotating on-disk file (2 × 256 KB, backup-excluded,
   redacted before write) or memory only (empty after iOS kills the app)?
   **Rec: on-disk** — "it failed this morning" is the common report.
8. **What the export may name:** host:port of addresses yes; computer/device
   names, titles, paths no; session ids as 8-char prefixes. **Rec: as stated.**
9. **Size and slot:** M, one branch, started after 12c and 13c merge (both
   touch `App.tsx`; 13c owns `package.json`/`bun.lock`/`expo-file-system`).
   **Rec: yes**; no split (the export part is ~1 day of the same files).

#### Orchestrator decisions (owner night delegation 2026-11-14)

Owner asleep, delegated: every Owner question above is decided with its RECOMMENDED option. Implementation APPROVED.

## Execution

*— claude-opus-5-5, 2026-11-14*

### Step 0 (blocking, run before any lock code)

Probe app in `.tentacle/tmp/mobile-lock/probe` (a bare Expo app with the three
modules, driven over HTTP so no tap or Maestro step was needed; results pasted
there in `step0-results.txt`). iOS 26.5 simulator `0FA4B51F` (iPhone 17 Pro),
Xcode 27.1.

| # | Fact | Result |
|---|---|---|
| 0.1 | `enableAppSwitcherProtectionAsync` exists in the installed build | **PASS** — `expo-screen-capture@58.0.6`'s `ScreenCapture.d.ts` declares `enableAppSwitcherProtectionAsync(blurIntensity?)` and `disableAppSwitcherProtectionAsync()`. D4(a) ships; the local native module D4(b) is not needed. |
| 0.2 | Face ID scriptable | **PARTIAL** — enrolment and a MATCH are (`notifyutil -p …enrollmentChanged` then `-p …pearl.match` → `authenticateAsync` resolves `{success:true}`; the `-s` alone does not flip `isEnrolledAsync()`, the `-p` post does). A **NOMATCH** is not: with `disableDeviceFallback` both true and false the promise never resolved in the budget and the sheet stayed up (two tries). Per the plan's own contingency the failing-prompt path becomes a real-device item and no flow depends on it. |
| 0.3 | A 1 s timer does not fire while backgrounded (fact 1) | **FALSE ON THE SIMULATOR** — `AppState` went `inactive->background` at 8.09 s and ticks continued at 9.21, 10.37, 11.51… The simulator does not suspend JS for a backgrounded app. **The heartbeat premise is a real-DEVICE fact and is not provable here.** The design does not change (on a device JS *is* suspended, which is why the heartbeat is correct), D1's F7/F8 behaviour is pinned by unit tests that assume suspension, and the device check is listed under "Not verified". |
| 0.4 | The switcher snapshot is unreadable with the cover on (fact 2) | **NOT PROVEN (2 tries)** — the snapshots land as KTX (`AAPL\r\n…`, undecodable with the local tooling within budget) and their hashes are IDENTICAL with the cover ON and OFF, so on the simulator the snapshot is not re-taken on resign-active (or the cover is not in it). Real-device check, as the plan allows. |
| 0.5 | The lock's container is above a native sheet and an Alert (fact 3) | **PASS** — a `Modal` with `presentationStyle="fullScreen"` and `animationType="none"` was screenshotted above an open `formSheet` and above an open `Alert`; in both cases the underlying content is not visible. |

Step 0 needed four builds: the first three died on symbol mismatches because the
probe resolved newer Expo packages (`expo-modules-core@58.0.30`) than the repo
locks (`58.0.24`); pinning the probe's overrides to the repo's locked versions
fixed it. The disk was also full at one point (117 MiB free) and stale
`tentacle-*` DerivedData was deleted to make room — no repo file was touched.

### What was built, in order

1. **`app-lock.ts`** (D1, pure) — the state machine, injected `now`, and one
   event beyond the plan: **`prompted`** (the component ACKs a raised prompt so
   the one-shot flag cannot re-raise it — without it the prompt's own
   `inactive → active` looped, which the plan's own F5 test caught).
2. **`lock-settings-store.ts`** (D3, pure) — the versioned `{v:1, delay}`
   record, the fail-closed decode (`5m`, never `never`), and a write GUARD
   (`guardLockSettingStore`) so an unknown-version record is never overwritten.
3. **`app-log.ts`** (D7, pure) — the typed ring, `redact()` (URL → `scheme://
   host:port`, `Bearer …`, `token=…`, ≥20-char base64/hex runs, 160-char cap),
   `shortId`, `fieldValue`, `exportText`, `exportFileName`.
4. **`app-log-fs.ts`** (D7, injected files) — rotation at 2 × 256 KB with the
   versioned header line, an unknown-version file rotated away (F19), and the
   export handoff that deletes the temp file even when the share throws (F18).
5. **Adapters**: `lock-auth.ts` (D2), `lock-settings-expo.ts`, `app-log-fs-expo.ts`.
6. **`switcher-cover-rule.ts` + `switcher-cover.ts`** (D4a) — split so the RULE
   is testable without the native module (a single file importing
   `expo-screen-capture` made `bun test` load React Native).
7. **`connection.ts`** — `console.log` → the injected `AppLog`; the dialled URL is
   never logged, only its host (P3).
8. **`routes.ts`** — the `Settings` route.
9. **`LockGate.tsx`** (D5) — cover, accessibility hiding, the heartbeat, the
   prompt effect, the Unlock button.
10. **`SettingsScreen.tsx`** (D6) + the `open-settings` row in `ComputersScreen`.
11. **`App.tsx`** (D8) — the ONE `LockGate` wrapper (on the loading return too, so
    the spinner is never the one thing above the lock), the `Settings` screen, the
    ONE log sink passed to `openComputer`, the setting read + `SWITCHER_COVER.apply`,
    and the log→file drain.
12. **E2E**: the `faceid-*`/`log-file` hooks and their scripts, `_unlock.yaml`,
    flows 18–21, and `_unlock` after every `launchApp` in `_pair`, 10, 12–17.

### Drift from the Implementation (and why)

- **D1 gained the `prompted` event.** Not in the plan's table; without it the
  one-shot prompt re-fires forever (F5's loop). Found by the plan's own F5 test.
- **`lockView().prompt` is NOT gated on `cover === "lock"`.** Owner Q6's weakening
  prompt happens while the app is unlocked and visible; gating it on the cover
  made weakening impossible to confirm.
- **`fieldValue` truncates to 24 chars, not to `DETAIL_MAX`.** D7 says `fields`
  holds numbers, booleans and short enums — a 76-char title in `fields` was
  passing through. A module-level cap makes "no title in `fields`" a property of
  the module instead of a promise every call site must keep.
- **The gear is an in-screen row, not a native-stack `headerRight`.** The repo
  already made this choice for Remove (`ComputersScreen.tsx`: RN's new
  architecture exposes no native header content to XCUITest, so a flow could never
  assert it). `testID="open-settings"`, beside the existing "Pair a computer" row.
- **The backup exclusion (Owner Q7) is NOT implemented.** `expo-file-system@58.0.10`'s
  `FileWriteOptions` has only `encoding`/`append` — no per-file backup flag, and
  excluding the document directory needs a native
  `NSURLIsExcludedFromBackupKey` line this task's dependency set does not have.
  **Open item**: the ring lives in `Documents/` and IS in an iCloud backup until
  that lands. It is redacted at write time, so what a backup would carry is
  already redacted text — but the plan promised exclusion and it is not there.
- **Flow 07 is `19-lock-unlock-button`, not `07-lock-nomatch`.** Step 0 could not
  script a failing prompt on the simulator, so the reachable half of F5 (the
  Unlock button exists and works) is the flow and the no-auto-reprompt half is
  `app-lock.test.ts`'s. New flows are numbered 18–21 because 06–09 already exist.
- **`APP_VERSION`/`APP_BUILD` are constants in `App.tsx`.** `expo-application`
  would report them natively; the plan forbids adding a dependency for a header
  line. They must be bumped with `app.json`'s `version` — noted as debt.
- **`exportLogs` appends the previous run's file content** after the ring's own
  entries (`--- previous run ---`), so a crash is visible in the export.

### Tests and mutations

New: `app-lock.test.ts` (26), `lock-settings-store.test.ts` (10),
`app-log.test.ts` (18), `app-log-fs.test.ts` (12), `switcher-cover.test.ts` (3),
plus new cases in `connection.test.ts` (3) and `routes.test.ts` (1).

Non-vacuity — each mutation was applied, the named test shown RED, then reverted
(all six restored, suite green afterwards):

| Mutation | Result |
|---|---|
| the elapsed source → the `background` timestamp (the fail-open bug) | **2 F7 tests RED** (`ticks stop … → LOCKED`, `elapsed … from the LAST TICK`) |
| `>` → `>=` on the threshold | **F9 RED** (`EXACTLY at the threshold does not lock`) |
| `redact` → identity | **6 canary tests RED** (URL token, userinfo/path, Bearer, hex key, base64url key, the 160-char cap) |
| log the raw dialled URL instead of the host | **P3 test RED** (`a dial logs its HOST only`) |
| restore `console.log` on the link path | **console test RED** (`no console.log is left on the link's path`) |
| apply a WEAKENING immediately (Owner Q6's guard dropped) | **2 F5/Q6 tests RED** (`weakening waits for a successful auth`, `a weakening NEVER applies without an auth …`) |

Two pre-existing guard tests caught real regressions of mine and were updated
rather than weakened: `pairing-guards.test.ts` (a second Keychain importer — the
guard now names both adapters and still proves both stores stay pure) and
`e2e-flows.test.ts` (my new flows had to pair through `_pair`, name
`${output.computerId}`, and end on a hook-truth script rather than a container —
all three are the guards' own rules, applied to the new flows).

### Gate

- `bun run typecheck` — clean.
- `bun run lint` (`biome check .`) — **clean, 0 errors 0 warnings** (baseline §6).
- `bun test` — full suite green, the three opt-in skips unchanged.
- No schema change: nothing here crosses the wire (P1), so
  `packages/protocol/schema/protocol.json` is untouched and no `protocol.d/` note
  is needed.
- `changelog.d/mobile-lock.added.md` — one bullet.

### Not verified here (and how to)

1. **The heartbeat on a real device** (Step 0 fact 1 was false on the simulator).
   Real iPhone: choose `5m`, background 6 minutes, return → the lock must be up.
2. **The switcher snapshot** (fact 2 / F12) — real iPhone: open the switcher over a
   session list and confirm the content is unreadable.
3. **`faceid-nomatch`** — real iPhone: deny Face ID in Settings → Face ID &
   Passcode, then unlock: the passcode sheet must appear (decision 14's fallback).
4. **The Maestro flows themselves** — `bun run e2e:mobile` was NOT run: it boots a
   Release build of the app on the simulator (a ~15 min build) and the flows need
   the harness's daemon, pairing and seed. The flows and hooks typecheck and
   satisfy `e2e-flows.test.ts`'s rules, but they have not been executed.

## Review

*— claude-opus-5-5, 2026-11-14* (fresh context; **same model as the plan's author** — shared blind spots possible; the executor was DeepSeek)

**Verdict: REQUEST-CHANGES**

### Findings

1. **MEDIUM — every Settings change re-locks the app and asks Face ID again.**
   `apps/mobile/src/app-lock.ts:164` (`onLoaded`: `next.locked ? next : beginEpisode(next)`)
   + `apps/mobile/src/screens/LockGate.tsx:97-101` (re-dispatches `loaded` on every
   `setting` prop change) + `apps/mobile/App.tsx` `selectDelay` / the `authResult`
   handler (`setLockSetting(...)` after each write). Repro
   (`.tentacle/tmp/mobile-lock/relock.ts`, reducer driven exactly as the wiring does):
   ```
   unlocked, setSetting immediately → loaded immediately → {"cover":"lock","prompt":true,"locked":true}
   setSetting 1h → prompted → authResult success → loaded 1h → {"cover":"lock","prompt":true,"locked":true}
   ```
   Stronger delay: the app locks under the person's finger. Weakening: two Face IDs,
   and cancelling the second leaves the app locked right after a successful auth.
   Not fail-open, but the Settings screen is broken as UX and flow 20 (select
   `immediately`, then `pressKey: home`) will hit an unexpected lock+prompt
   (the flows were never run). No test covers `loaded` arriving on an unlocked
   state. Fix direction: `loaded` is a launch-time event — apply it only while
   `setting === "loading"`, or stop feeding later setting changes through it
   (the reducer already got `setSetting`); add the red test.
2. **MEDIUM — daemon text reaches the export unredacted (F16 not met; its test was weakened).**
   `apps/mobile/src/connection.ts:285` logs `error.message` and `:142-150` the ws
   close `reason` as `detail`; `redact()` (`app-log.ts:93-99`) removes only URLs,
   bearer/params and ≥20-char runs, so a path, title or prompt fragment in a
   daemon/JSON-RPC error survives up to 160 chars. The plan (Tests, `app-log.test.ts`)
   requires `CANARY-PROMPT`/`CANARY-TITLE` to be absent from the export;
   `test/app-log.test.ts:110-115` instead asserts only that the TAIL (`COMPUTER`)
   was truncated away — the prompt and title canaries are present and the test
   passes. Execution does not list this as drift. Either log a closed error code /
   class instead of the message (D7's "fields limited to numbers, booleans and short
   enums"), or record the decision to accept bounded daemon text as an explicit
   drift with the owner's OK — and make the test state the true property.

### Gate (re-run here)

- `bun test apps/mobile/test` — **639 pass, 0 fail** (51 files).
- `bun run lint` — clean (1237 files). `bun run typecheck` — clean.
- Full `bun test` not re-run (only the mobile app is touched).

### Mutation

`app-lock.ts:202` — dropped the `now < lastSeenActive` clause → **F8 test RED**
(1 fail / 25 pass); reverted, `git status --porcelain` empty.

### Attacks tried

- Fail-open at cold start: initial view before `launch` is `cover:lock`
  (setting `loading`) — holds. `LockGate` at the same root position in both
  `App` returns, so no remount / state loss — holds.
- Late `background`+`active` (F7), clock back (F8), threshold (F9), F5 no-reprompt
  loop via `prompted` ack — hold in the reducer (device heartbeat still unverified,
  as Execution says).
- Weakening without auth: `selectDelay` reads `pendingSetting` after dispatch and
  writes nothing — holds; a failed auth clears `pendingSetting` — holds.
- `authenticate`/`capability` throwing → `fail` / `ok` (fail-closed) — holds.
- Setting store: unknown `v`/garbage/read error → `5m`, writes refused — holds
  (LOW: a transient Keychain read error blocks every write for the session).
- Log drain dedups by `entry.t >` — LOW: entries sharing the last drained
  millisecond are skipped from the file.

### What holds / executor behaviour

The reducer, store and redaction-of-secrets (URL query, bearer, keys) are sound and
honestly tested; Step 0 results and unverified items are reported candidly
(backup exclusion, Maestro not run). The executor missed the interaction between
`loaded` and later setting changes, and silently narrowed the plan's canary test.

# feat/mobile-live-activity — Live Activity / Dynamic Island: push-to-start, end-to-end encrypted updates, the 8 h cap (mobile task 18)

> **Status:** implementation (plan written, **not approved**; see Owner questions)
> **Branch:** `feat/mobile-live-activity` (this doc). Slices L0–L12 run **in order on this branch**, one commit per slice on the owner's OK, each gated by its narrow tests (AGENTS §4); full gate + `bun run e2e:mobile` before Review. **Starts only after task 17 (`feat/mobile-notifications`) is merged** (Owner Q9): it reuses task 16's push crypto, relay `push` frame, `PushNotifier` hook and push store, and task 17's NSE `PushCore` Swift, push-directory Keychain item, `gate.hold()` and answer coordinator.
> **Size:** L as a whole, split into S/M slices (table below) · **Blast:** load-bearing for L7/L8 (they widen task 16's hook in the session's `emit` path and add device-principal methods); the rest is `contained`/`cross-module`. The eval row says "L · cross-module"; re-sized because of L7/L8. · **Suited:** L7, L8 → strong executor + mandatory fresh-context Review red-teaming "a relay/pod is not trusted", "one session path", "don't serialize the RPC peer", the steering no-await window and "a decision is only a person's". L10 (Swift widget + native module) and L11's action path are security-relevant → strong executor. L1, L2, L3, L5, L9, L12 are S and fit a weaker executor (DeepSeek); L4, L6 are M `contained`. The owner assigns executors.
> **Changelog:** `changelog.d/mobile-live-activity.added.md` (L12): `- **Live Activity and Dynamic Island on iPhone.** A running turn shows on the lock screen and in the Dynamic Island (project, session, current tool, elapsed time), an approval waiting shows Approve / Deny, and a finished turn stays for a few minutes. Turns started on another device start it by themselves. Updates are end-to-end encrypted: Apple and the relay see only opaque bytes.`

## Context

*— claude-opus-5-5, 2026-11-14*

Mobile task 18 of `docs/eval/mobile-app.md` (decision 21, Phase 6, row
"18 | Live Activity / Dynamic Island (push-to-start, updates) | L · cross-module").

Binding decisions (linked, not copied):
- **Decision 11** (`docs/eval/mobile-app.md:184-190`): Live Activity in v1 —
  lock screen + Dynamic Island show the running turn (current tool, elapsed),
  an approval waiting (with Approve / Deny), "done" for a few minutes; updated
  via ActivityKit push **through the same relay as notifications**; a turn
  started elsewhere (app closed) starts it via **push-to-start**; the widget is
  a SwiftUI extension; **an activity lives at most 8 h** (handed to this task by
  the eval's Review, `:618`).
- **Decision 8 / 14** (`:146-158`, `:207-214`): content end-to-end encrypted;
  "From a notification or the Live Activity, Approve always asks Face ID".
- **Decision 2 / 9 / 18 / 19**: one relay for streams and push; domain never
  hard-coded; the APNs key lives only on the relay host; no third-party
  services (raw APNs, never Expo push).
- **Decision 17**: the activity shows the one session title.
- **Decision 20**: logic in pure TS modules under `bun test`; crypto pinned by
  cross-language vectors; E2E via `xcrun simctl push`; real-iPhone checklist
  "real push, Face ID, **Dynamic Island**".
- **Minimum iOS 18, iOS 26 as enhancement** (`:363-373`): push-to-start 17.2,
  interactive Live Activity 17 — available on every supported iPhone. iPad has
  no Live Activities: the feature reports `unsupported` there.
- **Mockups approved** (`:345`): the Live Activity / Dynamic Island screen is
  one of the 10; accent `#0E7490` light / `#06B6D4` dark.

Builds on (plans **not approved yet**, read-only:
`.tentacle/tmp/plans/mobile-push.md`, `.tentacle/tmp/plans/mobile-notifications.md`,
`.tentacle/tmp/plans/mobile-relay.md`): task 15 (relay control socket
`/v1/daemon`, `ready.features`), task 16 (HPKE Auth push sealing with the
computer's static key as sender and a per-device push key as recipient;
`onPushEvent` hook in `HostedSession.emit`; `PushNotifier`; `devices/push/<id>.json`;
relay `push` / `push-result` frames and APNs client), task 17 (NSE `PushCore`
Swift files + SwiftPM tests over shared vectors; the `tentacle.push.directory`
Keychain item in a shared access group listed AFTER the app's own; the answer
coordinator with `gate.hold()`, Face ID, fallback notification;
`RemoteClient.answerPermission`).

**Trust.** The relay and Apple are **not trusted** (AGENTS §7 "a pod is not
trusted" spirit; task 16 Trust, task 17's extra rule). They may read, drop,
delay, replay, reorder, forge or rewrite anything they carry, including every
clear ActivityKit field (`event`, `timestamp`, `stale-date`, `attributes`).
They must not learn content (project, session title, tool, command), must not
make the phone show authentic-looking content, and **nothing an activity
carries can make the phone send an answer** — an answer needs a plaintext the
app itself opened and authenticated, plus the person's gesture (and Face ID for
Approve). Accepted: they see ActivityKit's clear metadata (start/update/end,
priority, timing, three size buckets) and can drop or junk-start activities.

**Deploy is NOT part of execution.** Relay changes ship with the next relay
deploy, which is the owner's step **D4** (planned in L12's runbook delta, never
done by an executor). Apple console steps are **D4a**. No executor touches the
server (142.132.169.22 / `relay.tentacle.so`), Apple's console, DNS or Caddy.

**Repro (2026-11-14): the capability is missing.** On this branch (= `main` @
`88f5a8f`), a search for
`ActivityKit|LiveActivit|live_activity|liveactivity|NSSupportsLiveActivities|pushToStart`
in `{packages,apps}/**/*.{ts,tsx,json,swift,js}` → **No files found**.
`apps/mobile/app.json` has no `NSSupportsLiveActivities`, no extension target,
no `apps/mobile/targets` / `apps/mobile/modules`. The executor re-runs the
search on `main` after task 17 merged: then the push/NSE pieces exist, still no
Live Activity.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Everything the activity shows is already produced synchronously, in order,
at one daemon point — the session's `emit` — so task 16's non-attachment
observer, widened by three update kinds, is all the daemon needs; and the phone
can keep it end-to-end encrypted because the widget extension renders an
opaque `content-state` it opens itself.** The daemon half is proved by source;
the phone half is the blocking probe L0(a).

Proof (daemon, by source):
- **One fan-out point.** Every update is numbered and fanned out by
  `HostedSession.emit` (`packages/daemon/src/hosted-session.ts:1948-1963`),
  synchronously, never awaited; a follower (`watchers.offer`, `:1962`) runs
  after the attachment loop and cannot reorder or delay a client's stream.
  Task 16's `onPushEvent` sits right there.
- **Every input the activity needs passes through it:** a turn's start
  (`emit({ type: "turn_start", … })`, `:2081`, `:2280`), each agent event incl.
  tool calls (`eventToUpdate(named)` then emit, `:2458`), an ask becoming
  visible (`ask.shown = true` then emit, `:921`, `:1032`), its settle
  (`settle`, `:1136`), the turn's end (`finishTurn`, `:2505`, called from
  `:2397`, `:2468`, `:2479`, `:3013`), the title (`session_title`) and
  `session_closed`.
- **The shapes carry what is shown:** `tool_call.title` + `status`
  (`packages/protocol/src/updates.ts:45-52`), `turn_start.turnId`
  (`:242-254`), `turn_end.stopReason` + `error` (`:257-266`),
  `session_title.title` (`:301-305`), `session_closed` (`:290-293`).
- **The observer must not be an attachment.** `recheckAsks` denies a pending
  ask when no attached client can show it (`hosted-session.ts:1088-1097`,
  called at `:1569`, `:1592`); `Attachment` (`:191-203`) feeds that set.
  Task 16 keeps the hook out of it; this task only widens its kind filter.
- **The daemon holds the sender key** (`device-authority.ts:146` `staticKey()`,
  `:151` `identity()`), as for push.
- **The daemon never settles an ask itself** (`hosted-session.ts:20-31`), so an
  activity, like a push, can only *show* state — it can never race a decision.

Phone half, **not provable by source, blocking (L0(a))**: ActivityKit decodes
`aps.content-state` into the widget's `Codable` `ContentState` and hands it to
the SwiftUI view in the extension process; the view may run CryptoKit
`HPKE.Recipient(…authenticatedBy:)` with keys read from the shared Keychain
item (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, `apps/mobile/src/secure-kv.ts:17`)
on a locked-after-first-unlock phone. If L0(a) fails, there is no E2E Live
Activity possible through ActivityKit push: the plan stops and Owner Q1's
fallback applies.

### Preconditions

- **Only `serve` on the user's host pushes** (task 16 Preconditions:
  `startDaemon` alone wires a `PushNotifier`; pods / in-process worker have no
  device route). Same here: no Live Activity from a pod.
- **One link per computer** (`apps/mobile/src/link-registry.ts:1-12`); an
  answer from an activity goes through the registry's ONE link (task 17
  Preconditions), never a new `openComputer`.
- **The foreground gate drops the socket in the background**
  (`apps/mobile/src/foreground-gate.ts:1-34`, `suspend()` `:111-120`). Reporting
  an update token from a background launch uses task 17's `gate.hold(ms)`.
- **"Attached to session S" ≈ "app foreground on S"** (task 16 F17, the gate
  + `session-runtimes.ts`). Used by the start rule.
- **Task 17's directory item** `tentacle.push.directory` holds the peers
  (`kid → computerKey`) and the current + ≤ 24 h previous push private keys,
  never the Noise device key; written only by the app. The widget extension
  joins the same shared access group (D4a) and reads only that item.
- **Device principal** is known per connection (`packages/daemon/src/connection.ts:122-131`,
  `:178`), so device methods are gated like task 16's `device/push_register`.
- **Protocol: additive only.** New methods (`MethodNotFound` on an older daemon)
  and no new `session/update` kind → **no `PROTOCOL_VERSION` move, no
  `protocol.d/` note**; `protocol.json` regenerated by `bun run schema:export`.
- **Relay wire** is gated by `ready.features` (task 16 C1): a daemon sends a
  Live Activity frame only to a relay that announced `"liveactivity"`.

### Design

**1. What is shown (the plaintext, `@tentacle/protocol` `live-activity.ts`).**
`ActivityContent { v:1, slot, seq, at, kind: "running"|"asking"|"done"|"failed"|"cancelled",
computer: line(64), project: line(120) (basename of `cwd`), title: line(120),
turnId, startedAt (ms, the turn's ORIGINAL start), tool?: line(80) (latest
`tool_call.title`), ask?: { requestId, tool: line(60), preview: line(160),
options: [{optionId, kind}] }, error?: line(120), more?: int }`.
`slot` = 96-bit random per activity (daemon-chosen); `seq` monotonic per slot.
Clipped UTF-8-safely and padded to 512 / 1024 bytes before sealing, so
payload + clear fields fit APNs's 4 KB (a test asserts the worst case).
Elapsed is drawn on the phone (`Text(timerInterval: startedAt…)`), so it never
costs an update.

**2. Crypto (`@tentacle/transport/push`, `seal-activity`).** Task 16's HPKE
Auth suite and keys (sender = computer static key, recipient = the device push
key) with **domain separation**: `info = "tentacle-la/1"`, `aad = kid ‖ slot`.
A content-state sealed for activity A cannot be opened inside activity B
(the widget passes B's `attributes.slot` as aad) — so a relay cannot move one
session's state into another's activity. The clear `ContentState` is
`{ v:1, e: b64url, c: b64url }`; the clear `attributes` (push-to-start only)
are `{ v:1, k: kid, slot }` — no content. Vectors
`packages/transport/test/vectors/la-v1.json` (fixed keys + seed → exact bytes),
read again by the Swift tests.

**3. Daemon rules (pure `packages/daemon/src/live-activity-rules.ts`).**
State per `(sessionId, deviceId)`; inputs = hook events + attached-device set +
registrations + injected clock; outputs = desired-state commands
`start | update | end` with an `ActivityContent`.
- **Start** for device D on session S when D has a Live Activity registration,
  is **not attached to S**, and either the turn has run ≥
  `liveActivity.startAfterSeconds` (default 20; short Q&A never lights the
  phone) or an ask is raised (immediately: the activity is quiet, the
  Time Sensitive banner stays task 16's job). At most **3 live activities per
  device** (iOS allows ~5 per app); a 4th start ends the oldest `done` one,
  else is skipped with an audit line (Owner Q3).
- **Update** on a new `tool_call` (coalesced: ≤ 1 per 15 s, priority 5), on
  `permission_request` → `asking` and `permission_resolved` → `running`
  (immediate, priority 10), on `session_title` (coalesced), and a **heartbeat**
  every 10 min of silence (priority 5) that moves `stale-date` (now + 15 min).
  A stale view says "may be out of date — open tentacle" (Owner Q4).
- **End** on `turn_end`: `done` / `failed` / `cancelled`, priority 10,
  `dismissal-date` = now + 5 min ("done for a few minutes"). On
  `session_closed`: end at once.
- **8 h cap (Owner Q5).** At 7 h 45 min of an activity's life with the turn
  still running: `end` it (dismissal now) and `start` a continuation (new slot,
  same `turnId`, same `startedAt` so elapsed is continuous). Margin is a
  constant in the pure module, tested at the boundary.
- **Dismissed by the person** (the app reports it, or APNs says the update
  token is `gone`): never restarted for that turn; the next turn may start one.
- **Both channels for an ask:** task 16's notification is still sent per its
  grace rule (the reliable, actionable channel); the activity is best-effort.
  Same `requestId` → answering in either makes the other converge
  (`ask_resolved` replacement push; activity back to `running`).

**4. Daemon wiring (`live-activity-notifier.ts`, store, methods).**
- Task 16's `onPushEvent` filter gains `turn_start`, `tool_call`,
  `session_title` (still synchronous, `try/catch`, never awaited; I/O after
  `queueMicrotask`). One `LiveActivityNotifier` per `serve`, beside
  `PushNotifier`, fed by the same hook.
- **Registration file** `<configDir>/devices/live/<deviceId>.json` =
  `{ v:1, startToken, env, registeredAt }`, 0600, tmp + rename; unknown `v` →
  that device gets no activity, file untouched (AGENTS §7 on-disk rule).
  `removeDevices` / `devices reset` delete it next to `push/<id>.json`.
  `tentacle devices` shows a `live` column.
- **Update tokens live in daemon memory only** (Owner Q8): `slot → {deviceId,
  token, sessionId}`; an activity lives ≤ 12 h and a restart is rare. After a
  restart the activities go stale (Design 3) and the app's reconcile ends them.
- **Latest-state sink:** per slot the notifier keeps only the newest desired
  state; while the relay link is down nothing queues, and on `ready` it resends
  the current state of every live slot (convergence by state, not by event
  replay).
- **Methods** (device principal only; refused for `token` / `pairing`, the gate
  at `connection.ts:302-311`):
  `device/live_activity_register { startToken: hex, env, enabled }` →
  `{ status: "on"|"off"|"relay-off"|"relay-no-la"|"unsupported" }`;
  `device/live_activity_token { slot, token: hex }` → `{ known: boolean }`
  (a token for a slot this daemon did not start → `known:false`, ignored);
  `device/live_activity_ended { slot, reason: "dismissed"|"ended"|"stale" }` → `{}`.
- **Relay frame** (amends task 16's `push`): `type: "liveactivity"`, `token`,
  `env`, `priority: 5|10`, `la: { event: "start"|"update"|"end", timestamp,
  staleDate?, dismissalDate?, contentState: {v,e,c}, attributes?: {v,k,slot} }`.

**5. Relay (`apps/relay/src/apns.ts` + `relay-core.ts`).** Announces
`"liveactivity"` in `features` only with an APNs key. Builds `aps` from a fixed
template: `apns-push-type: liveactivity`, `apns-topic` = configured bundle id +
`.push-type.liveactivity`, `aps.event`, `aps.timestamp`, `aps.content-state`,
optional `stale-date` / `dismissal-date` (bounded: ≤ now + 12 h),
`attributes-type: "TentacleActivityAttributes"` (fixed, never daemon-supplied),
`attributes`, and for `start` only a fixed generic `alert` ("tentacle" /
"A turn is running") if L0(d) shows it is required. Limits (pure, defaults
overridable): per token 60 LA pushes / h, priority 10 ≤ 20 / h per token
(excess downgraded to 5, never dropped), payload ≤ 4096 bytes. Logs never hold
a token beyond 8 chars or any payload.

**6. Phone, native (Swift, L10).**
- **Local Expo module** `apps/mobile/modules/live-activity`: exposes
  `pushToStartToken` events (`Activity<TentacleActivityAttributes>.pushToStartTokenUpdates`),
  `activities()` (id, slot, clear content-state, state), per-activity
  `pushTokenUpdates` / `activityStateUpdates` as events, `end(id)`, and
  `takePendingActions()` (the intent queue, drained by JS at every start).
- **Widget extension** `apps/mobile/targets/live-activity/` (same tooling as
  task 17's NSE target, `@bacons/apple-targets`): lock-screen view, Dynamic
  Island compact / minimal / expanded. Each view calls `LACore.open(state,
  attributes)` (task 17's `PushCore` open + directory read, with `info` / `aad`
  of Design 2) → `ActivityContent` or **placeholder** ("tentacle — open to see",
  no buttons) on any failure (unknown kid, bad tag, unknown `v`, slot mismatch).
- **Buttons (Owner Q6):** `asking` with an offered `allow_once` / `reject_once`
  renders Approve / Deny as `Button(intent:)` with `LiveActivityIntent`s
  (`isDiscoverable = false`, so Shortcuts cannot invoke them) that **open the
  app** and enqueue `{action, activityId}` for JS. Never `allow_always`.
- **Privacy on the lock screen (Owner Q7):** project, phase, elapsed and tool
  name are shown; `title` and `ask.preview` are `.privacySensitive()` (hidden
  while the device is locked, if L0(e) confirms; else omitted from the
  lock-screen view and shown only in the Dynamic Island expanded view).
- Shared Swift file `TentacleActivityAttributes.swift` compiled into both the
  app module and the extension (the push-to-start `attributes-type` string must
  match; it never changes name; fields are only ever added as optionals).
- iOS 26 enhancements inside SwiftUI with `#available(iOS 26, *)` (Swift's
  compile-time gate; the TS "feature table" rule is about JS branching).

**7. Phone, JS (pure modules, L9/L11).**
- `la-render.ts`: `ActivityContent → view-model` (strings, which buttons) —
  the spec the Swift views follow; vectors `apps/mobile/test/fixtures/la-render-v1.json`
  asserted by both TS and Swift tests.
- `live-activity-registration.ts`: per computer, register when
  `(startToken, env, enabled)` differs from the last ack (stored per computer
  in `computer-store`), on every successful connect; `MethodNotFound` →
  "update tentacle on <computer>", no retry loop; Settings toggle → `enabled:false`.
  `unsupported` when `areActivitiesEnabled` is false (iPad, user off).
- `live-activity-reconcile.ts`: on every connect, for each local activity of
  that computer: report an unacked update token; report `dismissed`/`ended`;
  end activities whose content does not open (forged/old key) or whose turn is
  no longer running per `session/list` (daemon truth wins).
- Background token report: when iOS launches the app in the background with a
  push-started activity's token, the adapter does `gate.hold(budget)` (task 17),
  one dial, `device/live_activity_token`, release. Fails → reported at the next
  connect; meanwhile the activity converges via `stale-date`.
- `live-activity-action.ts`: `decide({action, activityId}, activities, keys,
  peers, now)` re-opens the activity's CURRENT content-state in JS (task 16's
  `openActivity`), takes `requestId` / options from that plaintext only; then
  hands to task 17's answer coordinator: Approve → Face ID always →
  `allow_once`; Deny → `reject_once`; unverified / no option / not asking →
  open the Session screen, nothing sent.

### Slices

| id | scope | files | Size | Blast | deps |
|---|---|---|---|---|---|
| **L0** | Blocking probes, scratch only (`.tentacle/tmp/mobile-live-activity/`), results pasted into Execution. **(a)** A widget extension decodes a `ContentState {v,e,c}`, opens it with CryptoKit HPKE Auth reading a shared-group Keychain item, on the simulator, then on the owner's iPhone locked-after-first-unlock (device part owner-assisted). **(b)** `xcrun simctl push` with `apns-push-type: liveactivity` payloads (start with `attributes-type`, update, end) on the iOS 18 and 26 simulators. **(c)** Device, sandbox APNs (after task 16's D2): push-to-start from a killed app and from a force-quit app — is the app launched in the background, does RN JS run, does `gate.hold` + one dial + token report finish? **(d)** Is `alert` required on `start`; does a soundless alert light the screen? **(e)** Does `.privacySensitive()` redact a Live Activity on a locked phone? **(f)** `LiveActivityIntent` (`isDiscoverable=false`) opening the app cold and the JS drain seeing it. **(g)** APNs answers for an ended activity's token (410?). | scratch only | S | contained | task 17 merged |
| **L1** | Crypto: `sealActivity` / `openActivity` (info, aad = kid‖slot, padding 512/1024) beside `sealPush`; vectors | `packages/transport/src/push-seal.ts`, `packages/transport/test/push-seal.test.ts`, `packages/transport/test/vectors/la-v1.json` (new) | S | contained | L0(a) |
| **L2** | Protocol: `ActivityContent`, clear `ContentState` / attributes schemas, clip limits; `device/live_activity_register` / `_token` / `_ended` + registry; `schema:export` | `packages/protocol/src/live-activity.ts` (new), `packages/protocol/src/methods.ts`, `packages/protocol/src/index.ts`, `packages/protocol/schema/protocol.json` (regenerated), `packages/protocol/test/live-activity.test.ts`, `packages/protocol/test/json-schema.test.ts` (samples) | S | cross-module | L1 |
| **L3** | Relay wire: `push` frame `type:"liveactivity"` + `la` block; `"liveactivity"` feature | `packages/protocol/src/relay.ts`, `packages/protocol/test/relay.test.ts` | S | contained | L2 |
| **L4** | Relay: LA template (topic suffix, fixed `attributes-type`, bounded dates, start alert per L0(d)), LA limits, feature only with a key | `apps/relay/src/{apns.ts,relay-core.ts,server.ts}`, `apps/relay/test/{apns.test.ts,server-push.test.ts}` | M | contained | L3 |
| **L5** | Store: `devices/live/<id>.json` read/write/delete; `removeDevices` + `devices reset`; `devices` column | `packages/daemon/src/live-store.ts` (new), `packages/daemon/src/device-store.ts` (+2 lines), `packages/daemon/src/index.ts`, `packages/cli/src/devices-cmd.ts`, tests `packages/daemon/test/live-store.test.ts`, `packages/cli/test/devices-cmd.test.ts` | S | cross-module | L2 |
| **L6** | Pure rules (Design 3): start/update/end, coalescing, heartbeat, stale/dismissal dates, 8 h rollover, per-device cap, dismissed-never-restart; injected clock | `packages/daemon/src/live-activity-rules.ts` (new), `packages/daemon/test/live-activity-rules.test.ts` | M | contained | L2 |
| **L7** | Daemon wiring: widen `onPushEvent` kinds; `LiveActivityNotifier` (rules → seal → latest-state sink); in-memory slot table; the three methods in `Connection`; audit lines | `packages/daemon/src/hosted-session.ts` (filter only), `packages/daemon/src/session-host.ts`, `packages/daemon/src/connection.ts`, `packages/daemon/src/live-activity-notifier.ts` (new), `packages/daemon/src/index.ts`, tests `packages/daemon/test/live-activity-notifier.test.ts`, `packages/daemon/test/push-hook.test.ts` (extend) | M | **load-bearing** | L1, L5, L6 |
| **L8** | `serve` wiring: config `liveActivity.enabled` / `liveActivity.startAfterSeconds` (+ key docs), `relayLink` feature gate + resend-on-ready; end-to-end bun test (phone over Noise registers → turn > threshold → fake APNs gets a `start` whose state opens; ask → `update asking`; end → `end` with dismissal) | `packages/config/src/{schema.ts,defaults.ts,key-docs.ts,resolve.ts}`, `packages/daemon/src/relay-link.ts`, `packages/cli/src/serve.ts`, tests `packages/daemon/test/relay-link-la.test.ts`, `packages/cli/test/serve-live-activity.test.ts` | M | **load-bearing** | L4, L7 |
| **L9** | App pure render spec + vectors (Design 7 `la-render.ts`) | `apps/mobile/src/la-render.ts` (new), `apps/mobile/test/la-render.test.ts`, `apps/mobile/test/fixtures/la-render-v1.json` (new) | S | contained | L2 |
| **L10** | Native: Expo module `modules/live-activity`, widget target, shared attributes file, intents, `LACore` over task 17's `PushCore`; Swift tests over `la-v1.json` + `la-render-v1.json`; `app.json` (`NSSupportsLiveActivities`, extension, keychain group order); config-output test | `apps/mobile/modules/live-activity/**` (new), `apps/mobile/targets/live-activity/**` (new), `apps/mobile/native-tests/PushCoreTests/**` (extend), `apps/mobile/app.json`, `apps/mobile/package.json`, `apps/mobile/test/app-config.test.ts` (extend) | M | contained | L0, L9 |
| **L11** | App JS: registration, reconcile, background token report, action decide → task 17 coordinator, Settings row, adapter, wiring at connect and cold start | `apps/mobile/src/live-activity-registration.ts`, `apps/mobile/src/live-activity-reconcile.ts`, `apps/mobile/src/live-activity-action.ts`, `apps/mobile/src/live-activity-expo.ts` (adapter) (all new), `apps/mobile/src/computer-store.ts`, `apps/mobile/index.ts`, `apps/mobile/App.tsx`, `apps/mobile/src/screens/SettingsScreen.tsx`, tests `apps/mobile/test/live-activity-{registration,reconcile,action}.test.ts` | M | contained | L10, task 17 N6 |
| **L12** | E2E + checklist + runbook delta + changelog: Maestro flows, hook `seal-activity` (seal + `simctl push`), real-iPhone checklist lines, `docs/ops/relay-deploy.md` "deploy relay with LA" section (not applied) | `apps/mobile/e2e/flows/23-la-*.yaml`/`.js`, `apps/mobile/e2e/hooks.ts`, `apps/mobile/e2e/run.ts`, `apps/mobile/e2e/README.md`, `apps/mobile/test/e2e-flows.test.ts`, `docs/ops/relay-deploy.md`, `changelog.d/mobile-live-activity.added.md` | S | contained | L8, L11 |
| **D4a** | **Owner, Apple console**: App ID for the widget extension, keychain sharing group on it, regenerate profiles | none | — | account | before L10's device build |
| **D4** | **Owner-approved deploy**: the relay build with L4 to 142.132.169.22 per L12's runbook (APNs key already there from task 16's D2), restart, smoke test, rollback ready | none in repo | — | production | merged, owner OK |
| **D5** | **Owner, real device**: the checklist below | none | — | read-only | D4 |

Serial order: L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10 → L11 → L12.
L1/L2/L5/L6/L9 have no device dependency once L0(a) passed. Each slice runs only
its narrow test file(s) (AGENTS §4); L10 also runs `bun run test:swift`.

### Failure modes

| # | Case | Behaviour → how state converges |
|---|---|---|
| F1 | **Phone offline** | APNs keeps the latest LA push per token; on reconnect the phone gets it. Meanwhile `stale-date` turns the view "may be out of date". The pending ask/turn on the daemon is the truth; the app shows it on open. |
| F2 | **Daemon offline / laptop asleep mid-turn** | No updates or heartbeat → stale after ≤ 15 min; the activity ends itself at the 8 h cap at worst; next app run reconciles (ends it if the turn is gone). |
| F3 | **Relay down / link reconnecting** | Nothing queued; latest state kept per slot and resent on `ready`. Audit `la-dropped link-down` once per outage. Direct app paths unaffected. |
| F4 | **Relay without key / old relay** (no `"liveactivity"`) | Daemon sends nothing (feature gate; else an R2 relay would close the socket). Register result `relay-no-la`; Settings says so. |
| F5 | **Relay/Apple hostile: reads** | Sees tokens, timing, `event`, priority, dates, slot, kid, size bucket. Content sealed. Accepted (Owner Q2). |
| F6 | **Hostile: forges or junk-starts** | Without the computer key nothing opens → placeholder, no buttons. A hostile relay can start junk placeholder activities (it holds the start token), as it can send junk banners (task 16 F9). Bounded by the honest relay's limits; the app's reconcile ends unverifiable activities; the person can switch Live Activities off. |
| F7 | **Hostile: moves state between activities** | `aad` binds to `slot`; opening fails → placeholder. |
| F8 | **Hostile: replays / reorders** (rewrites clear `timestamp`) | The view may show an older state (display only). An action re-verifies in JS and then the daemon answers `PermissionNotPending` for a settled ask (`hosted-session.ts:1098-1129`, task 17). Reconcile corrects on next run. |
| F9 | **Hostile: drops / delays** | Undetectable; `stale-date` bounds how long a wrong state looks current. |
| F10 | **Key rotation — push key** | Task 17 keeps the previous key 24 h ≥ an activity's 12 h life: in-flight states still open. Older → placeholder. |
| F11 | **Key rotation — computer reset** (`devices reset`) | `devices/live/` emptied, slots forgotten; live activities can no longer open → placeholder; the app's reconcile ends them; the phone re-pairs and re-registers. |
| F12 | **Device revoked** | `removeDevices` deletes `live/<id>.json`; the notifier filters by the authority snapshot (task 16 F14) and ends nothing it cannot reach; activities go stale; an action's dial is refused → task 17's `revoked` fallback. |
| F13 | **Start-token rotation / reinstall** | Re-register on next connect (hash differs). A stale token → `gone` → compare-and-delete the file. |
| F14 | **App killed** | Push-to-start still works. The update token arrives only if iOS launches the app in the background (L0(c)); if the report fails, the activity shows its start state with a running timer, then stale; the next connect reports the token and updates resume. |
| F15 | **App force-quit by the person** | If L0(c) shows no background launch: same as F14's failure branch until the app is opened. If that is the common case, Owner Q8's channel fallback is re-planned. |
| F16 | **App backgrounded mid-turn on S** | The gate detaches → D no longer attached → start rule may fire (desired: the person left the app). |
| F17 | **Person dismisses the activity** | `activityStateUpdates` → `device/live_activity_ended dismissed` (when the app runs) or APNs `gone` on the next update → never restarted for that turn. |
| F18 | **8 h cap** | Rollover at 7 h 45 min (end + continuation, same `startedAt`). If iOS ended it first (clock skew), the next update gets `gone` → treated as ended by the system (not dismissed) → one continuation start. |
| F19 | **Priority / budget throttling by Apple** | Priority 10 only for asking / resolved / end / start (≤ 20 / h per token, excess downgraded to 5); tool updates coalesced at priority 5. A throttled update is superseded by the next state anyway. |
| F20 | **Many sessions** | ≤ 3 live per device; the oldest `done` gives way; else skipped + audited, never silent. |
| F21 | **Two daemons on one computer** | Each starts activities only for its own sessions via its own relay link; registrations shared through `live/` files. An action on a sibling's activity the app's one link does not reach → task 17 Q6 fallback (debt). |
| F22 | **Version skew** | Old daemon → `MethodNotFound` → Settings "update tentacle". New daemon + old app → never registers. Widget older than `ActivityContent.v` / unknown `kind` → placeholder. `ContentState` / attributes: fields only added as optionals (Codable ignores unknown keys; a removed key would make iOS drop the update). Unknown `live/<id>.json` `v` → device skipped, file untouched. No protocol bump. |
| F23 | **Hook throws / notifier bug** | Caught in task 16's wrapper; the turn and other clients unaffected (mutation test in L7). |
| F24 | **iPad / Live Activities off in Settings** | `areActivitiesEnabled` false → `unsupported` / `off`; the daemon starts nothing for that device. |
| F25 | **Empty / invalid input** | Bad hex, unknown env, unknown slot → `InvalidParams` / `known:false`; nothing written. Oversized plaintext impossible (clipped; worst-case test). |

### §7 invariants touched

- **One session path:** an observer + a transport; answers ride task 17's
  coordinator over the ONE link and the existing `session/resolve_permission`.
- **Relay/pod not trusted:** sealed on the laptop, sender authenticated, bound
  to the slot; the widget output is display only; JS re-verifies before any
  answer; `push-result` input validated (only `gone` acts, compare-and-delete).
- **Single broker:** untouched (task 17's `answerById` path).
- **Don't serialize the RPC peer:** the three methods take no lock; the store
  write is an atomic rename.
- **Steering no-await window:** the widened hook stays synchronous and O(1);
  L7 extends task 16's "nothing awaited inside `finishTurn`" test.
- **Persistence:** `devices/live/<id>.json` is a new versioned laptop-side file
  family; written only by a `serve` with a device route; update tokens never
  hit disk.
- **Logic in pure modules:** rules, render, registration, reconcile, action are
  pure; Swift follows the TS spec through shared vectors.

### Tests

Red-first for every behaviour; each names its mutation (AGENTS §9).

Unit (`bun test`, in `bun run check`):
- **L1** vectors byte-exact; open with the wrong slot as aad → throws
  (mutation: drop `slot` from aad → fails); `info` of push vs LA not
  interchangeable (a push envelope does not open as an activity); wrong sender
  → throws; lengths ∈ {512, 1024}.
- **L2** round-trip, strip of extra fields, worst-case `ActivityContent`
  (4-byte chars, every cap) + clear fields + fixed `aps` ≤ 4096 bytes; method
  params validation.
- **L3** frames round-trip; unknown `t` still rejected; `features` absent ≡ `[]`.
- **L4** template ignores any daemon `aps` / `attributes-type`; topic suffix
  from config; dates beyond now + 12 h refused; priority-10 budget downgrades
  at N+1 (mutation: drop instead of downgrade → fails); no key → no feature;
  logs carry no token beyond 8 chars.
- **L5** 0600 write/read; unknown `v` skipped, bytes unchanged;
  compare-and-delete keeps a newer token; revoke/reset remove the file.
- **L6** (table, injected clock): turn 19.9 s → nothing, 20 s → start for
  non-attached registered devices only (mutation: include attached → fails);
  ask → immediate start/`asking`; tool updates coalesced to 1 / 15 s;
  heartbeat at 10 min moves stale-date; end → dismissal + 5 min; cancelled →
  `cancelled`; rollover at 7 h 45 min keeps `startedAt` and changes slot
  (mutation: reuse slot → fails); dismissed → no restart same turn, start on
  next turn; cap 3 with oldest-`done` eviction.
- **L7** real `HostedSession` + spy: the hook now sees `turn_start` /
  `tool_call` / `session_title` in emit order; notifier is not an attachment
  (no `recheckAsks` deny with nobody attached); throwing notifier → turn ends
  (F23); nothing awaited in `finishTurn`; methods refused for `token`
  principal; `_token` for an unknown slot → `known:false`; latest-state sink
  keeps only the newest per slot.
- **L8** against task 15's relay + L4 + fake APNs (h2c, task 16 Repro shape):
  the end-to-end chain in the slice table; relay without `"liveactivity"` → no
  frame (mutation: ignore features → the relay closes the socket, test fails);
  link down then `ready` → current state resent once; config validation
  (`startAfterSeconds` −1 / 3601 refused).
- **L9** render table per kind; buttons only for offered `allow_once` /
  `reject_once` (mutation: `allow_always` → Approve → fails); placeholder for
  unknown `v`; vectors regenerated = committed.
- **L10** `app-config.test.ts`: `NSSupportsLiveActivities`, extension bundle
  id, deployment target, keychain group order unchanged (app group first).
- **L11** registration once per (token, env, enabled) per computer;
  `MethodNotFound` → no loop; reconcile ends an unverifiable / no-longer-running
  activity and reports unacked tokens; action with a forged state →
  nothing sent (mutation: trust the intent's params → fails); Approve always
  goes through Face ID (task 17 coordinator spy).

Swift (`bun run test:swift`, macOS, run by `e2e:mobile` preflight): opens every
`la-v1.json` vector; slot mismatch / wrong sender / flipped byte → placeholder;
view-model equals `la-render-v1.json`.

Maestro (`bun run e2e:mobile`, mandatory before merge, L12; iOS 18 and 26
simulators), against real `serve` + local relay + mock model:
`23-la-start` (a mock turn > threshold → hook `seal-activity` pushes `start` →
activity visible on the lock screen), `23-la-asking` (update `asking` →
Approve → Face ID match → daemon truth: `allow_once`; nomatch → still pending),
`23-la-end` (end → "done" shown, gone after dismissal), `23-la-forged`
(non-pinned sender → placeholder, no buttons; daemon truth unchanged),
`23-la-log-canaries` (no title/preview in exported logs). If L0(b) shows
`simctl` cannot push Live Activity payloads, these use a dev-only local-start
hook and the push path moves to D5.

Real server / device (D4 + D5, owner; recorded in Execution with dates):
push-to-start from `serve` → `relay.tentacle.so` → APNs on a killed and a
force-quit app; Dynamic Island compact/expanded on an iPhone 14 Pro+, lock
screen on the owner's iPhone 12 Pro (no Island); locked-phone redaction;
Approve from the lock screen (unlock → app → Face ID); a > 8 h turn (mock
model sleeping) rolls over without a gap; dismiss → no restart; airplane mode
→ stale → converges on reconnect.

### Owner questions

1. **E2E model: the content-state is HPKE-sealed (task 16 keys, `info`
   "tentacle-la/1", bound to the activity slot) and opened inside the widget;
   if L0(a) shows the widget cannot decrypt, fall back to a content-free
   activity (phase + elapsed, no project/title/tool) rather than dropping the
   feature?** **Rec: yes** — the only E2E shape ActivityKit allows; the
   fallback keeps the Island useful without leaking content.
2. **Accept the clear metadata ActivityKit requires (`event`
   start/update/end, priority, timestamps, stale/dismissal dates, slot), so
   the relay and Apple can tell when a turn starts, waits and ends?**
   **Rec: yes** — unavoidable with ActivityKit push; content stays sealed.
3. **Start rule: per device not attached to the session, when a turn has run
   ≥ 20 s (`liveActivity.startAfterSeconds`) or an ask is raised; one activity
   per (device, session), ≤ 3 per device; task 16's notification is still sent
   for asks?** **Rec: yes** — short turns never light the phone, long ones do
   even with a TUI at the desk; the notification stays the reliable channel.
4. **Cadence: tool updates coalesced ≤ 1 / 15 s at priority 5; asking /
   resolved / end at priority 10; heartbeat every 10 min; stale after 15 min;
   "done" stays 5 min?** **Rec: yes** — fits Apple's budget, elapsed is drawn
   locally.
5. **8 h cap: at 7 h 45 min end and push-start a continuation with the same
   start time; a dismissed activity is never restarted for that turn?**
   **Rec: yes.**
6. **Actions: Approve / Deny are non-discoverable `LiveActivityIntent`s that
   open the app; Approve always asks Face ID and is `allow_once` only; Deny
   sends without Face ID; no background answer from the activity in v1?**
   **Rec: yes** — reuses task 17's coordinator; a background Deny can follow
   once task 17's N0(d) budget is known.
7. **Lock screen: show project, phase, elapsed, tool name; hide session title
   and command preview while the phone is locked (`.privacySensitive()`, or
   Island-only if L0(e) fails)?** **Rec: yes** — decision 14's spirit without
   making the activity useless.
8. **Update path: per-activity update tokens, kept in daemon memory only
   (lost on restart → stale → app reconcile); iOS 18 broadcast channels only
   if L0(c) shows background token reports fail on force-quit (a re-plan)?**
   **Rec: yes.**
9. **Sequencing and owner steps: start after task 17 merges; D4a (Apple
   console: widget App ID, keychain group, profiles), D4 (deploy the relay with
   LA support to 142.132.169.22, owner-approved) and D5 (real-device
   checklist) are owner-only?** **Rec: yes** — no executor touches Apple's
   console or the server.

## Execution

## Review

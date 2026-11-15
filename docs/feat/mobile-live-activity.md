# feat/mobile-live-activity — Live Activity / Dynamic Island: push-to-start, end-to-end encrypted updates, the 8 h cap (mobile task 18)

> **Status:** implementation APPROVED by the owner (2026-11-14)
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

**Repro (2026-11-14): the capability is missing.** On the base this branch was
cut from (`88f5a8f9`), a search for
`ActivityKit|LiveActivit|live_activity|liveactivity|NSSupportsLiveActivities|pushToStart`
in `{packages,apps}/**/*.{ts,tsx,json,swift,js}` → **No files found**.
`apps/mobile/app.json` has no `NSSupportsLiveActivities`, no extension target,
no `apps/mobile/targets` / `apps/mobile/modules`. The executor re-runs the
search on `main` after task 17 merged: then the push/NSE pieces exist, still no
Live Activity.

> **Branch state (corrected in fix round 1, 2026-11-15; re-measured in round 2,
> 2026-11-16).** `88f5a8f9` is this branch's **cut point**, not current `main`.
> Current `main` is `b9b2d4fb` and this branch is **315 commits behind** it, so
> none of the push stack the plan builds on exists here yet — `main` moved during
> round 2 (`b44766f8` at 305 behind → `b9b2d4fb` at 315); the merge stays
> conflict-free at the later base (`git merge-tree --write-tree main HEAD` → exit
> 0). The probe is in
> `.tentacle/tmp/mobile-live-activity/precondition-probe.txt`. The plan's
> `file:line` citations were verified **correct at `88f5a8f9`** (23/23) and
> re-mapped to `main`: task 16's push hook shifts every cited line in
> `hosted-session.ts` by +2 … +235
> (`.tentacle/tmp/mobile-live-activity/cite-map.txt`). **L0–L12 must not run on
> this branch as it stands** — the base has to carry `main` first (the
> orchestrator's `git merge-tree` is clean: no conflicts).

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
  called at `:1569`, `:1592`); `Attachment` (`hosted-session.ts:191-203` — the
  file matters: the drift table below now carries it) feeds that set.
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

#### Owner decisions (2026-11-14)

All nine questions: the recommendation (owner: "Tutte come raccomandato").
Execution starts after task 17 (mobile-notifications) is merged. *—
claude-opus-5-5 (orchestrator), 2026-11-14*

## Execution

### Blocked at the load-bearing check — no slice executed

*— claude-opus-5-5, 2026-11-15*

**Verdict: STOP, per the executor brief ("First re-run its load-bearing check;
if it fails STOP") and AGENTS §0.** The plan's own precondition is not met on
this branch, so L0(a) and every daemon slice would be checked against code that
does not exist here. Nothing was implemented, nothing mutated.

**What the re-run says.** Probe output:
`.tentacle/tmp/mobile-live-activity/precondition-probe.txt`.

1. **The branch does not contain task 16 or task 17.** `feat/mobile-live-activity`
   is cut at `88f5a8f9` — the exact commit the Context calls out as the branch's
   base — and carries exactly one change over it: this doc (`git diff --stat
   88f5a8f9 HEAD` → `docs/feat/mobile-live-activity.md | 488 +++++`, nothing
   else). `main` is at `b44766f8` ("Merge branch 'feat/mobile-notifications'",
   i.e. task 17 merged) and the branch is **305 commits behind it**.
2. **Every file the Implementation builds on is absent here and present on
   `main`:**

   | file (plan slice) | on branch | on `main` |
   |---|---|---|
   | `packages/transport/src/push-seal.ts` (L1: "beside `sealPush`") | **missing** | yes |
   | `packages/daemon/src/push-notifier.ts` (L7: "beside `PushNotifier`") | **missing** | yes |
   | `packages/daemon/src/push-rules.ts`, `push-store.ts` (task 16) | **missing** | yes |
   | `packages/daemon/src/relay-link.ts` (L8) | **missing** | yes |
   | `packages/protocol/src/relay.ts` (L3: the `push` frame) | **missing** | yes |
   | `apps/mobile/targets/notification-service` (task 17's NSE) | **missing** | yes |
   | `apps/mobile/native-tests/PushCoreTests` (L10 extends it) | **missing** | yes |

   Also absent on the branch: `onPushEvent` / `PushHookEvent` / `PushNotifier`
   (no match in `packages/daemon/src`), the `push` / `push-result` relay frames,
   and `apps/mobile/modules`.
3. **The load-bearing assumption cannot be checked against the cited code.**
   It rests on "task 16's `onPushEvent` sits right there" in
   `hosted-session.ts:1948-1963`. That hook does not exist on this branch: the
   cited range is `emit()` and `finishTurn` is at `:2505`, and `ask.shown`
   does sit at `:921` / `:1032` — but `grep -c onPushEvent
   packages/daemon/src/hosted-session.ts` → **0**. The line numbers happen to
   match while the hook the assumption rests on is simply not there, which is
   the dangerous case: a check that reads "citations line up ⇒ plan verified"
   would have passed. So the daemon half of the load-bearing assumption is
   unverifiable on this branch, not merely off by a few lines.
4. **Two more preconditions fail outright.** `apps/mobile/src/secure-kv.ts`
   exists but `gate.hold(ms)` does not: on the branch `hold()` takes no budget
   (`foreground-gate.ts:68`), and task 17 is what gives it one (Preconditions
   cite it as `gate.hold(ms)`). Task 17's answer coordinator
   (`answerById` / `RemoteClient.answerPermission`) is likewise absent, so
   L11's action path has nothing to hand to.
5. **The capability repro is still true** (the Context's search over
   `{packages,apps}/**/*.{ts,tsx,json,swift,js}` → no files), but for the wrong
   reason: this branch predates the push stack the feature is supposed to sit
   on. A feat repro that passes because its foundation is missing is not
   evidence of the gap the plan is about.

**Environment, since it bounds what L0 could ever do here.** Xcode 27.1
(27A9275) is installed, but only the **iOS 26.5** simulator runtime is — the
iOS 18 simulator the Tests section requires ("iOS 18 and 26 simulators") is not
present. L0(a)–(g) and every subsequent device/`simctl` step also need the D4a
Apple-console work (widget App ID, keychain sharing group) first. The repo gate
itself runs on this branch (`bunx tsc --noEmit` → exit 0), so the branch is
coherent — it is the prerequisites that are missing, not a broken tree.

**Drift from the Implementation: none — the Implementation is unreachable, not
wrong.** One thing *is* now wrong in the doc and should be fixed by whoever
re-issues the task, not silently by me: the Context's "Resume on `main` @
`88f5a8f`" instruction reads as if 88f5a8f were current `main`; current `main`
is `b44766f8` and the branch was never re-based or re-created after task 17
merged. Per AGENTS §10 this doc rides the code branch, so a re-cut of the branch
also has to carry this doc across (or the branch needs `main` merged **into**
it before L0 — the substantive re-base is the one thing I ran out of standing
to do here).

**The one decision needed.** How to get task 16 + task 17's code under this
branch, then who re-issues. Any of these unblocks L0 onward; all of them are the
orchestrator's call, not an executor's:

- (a) **Re-cut the branch off current `main`** (`b44766f8`) and re-apply this
  doc — cleanest, and what "Starts only after task 17 is merged (Owner Q9)"
  assumes; the plan's `file:line` citations then apply as written.
- (b) `git merge main` into this branch (305 commits; I am forbidden from
  `checkout`/`restore`/`stash`/`commit`, and a conflict-resolving merge of 305
  commits is not an executor's unilateral call).
- (c) Execute L0's probes only (scratch, no code) if the owner wants the
  device questions answered while the branch question is settled — but (a) must
  still happen before L1, and L0(b)'s iOS 18 half needs that runtime installed.

Until then: **L0–L12 all PARTIAL (0 of 13 slices), 0 mutations run.** The gate
was run anyway so the claim is measured, not assumed — `bunx tsc --noEmit`
exit 0 · `bun run lint` "Checked 1292 files … No fixes applied", 0 errors
(baseline-clean, AGENTS §6) · `bun test` **9317 pass, 3 skip, 0 fail** (9320
tests / 670 files, 373 s; the 3 skips are the three opt-in ones). This is the
branch's pre-existing state and says nothing about the feature — it is reported
so a later round can tell "green because untouched" from "green after work". No
changelog fragment was written, because there is no user-visible change to
announce; no `protocol.d/` note, because no schema changed; `protocol.json` was
not regenerated, because nothing it is derived from moved.

### Citation re-check — plan correct at its own base, re-mapped to `main`

*— claude-opus-5-5, 2026-11-15* (fix round 1, Review finding 1)

Review round 1 asked for the plan's `file:line` citations to be re-checked
against the base the branch would actually run on. Evidence:
`.tentacle/tmp/mobile-live-activity/cite-check.ts` → `cite-map.txt`. It reads
`git show <rev>:<file>` only (never the worktree, index or refs) and asserts two
independent things per claim: the symbol really is at the plan's line **on
`88f5a8f9`** (was the plan right when written?), and where that same symbol sits
**on `b44766f8`** (what L0 must actually read).

**Result: 23/23 citations were correct at `88f5a8f9`; 17 of them shifted on
`main`.** So the plan was not wrong — it was written against the pre-task-16
tree. Task 16's push hook (`emit` → `offerPush`) added ~139 lines above the
fan-out point and ~235 above the turn machinery, which is why the old numbers
point at unrelated code on `main` (the dangerous "line numbers line up" case the
previous Execution flagged).

Files: `hs` = `packages/daemon/src/hosted-session.ts` · `upd` =
`packages/protocol/src/updates.ts`. The file column is load-bearing: a line
number without its file is not a citation (see the round-2 note under the
table).

| claim | file | plan line | on main | shift | correct at base? |
|---|---|---|---|---|---|
| emit fan-out | `hs` | `1948` | `2087` | +139 | yes |
| watchers.offer | `hs` | `1962` | `2101` | +139 | yes |
| turn_start (a) | `hs` | `2081` | `2284` | +203 | yes |
| turn_start (b) | `hs` | `2280` | `2483` | +203 | yes |
| eventToUpdate then emit | `hs` | `2458` | `2693` | +235 | yes |
| ask.shown (a) | `hs` | `921` | `1028` | +107 | yes |
| ask.shown (b) | `hs` | `1032` | `1141` | +109 | yes |
| settle() | `hs` | `1136` | `1265` | +129 | yes |
| finishTurn() | `hs` | `2505` | `2740` | +235 | yes |
| finishTurn call (a) | `hs` | `2397` | `2632` | +235 | yes |
| finishTurn call (b) | `hs` | `2468` | `2703` | +235 | yes |
| finishTurn call (c) | `hs` | `2479` | `2714` | +235 | yes |
| finishTurn call (d) | `hs` | `3013` | `3248` | +235 | yes |
| recheckAsks def | `hs` | `1088` | `1217` | +129 | yes |
| recheckAsks caller (a) | `hs` | `1569` | `1704` | +135 | yes |
| recheckAsks caller (b) | `hs` | `1592` | `1731` | +139 | yes |
| Attachment interface | `hs` | `191` | `193` | +2 | yes |
| no own decision (comment) | `hs` | `30` | `30` | same | yes |
| tool_call.title+status | `upd` | `45` | `45` | same | yes |
| turn_start.turnId | `upd` | `242` | `242` | same | yes |
| turn_end.stopReason+error | `upd` | `257` | `257` | same | yes |
| session_closed | `upd` | `290` | `290` | same | yes |
| session_title.title | `upd` | `301` | `301` | same | yes |

**Five** of the six `same` rows are in `packages/protocol/src/updates.ts`, which
task 16 did not touch; the sixth, `no own decision`, is a comment in `hs`
(fix round 2 — the earlier wording said "six … are in `updates.ts`", which was
off by one). **For L0 onward: read the `on main` column, not the prose numbers** —
the Implementation's inline citations stay as written (they are true of the plan's
base) and this table is the translation. One genuinely wrong citation in the old
text is corrected here: the `finishTurn` *end* was cited as a single line
(`:2505`) but that is the **definition**; the four **call sites** are
`:2397`, `:2468`, `:2479`, `:3013` (→ `:2632`, `:2703`, `:2714`, `:3248`).

**Not verified here:** anything the citations resolve to but the plan reasons
*about* — e.g. that an activity can never race a decision. That is L7's test, not
a line-number check.

### Fix round 1

*— claude-opus-5-5, 2026-11-15*

**Scope: the two MEDIUM findings of Review round 1. No code, no slice (L0–L12
remain 0 of 13).** The blocking condition the earlier round reported is
unchanged and re-verified here; what this round fixes is what it could fix
without standing to merge 305 commits — the doc's false base claim and its
unpinned citations, plus the attribution the review flagged.

**Re-verified first (the blocking premise still holds):** `git rev-list --count
HEAD..main` → **305**; `main` = `b44766f8`. `push-seal.ts`,
`push-notifier.ts`, `relay-link.ts`, `protocol/relay.ts` — all absent here,
present on `main`. `grep -c onPushEvent packages/daemon/src/hosted-session.ts` →
**0** here, **4** on `main` (`:397`, `:419`, `:2127`, `:2162`). So L0 would still
be checked against code that is not on this branch. **New evidence for the
orchestrator:** `git merge-tree --write-tree main HEAD` → exit 0, one tree
(`7e9449be…`), **no conflicts** — bringing `main` in is mechanical, not a
305-commit conflict-resolution job. Doing the merge is a commit, which an
executor may not make, so it stays the orchestrator's step (option (a)/(b) of
the earlier round — now known to be conflict-free in both shapes).

**Finding 1 (MEDIUM) — FIXED. Two parts.**

*(a) The false base claim.* `## Context`'s Repro said "On this branch (= `main`
@ `88f5a8f`)" — false, and the source of the whole confusion: `88f5a8f9` is the
**cut point**, while current `main` is `b44766f8`, 305 commits ahead. The Repro
now says "the base this branch was cut from (`88f5a8f9`)", and a call-out under
it states the real gap, the probe file, and that L0–L12 must not run on this
branch as it stands.

*(b) The citations.* The review asked to re-check the plan's line numbers
against the base. Done mechanically, not by eye:
`.tentacle/tmp/mobile-live-activity/cite-check.ts` (reads `git show <rev>:<file>`
only — never the worktree, index or refs) asserts, per claim, that the symbol is
really at the plan's line on `88f5a8f9` **and** finds the same symbol on
`b44766f8`. Output `cite-map.txt`, pasted into the new **Citation re-check**
section above.

**Result: 23/23 citations were correct at `88f5a8f9`; 17 shifted on `main`**
(task 16's push hook sits above the fan-out point: +139 at `emit`, +235 at the
turn machinery; the six unchanged rows are in `protocol/updates.ts`, untouched
by task 16). So the plan was **not wrong** — it was written against the
pre-task-16 tree, which is exactly the distinction the review needed. The drift
table is now the translation for L0 onward. One genuine error was found and
corrected: the plan cited `finishTurn`'s end as `:2505`, which is the
**definition**; the four call sites are `:2397`, `:2468`, `:2479`, `:3013`.

**Finding 2 (MEDIUM) — FIXED as an honest record; the prior signature is not
rewritten.** The review is right that it cannot be true: the earlier Execution
is signed `claude-opus-5-5` inside commit `b5622d6a`, whose subject is
`feat(mobile-live-activity): exec (deepseek)`. I looked for the deciding evidence
before concluding — the prior executor's transcript is not in
`~/.claude/projects` (70 project dirs searched for its own distinctive strings:
no match), and the session store does not attribute that section; the Commit
trailer is just the human owner (`Gabriel Meghnagi`), and `git` alone cannot say
which model wrote a line. **So the truth is: the section's author is
undetermined, and neither the title nor that signature is evidence.** Per §10 the
signature's job is to make drift by model visible; forging it in either direction
would destroy exactly that. I therefore left the earlier section byte-for-byte as
the reviewer found it and record the conflict here instead: **treat that
section's signature as unreliable, and its subject-line "deepseek" as unproven.**
This round's own signature is real — it is the model id in this session's
transcript (`claude-opus-5-5`), read from
`~/.claude/projects/-Users-gmeghnag-tentacle/…jsonl`, not assumed.

**Red before green (AGENTS §9).** Verifier:
`.tentacle/tmp/mobile-live-activity/doc-guard.test.ts` — 6 assertions over the
doc, whitespace-normalised so a wrapped sentence still matches.

- **RED on the pre-fix doc** (`guard-RED.txt`): `1/6 passed`, exit 1 —
  F1a, F1c, F1d, F2a, F2b all fail on the real assertions. (F1b passed
  legitimately: the old text already mentioned `b44766f8`/305 in its Execution.)
- **GREEN after** the edits: `6/6 passed`, exit 0 (`guard-GREEN.txt`).

**Mutations (§9 non-vacuity — each re-broke the doc, observed the test fail,
restored):**

| # | mutation | expected | observed |
|---|---|---|---|
| M1 | restore the stale `(= `main` @ `88f5a8f`)` wording in the Repro | F1a red | **F1a FAIL** (5/6) |
| M2 | rename the drift table's headers (`on main`/`shift` → `moved?`) | F1c red | **F1c FAIL** (3/6) |
| M3 | soften the Result line to "the citations are approximate" | F1d red | **F1d FAIL** (3/6) |
| M4 | forge this round's sign-off to `deepseek-v4` | F2a red | **F2a FAIL** (5/6) |
| M5 | delete the Finding-2 attribution paragraph | F2b red | **F2b FAIL** (5/6) |

**Four of the five mutations first PASSED — each assertion was rewritten to
stop being vacuous.** That is the §2 trap ("proving a weaker correlated
property") caught mechanically, and it is the most useful thing this round
produced:

| # | why it passed while the claim was deleted | fix |
|---|---|---|
| M3′ | F1d matched `/23\/23/` anywhere; the table header *"correct at base?"* satisfied its second branch | anchor on `**Result: 23/23 citations were correct at `88f5a8f9`` |
| M4′ | F2a matched `*— claude-opus-5-5…*` anywhere in the section, so a sub-section's signature covered a forged sign-off | take the section's **first** signature, assert the id equals `claude-opus-5-5` |
| M5′ | F2b matched `/deepseek/i`, which recurs in the mutation table itself | assert the substance: "undetermined" + "treat that section's signature as unreliable" |
| M2′ | the "drift map" regex was satisfied by a header rename | anchor on the exact `\| claim \| plan line \| on main \| shift \|` header |

F1a also needed scoping: an unscoped check tripped on this very section, which
*quotes* the old wording to explain the fix — quoting is not the bug — so it now
reads only the Context/Repro region (before `## Implementation`).

**Drift from the Implementation: none — the Implementation did not run.** The
one doc-level change beyond the findings: the `finishTurn` call-site correction
above, which is a citation fact, not a design change.

**Still PARTIAL, and why.** L0–L12: **0 of 13**. The precondition (task 16 + 17
under this branch) is still unmet, exactly as the previous round reported; no
slice can be executed or mutation-tested until the base carries `main`. Not
verified here: any runtime behaviour of the plan — there is no code to observe.
Environment note carried forward: only the iOS 26.5 simulator runtime is
installed, so the Tests section's "iOS 18 and iOS 26" requirement still needs the
iOS 18 runtime (plus D4a's Apple-console work) before L0 can pass.

**Gate (measured, this round — final run on the finished tree):** `bunx tsc
--noEmit` → exit 0 · `bun run lint` → "Checked 1292 files. No fixes applied", 0
errors/warnings (baseline-clean, AGENTS §6) · `bun test` → **9317 pass, 3 skip, 0
fail**, 9320 tests / 670 files, 370 s
(the 3 skips are the three opt-in ones). This is a doc+scratch round, so green
here means "the doc edits changed no code path", not "the feature works". No
changelog fragment (no user-visible change), no `protocol.d/` note (no schema
change), `protocol.json` untouched.

### Fix round 2

*— claude-opus-5-5, 2026-11-16*

**Scope: Review round 2's two findings, plus one record defect this round found
and fixed. No code, no slice (L0–L12 remain 0 of 13).** The signature is real:
read from this session's transcript
(`~/.claude/projects/-Users-gmeghnag-tentacle/d3ca19a6-….jsonl` — 460 assistant
records, every one `"model":"claude-opus-5-5"`), not assumed.

**Re-verified first (the blocking premise still holds).** `git rev-list --count
HEAD..main` → **315**; `main` = **b9b2d4fb**. `push-seal.ts`,
`push-notifier.ts`, `relay-link.ts` absent here, present on `main`;
`grep -c onPushEvent packages/daemon/src/hosted-session.ts` → **0** here. The
branch is still cut before tasks 16/17, so no slice can run. `main` moved
**during** this round (`b44766f8`/305 → `b9b2d4fb`/315), which is why both
verifiers first went red on the doc's now-stale base claim — that is the guards
working, and the figures above are the final measurement. **New — what round 2
could not do:** `git merge-tree --write-tree main HEAD` → exit 0, **no
conflicts**, re-confirmed at the later base. It writes no ref and no index, so it
is inside an executor's standing; the merge itself is a commit and is not.

**Finding 1 (the branch/base) — FIXED to the limit of an executor's standing;
the merge itself is STILL OPEN and remains the orchestrator's.** Round 2 asked
the orchestrator to confirm the merge is conflict-free before merging; that is
now **confirmed** above, with the tree hash recorded. What I cannot do is perform
it (`git merge` = a commit, and this round is forbidden
`checkout`/`restore`/`stash`/`commit`), so the root cause stays open by design,
not by omission. Nothing here pretends the branch is usable.

**New defect found this round, MEDIUM — the drift table had no file column, so
two of its rows cited a line in the wrong file. FIXED.**

Round 1 added the drift table to stop "line numbers line up while pointing at
unrelated code". It then reproduced that trap itself: the table recorded *which
line*, never *which file*. Eighteen rows are `hosted-session.ts`, five are
`updates.ts`, and a reader following `| Attachment interface | 191 | 193 |` has
no way to know it means `hosted-session.ts:191-203` — the Implementation prose at
`:119` says so, but the adjacent rows are `updates.ts`, so the natural read is
`updates.ts:193`. Measured, that line is `});`. The interface is at
`hosted-session.ts:191` on the base and `:193` on `main` (task 17's `hop` field
is what moves it), so the *number* was right and the *citation* was not — the
worse kind of wrong, because it survives a spot-check of the number.

Fixed by adding the missing `file` column (aliases defined above the table) and
one sentence on why that column is load-bearing. Second, smaller correction: the
prose said "the six `same` rows are in `packages/protocol/src/updates.ts`", but
only **five** are — the sixth, `no own decision`, is a comment in
`hosted-session.ts:30` (`the daemon makes no decision of its own`). Both are
prose/table errors; no design change.

**What was re-verified, mechanically.** Round 2 spot-checked rows by eye and said
so. This round checks **every row against the commits**:
`.tentacle/tmp/mobile-live-activity/r2-cite-verify.ts` reads `git show
<rev>:<file>` only (never the worktree, index or refs) and asserts per row: the
row names a file (A1) · the `on main` line in that file at `main` really is the
claimed symbol (A2) · the `plan line` in that file at `88f5a8f9` really is that
symbol (A3) · `on main − plan line` equals the `shift` cell (A4). The verifier
supplies the symbols; **the numbers come from the doc**, so the two are checked
against each other rather than against themselves.

**Result: 23/23 rows hold on all four assertions** (71 row-level checks) plus 2
doc-level checks = **73/73** (`r2-cite-GREEN.txt`). Round 1's arithmetic and round
2's spot-check were both right: the table's *numbers* were never the problem —
the missing *file* was.

**Red before green (AGENTS §9).**

- **RED on the pre-fix doc** (`r2-cite-RED.txt`): **0/25** — A1 and all 23 A2s
  fail on the real assertion ("row names no file"); A1b fails with the trap
  measured: `updates.ts:193 = "});"`.
- **GREEN after**: **73/73**, exit 0 (`r2-cite-GREEN.txt`).

**Mutations (§9 non-vacuity — each re-broke the doc, observed the named test
fail, restored from `doc-r2-good.md`):**

| # | mutation | expected | observed |
|---|---|---|---|
| M1 | drop the `file` column (header + every row) | A1 red | **A1 + A1b + 23×A2 FAIL** (0/25) |
| M2 | `Attachment` row back to `upd` — the real defect | A1b, A2, A3 red | **3 FAIL** (68/73): A1b; `@ updates.ts:193 on main (found "});")`; `@ updates.ts:191 at 88f5a8f9 (found "unansweredCalls…")` |
| M3 | `emit` `on main` `2087`→`2088` | A2, A4 red | **2 FAIL** (69/73): A2 (`found "const params = toUpdateParams…"`), A4 (`doc=+139 real=+140`) |
| M4 | revert the "Five" correction to "Six" | D1 red | **D1 FAIL** (72/73): `table: 6 same, 5 upd, 1 hs` |
| M5b | base claim `305`→`304` (at the then-current base `b44766f8`) | D2 red | **D2 FAIL** (72/73) |
| M5b′ | base claim `315`→`314` (re-run at the final base `b9b2d4fb`) | D2 red | **D2 FAIL** (72/73) |
| M6 | drop the `file` column vs round 1's guard | F1c red | **F1c FAIL** |

**A vacuous assertion of mine was caught by mutation, not by reading.** D2 first
asserted the flat text `includes("305 commits behind")`; **M5 (inserting a hedge
right after the claim) still passed 73/73**. Fixed to parse the sentence's actual
number and compare it with `git rev-list --count HEAD..main`, which M5b then
failed correctly. Reported rather than hidden: **M5c (appending a clause after a
correct claim) still passes**, and that is not vacuity — the claim stays true and
no assertion should fail on a true claim.

**One regression I introduced, and fixed.** Round 1's `doc-guard.test.ts` F1c
pinned the exact old header `| claim | plan line | on main | shift |`, so adding
the `file` column turned a passing test red (5/6). I did not delete the test: F1c
now asserts the **stronger** header including `file`, and M6 proves it still bites
(drop the column → F1c FAIL). Guard now **6/6**.

**Drift from the Implementation: none — the Implementation still did not run.**
Both doc edits are record corrections (a citation's file, a miscount); neither
touches the design, the slices or any precondition.

**Still PARTIAL, and why.** L0–L12: **0 of 13**. Precondition unchanged — the
branch does not carry `main`; the merge is conflict-free but is a commit, which
this round may not make. Not verified here: any runtime behaviour of the plan (no
code exists to observe), and the iOS 18 simulator runtime is still absent (only
26.5 installed), which L0(b) needs alongside D4a's Apple-console work.

**Gate (measured, final run on the finished tree):** `bunx tsc --noEmit` → exit
0 · `bun run lint` → "Checked 1292 files in 371ms. No fixes applied", 0
errors/warnings (baseline-clean, AGENTS §6) · `bun test` → **9317 pass, 3 skip, 0
fail**, 9320 tests / 670 files, 368 s (the 3 skips are the three opt-in ones),
re-run on the finished tree after the last doc edit.
Doc+scratch only: `git status --short` → `M docs/feat/mobile-live-activity.md`,
nothing else, so green means "the doc edits changed no code path", not "the
feature works". No changelog fragment (no user-visible change), no `protocol.d/`
note (no schema change), `protocol.json` untouched.

**Scratch location, honestly.** AGENTS §6 names
`<repo root>/.tentacle/tmp/<slug>/`, but this session's write scope is the branch
worktree, so the evidence sits in
`.tentacle/worktrees/mobile-live-activity/.tentacle/tmp/mobile-live-activity/`
(where round 1 also put it). Both are gitignored; nothing is lost, and a reviewer
must look there.

## Review

*— claude-opus-5-5, 2026-11-15*

**Verdict: REQUEST-CHANGES. Nothing to approve: no code was built. The
executor was right to stop.**

`git diff main...HEAD` is this doc alone (+99 lines of Execution). None of the
L0–L12 slices exist, so there were no §7 invariants, failure modes or new tests
to attack, and no mutation to run.

**Premise check (were the executor's blocking claims true?):**

| claim | result |
|---|---|
| branch is 305 commits behind `main` | TRUE (`git rev-list --count HEAD..main` → 305) |
| only this doc differs from `88f5a8f9` | TRUE (`git diff --stat 88f5a8f9 HEAD` → this doc only) |
| `push-notifier.ts`, `push-seal.ts`, `relay-link.ts` missing here, present on `main` | TRUE (Glob finds none here; `git cat-file -t main:<path>` → blob for each) |
| `onPushEvent` absent from `hosted-session.ts` | TRUE (0 matches) |
| `gate.hold()` takes no budget | TRUE (`apps/mobile/src/foreground-gate.ts:68` `function hold(): Promise<void>`) |

**Gate:** `bun run lint` passes: 1292 files checked, nothing to fix.
`bun run typecheck` passes. `bun test` was not re-run: no code changed, and the
executor's run (9317 pass, 3 opt-in skips, 0 fail) describes the base this
branch already has.

**Findings:**
1. **MEDIUM — the branch can't carry this feature.** It is cut before tasks 16
   and 17 (doc:4, :67 still say "resume on `main` @ `88f5a8f`"). The
   orchestrator must re-cut it from current `main` (`b44766f8`) and carry this
   doc across (option (a)), then re-check the line numbers the plan cites
   (e.g. `hosted-session.ts:1948-1963`) against that base before L0.
2. **MEDIUM — who wrote the Execution section is unclear.** Commit `b5622d6a`
   is titled "exec (deepseek)", but the section is signed `claude-opus-5-5`.
   §10 needs an honest signature so drift by model can be tracked. Whoever
   re-issues the task must fix one or the other.

**Attacks tried:** (1) checked whether the "blocked" claim was just a misread
line number. It is not: the line numbers match, but the hook is missing. (2)
looked for any code change slipped in beside the doc: none. (3) checked whether
the stop hid a change that broke the gate: lint and typecheck are clean.

**Executor behaviour:** correct and disciplined. It applied the brief's
load-bearing STOP instead of building on code that isn't there. It wrote no
code, ran the gate so the result was measured, and escalated with one specific
decision for the orchestrator.

**Same model family?** The section is signed by the same model family as this
reviewer, so blind spots may be shared. For this doc-only round that risk is
low.

### Round 2

*— claude-opus-5-5, 2026-11-15*

**Verdict: REQUEST-CHANGES. The executor fixed everything it could; the
remaining fix needs the orchestrator.** `git diff HEAD~1` changes only this
doc. The branch is still 305 commits behind `main`, and L0–L12 are still
0 of 13.

- **Finding 1(a), the false base claim — FIXED.** The Repro now names
  `88f5a8f9` as where the branch was cut, and a new note under it says how far
  behind `main` the branch is. Mutation M1 (put the stale "= `main` @
  `88f5a8f`" wording back): `doc-guard.test.ts` F1a FAILS (5/6). Reverted; the
  tree is clean.
- **Finding 1(b), the line numbers — VERIFIED independently.** I dumped
  `git show main:packages/daemon/src/hosted-session.ts` myself. On `main`:
  `ask.shown` is at :1028/:1141, `recheckAsks` at :1217 (called at
  :1704/:1731), `watchers.offer` at :2101, the `finishTurn` calls at
  :2632/:2703/:2714/:3248 and its definition at :2740. On the branch base:
  :921/:1032, :1088, :1569/:1592, :1962, :2397/:2468/:2479/:3013 and :2505.
  Every row I checked matches the table, and so does the `finishTurn`
  definition-vs-call-sites correction.
- **Finding 1, the root cause — STILL OPEN, orchestrator's action.** Fixing the
  base needs a merge or a re-cut, which is a commit and outside an executor's
  standing. I could not re-run the executor's claim that
  `git merge-tree main HEAD` is clean: running it needed an approval I don't
  have. The orchestrator should confirm it before merging.
- **Finding 2, who wrote Execution — FIXED honestly.** The doc now says the
  author is undetermined and the earlier signature is unreliable. Nothing was
  forged and the earlier section was not rewritten.
- **Regressions:** none. Only Markdown changed. `bun run lint` checked 1292
  files with nothing to fix, and `bun run typecheck` passes.
- **Minor (no effect on the verdict):** the executor's evidence files are in
  the worktree's `.tentacle/tmp/`, not the repo root's that AGENTS §6 names.
  Both are gitignored, so nothing is lost.

**To clear:** the orchestrator merges `main` into this branch or re-cuts it
from `main`. Then the real Execution, L0 onward, needs its own review.

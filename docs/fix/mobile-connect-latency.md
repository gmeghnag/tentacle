# fix/mobile-connect-latency — the phone connects at once and re-reads a session reliably

Type: fix · Size: M · Blast: cross-module (app link + `@tentacle/client`) · Suited: Opus plan → executor → Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-24*

Owner 23/11 ~23:55: on the iPhone a Mac session (the owner's `serve` in ~/assistant, via relay.tentacle.so) stays «connecting» a few seconds, on a cold open AND back from background; and sometimes, after a reconnect, the session shows in red «could not re-read this session — showing what was already loaded» with the composer saying «This session has ended», until the owner switches to another session and back. A Sonnet triage (code-read, NOT device-proven) wrote `.tentacle/tmp/connect-latency/REPORT.md` — read it all; its file:line claims must be re-verified, its causes proven (red-first fake-clock tests) before fixing:
- `address-dial.ts:43` `STAGGER_MS` 750 per direct address even when the previous one rejected fast (the Mac advertises LAN + Tailscale before the relay → ~1.5 s off-LAN); `lastGood` not persisted across a cold start.
- `suspend()` starts a full-jitter backoff (≤ 30 s); `resume()` does not redial now; attempts may count while suspended.
- serial relay round trips (relay dial → Noise → initialize → session/open) — measure with per-phase timing logs; parallelise only what is safe.
- re-read: `resync()` (`session-screen-controller.ts:2147`) does `leave` then `attach`; if the attach fails (`gone` when the entry is `closing`, `remote-client.ts:4236`; or a 30 s timeout) the screen stays `failed` with no handle, and `link(up)` never retries (`remote-client.ts:1793`); the «ended» placeholder (`SessionScreen.tsx:1685`) is wrong for this state.
Owner 24/11 ~00:10: queue it right after `feat/mobile-native-sheets` (with `feat/image-view`). `feat/workflows-ui` (branch, unmerged) touched `client/src/remote-client.ts` (slice 1b) — list the overlap and how to avoid a conflict.

## Implementation

*— claude-opus-5-5 (planner), 2026-11-24 — **NOT approved yet** (the owner approves it)*

Line numbers are for `main` at `9ba88709`. `feat/mobile-native-sheets` merges first and shifts them in
`App.tsx` / `SessionScreen.tsx` (see *Overlap*): re-locate by symbol, not by number.

### Triage claims, re-verified

| Claim (REPORT.md) | Verdict | Evidence |
|---|---|---|
| W1: a fast-failing address still holds the next one back by `STAGGER_MS` | **true** | `address-dial.ts:43` (750); the reject branch `:263-273` records the error and never calls `startNext()`, so slot *i+1* starts only from the timer `arm()` set at `:240/257` |
| W2: `lastGood` is in-process only | **true** | `connection.ts:288` `const memory = { lastGood: undefined }` is built per `openComputer`; header `address-dial.ts:23-25` says so |
| Direct first, relay last | true | `pair-addresses.ts` `directFirstRelayLast` (header `address-dial.ts:7-8`). **Not verified**: how many direct addresses the owner's phone record holds and whether an off-LAN direct address *rejects* or *hangs* on iOS — that decides how much W1 alone buys (the phase log in slice 1 answers it) |
| W3: `resume()` never redials now | **true** | `foreground-gate.ts:153-159` only releases a dial already parked; the client's redial is `dialTimer` (`remote-client.ts:3417-3422`), armed by `schedule(linkDropped(...))` at `:3388` with full jitter `backoffMs` (`link-machine.ts:93-96`, ceiling 500·2^attempt, cap 30 s). Nothing public cancels `dialTimer` except `close()` (`:3117`) |
| W4: attempts count while suspended | **true** | a parked dial is rejected after `LIVENESS_MS` 15 s by `dialChannel` (`remote-client.ts:3339-3346`) → `redial` → `dialFailed` keeps `attempt` and schedules `attempt+1` (`link-machine.ts:143-160`); `attempt` resets only in `linkDropped` after `STABLE_UP_MS` 10 s up (`:138`), never at `linkUp` (`:163`) |
| re-read: `resync` = leave then attach; a failed attach leaves the screen handle-less | **true** | `session-screen-controller.ts:2120-2153`: `controller.leave` (`:2136`), `handle = null` (`:2137`), `attach(false)` (`:2141`); on failure `status = {phase:"failed"}` (`attach`, `:1469-1476`) |
| `link(up)` never retries a failed screen | **true** | `:1781-1795`: the outbox and the owed resync both require `status.phase === "open"`; `resyncOnUp` is consumed at `:1792` before that check |
| `link(up)` reaches the screen in the same tick as the client's `recover` | **true** | `RemoteClient.dial` calls `emitStatus(up)` (`remote-client.ts:3460`) **then** `recover(entry)` for every entry (`:3461-3463`), synchronously; the app subscribes the screen synchronously (`App.tsx:1834` `link.onStatus((s) => created?.link(s.state === "up"))`). `controller.leave` defers its detach one microtask (`session-controller.ts:150-164` `serialise` → `previous.then(run)`), so `recover` sends `session/open{since}` for the OLD entry first, then the detach marks it `closing` (`remote-client.ts:1955`) and the new attach registers a NEW entry (`:3491` — a `closing` entry is replaced) |
| the reason the attach fails (`gone` / `timeout` / `link`) | **NOT proven** | three typed paths exist (`session-controller.ts:85-103`; `whenLive` `remote-client.ts:4236-4250`; `ATTACH_TIMEOUT_MS` `:1494-1506`); the screenshot (`.tentacle/tmp/connect-latency/owner-reread-failed.jpg`) crops the banner that would name it. Slice 3 reproduces it; the trace `{kind:"attach", state:"fail", reason}` (`session-screen-controller.ts:1469`) is in the phone's export |
| «This session has ended» is the generic `!editable` placeholder | **true** | `SessionScreen.tsx:1683-1687`; `editable:false` for `opening` (`session-view.ts:380,389`), `failed` (`:403`) and ended (`:413`) — and the decision sits in a component (AGENTS §7 debt) |
| `resyncOnUp` can simply be dropped (REPORT E.3) | **false — keep it** | it exists because a device capture showed the redial re-reads nothing on this screen (`session-screen-controller.ts:1126-1133`, `docs/fix/mobile-queued-stuck.md` (c)); its test `session-screen.test.ts:1013-1037` pins it |

### Load-bearing assumption

**Every slow or broken path here is in the phone's dial/redial scheduling and in the screen's re-attach — none is on the
wire or in the daemon — so the fix needs no protocol, daemon or relay change.** Proof: W1/W2 are inside `firstAnswering`
(pure, `address-dial.ts:150-313`, timer injected); W3/W4 are inside `RemoteClient`'s own scheduler (`schedule`/`dial`,
`remote-client.ts:3407-3473`) and the gate (`foreground-gate.ts`); the re-read failure is client/app-side ordering
(table above) and the daemon side is benign (`session/detach` is SYNCHRONOUS and a no-op for an id not attached here,
`daemon/src/connection.ts:1067-1078`, re-verified — so a detach cannot overtake a later open on the same connection; the
owner's switch-away-and-back proves a fresh `session/open` succeeds). Open residue: the recover's `session/open{since}`
for the OLD entry is async daemon-side and may finish after the detach. If slice 3's repro shows the daemon refusing or
silently dropping the new attach because of that, this assumption breaks: **STOP and re-plan** (it would be a daemon fix and a
`load-bearing` blast). W6/W7 (serial relay round trips) are NOT changed here: they are only measured (slice 1), because
parallelising `initialize`/`session/open` or pre-opening daemon legs touches the wire and the relay (Owner Q4).

### Preconditions (verified)

- `firstAnswering` takes an injectable `DialTimer` (`address-dial.ts:46-48, 93-94`); `address-dial.test.ts` already has
  `manualTimer()` (`:113`). `pairing.ts` also calls `firstAnswering` — W1's change applies to pairing too (wanted; its
  `isTerminal` override is untouched).
- `RemoteClient` takes `clock` and `random` (`remote-client.ts:532-534`); `reattach.test.ts:1090` has `manualClock()`.
- `apps/mobile/test/session-link.test.ts:130-190` drives a REAL in-process daemon (`SessionHost` + `Connection` +
  `createChannelPair`) through the app's own `createForegroundGate` (`gate: true`, `suspend`/`resume`), and
  `apps/mobile/test/outbox-link.test.ts:54-55` already mounts `createSessionScreen` on a real client — slice 3's repro
  composes the two; no new fake.
- The stored computer record is rebuilt field-by-field on load (`computer-store.ts:226-255`): an unknown field from a
  newer build is dropped, an absent optional one loads (the `thisDeviceName` precedent, `:241-247`).

### Design

Four slices, in order. Each slice: red test first, then the fix.

**Slice 1 — evidence first (phase timing, no behaviour change).** In `connection.ts` log, through the existing
`log.log("info", …)` (`:183`), one entry per phase with `ms` since the dial started: `dial-open` per address
`{slot, kind: "direct"|"relay", ok, ms}` (the slot and kind, never the IP — the export leaves the phone),
`dial-confirm {ms, ok}`, `dial-init {ms}` (first `initialize` only). In `session-screen-controller.ts` the existing
`trace` gets `ms` on `attach ok/fail`. This is what proves on the device which wait dominates after slices 2–3, and
whether off-LAN directs reject or hang. It ships (it is the only device-side evidence path we have).

**Slice 2a — W1: a failed open starts the next address at once** (`address-dial.ts`, reject branch `:263-273`). When an
`open` rejects while the race is undecided and an unstarted address remains, cancel `armed` and call `startNext()` now.
Everything else is unchanged: the stagger still governs an open that HANGS, the winner/abandon/`failed`/terminal rules
are untouched. Effect: two fast-failing directs → relay starts at t≈0 instead of t=1500 ms. With no address left, the
round still fails as today.

**Slice 2b — W2: remember the winning address across a cold start** (Owner Q1, recommended yes). Persist the winning
address **string** (not the index: `setAddresses` — the `daemon/discover` refresh, `computer-store.ts:188-189` — can
reorder or replace the list, and an index would then point at a different address). `StoredComputer` gains optional
`lastAddress?: string`; `openComputer` maps it to `memory.lastGood` (`addresses.indexOf`, `-1` → `undefined`) and, after a
success whose winner differs, calls a new `OpenComputerDeps.onAnswered?(address)` that the app wires to a new
`store.setLastAddress(id, address)` (same rules as `setAddresses`). Best effort: a failed write is logged, never fails
or delays the dial. No other memory is persisted.

**Slice 2c — W3/W4: coming back to the foreground dials NOW.** A pure step in `link-machine.ts`:
`linkResumed(state): LinkStep | null` — `null` when `up`, `dialing` or `stopped` (nothing to anticipate: an `up` link is
fine, a `dialing` one is the dial the gate just released, a `stopped` one is terminal); otherwise
`{ state: {...state, kind: "backoff", attempt: 0}, dialInMs: 0, status: reconnecting(attempt 0) }`. Resetting
`attempt` to 0 is what makes the attempts counted in the background (W4) harmless: a return is a fresh start, not the
N-th retry. `RemoteClient.redialNow()` (public): `if (disposed || stopError || !channelFactory) return;` compute
`linkResumed(this.link)`; if a step, clear `dialTimer` and `schedule(step)`. `connection.ts` `resume`:
`const was = gate.isSuspended; gate.resume(); if (was) client.redialNow();` — only a REAL return redials (a duplicate
`active` is a no-op twice over). The method is added next to `schedule`/`dial` (`remote-client.ts:3407-3473`) — see
*Overlap*.

**Slice 2d — the gate suspends on `background` only** (Owner Q2, recommended yes). Today `App.tsx:2256-2260` suspends on
ANY non-`active` state, so `inactive` (Face ID prompt of the app lock, Control Center, a call banner) closes the socket and
forces a full redial on return — the screen controller already learned that `inactive` is not a departure
(`session-screen-controller.ts:1803-1808`, Review round 5). Move the decision into a pure `foregroundAction(state)`
(`foreground-gate.ts`: `"active"` → `resume`, `"background"` → `suspend`, else nothing) and make `App.tsx` call it; the
same applies to the launch path `App.tsx:615` (`AppState.currentState !== "active"` → only `=== "background"`). Safe:
iOS always passes through `background` before it suspends JS.

**Slice 3 — the re-read never strands the screen.**
- *3a, reproduce* (red, before any fix): in a new `apps/mobile/test/session-resync-link.test.ts` mount
  `createSessionScreen` on a real client from the `session-link` harness with `gate: true`, the screen subscribed to
  `client.onLinkStatus` **synchronously**, exactly as `App.tsx:1834` does. Script: open a seeded session → `suspend()`
  (link drops) → `screen.appState("background")` → `screen.appState("active")` (owed: `resyncOnUp`) → `resume()` → link
  up. Assert at the end: `status.phase === "open"`, `view.editable === true`, no `RESYNC_FAILED_NOTICE`, and the daemon
  lists the session `attached` by this client. Record the trace's `reason`. Two-strike rule (§0): if two variants
  (second: also drive a concurrent `controller.open` of the same id, as the hub/outbox do) stay green, STOP and ask the
  owner for the phone export (`grep ptrace`, Owner Q3) — do not guess a root cause.
- *3b, root cause* (chosen by 3a's reason; the plan's expectation, to be confirmed): the owed resync must not race the
  client's own re-attach of the same id. Run it **after** `recover` for that id has settled, not in the `emitStatus` tick:
  the screen's `link(up)` defers the owed resync until the handle reports live on the new generation (the client already
  knows: `whenLive`/`liveGen`). Expose that as a promise on the existing session handle (`RemoteSession`), additive, no
  wire change — or, if 3a shows the failure is the daemon detaching the new attach, STOP (load-bearing assumption).
- *3c, the net* (mandatory whatever 3b finds): a screen in `phase: "failed"` with a RETRYABLE reason (`link`, `timeout`,
  `gone` — exactly the reasons `failureBanner` marks `retry: true`, `session-view.ts:301-313`) re-attaches once per
  `link(up)`, with the same guards (`!disposed && !attaching && !refreshing`). Never for `archived` / `deleted` /
  `too-many` (a person's decision). One attempt per `up`: bounded by link-ups, never a loop. The decision goes in a pure
  helper (`retryOnUp(status)`) in `session-screen-controller.ts`'s module family, unit-tested.
- *3d, copy*: the placeholder moves into the view-model (`session-view.ts` `composer.placeholder`, §7: a branch is logic,
  not presentation): `ended` → «This session has ended»; `failed` → «Not connected — tap Retry» (retryable) / the banner
  owns the non-retryable text, placeholder «Session closed»; `opening` → «Loading…»; editable → `undefined` (the
  component keeps the voice/default). `SessionScreen.tsx` only reads it.

### Files (dependency order)

1. `packages/client/src/address-dial.ts` (2a) · `packages/client/src/link-machine.ts` (`linkResumed`, 2c) ·
   `packages/client/src/remote-client.ts` (`redialNow`, 2c; the 3b live-promise only if 3a points there) ·
   `packages/client/src/remote-session.ts` (3b, only if needed) · `packages/client/src/index.ts` (export, if needed).
2. `apps/mobile/src/computer-store.ts` (`lastAddress`, `setLastAddress`, 2b) · `apps/mobile/src/connection.ts` (phase
   log 1, `lastAddress`/`onAnswered` 2b, `resume` → `redialNow` 2c) · `apps/mobile/src/foreground-gate.ts`
   (`foregroundAction`, 2d) · `apps/mobile/src/session-screen-controller.ts` (trace `ms` 1, 3b, 3c) ·
   `apps/mobile/src/session-view.ts` (placeholder, 3d).
3. `apps/mobile/App.tsx` (`onAnswered` wiring, `foregroundAction` at `:615` and `:2254`) ·
   `apps/mobile/src/screens/SessionScreen.tsx` (read `placeholder`, 3d).
4. Tests (below) · `changelog.d/mobile-connect-latency.fixed.md` (user-visible).
No protocol, daemon, relay or TUI file. No `protocol.d/` note.

### Failure modes → how state converges

- **All addresses fail fast** (phone offline): the round now fails at once instead of after N·750 ms; the client's
  backoff (`dialFailed`) still spaces redials — no hot loop (test).
- **A direct address hangs**: unchanged — the stagger starts the next one after 750 ms; 2b makes the relay first on the
  next cold start if it won last time.
- **Persisted address no longer in the list** (discover refresh): `indexOf` → `-1` → start at 0, as today. **Write
  fails**: logged, dial unaffected. **Back on the LAN with `lastAddress` = relay**: the relay is tried first and wins
  (works, a few ms slower) — the same behaviour the in-process memory already has today; noted as debt, not fixed here.
- **`redialNow` races the backoff timer**: it clears `dialTimer` before scheduling (one dial). **While a dial is in
  flight** (`dialing`, incl. the one the gate just released): no-op. **After a terminal stop** (`unauthorized`,
  VersionMismatch): no-op — a return never revives a revoked phone. **Disposed / closed client**: no-op.
- **Duplicate `active`** / `inactive`↔`active` blips: `was` is false → no redial, no socket drop (2d).
- **A dial parked > 15 s in the background** (W5): `dialChannel` gave it up; the gate's generation supersedes it on the
  next `dial()` (`foreground-gate.ts:118-133`), which `redialNow` now starts at once.
- **Re-read during a link flap**: the owed resync waits for the next `up` (unchanged); a failed one is retried at the next
  `up` (3c). **Archived / deleted while away**: failed, not retried, honest banner (unchanged). **Screen disposed while a
  retry is pending**: the `disposed` guard (`attach` `:1464`) drops it.
- **Version skew**: none — no wire field changes; an older record without `lastAddress` loads; an older build drops the
  field on rewrite (harmless: a hint).

### Tests (each shown RED on today's code first, §9)

| # | File | Asserts | Red today because |
|---|---|---|---|
| T1 | `packages/client/test/address-dial.test.ts` | 3 addresses, opens 1–2 reject at once → open 3 is started **before any timer fires** (`manualTimer` has fired nothing) | 3 starts only from the stagger timer |
| T2 | same | a HANGING open 1 still delays open 2 by exactly `staggerMs` (the stagger is kept for hangs); all-fast-fail → rejects with the last error, no timer left armed | guards 2a against over-reach (green both sides by design; its mutation: start every address at t=0 → red) |
| T3 | `apps/mobile/test/computer-store.test.ts` (existing) + an `openComputer` test with a fake `WebSocket` | `lastAddress` round-trips; maps to `lastGood`; an address missing from the list → start 0; a success on a different address calls `onAnswered` once | field does not exist |
| T4 | `packages/client/test/link-machine.test.ts` | `linkResumed`: `null` for up/dialing/stopped; backoff with `attempt: 5` → `attempt 0`, `dialInMs 0` | function does not exist |
| T5 | `packages/client/test/reattach.test.ts` (`manualClock`) | link up > 10 s, drop, `random: () => 0.999`, fail dials until attempt ≥ 4; then `redialNow()` → the factory is called **with no clock advance**; second `redialNow()` while dialing → no second factory call; after a terminal stop → no call | today the dial waits the backoff (up to 8 s+) |
| T6 | `apps/mobile/test/session-link.test.ts` (real daemon, `gate: true`) | suspend, advance the client past 2× `LIVENESS_MS`, `resume()` → link `up` within one tick budget (no backoff wait) | today resume only releases a parked dial |
| T7 | `apps/mobile/test/foreground-gate.test.ts` | `foregroundAction("inactive")` → none; `"background"` → suspend; `"active"` → resume | function does not exist |
| T8 | `apps/mobile/test/session-resync-link.test.ts` (new, 3a) | the repro above ends `open`/editable/no notice/attached | the reported bug (if it does not go red: §0 two-strike → Owner Q3) |
| T9 | `apps/mobile/test/session-screen.test.ts` (`countingHarness`) | failed with `link`/`timeout`/`gone` + `link(true)` → one re-open; `archived`/`deleted`/`too-many` → none; two `up`s with the retry still failing → exactly two opens, not more | `link(up)` ignores `failed` (`:1793`) |
| T10 | `apps/mobile/test/session-view.test.ts` | placeholder per phase (ended / failed-retryable / failed-other / opening / live → `undefined`) | field does not exist |

Non-vacuity (§9): T5 and T8 are each re-run with the fix mutated away (`redialNow` body emptied; 3b's deferral removed)
and must go red. Narrow runs per slice (`bun test packages/client/test/address-dial.test.ts`, …); full `bun run check`
before Review.

### Mac + iPhone parity

- **Dial race (2a/2b)**: iPhone-only by construction — `firstAnswering` is called only by `apps/mobile/src/connection.ts`
  and `packages/client/src/pairing.ts`; the Mac's `tentacle connect` dials one URL. 2a also speeds up the phone's
  PAIRING over several addresses (same rule, same tests).
- **`redialNow` (2c)**: lives in `RemoteClient`, shared by both; only the phone calls it (the Mac has no foreground gate:
  a laptop's process is not frozen by the OS, so its backoff is the right behaviour). No TUI change.
- **Re-read (3)**: the TUI has no leave+attach resync (its re-attach is the client's `recover`, the same path), so 3a–3c
  are phone-only; 3b, if it lands in `RemoteSession`, is additive and inert for the TUI.
- **Copy (3d)**: the TUI's own ended/failed wording is unchanged.

### Overlap with other branches (and how to avoid a conflict)

- **`feat/workflows-ui`** (unmerged) adds to `remote-client.ts` at `main` lines ~104, ~184, ~441, ~778, ~848 (a
  `SessionEntry` field), ~965, ~1578 (+97 lines of methods), ~3515 (in `register`), ~3579, ~4000, ~4189, ~4374, and to
  `remote-session.ts` (+126), `index.ts`, `mapping.ts`. This plan touches `remote-client.ts` only in
  `schedule`/`dial`/`redial` (`:3407-3473`, ≥ 40 lines from the nearest hunk at 3515) plus one import line near `:130-136`
  (`linkResumed`, inside the `./link-machine.ts` import — not the `@tentacle/protocol` import blocks the branch touches).
  Rules for the executor: **do not** touch `SessionEntry`, `register`, or the `index.ts` export block unless 3b needs it;
  if 3b needs a `RemoteSession` member, add it at the END of the interface/class (the branch inserts mid-file); whichever
  merges second resolves a textual conflict only.
- **`feat/mobile-native-sheets`** (unmerged, merges first per the owner's queue) rewrites large parts of
  `SessionScreen.tsx` (hunks to ~1892) and adds to `App.tsx` (~1741-1886, ~2377, ~2769-2818) and touches
  `remote-client.ts:4718` (one line). The orchestrator merges `main` into this branch **after** native-sheets lands and
  **before** Execution starts; 3d's component edit is one prop read.
- **`feat/image-view`**: only `docs/feat/image-view.md` so far — no overlap.

### Owner questions (only what the eval did not decide)

- **Q1 — persist the winning address (2b)?** It adds an optional field to the phone's computer record. *Recommend yes*:
  without it W1 is re-paid on every cold start whenever the directs HANG rather than reject.
- **Q2 — suspend only on `background` (2d)?** *Recommend yes*: today every Face ID prompt / Control Center pull drops the
  socket and costs a full reconnect; the screen controller already treats `inactive` as not leaving.
- **Q3 — the phone's log export**, if T8 cannot reproduce in two attempts: the `ptrace` `attach fail` `reason` of one
  occurrence. *Recommend*: send it now if handy — it decides 3b's root cause directly.
- **Q4 — W6/W7 (serial relay round trips, ~8–10 RTT) out of this fix?** *Recommend yes*: measure with slice 1 first;
  pipelining `session/open` with `initialize` or pre-opened daemon legs is a wire/relay change for a separate task, only if
  the measured phase justifies it.
- **Q5 — start the relay in parallel with the first direct** (REPORT option)? *Recommend no*: it opens a relay leg (and a
  daemon-side stream) on every dial, LAN included; 2a + 2b cover the off-LAN case without that cost.

## Execution

## Review

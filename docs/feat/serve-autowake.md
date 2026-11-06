# feat/serve-autowake — a `serve` daemon wakes its own session on a background-job exit when nobody is attached

> **Status:** executed (awaiting fresh-context Review)
> **Branch:** `feat/serve-autowake` — off `main` @ `70ec587` (v0.3.0; `fix/attach-unflushed-exits`, `fix/run-rm-flag`, `feat/tui-light-theme` merged)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the daemon starts a model turn on its own inside `HostedSession`'s one busy slot, default ON; no §7 invariant is changed, but the turn lifecycle, the permission-ask-with-nobody rule and the persistence boundary are all exercised) · **Suited:** Opus executes; mandatory fresh-context Opus Review that red-teams the busy slot, the ask-with-nobody-attached case and the compose with the attach-time wake

Planned read-only on `main` @ `416be44` (detached). Line citations below are the plan's (`416be44`); re-verified on `70ec587` — where the code moved or the design changed, see **Execution → Drift** (the plan text is kept as approved, with `[as-built]` marks at the changed points).

## Context

*— claude-sonnet-5-5, 2026-11-06*

**Problem (owner, 2026-11-06).** A background job that ends while a `serve` session has no client attached leaves its exit unflushed until someone types or attaches. Today only two places wake: the TUI (`packages/tui/src/App.tsx:660-684`, `wakeDue` at `:680`) and the `run --detach` relay (`packages/cli/src/relay.ts:422`, `relay-state.ts:relayWakeDue`). `HostedSession` sees the exit (`packages/daemon/src/hosted-session.ts:451-459`) and only streams `background_exit`; the agent keeps it in `pendingExits` (`packages/agent/src/agent.ts:535`, drained only at a turn's start, `:795`/`:1821-1826`). `fix/attach-unflushed-exits` (owner answers 2026-11-06, Q2 A) makes an *attaching* TUI wake for it; this task makes the *daemon* wake when nobody comes. Owner's rules (TODO entry): the `autoWake` switch, a `failed` run never wakes, one wake per job end, no limit, an attached TUI wakes instead (no double wake), pods out, reuse `@tentacle/core` `auto-wake.ts`.

**Repro (feature missing).** `tentacle serve` + `tentacle connect`; ask the agent to start `sleep 5; echo done` as a background job and end its turn; quit the TUI (detaches); wait 30 s; `tentacle connect --resume` → the history ends at the agent's "started" message, no `[background]` flush, no wake. Not run live; red test W-1 below is the repro.

**Constraints.** AGENTS §7: the daemon on `serve` is the user's own host and already holds the model (`serve.ts:180`, `buildAgent` from the daemon's `config`), so no extra process and no creds move; persistence on a trusted `serve` daemon is the existing `SessionPersister.schedule` path, nothing new on disk; the peer is never serialised (the wake is a daemon-internal call to `prompt`, not an RPC handler); no pod (pod daemons and the in-process worker build `SessionHost` without the option → off, §7 "model stays on the laptop").

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

**`HostedSession` can start a continuation turn from inside the daemon, with no request, through the same `prompt()` a client uses, and `prompt()` is race-free against a client's concurrent `prompt`.** Proof:
- `prompt(turnId, content, …)` is synchronous up to the ack and takes the busy slot in that stretch (`hosted-session.ts:1120-1175`; `assertIdle` `:1377-1383` throws `TurnInProgress`/`CompactInProgress`). A client prompt and a daemon wake can never both run; the loser gets `TurnInProgress` (the wake catches it and does nothing — the condition is re-evaluated at the next trigger).
- An empty text is a continuation: `contentToText([])` is `""`; `Session.send("")` pushes no user message (`agent/src/session.ts:111-113`) and the agent flushes every pending exit at the turn start (`agent.ts:795`). The same path the relay's wake uses (`docs/fix/detached-autowake.md`, load-bearing assumption). **Executor: confirm `prompt(id, [])` is accepted by `assertTextOnly`/`contentToText` for an empty array; else call `prompt(id, [{type:"text",text:""}])`** (W-1 proves it).
- A fresh turn id is required (a reused id returns the cached ack and runs nothing, `:1127-1130`): the wake mints `wake-${crypto.randomUUID()}`.
- The turn then behaves like any turn: `turn_start`/`turn_end` go to the ring (a later attach replays them from the cut), `finishTurn` stamps `lastActiveAt` and persists (`:1490-1530`).

W-1 (end to end over the real `SessionHost` + `Connection`, one `FakeJobs` given to BOTH the `Agent` and the host, as the relay rig does) is the first thing the executor writes.

### Preconditions (each verified)

- **P1 — where a job exit is seen with no client attached.** `HostedSession` constructor: `jobs?.onExit(...)` at `hosted-session.ts:451`, emitting `background_exit`. `this.attachments.size` (`:354`, `attachedCount` `:888`) is 0 when detached. The agent subscribed first (it is built by `createAgent` before the `HostedSession`, `session-host.ts:847-860`; a `JobController` fires its listeners in registration order — `FakeJobs` uses a `Set`, `session-reaper.test.ts:74-80`; **executor: confirm the real `JobController` in `core/src/jobs.ts`/`tools` does the same**), so when our callback runs the agent's `pendingExits` already holds the job. The wake therefore reads the agent's own count, not a second model (below).
- **P2 — the wake decision source.** `pendingExits.length` is exactly "exits no turn has flushed" (`agent.ts:507`, drained only `:1821-1826`, single caller `:795`) — the same fact `fix/attach-unflushed-exits` exposes as `pendingExitCount` (agent + `Session` getters; that plan's P-Load-bearing). This task REUSES that getter; if it is not merged yet the two getters are added here (identical). Using the count instead of a private "an exit happened" bit makes the wake **idempotent and self-healing**: a refused wake leaves the count > 0, so the next trigger retries; a wake that flushed leaves 0, so no extra empty continuation (strictly better than the TUI's boolean, which cannot see what a turn flushed — `detached-autowake.md` failure table).
- **P3 — the `@tentacle/core` module is reused, not rewritten.** `wakeDue({pending: count > 0}, {enabled, idle, blocked})` (`core/src/auto-wake.ts:34-36`). `@tentacle/daemon` already imports `@tentacle/core` types (`hosted-session.ts:50-58`); a runtime import of `wakeDue` adds no dependency edge. `wakeStep` is not needed (state is the agent's count); the module's header comment gets one line naming the third user.
- **P4 — a permission ask with nobody attached is HELD, durably.** `awaitDecision` (`hosted-session.ts:514-621`): `blockingUnsupported` returns `undefined` when `attachments.size === 0` ("Nobody attached: unchanged (held for a client to attach)", `:525-528`, `:628-638`); the ask is persisted *before* it is streamed (`:585-600`), sits past the cut so the ring never evicts it (module comment `:20-29`), and a later attach replays it (`attach` `:938-961`, `recheckAsks` `:959`). No timer, no daemon decision (`:26-29`). The woken turn therefore **blocks on the first ask that needs a human and holds the busy slot until a client attaches and answers (or cancels)**. That is the existing, owner-chosen "owner's exception" rule for any detached turn; the wake changes nothing in it. Consequences: (a) the single-broker invariant is untouched — the broker is the session's own, replaced by the hosted requester at construction (`:446`), and a wake turn asks through it exactly like a client-started turn; (b) the reaper cannot expire it: `liveness().busy = this.running` (`:912`) and a busy session is never idle-closed (`session-reaper.ts` header; `selectEvictable` skips busy); only the opt-in `adminCapMs` (`serve --max-detached-age`-style cap) closes a detached busy session; (c) a restart while suspended re-asks it (`hosted-session.ts:464-497`, AGENTS §7 persistence bullet).
- **P5 — persistence of a woken turn is free.** `prompt()` → `this.turns.set`, `this.persist()` (`:1146`, `:1173`) → `SessionPersister.schedule(id, () => this.persistedState())` (`:716-718`), synchronous capture, never awaited — the same steering-window rule as any turn. No new state is persisted (the wake decision derives from the agent's count and from in-memory `lastEndedBad`), so **`DAEMON_RECORD_VERSION` is unchanged**. Restart mid-wake: a turn cut short is closed honestly, a turn suspended on its own ask runs again and is re-asked (AGENTS §7); jobs do not survive a restart (the agent is rebuilt, count 0), so nothing is re-woken.
- **P6 — idle TTL / archive.** Idle = nothing attached and no turn (`session-reaper.ts` header; jobs do not count). A wake turn is a turn: busy while it runs, and `finishTurn` re-stamps `lastActiveAt` (`:1501`) — a wake restarts the idle clock like any activity. An unlimited poll loop (the model re-checks a build through jobs forever) therefore keeps the session out of the idle TTL; the bound is the existing `adminCapMs` and `session/close` (owner already accepted "no limit, user stops it", `docs/fix/autowake-unbounded.md`). An archived session has no `HostedSession`, no jobs, nothing to wake (close kills the jobs: `:1843-1845` `jobs.dispose()`); `session/open{reopen}` rebuilds an agent with count 0.
- **P7 — `connect` clients.** `connect` attaches a laptop TUI to a `serve` session over WS (`docs/feat/connect-sessions.md`); the TUI keeps no laptop copy and quitting only detaches. Attached → the daemon never wakes (gate below) and the TUI's own `wakeDue` (laptop `autoWake`) decides, exactly as today. Detached → the daemon decides. One owner at any moment.
- **P8 — the daemon's own config is available.** `startDaemon(config, …)` receives the daemon process's resolved `TentacleConfig` (`serve.ts:113-116`), which has `autoWake` (`config/src/resolve.ts:109`, default `DEFAULT_AUTO_WAKE = true`). `createAgent: (cwd) =>` (`serve.ts:180`) ignores `session/open.settings` entirely (the type comment `session-host.ts:63-69`: "a factory that does not take it — `serve` — ignores it by construction"), and `SessionSettings` has no `autoWake` key (`protocol/src/session.ts:449-472`; `carried-settings.ts:40` "autoWake is not here: only the laptop's TUI reads it"). → See Design §"Which switch" and Owner Q1.

### Design

**1. The rule (pure, in `@tentacle/core`).** No new decision code beyond a tiny helper beside `wakeDue`, so the daemon, the TUI and the relay share the gate shape:

```ts
// core/src/auto-wake.ts — appended
/** A daemon (serve) wakes only for a session nobody watches, after a normal end. */
export function daemonWakeGate(s: {
  enabled: boolean; attached: number; busy: boolean; lastEndBad: boolean; closed: boolean;
}): WakeGate {
  return { enabled: s.enabled, idle: !s.busy, blocked: s.attached > 0 || s.lastEndBad || s.closed };
}
```
`HostedSession.maybeWake()` = `wakeDue({pending: session.pendingExitCount > 0}, daemonWakeGate({...}))`. Unit-tested alone (core, no I/O): each flag blocks; `enabled:false` blocks; `pending:false` blocks.

**2. Triggers (two, both in `hosted-session.ts`).**
- (a) **The exit callback** (`:451`): after emitting `background_exit`, `this.maybeWake()`. Idle + nobody attached → `startWake()` synchronously (no macrotask needed: not inside a steering window). **[as-built: scheduled on a macrotask too (`kickWake`) — after a settings sync the new agent's exit listener is registered AFTER the session's, so a synchronous check reads count 0; Drift D2, test W-12.]**
- (b) **A turn's end with nobody attached** — an exit that landed after the turn's start flushed it (or one that arrived during the turn). `finishTurn` is synchronous and must not do work in the steering window (`:1486-1495`, `drive` INVARIANT `:1389-1396`), so it only SCHEDULES, like `kickTitle` (`:1539-1554`): `this.wakeKick = setTimeout(() => { this.wakeKick = null; this.maybeWake(); }, 0)`; cleared in `close` (`:1820-1823` pattern). The macrotask re-checks everything (slot may be taken, a client may have attached, closed).
- NOT a trigger: the last client detaching (`removeAttachment` `:919`). Reason: an attached TUI with the laptop's `autoWake: false` that quits must not be overridden by the daemon's switch; and a TUI with `autoWake` on has already woken (idle) or its running turn's end is trigger (b). Left unflushed → the next attach wakes (attach-time wake) or the next prompt flushes. (Owner Q2.)

**3. `startWake()`** — `const id = "wake-" + crypto.randomUUID(); try { this.prompt(id, []) } catch (e) { if (RpcError TurnInProgress/CompactInProgress) return; this.reportTurnError(e) }`. A throw other than the busy-slot pair (e.g. closed) is reported through `onTurnError` (the daemon log), never to a client. Nothing else: `prompt` emits `turn_start`, persists, drives. A log line through the audit sink (`onAudit`, `session-host.ts` `opts.onAudit`): `wake: background job exit <sessionId>` — no job text (a job's command is model-supplied; never log it as trusted).

**4. `lastEndBad`** (memory only): set in `finishTurn` when `end.stopReason` is `"error"` or `"cancelled"`, cleared when the next turn STARTS (`prompt`/`sendNow`/resume). This is the "a `failed` run never wakes" rule translated: a model error (e.g. a 401), a user's Esc, or a close-cancel stops the chain — otherwise a wake that fails *before* its flush could re-wake at every turn end (trigger (b)) forever. After a bad end the exits stay unflushed; the next prompt or the attach-time wake flushes them. Not persisted: a reload has count 0 anyway.

**5. Which switch (`autoWake`) — deviation from the TODO wording, Owner Q1.** The TODO says "the laptop-side `autoWake` switch (carried to the daemon)". Verified: `serve` ignores `session/open.settings` (P8), `autoWake` is not a `SessionSettings` key, and a per-session carried flag would need: a new settings key + a `CARRIED` row (compile-enforced classification, `carried-settings.ts:38`), `serve` reading it, storing it on the `HostedSession`, and persisting it in the daemon record (a `DAEMON_RECORD_VERSION` bump, §7 on-disk rule) — and the creating client's value would then rule a session other clients also attach to. **Recommended (smallest): the `serve` host's own `config.autoWake`** (`serve.ts` passes `wakeOnJobExit: config.autoWake` into `SessionHostOptions`). It is the user's own host and config, default on; attached TUIs keep using their laptop switch. Pod daemons / worker: option absent → off.

**6. Compose with `fix/attach-unflushed-exits` — no double wake, one owner at a time.**
| Moment | Who wakes | Why no double |
|---|---|---|
| exit, nobody attached, idle | the daemon (a) | the turn start flushes → count 0 |
| exit, TUI attached, idle | the TUI (live `onExit`) | daemon gate `attached > 0` blocks |
| exit during a daemon wake turn, nobody attached | the daemon at its end (b), if the count > 0 | count is the truth; flushed → none |
| TUI attaches while a daemon wake turn runs | nobody extra: the TUI replays the running turn | **see refinement below** |
| TUI attaches later to unflushed exits (bad end, `autoWake` off on the daemon, daemon wake lost the slot) | the TUI, from the open reply's `unflushedExits` | daemon gate `attached > 0` |
| two clients attached | neither daemon; each TUI's own rule | unchanged |

*Refinement (small, load-bearing for "no double wake").* The agent's flush happens inside the turn's first `next()` but after a possible `await runner.resolveProjectTrust(...)` (`agent.ts:760-766`, only when project hooks need trust), so right after `prompt()` returns the count may still be > 0. A TUI that attaches in that window would read `unflushedExits > 0` (attach plan, `HostedSession.unflushedExits`), pend a wake, and fire an empty continuation when the daemon's turn ends. Fix on the seam that plan adds: `HostedSession.unflushedExits` returns **0 while the active turn is a daemon wake that has not flushed yet** (`wakeTurnId === activeTurnId`) — the turn's start will flush them, by construction (`agent.ts:795`); an exit arriving after that flush reaches the attached TUI through its live listener/backlog (that plan's seam B). One line + one test (W-7). If `fix/attach-unflushed-exits` is not merged, this refinement is skipped and the rule "attach test W-7" waits for it.

**Why not elsewhere.** A second process/relay for `serve`: rejected by the owner (the daemon already holds the model). A TUI/laptop-side wake for detached sessions: nothing runs there when the user is away. Waking on every detach: overrides a laptop `autoWake: false` (trigger discussion above). A new wire method/field: none needed — this is entirely daemon-internal; `PROTOCOL_VERSION` stays (no schema change at all; an older client sees only ordinary `turn_start{prompt:""}`/`turn_end`, the same frames a TUI continuation already sends, `remote-session.ts:664,1047,1302`).

### Files

Dependency order (core → agent → daemon → cli):

1. `packages/core/src/auto-wake.ts` — `daemonWakeGate` (+ header line). No `index.ts` change (`export *`, `core/src/index.ts:12`).
2. `packages/agent/src/agent.ts`, `packages/agent/src/session.ts` — `pendingExitCount` (skip if `fix/attach-unflushed-exits` already merged it).
3. `packages/daemon/src/hosted-session.ts` — ctor option `wakeOnJobExit`; `lastEndBad`; `wakeKick`; `maybeWake`/`startWake`; calls at `:451`, in `finishTurn`, cleared in `close`; the `unflushedExits` refinement. `packages/daemon/src/session-host.ts` — `SessionHostOptions.wakeOnJobExit?: boolean`, passed in `build` (`:857`; the restore path goes through `build` too, `:706`).
4. `packages/cli/src/serve.ts` — `wakeOnJobExit: config.autoWake` in the `SessionHost` options (`:171-ish`, the one non-stdio factory). `serve --stdio` (`:478`) and `worker.ts:116` untouched.
5. Docs: `docs/attach-detach-behaviour.md` row ("serve: job exit with nobody attached → the daemon starts a continuation; `autoWake: false` on the daemon host → no; attached → the TUI decides"), `CHANGELOG.md` `### Added`, README `autoWake` line (`serve` also reads it), `docs/feat/detached-runs.md`/`connect-sessions.md` one cross-ref, `TODO.md` at merge.
Tests: `packages/core/test/auto-wake.test.ts`, `packages/daemon/test/serve-autowake.test.ts` (new), `packages/cli/test/serve*.test.ts` (one wiring test).

Unchanged: protocol, client, tui, `relay*.ts`, `@tentacle/config`, `PROTOCOL_VERSION`, `DAEMON_RECORD_VERSION`.

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| **The feature:** job exits, nobody attached, idle, `autoWake` on, last turn ended normally | one continuation turn; persisted; reply in the record; the next attach replays it | count 0 after the flush |
| **Attach during a wake** | attaches as a normal client; replays `turn_start{prompt:""}`…; the open reply's `unflushedExits` is 0 (refinement) | no TUI wake, no empty continuation |
| **Two clients** | the gate sees `attached > 0` → daemon never wakes; each TUI by its own rule | unchanged |
| **Exit while a client is attached, then it detaches** | no daemon wake (no detach trigger); flush at the next prompt or attach-time wake | by design (Q2) |
| **Exit during a running turn, nobody attached** | no wake now; trigger (b) at the turn's end if the count > 0 | exits the turn's start already flushed are not re-woken |
| **Wake loses the slot** (a client prompt just landed) | `TurnInProgress` swallowed; the client's turn flushes the exit at its start | count 0 |
| **Compaction running** | `CompactInProgress` swallowed; trigger (b) analogue: a compaction's end is not a trigger today → the exit waits for the next trigger/prompt/attach | **gap, accepted & noted**: add `compact` end to the macrotask re-check if cheap (executor decides; one line at the compaction's slot release) |
| **Woken turn needs a permission, nobody attached** | held, persisted, shown on attach (P4); busy ⇒ not idle-reaped | a client answers/cancels; or `adminCapMs`; restart re-asks it |
| **Woken turn: model error / user cancel** | `lastEndBad` → no further wake | next user turn clears it; exits flush then |
| **Daemon restart mid-wake** | running turn closed honestly (or re-asked if suspended on its ask); jobs gone, count 0 | no wake after restart |
| **Failed model (401), many exits** | one failed wake, `onTurnError` logs it, `lastEndBad` stops the chain | no spin, no cost loop |
| **`autoWake: false` on the daemon host / pod daemon / worker** | option off → never wakes | exits flush at the next prompt, as today |
| **Hostile `connect` client** | cannot trigger a wake: the trigger is a job exit of the daemon's own jobs; a forged `session/prompt` is an ordinary prompt | n/a (serve auth/token model unchanged) |
| **Project hooks need trust, nobody to ask** | `resolveProjectTrust` (`agent.ts:762`) with no `askHooksTrust` — **executor: read what it does with none (deny vs. hang)**; a hang would hold the slot like an ask. Expected: untrusted ⇒ hooks skipped | W-8 pins the observed behaviour |
| **Unbounded poll loop** | allowed (owner, `fix/autowake-unbounded`); resets the idle TTL each turn | `session/close`, `adminCapMs` |

### Tests

Red first on `main` (§9); existing fakes only: the daemon test rig of `session-reaper.test.ts` (`FakeJobs`, `daemon()` on an injected clock) but with that `FakeJobs` ALSO passed to `new Agent({ jobs })` so the agent's `pendingExits` fills (the reaper rig does not); a scripted `ModelProvider` that records calls; the real `SessionHost` + `Connection` + a raw client. One mutation per test.

- **W-1 (red on `main`)** — start a turn, end it (`end_turn`), fire a job exit with nobody attached, `wakeOnJobExit: true` → within a tick a second turn exists, the model saw the `[background]` note, the history ends with the assistant reply. *Mutation:* drop the `maybeWake()` call at `:451` → fails.
- **W-2 off** — `wakeOnJobExit` unset/false → no second turn, count stays 1. *Mutation:* ignore `enabled` → fails.
- **W-3 attached** — a client attached, exit → no daemon turn (client sees only `background_exit`). *Mutation:* ignore `attached` → fails. Then detach and assert still no wake (no detach trigger).
- **W-4 no limit** — 25 sequential exits, each woken turn ends a new job → 25 wakes, no stop. *Mutation:* add a counter cap → fails.
- **W-5 bad end** — the previous turn ended `error` / was cancelled → exit → no wake; after a normal user turn, a new exit wakes. A wake whose model throws → exactly one wake, `lastEndBad`, a second exit does not chain a retry. *Mutation:* never set `lastEndBad` → the chain test fails (counts model calls).
- **W-6 exit during a turn** — exit while the turn runs (after its start flush) → one wake at its end; exit BEFORE the start (flushed by it) → no extra wake (count 0). *Mutation:* trigger (b) removed → first leg fails; a boolean `pending` instead of the count → second leg fails.
- **W-7 attach during a wake (refinement)** — wake turn running (model gated), a client opens → open reply has no `unflushedExits` (or 0); replay carries `turn_start{prompt:""}`. Skipped until `fix/attach-unflushed-exits` merges. *Mutation:* return the raw count → fails. **[as-built: merged; the gated-model form is past the flush and so vacuous for this mutation — the pre-flush window is pinned by W-7b (project-hook trust pending); Drift D4.]**
- **W-8 ask with nobody** — wake turn whose model calls a gated tool: no wake completion, `liveness().busy`, `permission_request` pending; `reapExpired` past the TTL does not close it; a client attaches → receives the request, `resolvePermission` → the turn completes. *Mutation:* auto-deny in the nobody-attached branch → fails.
- **W-9 persistence** — with a `SessionPersister` (existing persistence-test rig, `persistence.test.ts`): after the wake turn the record holds its messages and `turns` key; reload → no second wake, `DAEMON_RECORD_VERSION` unchanged. *Mutation:* skip `persist()` in the wake path (call a non-persisting variant) → fails.
- **W-10 slot race** — a client `prompt` lands first → the wake swallows `TurnInProgress`, exactly one turn runs, the client's turn flushed the exit. And a wake `prompt` first → a client prompt gets `TurnInProgress`.
- **W-11 close / archive** — `close()` with a pending `wakeKick` → no turn starts after close (timer cleared). *Mutation:* don't clear → fails.
- **W-12 pod/worker** — `SessionHost` built the way `serve --stdio`/`worker.ts` do → no wake (wiring test in `packages/cli/test`: `startDaemon` passes `config.autoWake`; the stdio factory doesn't).
- **Core** — `daemonWakeGate` truth table; `wakeDue` with `pending` derived from a count.

Gate before done: `bun test`, `bun run typecheck`, `bun run lint` (clean baseline). Live (optional, `serve` + `connect`, local Qwen): `sleep 8` background job, quit the TUI, wait 30 s, `connect --resume` → the wake turn is in the history; with `"autoWake": false` in the daemon host's config → it is not. Plus: wake that needs a permission → the prompt appears on attach.

### Notes / debt

- Per-session carried `autoWake` (Q1 option B) is a follow-up if connecting laptops need their own switch: a settings key, a `CARRIED` row, persisted on the record (version bump).
- A compaction's end and a last-detach are not triggers (gap/Q2).
- `/sessions` could show "waiting jobs"/"woken" later; no reader today.
- The model's `[background]` note and the replayed `turn_start{prompt:""}` make a wake visible on attach; a dedicated "woken by job exit" notice is a possible later display-class update (free to add, `UPDATE_CLASS`), not needed now.

## Execution

*— claude-opus-5-5, 2026-11-06*

On `feat/serve-autowake` off `main` @ `70ec587`. Not committed (the orchestrator commits).

### Re-verified preconditions (on `70ec587`)

- `fix/attach-unflushed-exits` is merged: `Agent.pendingExitCount` (`agent.ts:552`), `Session.pendingExitCount` (`session.ts:150`), `HostedSession.unflushedExits` (was `hosted-session.ts:900-903`), read by `session/open` AFTER the attach in one synchronous segment (`connection.ts:446`). Nothing to add on the agent side (plan file 2 skipped).
- Job listeners fire in registration order in every `JobController`: a `Set` in `exec/src/background.ts:143` and `cli/src/session-jobs.ts:72` (P1). **But** a settings sync (`SessionHost.updateSettings` → `swapAgent`) builds the new `Agent` after the `HostedSession`, so its listener runs after ours → D2.
- An empty prompt is accepted: `assertTextOnly([])` passes, `contentToText([])` = `""` (`mapping.ts:116`), `Session.send("")` pushes no user message (`session.ts:~126`). W-1 proves it.
- Project-hook trust with no asker: `HookRunner.resolveProjectTrust` (`hooks.ts:452-466`) with `ask === undefined` → untrusted ("no client to ask"), no hang. A wake prompt passes no `askHooksTrust`, so its hooks are skipped (the plan's W-8 trust row: observed, no wait).
- The busy-slot, persistence, ask-with-nobody and close sites are as the plan says; lines moved: exit callback now `hosted-session.ts:~489`, `prompt` `:~1170`, `drive` `:~1490`, `finishTurn` `:~1590`, `compact` `:~1830`, `close` `:~1940`.

### As-built (in order)

1. **core** — `packages/core/src/auto-wake.ts`: `DaemonWakeState` + `daemonWakeGate` (header names the third user). Test: `packages/core/test/auto-wake.test.ts` (+3 cases). Red: import missing; mutation (drop `attached` from `blocked`) → red.
2. **daemon** — `packages/daemon/src/hosted-session.ts`: `SessionWake` option (10th ctor param; present = on), fields `wake`, `wakeKick`, `lastEndBad`, `wakeUnflushed`; the exit callback calls `kickWake()`; `finishTurn` sets `lastEndBad` (`error`|`cancelled`), clears `wakeUnflushed`, and calls `kickWake()` after `kickTitle()` (scheduling only — the steering window is untouched); `compact`'s `finally` calls `kickWake()` (the plan's "compaction gap", closed); `close` clears `wakeKick`; `kickWake` (setTimeout 0, one pending) → `maybeWake` (`wakeDue({pending: count>0}, daemonWakeGate(...))` → `prompt("wake-<uuid>", [])` + audit line `wake: background job exit <id>`, never the command); `drive` clears `wakeUnflushed` on the wake turn's first `background_exit`; `unflushedExits` returns 0 while `wakeUnflushed === activeTurnId`. `packages/daemon/src/session-host.ts`: `SessionHostOptions.wakeOnJobExit`, passed (with `onAudit`) in `build` (the restore path too). Test: `packages/daemon/test/serve-autowake.test.ts` (new, 15 cases W-1…W-13, real `SessionHost` + `Connection`, one `FakeJobs` shared by agent and host). Red before wiring: 12/14 failing on their assertions.
3. **cli** — `packages/cli/src/serve.ts` `reloadedHost`: `wakeOnJobExit: config.autoWake`. `serve --stdio` (`podDaemonHost`) and `worker.ts` untouched. Test: `packages/cli/test/serve-autowake.test.ts` (new): real `startDaemon`, a fake OpenAI endpoint, a real `sleep 0.3` background job approved over WS, detach → the daemon's third model request carries the `[background]` note, exactly one, the snapshot ends with the wake's reply, `unflushedExits` absent; `"autoWake": false` → two requests only, the next `open` says `unflushedExits: 1`. Red before the wiring line (on: timed out waiting for request 3; off: green).
4. **docs** — `CHANGELOG.md` `[Unreleased] ### Added`; `docs/attach-detach-behaviour.md` new row (§2.5); `docs/container-config-sources.md` one clause.

**Protocol: untouched** (no schema, no `PROTOCOL_VERSION`, no `DAEMON_RECORD_VERSION`; `protocol.json` needs no regeneration).

### Mutations (each: cp backup → edit → narrow test → cp restore → `shasum -c` OK)

| # | Mutation | Red test |
|---|---|---|
| core | `blocked` ignores `attached` | `daemonWakeGate` "each condition alone" |
| M1 | drop `kickWake()` in the exit callback | W-1 (and the rest) |
| M2 | drop `kickWake()` in `finishTurn` | W-6 |
| M3 | `lastEndBad` always false | W-5, W-5b |
| M4 | `unflushedExits` returns the raw count | W-7b (W-7 stayed green → D4) |
| M5 | gate sees `attached: 0` | W-3, W-7 |
| M6 | `enabled: true` / no `wake` check in `kickWake` | W-2 |
| M7 | `close` doesn't clear `wakeKick` + gate ignores `closed` | W-11 |
| M8 | synchronous `maybeWake()` in the exit callback | W-12 (W-1 stays green: the ordering hazard is swap-only) |
| M9 | drop `kickWake()` at the end of `compact` | W-13 |
| cli | no `wakeOnJobExit` in `startDaemon` (the pre-wiring state) | cli "autoWake on" |

Not mutated: W-4 (no cap exists to remove), W-8 (pins the pre-existing ask-with-nobody rule; the auto-deny mutation would be in code this task does not touch), W-9 (persistence goes through the unchanged `prompt`/`finishTurn` path), W-10 (slot race: `assertIdle`, unchanged).

### Drift from the Implementation

- **D1** — `pendingExitCount` / `unflushedExits` already merged (plan file 2 and the "if not merged" branches dropped).
- **D2** — trigger (a) is a macrotask (`kickWake`), not a synchronous `maybeWake`: after `session/update_settings` the swapped agent subscribes to the jobs AFTER the session, so a synchronous check reads count 0 and never wakes (M8/W-12 prove it). Cost: one macrotask of latency.
- **D3** — the compaction's end IS a trigger (one line; the plan left it to the executor).
- **D4** — the no-double-wake refinement uses a per-turn mark `wakeUnflushed`, set BEFORE `prompt()` (its start can flush synchronously, or after the trust `await`) and cleared on the wake turn's first `background_exit` event or its end. The plan's W-7 (model gated) is past the flush and could not catch the raw-count mutation; W-7b holds the start at a pending project-hook trust and does.
- **D5** — `startWake` swallows nothing specially: the gate checked `running` in the same synchronous stretch, so `TurnInProgress` cannot happen; any throw goes to `onTurnError`.
- **D6** — `lastEndBad` is set at every real turn end (true for `error`/`cancelled`, false otherwise) instead of "cleared at the next start": equivalent for the gate (only read while idle).
- **D7** — no README line (README has no `autoWake` entry to extend); `detached-runs.md` / `connect-sessions.md` cross-refs not added (the user-facing table row covers it).
- **D8** — cli wiring test is an end-to-end `startDaemon` test (real disk, real `sleep`, fake model endpoint) instead of an options-inspection test: `startDaemon` exposes no host to inspect.

### Gate (once, at the end)

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: `Checked 710 files … No fixes applied.` (0 errors, 0 warnings — the baseline).
- `bun test packages`: `5266 pass · 3 skip · 0 fail` (the three opt-in skips).
- Narrow: `packages/daemon/test/serve-autowake.test.ts` 15/15, `packages/cli/test/serve-autowake.test.ts` 2/2, `packages/core/test/auto-wake.test.ts` 9/9.

### Unverified

- Live `serve` + `connect` with a real model (owner checklist below). The cli E2E test covers the same path with a fake endpoint.
- Window: an exit that lands while a client is attached, then that client detaches within the same macrotask, is woken by the daemon (the deferred check sees nobody attached). The client's own wake prompt cannot land after its detach, so no double turn; the window is ~0 ms.

### Owner live checklist

1. `tentacle serve` (default config) + `tentacle connect`; ask the agent to run `sleep 20; echo done` in the background and end its turn; quit `connect`.
2. Wait ~30 s → the daemon runs one wake turn (`serve` log: `wake: background job exit <id>` if audit is on) and persists it.
3. `tentacle connect --resume` → the history shows the `[background]` note and the agent's reply; no `ended while you were away` notice, no second turn.
4. Put `"autoWake": false` in the `serve` host's config, restart `serve`, repeat 1–2 → no turn; `connect --resume` shows `1 background job(s) ended while you were away` (and the laptop's own `autoWake` decides whether the TUI wakes).
5. Stay attached with `connect` while the job ends → exactly one wake turn (the TUI's), none from the daemon.

## Review

*— claude-opus-5-5, 2026-11-06* — fresh context, but the **same model as the executor** (Opus executed): blind spots we share could get past both passes.

**Verdict: REQUEST-CHANGES.** There is one MEDIUM finding: a double wake when a TUI attaches during the daemon's wake. The daemon side holds. The double wake comes from where this feature meets `fix/attach-unflushed-exits` seam B (the client backlog), and the refinement does not cover that path.

### Findings

1. **MEDIUM — a TUI that attaches while the daemon's wake turn runs fires a second, empty continuation when that turn ends.** The refinement (`hosted-session.ts` `unflushedExits` → 0 while `wakeUnflushed === activeTurnId`) only closes seam **A** (the open reply's count). Seam **B** is still open.
   - **The replay carries the exit.** When the session is detached, the session-level `background_exit` update (the exit callback, `hosted-session.ts:~500`) lands after the old cut and before the wake's `turn_start`. So an open during a wake turn that has not committed yet replays it.
   - **The client queues it for the TUI.** `RemoteClient.deliver` (`remote-client.ts:1969-1984`) puts it in `exitBacklog`.
   - **The TUI arms a wake from it.** The TUI's `jobs.onExit` (`App.tsx:~701`) steps `wakeStep exit`, so the wake is pending.
   - **Nothing clears it.** A foreign turn (`onActivity`, `App.tsx:~1395-1445`) never steps `turn_started`. When the daemon's wake ends, `streamTurn`'s `finally` calls `wakeIfPending()` (`App.tsx:1303`), which sends `""` as a continuation. The agent's count is already 0, so that is an extra model turn with no new input.

   This breaks the owner's "no double wake" rule. It also contradicts the Failure-modes row "Attach during a wake → no TUI wake, no empty continuation".

   **Evidence:**
   - *Daemon repro* (copy of the rig with absolute imports, `.tentacle/tmp/serve-autowake-review/repro.test.ts`): wake turn gated in the model, then a client opens.
     ```
     REPRO gated open {"sessionId":"S",…,"created":false,"resync":true}      ← no unflushedExits (seam A OK)
     REPRO gated replay ["background_exit","turn_start","context_note"]     ← seam B: the exit is replayed
     REPRO ask   replay ["tool_call","permission_request"]                   ← a held ask moved the cut: no exit
     ```
   - *TUI repro* (`tui-repro.test.ts`, ink-testing-library): `jobs.onExit` hands the backlog over synchronously, as `RemoteClient.onBackgroundExit` does. `watch` raises the running foreign wake turn, which is then ended.
     ```
     REPRO sends while wake runs: 0
     REPRO sends after the daemon's wake ended: 1     ← the second wake
     ```
   - The control run (empty backlog) was **not run**: the permission sandbox refused the env var. From the code, nothing else sets `pending`.

   **When it happens:** the window is the whole wake turn while it is model- or tool-bound, not a held ask. Reconnecting during a long auto-approved tool call is a plausible user path.

   **Fix (executor's choice, red test first):**
   - (a) **Recommended, daemon-side, no TUI change:** in `maybeWake`, commit/move the cut before `prompt()`. A mid-wake attach then gets the exit through the snapshot plus the turn's own flush note, not as a live `background_exit`. That is what a held ask already does by accident.
   - (b) Client-side: drop backlog exits that a replayed `turn_start` follows in the same open.

   Either way, add a test that drives `RemoteClient` (or the TUI) through an attach mid-wake and pins "one model call" end to end. W-7 asserts only seam A.
2. **LOW — W-8 does not pin the reaper.** The plan's W-8 says "`reapExpired` past the TTL does not close it". The test checks `liveness().busy` but never runs the reaper. The property holds by code (`session-reaper.ts:65,99` skip `busy`), so this is a test gap only.
3. **LOW — a user's Esc on any turn stops the daemon's wakes** until a later turn ends normally (`lastEndBad` on `cancelled`). This follows the rule as designed (D6) and the exits flush at the next prompt/attach. It is noted so the owner knows "cancel" covers the TUI's own turns too.

### Gate (re-run by me, once)

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: `Checked 710 files … No fixes applied.` (the baseline).
- `bun test packages`: **5266 pass · 3 skip · 0 fail** (the three opt-in skips). Same as Execution.

### Mutation (mine, on the most load-bearing guard)

`maybeWake`'s gate `attached: this.attachments.size` → `attached: 0` (cp backup → edit → test → cp restore → `shasum -c` **OK**, `git status` clean).

| Test | Result |
|---|---|
| W-3 | red |
| W-7 | red (3 model calls ≠ 2) |
| W-7b | red |
| others (14) | green |

The guard is not vacuous. The executor's M1–M9 table is consistent with what the tests assert (not re-run one by one).

### Premise table

| Premise | Verdict |
|---|---|
| P1: job listeners fire in registration order; a swap registers after → D2 macrotask | TRUE (W-12 / M8) |
| P2: `pendingExitCount` = unflushed exits; merged | TRUE |
| P4: an ask with nobody attached is held and persisted; busy ⇒ not reaped (`session-reaper.ts:65,99`) | TRUE |
| P5: no new persisted state, `DAEMON_RECORD_VERSION` unchanged | TRUE (diff touches no record code) |
| P8: `serve` ignores carried settings; `config.autoWake` wired only in `reloadedHost` (`serve.ts:198`); `serve --stdio` / worker untouched | TRUE |
| Design §6 row "TUI attaches while a daemon wake turn runs → nobody extra" | **FALSE** (finding 1) |

### Attacks tried

1. **Attach mid-wake (double wake):** FOUND (finding 1). Seam A holds (W-7/W-7b). Seam B leaks when the wake is model- or tool-bound. A held ask does not leak (the cut moved).
2. **TUI attached when the job ends:** holds. The daemon's macrotask sees `attached > 0` (W-3, my mutation). The TUI wakes alone.
3. **Attach after the wake ended:** holds. The cut is past the wake turn and the count is 0, so nothing is replayed and nothing is owed.
4. **Ask with nobody attached:**
   - holds the slot, persisted;
   - the reaper skips busy, so no TTL or archive while it waits; only the opt-in admin cap closes it;
   - the ask is replayed on attach and answering completes the turn (W-8);
   - a restart re-asks it (existing rule, unchanged path).
5. **`autoWake: false` on the host:** no turn, and the next `open` says `unflushedExits: 1` (cli E2E).
6. **Bad end:** `error`/`cancelled` stops the chain (W-5/W-5b). One wake per job end and no cap (W-4).
7. **Close during a pending check:** `close` sets `closed` BEFORE `finishTurn(cancelled)`, so that turn end's `kickWake` is a no-op and no timer leaks (`hosted-session.ts:1987-2000`). An archived session has no `HostedSession` and nothing to wake. A wake poll loop resets the idle clock: owner-accepted, bounded by close / admin cap.
8. **Pod / worker / `run --detach`:** the option is absent there (`podDaemonHost` and `worker.ts` not in the diff), so wake is off. The relay is unchanged.
9. **§7:**
   - the peer is not serialised (the wake is a daemon-internal synchronous `prompt`, no new await in a handler);
   - single broker unchanged (the wake asks through the session's hosted requester);
   - protocol untouched;
   - persistence via the unchanged `prompt`/`finishTurn` → `schedule` path.

### What holds

The daemon-side design is sound:
- the count-driven gate in the pure core module;
- the macrotask trigger (D2 is a real catch);
- the compaction trigger (D3);
- `lastEndBad`;
- the close ordering;
- the serve-only wiring.

### How the executor behaved

Disciplined:
- re-verified the plan on the new base;
- caught the swap-order hazard (D2) and the vacuous W-7 (D4) itself, with mutations;
- reported drift honestly.

What it missed: it reasoned about the attach only through seam A (`unflushedExits`), not the client backlog that the same merged fix added. That is the layer finding 1 lives in.

### Owner question (review)

- **R-Q1 — where to fix finding 1?** *Recommendation: (a), daemon-side.* Commit the cut before the wake's `prompt()` so that a mid-wake attach never replays the exit as a live `background_exit`. It keeps the TUI unchanged and stays inside this task's files. (b), filtering in `RemoteClient`, also helps two-TUI cases but widens the blast to the client.

## Owner questions

1. **Which `autoWake` does a `serve` daemon read?** The TODO says "carried to the daemon", but `serve` ignores `session/open.settings` and `autoWake` is not a settings key; carrying it per session means a settings key, a `CARRIED` row, and a persisted field (daemon-record version bump). *Recommendation: A — the `serve` host's own `config.autoWake`* (default on; attached TUIs still use their laptop switch). B (carry per session) later if a laptop needs its own switch for a shared daemon.
2. **Should the last client detaching also trigger a wake?** *Recommendation: no.* It would override a laptop `autoWake: false` with the daemon's switch; the unflushed exit is flushed by the next attach (attach-time wake) or prompt, and a turn that ends with nobody attached already wakes.
3. **Blast rating.** I rate it `load-bearing` (default-on autonomous model turns in the daemon's busy slot) → Opus executes + mandatory fresh-context Review. *Recommendation: accept; do not downgrade to cross-module.*

### Owner answers (2026-11-06)

1. **A** — the `serve` daemon reads its host's own `config.autoWake` (default on); attached TUIs keep their laptop switch.
2. **A** — no wake on the last client's detach. Owner clarified: `serve` follows ITS OWN config (`autoWake` is not a session setting; not carried); exits after the detach wake the daemon per that config.
3. **A** — load-bearing: Opus executes, mandatory fresh-context Review. Scope: `serve`/`connect` mode only (owner asked for the per-mode distinction; local/pod/detached are covered elsewhere).

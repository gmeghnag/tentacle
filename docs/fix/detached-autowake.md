# fix/detached-autowake — a detached run with no TUI wakes on a background-job exit

> **Status:** executed, awaiting fresh-context Review
> **Branch:** `fix/detached-autowake`, off `main` @ `036a172`
> **Type:** fix · **Size:** M · **Blast:** load-bearing (re-rated from the TODO's S–M · cross-module: it adds turns inside the relay's lifecycle, touches `exitPlan` and the keep=false save-confirmed path, AGENTS §7 "Pod/container lifecycle") · **Suited:** Opus executes; mandatory fresh-context Opus review that red-teams the §7 lifecycle + single-broker invariants

Planned on `main` @ `3a149c7` (`docs(todo): cli-main-terminal-seam done (merged 0a7496b)`), worktree `.tentacle/worktrees/main-docs`. Nothing was edited there.

## Context

*— claude-opus-5-5, 2026-11-05*

**Problem.** `run --detach` with NO TUI attached never auto-wakes when a background job exits. The decision to start a continuation turn lives only in the TUI (`packages/tui/src/App.tsx:654-665`, deferred path `:988-998`); the relay (`packages/cli/src/relay.ts`) runs exactly one turn (`relay.ts:357-381`, `drive` sends `spec.prompt` once) and never subscribes to job exits (no `onExit`/`jobs.` use in `relay.ts`; it only polls the running-job COUNT, `relay.ts:470-479`, every 30 s, `:84`). This was a known v1 limit: DR-4 says "v1 does **not** auto-wake on a background-job exit (F8: the logic is in the TUI) … Revisit once auto-wake moves to a pure module" (`docs/feat/detached-runs.md:231-234`, F8 at `:71-72`). This task is that revisit.

**Facts given in the brief, re-verified:**

| Claim | Verified |
|---|---|
| TUI-side wake `App.tsx:658-664` | ✅ `:658-665` (decision), plus `:597` (`wakePendingRef`), `:988-998` (`wakeIfPending`), `:1267-1270` (compaction defer), resets `:1098`, `:1108`, `:1475`, `:1599`, `:1802` |
| `autoWake` read laptop-side `main.ts:834` | ⚠ drift: the reads are `main.ts:854`, `:1614`, `:1664` (`autoWakeOnJobExit: config.autoWake`); `:834` is the `initialPrompt` parameter. Laptop-side: yes |
| schema `config/src/schema.ts:253-257` | ✅ (`autoWake: z.boolean().optional()` at `:257`); default `DEFAULT_AUTO_WAKE = true` `config/src/defaults.ts:23`; resolved `config/src/resolve.ts:93` |
| daemon streams `background_exit` `protocol/src/updates.ts:84-90` | ✅ schema; emitted outside turns by `daemon/src/hosted-session.ts:448-456`; class `display` `updates.ts:278` |
| relay has no wake handling | ✅ |

**Repro (owner, 2026-11-05).** `.tentacle/tmp/autowake-detach/check.sh` (docker + local Qwen). The folder holds only the script — the logs the brief mentions are not there; the observed output below is the TODO entry's (`TODO.md:430`). Script, verbatim:

```zsh
#!/bin/zsh
cd /Users/gmeghnag/tentacle/.tentacle/tmp/autowake-detach
date +%T
~/bin/tentacle run --engine docker --detach --no-mount --auto-accept --name aw-test --image registry.access.redhat.com/ubi9/ubi --prompt "Start the shell command 'sleep 20; echo WAKE-DONE' as a BACKGROUND job (do not wait for it). Then reply exactly 'started' and end your turn. When you later learn the job finished, reply exactly 'woke: <its output>'." 2>&1 | tail -5
date +%T; sleep 80; date +%T
~/bin/tentacle ps 2>&1 | head -5
```

Observed: after 80 s the session record still ends at `started` (no `woke: WAKE-DONE`); `ps` = `detached · idle`. ~15 s later `ps` = `running · idle`, and `tentacle rm aw-test` asked for `-f` ("a session may be attached") with nobody attached.
The executor re-runs it on `main` first and keeps `relay.log` (`<configDir>/runs/…/relay.log`, `state:` lines are timestamped, `relay.ts:205`) in the Execution section — that log is the evidence for the timeline below.

**Second symptom — diagnosed: NOT a bug of this task; DR-4 working, plus misleading wording.**
Timeline from the code (T0 = the run's turn ends, a few seconds after launch):
1. T0: first jobs poll (`relay.ts:490-492`, `nextPoll` starts at 0) → `jobs: 1` → view `running … (1 background job(s) running)` (`relay-state.ts:183-185`).
2. ≈launch+20 s: the job exits. No wake (the bug).
3. T0+30 s: next poll (`RELAY_JOBS_POLL_MS`, `relay.ts:84`) → `jobs: 0` → idle (`relay-state.ts:157`) → view `idle`, `exitAt = now + 60 s` (`relay-state.ts:13`, `:158-159`). `ps` with a live relay: `detached · idle` (`run-state.ts:470`, `:477`; `kept.ts:375` shows `relay.text` alone when the relay is alive).
4. ≈T0+90 s: the 60 s grace runs out → the relay leaves (keep=true: `exitPlan` → `leave`, `relay-state.ts:262-263`; `relay.ts:546`), lock released (`relay.ts:292`). `ps` with a dead relay: `${engine} · ${relay.text}` (`kept.ts:375`) = `running · idle` — `running` is the CONTAINER's engine state (`statusText(row.status)`), `idle` the last record.
5. `rm` on a running container asks for `-f` whenever the engine says `running`, relay or not (`kept-cmd.ts:387-396`); the text "a session may be attached" (`kept-cmd.ts:393`, `kept.ts:489`) is a guess — it is printed even when the laptop knows no relay and no TUI presence is alive.
The check at launch+80 s and the flip ~15 s later match steps 3-4 (exit due ≈ launch+92-95 s). So: the flip is the designed idle exit (DR-4, `docs/feat/detached-runs.md:222`); after this fix it still happens, only after the wake turn plus 60 s. The confusing part is wording (`running · idle` reads as "the run is running"; `rm` guesses an attached session). **Out of this task** (it touches `kept.ts`/`kept-cmd.ts`, unrelated to the wake) → Owner question Q1.

**Constraints.** The wake decision stays on the laptop (the relay is the laptop's process; `autoWake` is a laptop setting and stays OUT of `feat/config-carry`'s `session/open.settings`, `.tentacle/worktrees/config-carry/docs/feat/config-carry.md:14`, `:561-564`). AGENTS §7: logic in a pure module shared by TUI and relay, no second copy; one session path (the relay already drives `attachEngineRuntime`, `relay.ts:331`); single broker; pod not trusted.

## Implementation

*— claude-opus-5-5, 2026-11-05*

### Load-bearing assumption

**A relay with no TUI receives every `background_exit` of its session while idle, through `runtime.jobs.onExit`, and an empty prompt sent through its one session runs a continuation turn daemon-side.** Proof chain:
- Daemon: the session subscribes to its `JobController` and emits `background_exit` the moment a job exits, outside any turn (`hosted-session.ts:444-456`); `emit` sends to every attachment (`hosted-session.ts:1075-1086`).
- Client: `background_exit` is not turn-scoped; `RemoteClient` fires `exitListeners` whatever turn state (`remote-client.ts:1697-1703`); `RemoteSession` leaves it to them (`remote-session.ts:1227-1234`, `:1319-1328`).
- Runtime: `LocalRuntime.jobs` is `remoteJobsView(client)` whose `onExit` is `client.onBackgroundExit` (`local-runtime.ts:159-179`, `:669`). The relay's runtime is `attachEngineRuntime` → `createLocalRuntime` (`relay.ts:331-342`), so `runtime.jobs.onExit` is available to it today, unused.
- Continuation: the wire accepts an empty text (`PromptParamsSchema.content` is `min(1)` blocks, `protocol/src/session.ts:176`; `TextContentSchema.text` is `z.string()`, `protocol/src/content.ts:8-11`; the client sends `[text(prompt)]`, `remote-client.ts:935`); the agent treats `""` as a continuation (`agent/src/session.ts:89-92`) and flushes ALL pending exits into the history at turn START, only there (`agent/src/agent.ts:742-746`, `:1734-1753`).
- The agent's own flush event is NOT streamed (`daemon/src/mapping.ts:283-289` returns `null`), so each job reaches a client's exit listener exactly once (no double fire).
The first relay test (R-W1, below) proves the chain end-to-end over the real `SessionHost` + `Connection` rig (`cli/test/relay.test.ts:99-207`) — it is the first thing the executor writes, red on `main`.

### Preconditions

- **P1 — one turn at a time, daemon-enforced.** `prompt` takes the busy slot synchronously (`hosted-session.ts:1137-1142`, `assertIdle` `:1374-1380` → `TurnInProgress`/`CompactInProgress`). Two wakers can never both run: the loser is refused before streaming. The TUI already withdraws a refused continuation silently (`App.tsx:1185-1192`, `lostSlot` `tui/src/turn-feed.ts:122-124`).
- **P2 — at most one laptop owner of a detached run.** While a relay lives, an `attach` goes through `prepare`/`commit` (`attach-run.ts:333-392`); `prepare` freezes the relay's policy and disarms its net (`relay.ts:399-427`); after `commit` the relay only drains and leaves (`relay.ts:428-450`, `relay-state.ts:145-148`, `:153-156`). So relay and TUI never both decide a wake for the same exit, if the relay's wake is gated on `handover === "none"`.
- **P3 — the relay's turn identity.** The relay mints one id and sends the run's prompt under it (`relay.ts:194`, `:361-363`); `owner.json` carries it (`relay.ts:218`); an attaching TUI adopts it so auto-accept may answer it (B2, `attach-run.ts:353-359`, `:435`). The daemon caches a turn by id and never runs a second turn for a reused id (`hosted-session.ts:1123-1127`) → **a wake needs a fresh id**.
- **P4 — the relay owns auto-accept for its own turns.** `policy.bindOwnsTurn(session.ownsTurn)` (`relay.ts:356`) on THE one broker (`relay.ts:313-316`); a turn the relay sends is its own, so `--auto-accept` covers a wake turn with no new wiring.
- **P5 — save-confirmed rule.** The net's check is `turn !== "running" && runtime.saveConfirmed()` (`relay.ts:353`); the exit path saves after `session.flushed()` and vetoes a removal when unsaved (`relay.ts:518-554`). A wake turn goes through the same `session` (`relay.ts:355`), so its post-turn save follows the same rule. (To pin by test R-W6: the wake reply is in the laptop store before a keep=false removal.)
- **P6 — idle exit is pure.** `relayStep`/`relayExits`/`exitPlan` (`relay-state.ts:83-167`, `:253-278`); a `turn_started` clears `exitAt` at the next tick (`:157-160`).
- **P7 — the control socket's reply parser drops unknown fields** (`control-socket.ts:95-112`): a new optional reply field is additive between laptop builds (the schema stays `CONTROL_SCHEMA_VERSION = 1`, `:19`).
- **P8 — the TUI's streamed turns all settle through one `finally`** that calls `wakeIfPending` (`App.tsx:1205-1233`) — own, adopted and foreign turns alike — so a pending wake handed to a TUI fires when the adopted turn ends.
- **P9 — package graph.** `@tentacle/tui` depends on `@tentacle/core` but not `@tentacle/client` (`packages/tui/package.json`); `@tentacle/cli` depends on both core and tui. `JobController` lives in `core/src/jobs.ts:48`. → the shared pure module goes in **`@tentacle/core`**.

### Design

**1. Shared pure module `packages/core/src/auto-wake.ts`** (React-free, no I/O), exported from `core/src/index.ts`:

```ts
/** One session's autonomous wake on a background-job exit (docs/fix/detached-autowake.md). */
export interface WakeModel { readonly pending: boolean }
export const initialWake: WakeModel = { pending: false };
export type WakeEvent =
  | { readonly type: "exit" }          // a job exited (the live notification)
  | { readonly type: "turn_started" }  // ANY turn started: its start flushes every exit (agent.ts:746)
  | { readonly type: "refused" }       // our wake did not start (lost the slot / deferred by a compaction)
  | { readonly type: "reset" };        // another session: the old one's exit is not ours
export function wakeStep(model: WakeModel, event: WakeEvent): WakeModel;
export interface WakeGate { readonly enabled: boolean; readonly idle: boolean; readonly blocked: boolean }
/** True ⇒ start ONE continuation now; the caller then steps `turn_started`. */
export function wakeDue(model: WakeModel, gate: WakeGate): boolean; // pending && enabled && idle && !blocked
```

Coalescing is the boolean: N exits before the next turn start = one pending = one wake (the agent drains them all at that start). This is exactly today's TUI semantics, made one function.

**2. TUI uses it (no second copy).** `App.tsx`: `wakePendingRef: boolean` → `wakeRef: WakeModel`. `onExit` (`:654-665`) → `wakeStep(exit)` then `wakeDue({enabled: autoWakeOnJobExit, idle: !running, blocked: false})`; `wakeIfPending` (`:988-998`) → the same check (the `setTimeout(0)` and the re-check of `running` stay); compaction defer (`:1268-1270`) → `refused`; the four "its turn flushes the job exits" resets (`:1098`, `:1108`, `:1599`, `:1802`) → `turn_started`; the session swap (`:1475`) → `reset`. Behaviour unchanged (pinned by T-TUI-1/2 before the edit). New prop `wakePending?: boolean` (from a hand-over, §5) seeds `wakeRef` with `pending: true`; a mount effect calls `wakeIfPending()` (if the adopted turn runs, P8 fires it at its end). `run.tsx:31-33`, `:95-97`: pass the prop through.

**3. Relay wakes (`relay-state.ts` + `relay.ts`).**
- `RelayModel` gains `wake: WakeModel` (`initialRelay.wake = initialWake`). New `RelayEvent` `{type:"job_exit"}` → `wake = wakeStep(wake, exit)`; `turn_started` also steps `wake` `turn_started`; new `{type:"wake_refused"}` → `turn: "over"` (rest/detail untouched, not a failure) + `wake` `refused`.
- Pure `relayWakeDue(model, exiting: boolean): boolean` = `wakeDue(model.wake, { enabled: true, idle: model.turn === "over" && model.asks === 0, blocked: model.handover !== "none" || model.stopping || model.linkStopped || exiting })`. (`enabled` is applied at subscription: the relay subscribes only when `config.autoWake` — Q5.)
- `exitPlan` (`relay-state.ts:253`): after the handover rows and before `keep`, `if (model.wake.pending && !model.stopping && !model.linkStopped) return { kind: "hold" }` — a pending wake is "in use", never a reason to leave or remove; the loop's `busy` (`relay.ts:504-508`) then returns to the ticks, where the wake fires.
- `relay.ts`: if `config.autoWake`, `runtime.jobs.onExit(() => emit({type:"job_exit"}))` after `attach` (unsubscribed in the exit path next to `offLink`, `relay.ts:524`). After every `emit`, `maybeWake()`: `if (relayWakeDue(model, exiting)) startWake()`. `startWake` is synchronous up to the send: mint `turnId = crypto.randomUUID()` (the `runTurnId` const `:194` becomes `let turnId`, still written as `runTurnId` in `owner.json` — no record-schema change; the `record` dedupe key `:200` must include it), `emit(turn_started)` (record written, caffeinate on, `exitAt` cleared), log `wake: background job exit` (no pod-supplied command text in the log; if ever logged: `untrustedText`), then `void drive("", turnId)`. `drive` (`:357-378`) takes `(text, turnId)`; a refusal with code `TurnInProgress`/`CompactInProgress` before any event streamed → `emit({type:"wake_refused"})` (retried at the next tick), never `turn_failed`. Same `stopSignal` (`:361`) → a stop cancels a wake turn like the run's turn.
- `exiting` (local flag): set before `readUse()` (`:496`), cleared on `hold`; together with `leaving` (`:242`, `:501`) it blocks a wake while the removal decision is in flight.

**4. Hand-over carries the wake (no lost, no double).**
- `prepare` ack gains `turnId` (the relay's current turn id). Once prepared the relay starts no wake (gate), so this id is final; `attach-run.ts` uses it for `adoptTurn` (`:358`) and its record (`:435`) instead of the possibly stale `deps.owner.runTurnId` read before the dial (fallback to it when absent: an older relay).
- `commit` ack gains `wakePending: boolean` (`model.wake.pending` at the ack, `relay.ts:449`). `joinRun` returns it in `Joined` (`attach-run.ts:237-253`, `:714-723`); `main.ts` adds it to the `run?` `Pick` (`:832`) and passes `wakePending` to `startTui` next to `autoWakeOnJobExit` (`:854`). The TUI then wakes per its OWN `autoWake` (§2).
- `parseReply` (`control-socket.ts:100-107`) copies `turnId` (string) and `wakePending` (boolean) when present and well-typed; laptop-local, both ends ours, additive (P7).

**Why not elsewhere.** Daemon-side wake: rejected — the decision would move into the pod (not trusted, §7) and `autoWake` would have to be carried, which `feat/config-carry` explicitly excluded. A runtime-level (`LocalRuntime`) wake: rejected — the TUI and the relay are different processes with different turn drivers; the shared thing is the decision, not the driver.

### Files

Dependency order (core → cli → tui), smallest diff:

1. `packages/core/src/auto-wake.ts` (new, ~40 lines), `packages/core/src/index.ts` (+1 export).
2. `packages/cli/src/control-socket.ts` — `ControlReply` ok-variant `turnId?`, `wakePending?`; `parseReply`.
3. `packages/cli/src/relay-state.ts` — `wake` in the model, `job_exit`/`wake_refused`, `relayWakeDue`, `exitPlan` hold row.
4. `packages/cli/src/relay.ts` — subscription, `maybeWake`/`startWake`, `drive(text, turnId)`, `let turnId` + record key, `exiting`, ack fields; header comment (`:1-20`) gains one line on the wake.
5. `packages/cli/src/attach-run.ts` — prepare `turnId`, `Joined.wakePending`.
6. `packages/cli/src/main.ts` — `Pick<Joined, …>` + one option at `:854`. **Shared with `feat/config-carry`** (its list: `config-carry.md:413`).
7. `packages/tui/src/run.tsx`, `packages/tui/src/App.tsx` — core module, `wakePending` prop.
8. **Q1=B (owner):** `packages/cli/src/run-state.ts` — pure `runFinished`; `packages/cli/src/kept.ts` — `KeptRelay.finished`, `statusCell`'s `up`, `runningReason`; `packages/cli/src/kept-cmd.ts` — `relayRow`, `rm`'s wording. Test: `packages/cli/test/kept-cmd.test.ts`.
9. Docs: `docs/feat/detached-runs.md` DR-4 (`:231-234`) one line "superseded: the relay wakes, fix/detached-autowake"; `docs/attach-detach-behaviour.md` rows (job exit with no TUI → the relay starts a continuation turn; `autoWake: false` → no; the finished run's `ps` and `rm`); this doc → `docs/fix/detached-autowake.md`; `CHANGELOG.md` (**shared with config-carry**); `TODO.md` at merge.

Shared with `feat/config-carry`: `packages/cli/src/main.ts`, `CHANGELOG.md`. Not shared: `engine-runtime.ts`, `local-runtime.ts`, `config/*` (this task changes no config file). Note for config-carry: its doc says `autoWake`'s "only reader is the laptop's TUI" (`config-carry.md:174`) — after this task the relay reads it too (still laptop-only; its Q2 conclusion holds, the sentence needs one word).

Tests: `packages/core/test/auto-wake.test.ts` (new), `packages/cli/test/relay-state.test.ts`, `packages/cli/test/relay.test.ts`, `packages/cli/test/control-socket.test.ts`, `packages/cli/test/attach-run.test.ts`, `packages/tui/test/auto-wake.test.tsx`.

### Failure modes

| Case | Outcome | Convergence |
|---|---|---|
| **No TUI, idle, job exits** (the bug) | `job_exit` → due → one continuation turn; record `running` → `idle`; save; 60 s grace | keep=true: leave. keep=false: fresh read + save confirmed → remove (unchanged rule) |
| **Exit during the relay's running turn** | pending; at `turn_ended` the next emit's `maybeWake` starts one wake | Exits arriving after the turn's start were not flushed by it (agent.ts:746) — the wake is needed, never redundant |
| **Several exits coalesced** | one pending → one wake; exits during that wake → one more after it | Bounded: ≤ 1 wake per turn end |
| **Exit lands between `turn_start` emit and the agent's flush** | flushed by that turn AND pending → one extra empty continuation | Harmless (one model call over unchanged history); same as the TUI today. Not designed out: the client cannot see which exits a turn flushed (`mapping.ts:283-289`) |
| **A turn already running from another client** (a pod-side client, §7) | wake refused `TurnInProgress` before streaming → `wake_refused` → retried each tick until it runs | Worst case one extra empty continuation after that turn; never a lost wake (a silent drop is a bug, §8) — Q3 |
| **TUI attaches while a wake turn runs** | `prepare` freezes; ack carries the wake turn's id; TUI adopts it (auto-accept applies, B2) | Its end: relay `handover==="done"` → no wake; TUI decides later exits. One owner |
| **TUI attaches while a wake is pending** (relay turn running, or exit during `prepared`) | relay never wakes while `prepared`/`done`; `commit` ack `wakePending: true` → TUI wakes at mount / at the adopted turn's end | No lost, no double wake |
| **Hand-over aborted** (`relay.ts:383-397`) | `handover` back to `none` → next tick `maybeWake` fires a pending wake | |
| **Two TUIs after hand-over** | both get the exit; one wins the slot, the other's continuation is withdrawn silently (`App.tsx:1185-1192`) | Pre-existing, unchanged |
| **Relay stop (SIGTERM) mid-wake** | `stopSignal` cancels the wake turn; `stopping` blocks new wakes; existing stop path (bounded wait, save, keep=false remove only if saved, `relay.ts:518-554`) | Unchanged R5/R6 behaviour, now also for a wake turn (test R-W5) |
| **Second SIGTERM / crash mid-wake, keep=false** | net's `saved()` false (`turn === "running"`) → workload kept, `not saved — workload kept` | Unchanged rule; test |
| **Exit during the exit-plan read** (`relay.ts:496`) | wake blocked (`exiting`); `exitPlan` returns `hold` on a pending wake → back to ticks → wake | Practically unreachable (idle needs a polled `jobs: 0`, and the exit notification precedes the list reply on the one ordered channel) — belt and braces, pure, tested |
| **Exit after the final plan (`leaving`)** | not woken; the exit stays pending in the agent | The next turn (an attach + prompt) flushes it. Accepted, said in the Review |
| **Link stopped** | `linkStopped` blocks; relay exits as today | |
| **Link reconnecting when the job exits** | depends on the redial replaying the missed update (ring, `hosted-session.ts:1077`) | Unverified: executor checks; if not replayed, a follow-up (not this task) |
| **Hostile pod spams `background_exit`** | ≤ 1 wake per turn end; each a model call through the laptop's key | No new exposure: a pod can already keep the relay alive (`jobs>0`, `docs/feat/detached-relay.md:213`) and drives `model/stream` through the served link anyway. Pod text never logged raw |
| **`autoWake: false`** | no subscription → no wake; DR-4 behaviour exactly as today | |
| **Wake turn needs a permission, no `--auto-accept`** | `waiting-permission`, relay stays (as the run's turn) | `attach` answers |
| **Version skew (laptop builds)** | older TUI ignores `turnId`/`wakePending` (P7) → today's behaviour; newer TUI vs older relay: fields absent → `deps.owner.runTurnId`, no pending | No wire (`PROTOCOL_VERSION`) change: nothing reaches the pod |

### Tests

Red first on `main` (§9); each pins the exact property. Seams: the real `SessionHost`+`Connection` rig (`relay.test.ts:99-207`) extended with an optional daemon-side `FakeJobs` (the `JobController` fake of `tui/test/auto-wake.test.tsx:35-59`) returned by `createAgent` and given to the `Agent` — so the exit crosses the real wire (`hosted-session.ts:448` → `remote-client.ts:1697` → `remoteJobsView` → relay). `Scripted.calls` counts model turns. Rig config gets `autoWake: true` via `rig(…, …, { autoWake: true })` (`relay.test.ts:210-221`).

`packages/core/test/auto-wake.test.ts` (new): exit → pending; N exits → one pending; `turn_started` clears; `refused` re-pends; `reset` clears; `wakeDue` false for each gate leg (disabled / not idle / blocked) and true only with all four.

`packages/cli/test/relay-state.test.ts`: `job_exit` pends; `relayWakeDue` false while `turn: running`, `asks>0`, `handover: prepared|done`, `stopping`, `linkStopped`, `exiting`; `wake_refused` → `turn: over`, `rest` unchanged; `exitPlan` → `hold` with a pending wake (keep=true and keep=false), still `remove` on a stop.

`packages/cli/test/relay.test.ts`:
- **R-W1 (THE bug, red on `main`)**: keep=true, run's turn ends, fire one daemon-side exit while idle → `Scripted.calls === 2`, the second request's last message is the agent's `[background] job …` note, the laptop store has the wake reply, and `owner.json` went `running` → `idle`.
- R-W2: exit during the run's turn (hang the first turn on a held stream) → exactly ONE wake after it ends.
- R-W3: three exits during the run's turn → exactly one wake; one exit during the wake turn → exactly one more.
- R-W4: `autoWake: false` → no second model call; the relay leaves after the grace as today.
- R-W5: SIGTERM during the wake turn, keep=false → cancelled, saved, removed (R5 path); with a stuck wake turn → not removed, `not saved` note.
- R-W6: keep=false, wake ends → removal only after the wake reply is in the store; the net's `saved()` is false while the wake runs.
- R-W7: hand-over: `prepare` → fire exit → no wake; `commit` ack has `wakePending: true`; separate case: `prepare` then close the socket (abort) → the wake fires.
- R-W8: `prepare` during a wake turn → ack `turnId` equals the `runTurnId` written for that wake (≠ the run's first id).
- R-W9: a `TurnInProgress` refusal (a second rig client holding the slot) → no `failed` state, the wake runs after the slot frees.

`packages/cli/test/control-socket.test.ts`: `parseReply` keeps `turnId`/`wakePending` when well-typed, drops wrong types, an old reply without them parses as before.
`packages/cli/test/attach-run.test.ts`: `joinRun` adopts the prepare ack's `turnId` (record + `adoptTurn`) and returns `wakePending` from the commit ack; absent fields → today's behaviour.
`packages/tui/test/auto-wake.test.tsx`: **T-TUI-1/2 written and green BEFORE the App edit** (characterisation, guards the refactor): exit during a running turn → exactly one continuation after; two exits idle → one turn. T-TUI-3 (red): `wakePending` prop → one continuation at mount, `model.turns === 1`; with `autoWakeOnJobExit={false}` → none.

**Mutations (confirm non-vacuity, then revert):** M1 drop the relay's `onExit` subscription → R-W1 fails. M2 drop the `handover` gate leg → R-W7 fails. M3 omit `wakePending` from the commit ack → R-W7 / attach-run fail. M4 remove the `exitPlan` pending row → its relay-state test fails. M5 `turn_started` does not clear `pending` → R-W3 / T-TUI-1 fail (extra turn). M6 TUI ignores `idle` in the gate → T-TUI-1 fails. M7 wake turn reuses the run's turn id → R-W1 fails (the daemon returns the cached ack, `hosted-session.ts:1125-1126`, no second model call).

Gate before done: `bun test` (baseline: all pass except the three opt-in skips), `bun run typecheck`, `bun run lint` (clean baseline). Live: re-run `check.sh` → the record ends with `woke: WAKE-DONE`; `ps` `detached · running` during the wake, `detached · idle` after, the relay leaves 60 s later.

**CHANGELOG** (`## [Unreleased]` → `### Fixed`):
- A `run --detach` with no terminal attached now reacts when a background job ends: the relay starts the follow-up turn itself, as the TUI does (`autoWake`, default on). Attaching mid-way never wakes the agent twice.
- (Q1=B) `ps` and `rm` no longer make a finished detached run look alive (`up · idle`; `rm` says the run has ended).

### Notes / debt

- Pre-existing, unchanged: a TUI whose continuation loses the slot drops its wake (`App.tsx:1185-1192`); a TUI misses exits between its runtime's `attachTo` and the App's `onExit` subscription. A daemon-side "unflushed exits" count in `session/list`/open (additive field) would close both for every attach — a follow-up if wanted (Q6).
- **Review F6, accepted:** a refused streak keeps the relay alive with no limit, since each retry clears the grace, and writes `owner.json` each tick. It costs no model calls, and a pod can already pin the relay with `jobs > 0`. A refusal does not count against the wake limit.
- **Review F7:** `relay.test.ts` R-W9's `toBeLessThan(40)` was never seen failing (the mutant hangs first), and R-W4 (`autoWake: false`) has no mutation aimed at it.
- **Review F8:** logic in a component and in the driver: `App.tsx` `handedWakeRef`, `relay.ts` `text === "" && !streamed && slotTaken`. If the adopted turn is still not visible at the one retry, the wake is dropped and the next turn flushes that exit (read, not run).

## Execution

*— claude-opus-5-5, 2026-11-06*

**Re-verification on `036a172`.** The load-bearing chain holds; only lines moved: `background_exit` emit `hosted-session.ts:449-458`, client listeners `remote-client.ts:1750-1757`, agent flush `agent.ts:786` + `:1812-1832`, `assertIdle` `hosted-session.ts:1377-1383`, `autoWake` reads `main.ts:851`, `:1622`, `:1672`. R-W1 proves it end-to-end over the real `SessionHost` + `Connection`.

**As built, in order.**
1. `packages/core/src/auto-wake.ts`: `wakeStep`, `wakeDue`, as planned.
2. `relay-state.ts`: `wake`, `job_exit`, `wake_refused`, `relayWakeDue`, the `exitPlan` hold row. `control-socket.ts`: `turnId`, `wakePending` in the reply.
3. `relay.ts`: subscription gated on `config.autoWake`, `maybeWake` after every `emit`, `drive(text)` with a `let runTurnId`, `exiting`, both ack fields.
4. `attach-run.ts`, `main.ts`, `run.tsx`: the hand-over carry.
5. `App.tsx`: every `wakePendingRef` site moved to the core module (`:674-681`, `:1011-1022`, `:1126`, `:1136`, `:1302`, `:1513`, `:1638`, `:1841`), then the `wakePending` prop and its mount effect.
6. Q1=B: `runFinished`, `up · <state>`, `runningReason`.

**Drift from Implementation, and orchestrator decisions (owner delegation 2026-11-06).**
- **`turn_started` clears `exitAt` at once**, not at the next tick (corrects P6). Why: the loop checks `relayExits` before it ticks, so a wake started at the deadline's last moment would be left behind, and the relay would leave with the wake running.
- **A `failed` or `interrupted` run does not wake, and a pending wake does not hold it** (`rest !== "idle"` blocks; not in the plan). Why: a successful wake would overwrite the failure's reason and, with keep=false, turn a workload a failed run keeps into one it removes. It also stops a dead model endpoint from causing repeated wakes. Cost: that exit stays unwoken until the next turn flushes it.
- **`maybeWake` does not run on the `wake_refused` emit** (the plan said "after every emit"). Why: it would retry at once, in a tight loop against the pod. Retries come at the tick (Q3).
- **Log noise:** a refused streak writes one `wake refused` line and no `state:` flips, except during a stop or an exit. `owner.json` still flips at each retry, and `ps` can flicker `running`/`idle` during a foreign turn.
- **`wakeIfPending` no longer drops a wake when a turn is running at its timeout; it stays pending for that turn's end.** This is a small TUI behaviour change beyond the plan. Why: the handed-over wake needs it to fire after the adopted turn. Worst case: one extra empty continuation after a foreign turn.
- **A handed-over wake that loses the slot is re-pended, once** (`handedWakeRef`, not in the plan). Why: the adopted turn may not be visible yet (held while the history warms), and a silent drop is a bug (§8). Once only, so it cannot loop. Ordinary TUI wakes stay withdrawn as before (two-TUI behaviour unchanged).
- **`wakePending` is absent, not `false`, when nothing is pending.** Why: the existing `commit` tests pin `{ ok: true }`; `joinRun` reads absent as false.
- **`ps`: `up` only for a finished state** (`idle`, `failed`, `interrupted`; no relay, no TUI). `running · relay lost` and `running · attached` stay: neither is a finished run, and README and tests pin them.
- **`rm` wording is not the plan's "no tentacle session attached from this laptop".** It says `is still up — its detached run has ended and no terminal of it is attached`. Why: a plain session with no presence file cannot be ruled out, so the plan's sentence could be false. It applies only when the record's `created` matches (R4); otherwise the old guess stays. `rm` still asks: the removal is unchanged.
- **T-TUI-2 pins two turns, not the plan's "two exits idle → one turn".** Today's App starts a turn on the first exit; the second then waits for that turn's end. The characterisation test records what the code did before the edit.
- **CHANGELOG:** the wake line is under `### Fixed`, the `ps`/`rm` line under `### Changed`.

**Red/green, honestly.** Seen red before the code: R-W1 (`timed out waiting for the wake`), `relay-state` and `control-socket` tests, T-TUI-3/4, both `kept-cmd` tests. T-TUI-1/2 were green on the unmigrated App, as characterisation. **Not seen red on their own:** R-W2…R-W9 (written with R-W1, green at the first run after the relay edit), the core tests and the `attach-run` tests (their code was edited in the same step). The mutations below cover the main ones; R-W2, R-W4, R-W5, R-W5b, R-W6, R-W7b, R-W7c and R-W8 have no mutation aimed at them.

**Mutations** (`cp` backup, `shasum -c` identical after each group, backups removed):

| Mutation | Killed by |
|---|---|
| M1 no `onExit` subscription | R-W1 |
| M2 no hand-over gate leg | R-W7 |
| M3 `commit` ack omits `wakePending` | R-W7 |
| M4 no `exitPlan` pending row | `relay-state` exitPlan test |
| M5 `turn_started` does not clear | core tests, T-TUI-1; R-W3 **hangs** instead of failing (endless wakes), stopped by hand |
| M6 TUI `onExit` ignores idle | T-TUI-1 |
| M7 wake reuses the run's id | R-W1 |
| M8 `turn_started` keeps `exitAt` | `relay-state` deadline test |
| M9 a failed run wakes | `relay-state` failed-run test |
| M10 refusal retried at once | R-W9 **hangs** instead of failing, stopped by hand |
| M11 refusal treated as a failure | R-W9 |
| M12 TUI drops the handed wake on refusal | T-TUI-4 |
| M13 no mount wake | T-TUI-3 |
| M14 `joinRun` drops `wakePending` | `attach-run` hand-over test |
| M15 `joinRun` ignores the `prepare` `turnId` | `attach-run` hand-over test |
| M16 `ps` keeps the engine word | `kept-cmd` finished-run test |
| M17 `rm` ignores the record's tie | `kept-cmd` `rm` test |
| M18 `rm` ignores the TUIs | `kept-cmd` `rm` test |

The `toBeLessThan(40)` bound in R-W9 was never seen failing: under M10 the process hangs first, so it proves nothing on its own.

**Gate (foreground, final tree).** `bunx tsc --noEmit`: clean. `bunx biome check .`: clean, after formatting two test files. `bun test packages`: 4889 pass, 3 skip (opt-in), 0 fail. A bare `tsc -p apps/mobile` was not run, as instructed.

**Unverified.**
- **Nothing was run live:** neither the fix nor the plan's "re-run `check.sh` on `main` and keep `relay.log`". The timeline in Context stays derived from the code. Checklist below.
- **Link reconnect:** read, not run. A redial's replay reaches the same listeners (`remote-client.ts` `deliver`), so a missed exit should wake. If the ring evicted it (a resync), the exit is not delivered and only the next turn flushes it.
- **Exit during the exit-plan read:** pure tests only (`exiting`, the hold row), no relay test.
- **A wake in flight at the `commit` ack, refused after it:** the ack says nothing pending, so that exit is not woken. Narrow; the next turn flushes it.
- **Exit after the `commit` ack, before the App subscribes:** the Q6 gap, already `fix/attach-unflushed-exits` (`TODO.md:432`).
- `docs/feat/config-carry.md:174` still says `autoWake`'s "only reader is the laptop's TUI". Left as is; it needs one word.

**Headless live checklist** (docker, local model; not run). Base: `/Users/gmeghnag/tentacle/.tentacle/tmp/autowake-detach/check.sh`, built from this branch.
1. `run --detach` with the background `sleep 20; echo WAKE-DONE`: within about 30 s `relay.log` shows `wake: background job exit`, then a `state: running` with no TUI; the session record ends with `woke: WAKE-DONE`; `ps` shows `detached · running`, then `detached · idle`.
2. `autoWake: false` in the laptop config, same run: no `wake:` line, the record ends at `started`, the relay leaves after the grace as before.
3. After the relay leaves (up to about 30 s poll + 60 s grace): `ps` shows `up · idle`; `rm aw-test` with no `-f` and no terminal says `is still up — its detached run has ended and no terminal of it is attached. Pass -f …`; `rm -f aw-test` removes it.

### Execution — round 2

*— claude-opus-5-5, 2026-11-06*

The orchestrator's decisions on the Review, all implemented. Not committed.

**What changed.**
- **Q-R1, the cap:** `RELAY_WAKE_LIMIT = 20`, `RelayModel.wakes`, `relayWakeCapped` in `relay-state.ts`. Only a wake counts (`turn_started{wake}`), and a refusal gives its count back. Past the limit a pending wake is not due and `exitPlan` no longer holds on it: it returns `leave`, so keep=false keeps the workload. `relay.ts` `sayCapped` writes `wake limit reached — tentacle attach <name>` to the log and the record, once. The normal grace then runs.
- **Q-R2:** `runFinished` requires `owner.kind === "relay"`. After a TUI only detached, `ps` says `running · idle` and `rm` keeps "a session may be attached".
- **F3:** R-W11 (the review's REVIEW-F) and R-W11b (exit after the final plan; it could be driven, by firing inside the session's flush).
- **F4:** the stop handler emits `stop` before `abortHandover`.
- **F5:** `relayRow` uses `tied && runFinished(...)`.
- **F6, F7, F8:** Notes/debt only. `TODO.md` untouched.

**Drift.**
- **Added beyond the decisions:** R-W10c and a `sayCapped` call after the exit loop. An exit landing during the final read, past the limit, otherwise left a keep=false workload with no reason given.
- **The cap's keep=false rule applies only when a wake is owed.** If the 20th wake ends with nothing pending, nothing was cut off, so the normal removal runs (pinned in the `relay-state` cap test). This reads the decision narrowly: "the agent was cut off mid-work".
- **A stop past the limit still removes** (DR-5): the user asked for it.
- **Corrects round 1:** the "finished" rule above narrows that section's `ps`/`rm` bullet, and the "no bound" reading of "≤ 1 wake per turn end" is gone.

**Red first.**

| Fix | Test | Red on round 1's code |
|---|---|---|
| Q-R1 | R-W10, R-W10b | `Expected: 21`, received 22 and 23 |
| Q-R1 | `relay-state` cap tests | `RELAY_WAKE_LIMIT` not exported (module error, not an assertion); their property is shown by M-B, M-D, M-E |
| Q-R2 | `kept-cmd` detached TUI (`ps`, `rm`) | the `ps` test failed; the `rm` case received the "has ended" wording |
| F4 | R-W12 | `Expected: 1`, received 2 model calls |
| F5 | `kept-cmd` R4 | received `up · idle` |

R-W11, R-W11b and R-W10c are green by nature on the code they guard, so their red is on the mutants below.

**Mutations** (`cp` backup, `shasum -c` identical after each group, backups removed):

| Mutation | Killed by |
|---|---|
| M-A no `exiting = true` | R-W11 (not removed), R-W11b (`Expected: 1`, received 2: a wake started after the final plan) |
| M-B capped row of `exitPlan` falls through | R-W10b, `relay-state` cap test |
| M-C no `sayCapped` after the loop | R-W10c |
| M-D a refusal keeps its count | `relay-state` count test |
| M-E the run's own turn counts as a wake | R-W10, `relay-state` count test |

M-A and M-B ran in one group, as did M-C and M-D: each pair touches different code and is read through its own tests. M-A's R-W11b confirms what the Review only reasoned: without the guard, a wake starts in that window. I did not assert whether it reaches the delete.

**Gate (foreground, final code).** `bunx tsc --noEmit`: clean. `bunx biome check .`: clean, after formatting `kept-cmd.test.ts`. `bun test packages`: 4899 pass, 3 skip (opt-in), 0 fail; the reaper flake did not appear. Only `CHANGELOG.md` and docs changed after that run.

**Unverified.**
- **Still nothing run live.** The checklist above stands. New step: a turn that keeps ending jobs should stop at 21 model calls, with `ps` showing `idle (wake limit reached — tentacle attach <name>)`.
- **The cap's value is the Review's estimate, not a measurement.** A legitimate long poll loop stops at 20; `attach` resumes it. If the relay has already left, the owed exit reaches the agent only at the next turn's flush; the attaching TUI gets no `wakePending`.

## Review

*— claude-opus-5-5, 2026-11-06*

**Verdict: REQUEST-CHANGES.** 3 MEDIUM, 5 LOW. The core of the fix holds: one driver at a time, the hand-over carry, `saveConfirmed`, `autoWake: false`, a `failed` run stays failed. What blocks it: nothing limits unattended wakes (F1), `rm` can say a run has ended when it has not (F2), and the guard against a wake under a removal has no test (F3).

Same model as the executor, fresh context only: shared blind spots may survive both passes (AGENTS §10).

### Findings

**MEDIUM**

1. **F1: no bound on wakes in a run, and no test for one** (`relay.ts:248-256`, `:423-432`; `relay-state.ts:193-204`). The plan's "≤ 1 wake per turn end" limits the rate per turn, not the total. If each woken turn starts a job that ends, the loop runs until a stop, a hand-over or a failed turn. REVIEW-A below reached 300 wakes in 646 ms with an instant model. Nobody is watching, the laptop's key pays, and `wantsAwake` keeps the Mac awake during each turn. A shell job needs `--auto-accept` or an allowlisted command to restart without an ask. The TUI has the same logic, but there a person sees it and can stop it. Executor mutations M5 and M10 hung rather than failed, which fits: no outer bound exists. Decision: Q-R1.
2. **F2: `rm` says "its detached run has ended" after a TUI only detached** (`run-state.ts:488-494`, `attach-run.ts:539-544`, `kept.ts` `runningReason`). `runFinished` does not check the record's `kind`. `lastOut` writes `idle` when the last TUI of a keep=true run leaves, whether or not jobs or a turn are alive in the pod (REVIEW-C: `true` for a `tui` record). AGENTS §7 says that close only detaches. So the destructive prompt can say the run has ended while a background job is running, and the old cautious wording is gone. `rm` still asks. `up · idle` itself stays literally true. Recommended fix: require `owner.kind === "relay"`; a relay's `idle` means it read 0 jobs before leaving. That is a small change plus one test. Decision: Q-R2.
3. **F3: the guard against a wake under a removal has no relay test** (`relay.ts:552`). See Mutation below: the suite stays green without `exiting = true`. The Execution section's "pure tests only" understates this, because only `relayWakeDue`'s parameter is tested, not the wiring. REVIEW-F is the missing test: green on the real code, red on the mutant. Add it. Also add a case for an exit after the final plan, which I reasoned about but did not run.

**LOW**

4. **F4: a stop during a prepared hand-over with a wake pending starts that wake** (`relay.ts:282-284`, `:437-451`). `abortHandover` emits `handover_aborted` before `stop` is emitted, so `maybeWake` still sees `stopping: false`. REVIEW-B: prompts 1 → 2 and model calls 2, after the stop. The turn is cancelled and the stop path converges (not run for keep=false), but one prompt and one billed model call follow a stop. Fix: emit `stop` first, or block the wake in that step.
5. **F5: `ps` does not apply the R4 tie that `rm` does** (`kept-cmd.ts:225`; compare `kept-cmd.ts:392-397`). A record from an earlier workload of a reused name yields `up · idle`. The `idle` was already shown before this task, so only the word changes. Fix: `tied && runFinished(...)`.
6. **F6: a refused streak keeps the relay alive with no limit** (`relay.ts:423-432`). Each tick sets `exitAt`, then the retry's `turn_started` clears it, so the 60 s grace never elapses while the slot is held. It also writes `owner.json` each tick. This costs no model calls, and a hostile pod can already pin the relay with `jobs > 0`, but Q3's answer did not mention it. A shared bound from Q-R1 could cover it; otherwise record it as accepted.
7. **F7: test bounds that prove little.** `relay.test.ts:2530` (`toBeLessThan(40)`) was never seen failing, as Execution says. R-W4 (`autoWake: false`) has no mutation aimed at it; the check is simple and the test reads correct, but I did not mutate it either.
8. **F8: a logic decision in a component** (`App.tsx:1221-1225`, `handedWakeRef`; also `relay.ts:403`, `text === "" && !streamed && slotTaken`). AGENTS §7 wants tested branching in the pure module. The core wake decision is correctly in `core/auto-wake.ts` and `relay-state.ts`. Separately, if the adopted turn is still not visible at the one retry, the wake is dropped; the next turn flushes that exit. I read this path but did not run it.

**Not a finding, but needed before merge:** nothing has been run live. Run the Execution section's headless checklist. I did not re-run the owner's Repro (docker + local model).

### Gate

`bunx tsc --noEmit`: clean. `bunx biome check .`: clean (668 files). `bun test packages/core packages/cli packages/tui`: **2942 pass, 0 fail**; the reaper flake did not appear. This is the narrow gate requested, not the full `bun run check`.

### Mutation

One mutation, on `exiting = true` (`relay.ts:552`), the guard that keeps a wake from starting under a removal. `cp` backup, restored, `shasum -c` OK, `git status` clean.

| Run on the mutant | Result |
|---|---|
| `relay.test.ts` + `relay-state.test.ts` | **Survived:** 124 pass, 0 fail (F3) |
| REVIEW-E (the wake ends inside the read) | Survived; it does not reach the property |
| REVIEW-F (the wake outlasts the read) | **Killed:** `removed: false`, `the relay was stopped before the turn ended; not saved — workload kept`. Green on the restored code |

The mutant ends on the safe side here: the `settled` veto keeps the workload. After the final plan the veto has already been computed, so I expect a wake in that window to reach the delete. That part is reasoned, not run.

### Premise table

| Premise | Result |
|---|---|
| Symptom: the relay never subscribes to exits on `main` | TRUE from code (`git show main:…/relay.ts`: 0 `onExit`). The live Repro was not re-run |
| Daemon emits `background_exit` outside turns (`hosted-session.ts:453`) | TRUE |
| Listeners fire whatever the turn state (`remote-client.ts:1750-1756`) | TRUE |
| The agent flushes at turn start (`agent.ts:786`, `:1812-1832`) | TRUE |
| `""` is a continuation (`agent/src/session.ts:89-92`) | TRUE |
| `assertIdle` guards the slot (`hosted-session.ts:1377`) | TRUE by location and R-W9; body not reread |
| A reused turn id never runs twice (P3) | Not opened; R-W1 asserts a fresh id, and executor's M7 covers it |
| `autoWake` defaults on, laptop-side (`config/src/resolve.ts:430`) | TRUE |
| `parseReply` drops unknown fields, copies the new two (`control-socket.ts`) | TRUE |
| A pod can already drive `model/stream` (`remote-client.ts:1951`) | TRUE, no cap |
| "Bounded: ≤ 1 wake per turn end" | TRUE per turn, misleading as a bound (F1) |

### Attacks tried

| Attack | Result |
|---|---|
| Wake loop: each woken turn ends a job | **Unbounded** (F1) |
| Hostile pod: spoofed or flooded `background_exit` | No new exposure. N exits are one `pending`, nothing per exit is logged, and pod text stays out of the log. The pod can already call `model/stream` uncapped while the link is up, so the spoof gains nothing. The wake's real risk is F1, with an honest pod and a looping model |
| The single retry (`handedWakeRef`) | Once only, cannot loop, pinned by T-TUI-4. A possible drop is in F8 |
| Refusal retry | One attempt per tick, no tight loop (`emit` skips `maybeWake` on `wake_refused`; M10). Liveness cost is F6 |
| Two drivers: `prepare`/`commit` | Held. The gate blocks while `prepared` and `done`; the ack carries `turnId` and `wakePending`. No socket → `refuse` (`attach-run.ts:193-197`), never a blind join |
| Stop during a prepared hand-over | Stray wake (F4) |
| Wake with a turn running or an ask pending | Blocked by `idle` (`turn === "over" && asks === 0`); fires on the emit that frees it |
| Wake at `exitAt` | `turn_started` clears the deadline at once. With keep=true, plan and `leaving` are in the same tick. No endless hold: anything that sets `exitNow` also leads to an exit row |
| keep=false save | Held. `turn_started` is synchronous, so the net reads `running` for the whole wake; R-W5b and R-W6 pin it |
| `exiting` wiring | Correct by reading, untested (F3) |
| `autoWake: false` | No subscription, so never pending, so no wake and no `wakePending`. TUI side: the `enabled` leg and T-TUI-3 |
| `failed` / `interrupted` | Blocked by `rest !== "idle"`; no hold in `exitPlan`; M9 |
| `ps` / `rm` wording | `up` only with the engine at `running`, no relay, no TUI. Live relay states and `… lost` are unchanged. False claim in `rm` (F2); missing tie in `ps` (F5) |
| Logic placement | Decisions are pure, except F8 |

### What holds

The single broker is untouched: wake turns use the relay's one session and `policy`. No new secret or model path reaches the pod, and `PROTOCOL_VERSION` is unchanged. The fresh `turnId` is the only new value on the wire. No lock was added to the peer. `autoWake` stays on the laptop.

### Executor behaviour

Honest. Its "Red/green" and "Unverified" lists match what I found, including the tests it never saw red and the hanging mutations. It called its own drift out, and its added `rest !== "idle"` guard is the right call. Its miss: it listed the hanging mutants as a test nuisance without asking what they implied, which is F1.

### Questions for the orchestrator

- **Q-R1 (F1): add a cap on wakes per relay? Recommendation: yes, before merge.** A pure limit in `relay-state.ts`, e.g. 20 wakes per relay, not configurable for now. At the limit: no more wakes, the pending wake no longer holds `exitPlan`, a `wake limit reached — tentacle attach <name>` note goes into the record and the log, and the normal grace runs. With keep=false, keep the workload, since the agent was cut off mid-work. Turn REVIEW-A into its test. The trade-off: a legitimate long poll loop would stop at the cap, and `attach` resumes it. The cap value is my estimate, not measured.
- **Q-R2 (F2): narrow `runFinished` to relay records? Recommendation: yes.** After a TUI detach, `ps` and `rm` keep today's wording (`running · idle`, "a session may be attached"), which is cautious and true.

### Repro (scratch, `.tentacle/tmp/autowake-review/`, removed)

`relay.test.ts` lines 1–2276 with absolute imports, plus these tests inside the wake `describe`:

```ts
test("REVIEW-A", async () => {
  const jobs = new FakeJobs();
  let calls = 0;
  const model = { id: "loop", async *stream() {
    calls++;
    setTimeout(() => jobs.fire(`j${calls}`), 0);
    yield { type: "text", delta: "again" } as StreamEvent;
    yield { type: "done" } as StreamEvent;
  } } as unknown as ModelProvider;
  const pod = resident(model, { jobs });
  const { start, stopRef } = rig({}, {}, ON);
  const exit = start(pod.attach);
  const t0 = Date.now();
  while (calls < 300 && Date.now() - t0 < 20000) await tick(5);
  stopRef.stop?.();
  await afterGrace(exit);
  expect(calls).toBeGreaterThanOrEqual(300);
});

test("REVIEW-F", async () => {
  const jobs = new FakeJobs();
  const model = new Waking([say("started"), say("woke")], [1]);
  const pod = resident(model, { jobs });
  const box = removing({}, {}, ON);
  let fired = false;
  const exit = box.start(reading(pod, async () => {
    if (!fired) {
      fired = true;
      jobs.fire();
      await tick(20);
      setTimeout(() => model.open(1), 40);
    }
    return { jobs: 0, running: false, others: 0 };
  }));
  await waitFor(() => owner(box.dir)?.state === "idle", "the run's turn");
  await afterGrace(exit);
  expect(model.calls).toBe(2);
  expect(box.calls).toContain("remove:box");
});
```

REVIEW-B: `prepareAt`, `jobs.fire()`, `stopRef.stop()`, then count the `session/prompt` frames. REVIEW-C: `runFinished({ kind: "owner", owner: { kind: "tui", state: "idle" } }, false, 0)`.

```
REVIEW-A model calls: 301 wake log lines: 300 ms: 646
REVIEW-B prompts before stop: 1 after: 2 model calls: 2 wake logged: true
REVIEW-C finished after a TUI detach: true
REVIEW-E calls: 2 removed: true saved: true detail: undefined
REVIEW-F calls: 2 removed: true detail: undefined        (real code)
REVIEW-F calls: 2 removed: false detail: the relay was stopped before the turn ended; not saved — workload kept: tentacle rm box        (mutant)
```

## Owner questions

*— claude-opus-5-5, 2026-11-05*

- **Q1 — Second symptom (`running · idle`, `rm` asking `-f`).** Not a bug: the designed 60 s idle exit (DR-4) plus a guessing `rm` text. **Recommendation: OUT of this task**; a separate `fix/rm-ps-dead-relay-wording` (S · contained): `rm` says "is running (no tentacle session attached from this laptop)" when no relay and no TUI presence is alive, and `ps` marks the engine word for a finished detached run (e.g. `up · idle`).
- **Q2 — Hand-over carry (`turnId` in the `prepare` ack, `wakePending` in the `commit` ack).** **Recommendation: IN** — without it a wake pending at hand-over is lost, and a TUI attaching mid-wake treats that wake as foreign (auto-accept would not answer it). ~20 lines, laptop-local, additive.
- **Q3 — A wake refused because another client holds the turn.** Retry each tick (never lose a wake; worst case one extra empty continuation) vs drop it (TUI parity). **Recommendation: retry.**
- **Q4 — Migrate the TUI to the shared `@tentacle/core` module in this task.** **Recommendation: yes** (§7 "no second copy"; behaviour pinned by characterisation tests first). Alternative: relay-only now, TUI later (two copies meanwhile).
- **Q5 — Where the relay reads `autoWake`.** Its own loaded laptop config (`relayMain`'s `loadConfig` at the run's cwd/profile, `relay.ts:604-608`) vs a snapshot in `RelaySpec` at launch. **Recommendation: the loaded config** — same source as the TUI (`main.ts:854`), no spec-format change.
- **Q6 — Follow-up for the pre-existing attach gaps** (daemon reports unflushed exits at attach). **Recommendation: a TODO entry only, not now.**
- **Q7 — Rating and order.** Re-rated **M · load-bearing** (TODO said S–M · cross-module) because it adds turns inside the relay's lifecycle and `exitPlan`. **Recommendation:** Opus executes, fresh-context Opus review; branch only AFTER `feat/config-carry` merges (shared `main.ts`, `CHANGELOG.md`; per `TODO.md:430` "After feat/config-carry").

### Owner answers (2026-11-05)

- Q1: **B — IN this task**: the `rm`/`ps` wording for a finished detached run (no relay, no TUI) is fixed here too (owner chose over the recommendation).
- Q2: **A — IN**: hand-over carries `turnId` (prepare ack) and `wakePending` (commit ack).
- Q3: **A — retry** a refused wake at each tick (never lost; worst case one empty continuation).
- Q4: **A — migrate the TUI** to the shared `@tentacle/core` module in this task (characterisation tests first).
- Q5: **A — the relay reads `autoWake` from its own loaded laptop config** (`relay.ts:604-608`), no spec change.
- Q6: **A — TODO entry only** for the pre-existing attach gap (daemon reports unflushed exits at attach).
- Q7: **A — Opus executes, fresh-context Opus review; branch only after feat/config-carry merges.** Note for the executor: Q1=B adds the `rm`/`ps` wording fix (diagnosis above) to this task — update Files/Tests/CHANGELOG first.

### Orchestrator decisions on the Review (owner delegation 2026-11-06)

- **Q-R1 → yes, before merge:** a pure cap of 20 wakes per relay in `relay-state.ts`, as the review proposes: not configurable, at the limit no more wakes and no `exitPlan` hold, note `wake limit reached — tentacle attach <name>` in the record and the log, then the normal grace; keep=false keeps the workload. REVIEW-A becomes its test (red without the cap).
- **Q-R2 → yes:** `runFinished` requires `owner.kind === "relay"`; plus one test.
- **F3:** add REVIEW-F as a relay test (red on the `exiting = true` mutant), plus the exit-after-final-plan case if it can be driven.
- **F4:** fix: a stop during a prepared hand-over must not start the pending wake (emit `stop` first or block the wake), with a test.
- **F5:** fix: `ps` applies the R4 tie (`tied && runFinished(...)`), with a test.
- **F6:** accepted (no model calls; a pod can already pin the relay with `jobs > 0`); note it under Notes/debt.
- **F7, F8:** left as debt (TODO), no change this round.

*— claude-opus-5-5 (orchestrator), 2026-11-06*

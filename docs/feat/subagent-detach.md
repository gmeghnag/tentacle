# feat/subagent-detach — writing while a foreground sub-agent runs moves it to background

> **Status:** implementation (plan awaiting approval and the owner's answers)
> **Branch:** `feat/subagent-detach` (off `main` `f9342d3`)
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** DeepSeek exec, one Opus review

Task 6b of `docs/eval/subagent-live.md`. Vocabulary: **child** = a sub-agent; **detach** = a running foreground child becomes a background child `sa-N`; **steer** = a message written while a turn runs (`session/enqueue`).

## Context

*— claude-opus-5-5, 2026-11-10*

**Problem.** A foreground `agent_task` holds its round until the child ends. A steer waits behind it, however long the child runs: the model reads it only at the next round boundary (`packages/agent/src/agent.ts:898-902`). Send-now is worse: it aborts the turn and the child's work is lost.

**Decided already (not re-opened here).**
- Writing while a foreground child runs moves it to background (eval Q1, mock at `docs/eval/subagent-live.md:955-962`).
- **Q13 (a):** send-now first moves the child to background, then sends; its work is kept (`:1082`).
- **M1:** the trigger is `HostedSession.enqueue` / `send_now`, the USER's path, never `Session.enqueue` (`:810-820`). The child has its own controller, linked to the turn signal until detach and unlinked then; signals are never switched mid-run.
- **F8:** a detach never fails at a full cap (`:507-508`). **F6:** any writer's steer triggers it (`:499-500`).

**What 6a already gives** (`docs/feat/subagent-background.md`): `AgentJobs`, the `sa-N` id and ledger markers, the exit note and wake, asks attributed to `sa-N`, the `subagents` update, `agent_kill`. `/clear` keeps background work in-session (`docs/feat/clear-keeps-jobs.md`). 6b adds only the trigger that puts an already-running foreground child on that path.

**Repro** (2026-11-10, this tree; `.tentacle/tmp/subagent-detach/probe.ts`, real `HostedSession` + `Session` + `Agent`). Part A is the missing capability, part B is the proof used below. Output:

```
A after steer, child still running: model requests = 1
A after child end: model requests = 2
A 2nd request tail: [ "tool:child report", "user:steer text" ]
B before steer: model requests = 1
B next model request reached on microtasks alone: true (20 hops)
B 2nd request tail: [ "tool:moved to background as sa-1", "user:steer text" ]
```

The core of the probe (fake `Model` with a gated step, `blocking` tool whose `execute` returns a promise the probe holds):

```ts
// A: real createTaskTool, child model gated. Steer, settle, count parent.seen; then release the child.
r.hosted.prompt("t1", [{ type: "text", text: "go" }]);
await settle();
r.hosted.enqueue("e1", "t1", "steer text");
await settle(); // parent.seen.length === 1: the steer waits for the child

// B: the same synchronous stretch, which is what detachForeground() inside enqueue would be.
r.hosted.enqueue("e2", "t2", "steer text");
release({ content: "moved to background as sa-1" });
let hops = 0;
while (r.parent.seen.length < 2 && hops < 2000) { await Promise.resolve(); hops++; }
```

## Implementation

*— claude-opus-5-5, 2026-11-10*

### Load-bearing assumption

**A detach fired synchronously inside `HostedSession.enqueue` answers the `agent_task` call in the same round, and the steer is drained at the very next boundary, with no `await` added to the steering window.**

Proved, on both halves:
- **Code.** `enqueue` is synchronous (`packages/daemon/src/hosted-session.ts:2310-2337`). The loop's only wait on the call is its `execute` promise (`agent.ts:1371-1375`; group: `:1547-1549`, `:1565`). Then `tool_result`, the push and `history_commit` (`:1384-1393`), and the next iteration drains the queue before any model request (`:898-902`).
- **Execution.** Probe B above: the next model request is reached on microtasks alone (20 hops, no macrotask), and its tail is `[tool result, steer]`, in that order. T15 pins this on the real seam.

The eval's `ToolContext.detach` is not needed: the foreground slot in `AgentJobs` (`packages/core/src/agent-jobs.ts:236-247`) already reaches every running foreground child, so `agent.ts` does not change at all.

### Preconditions

| # | Fact | Where |
|---|------|-------|
| P1 | `HostedSession.enqueue` is the only user steer path, called only by the RPC handler | `daemon/src/connection.ts:343` |
| P2 | `Session.enqueue` is also a reload's restore path, and the non-hosted path: must never trigger | `hosted-session.ts:673`, `cli/src/session-jobs.ts:141` |
| P3 | Past its checks, `enqueue` is one synchronous stretch (`id` retry, reserved send-now and `NoTurnRunning` return or throw first) | `hosted-session.ts:2311-2336` |
| P4 | `sendNow` aborts the running turn at one point, synchronously | `hosted-session.ts:1721-1726` |
| P5 | Every foreground child holds a slot; slots and background children share the one cap | `agent-jobs.ts:236-247`, `:273-275` |
| P6 | A background launch's marker is logged and persisted synchronously, before the tool result commits | `hosted-session.ts:1499-1520` |
| P7 | `launched` binds the id to the active turn (the ask's `turnId`), so it must run while `activeTurnId` is still the old turn | `hosted-session.ts:635-641` |
| P8 | The tool result of a call that returns during an abort is still pushed and committed; the turn ends at the next iteration top | `agent.ts:1379-1393`, `:892-896` |
| P9 | The foreground ask settles on the TURN's signal and writes a `turn.pending` record | `hosted-session.ts:726`, `:752-765` |
| P10 | The background ask writes nothing and is re-offered at attach and barriers | `hosted-session.ts:855-909` |
| P11 | The child's permission lane waits on the child's call signal, and the requester runs inside it | `agent/src/permission-gate.ts:167-177` |
| P12 | `tool_progress` is a display update with a free `kind`, an unknown field is stripped, and new fields are free (§7) | `protocol/src/updates.ts:137-148` |
| P13 | `dispose` aborts `running` and clears `foreground` | `agent-jobs.ts:250-260` |

### Design

**Shape.** The slot of a foreground child becomes movable. `HostedSession` calls `agentRuntime.detachForeground()` at its two user paths. Each movable child, synchronously: takes an id, turns its slot into a running entry, unlinks from the turn, switches its sinks, and resolves its tool call with the moved-to-background result.

**1. `AgentJobs` (core).** `foreground` becomes `Map<symbol, { description, startedAt, move?: () => void }>`. `AgentSlot`'s ok arm gains:
- `movable(move: () => void): void`, which registers `move`;
- `adopt(spec, controller, live, run): string | undefined`.

`adopt` runs in one synchronous stretch. It returns `undefined` if disposed, no host, or the token is gone (released). Otherwise, in this order: `host.launched(spec)` first (a throw leaves the child foreground, nothing half-moved), then `foreground.delete(token)` and `running.set(...)` with the slot's `startedAt`, `live.set(agentId, seed)`, `changed()`, and `void drive(...).catch(() => {})` as `start` does. **No cap check (F8):** one slot is exchanged for one entry, `used()` does not change.

`detachForeground()`: iterate a snapshot of `foreground`, call each `move` in its own `try`. Idempotent: a moved child has left the map.

Extract `foldAgentProgress(live, event): boolean` from `progress` (`:164-176`) and export it, so the foreground phase folds the same way and the row is honest at the moment of the move.

**2. `agent_task` (tools/task.ts, foreground branch, `:235-260`).** When `bg` and `ctx.toolCallId` are both present, run through a new private `runMovable`. Otherwise today's path, unchanged. `runMovable`:

```ts
const own = new AbortController();
const unlink = linkAbort(ctx.signal, own);      // aborts own at once if already aborted
const withdrawn = new AbortController();
const live = emptyLive();
let agentId: string | undefined;                 // THE authority on which path won
let finished = false;
let sink = (e) => { foldAgentProgress(live, e); ctx.emitProgress?.(e); };
const running = run(runOpts, {
  signal: own.signal,
  onEvent: (e) => sink(e),
  toolCallId: ctx.toolCallId,
  sessionId: ctx.sessionId,
  move: { withdrawn: withdrawn.signal,
          background: () => agentId ? { id: agentId, signal: own.signal } : undefined },
});
const settled = running.then(
  (r) => { finished = true; return r; },
  (e) => { finished = true; return failure(e); },   // the 6a `outcome` text, stopReason "error"
);
let moved!: () => void;
const movedTo = new Promise<void>((r) => { moved = r; });
slot.movable(() => {
  if (finished || own.signal.aborted) return;       // already ending or cancelled: nothing to move
  const id = slot.adopt(spec, own, live, async () => shape(await settled, own.signal));
  if (id === undefined) return;
  agentId = id;
  unlink();
  sink = (e) => bg.progress(id, e);
  withdrawn.abort();
  ctx.emitProgress?.({ kind: "subagent_end", toolUses: live.toolUses, stopReason: "background", agentId: id });
  moved();
});
await Promise.race([settled, movedTo]);
unlink();
slot.release();                                      // idempotent; no-op after adopt
if (agentId !== undefined) return { content: movedText(agentId, args.description) };
return foregroundResult(await running);              // today's note logic, `:253-260`; a rejection re-throws
```

Rules the executor must keep:
- `agentId`, set synchronously in `move`, alone decides the path. Never branch on which promise won the race (a finished child and a move in the same tick would otherwise give two reports).
- A failure before the move must still fail the call as today, so the not-moved path awaits `running`, never `settled`: the throw reaches the registry and is not turned into a report (T13).
- `shape` is the closure 6a has at `:222-226`: extract it and use it in both paths.

`movedText`: `` moved to background as ${id}: ${description}. Its report will arrive later as a [background] note; you can keep working or end your turn. ``

**3. The child's asks (agent/subagent.ts, core/permission.ts, hosted-session.ts).** An open foreground ask lives on the turn (P9). It cannot stay there: the next round could commit past it, Esc would cancel it, and it has a `turn.pending` record. So it is **withdrawn and asked again on the background path**, inside the same permission lane (P11), so nothing can overtake it.
- `PermissionRequestOptions` gains `withdraw?: AbortSignal` (process-internal, like `signal`).
- `awaitDecision`: `const settleOn = options?.withdraw ? anySignal([signal, options.withdraw]) : signal;`, passed to `registerAsk` and to `untilAborted` (a hung disk must not trap the re-ask). In the final `.then`: `if (outcome.outcome === "cancelled" && options?.withdraw?.aborted) return DISMISSED;`. `AbortSignal.any` needs the cast the repo already has at `providers/src/connect-timeout.ts:173-175`: move that helper to core and reuse it.
- `SubagentRunControls` and `TaskRunControls` gain `move?: { withdrawn: AbortSignal; background(): { id: string; signal: AbortSignal } | undefined }`.
- `subagentRequester` gains the `move` parameter. At each ask: an owner (`background ?? move?.background()`) goes straight to the 6a path. Otherwise it asks with `withdraw: move.withdrawn`; if the answer is `dismissed` and `move.background()` is now set, it re-asks on the 6a path. A human's refusal is never `dismissed`, so it is never re-asked.

**4. The trigger (hosted-session.ts).**
- `enqueue`: after `this.queue.push(...)` at `:2334`, before `this.persist()`: `this.agentRuntime?.detachForeground();`. Only there: the three earlier returns and throws never detach.
- `sendNow`: inside the `running && this.controller` branch at `:1721`, between `this.successor = reserve()` and `this.controller.abort()`: the same call. Before the abort is the whole point (P7, and the child must be unlinked first).
- `Session.enqueue` is not touched.

**5. Display.** An optional `agentId` on `subagent_end`, end to end, is a free field (P12): no bump.
- `core/tool.ts:87` `ToolProgressEvent`; `agent.ts:268` and `:325` the `AgentEvent`; `daemon/src/mapping.ts:273-280`; `protocol/src/updates.ts:137-148` (and the doc comment at `:134`); `client/src/mapping.ts:128-136` through `progressText`; `tui/src/state.ts:453-462` onto `SubAgentProgress`.
- `tui/src/subagent-view.ts`: for `stopReason === "background"`, the outcome is `{ stopReason, closing: "→ background as sa-1 · its report will arrive later", movedTo: "sa-1" }` (`→ background` if the id is absent). Pure, unit-tested.
- `tui/src/render-lines.ts`: `:310` paints the closing row with `theme.subtle` when `view.done.movedTo` is set, else `theme.error` as today; `:473-479` gives no report body when moved (the row already says it, as the eval's mock shows).

No protocol method, no update kind, no on-disk format change. **`PROTOCOL_VERSION` stays 21.**

### Files

Dependency order, smallest diff:

1. `packages/protocol/src/updates.ts`: `agentId` optional on `ToolProgressSchema`. Then `bun run schema:export` (`packages/protocol/schema/protocol.json`).
2. `packages/core/src/agent-jobs.ts`: slot `movable` / `adopt`, `detachForeground`, `foldAgentProgress`, `startedAt` on the slot.
3. `packages/core/src/tool.ts`: `agentId` on `subagent_end`.
4. `packages/core/src/permission.ts`: `withdraw`.
5. `packages/core/src/index.ts` (if the new exports need it) and the `anySignal` move out of `packages/providers/src/connect-timeout.ts`.
6. `packages/agent/src/subagent.ts`: `move` control, `subagentRequester`.
7. `packages/agent/src/agent.ts`: `:268`, `:325` only (the optional field).
8. `packages/tools/src/task.ts`: `runMovable`, the shared `shape`, the `move` control type.
9. `packages/daemon/src/hosted-session.ts`: the two triggers, `awaitDecision`.
10. `packages/daemon/src/mapping.ts`: the field.
11. `packages/client/src/mapping.ts`: the field.
12. `packages/tui/src/state.ts`, `subagent-view.ts`, `render-lines.ts`.

`packages/cli` has no production change: `wiring.ts:559-572` already passes `background: agentJobs`. Tests are listed below.

### Failure modes

| # | Case | How state converges |
|---|------|---------------------|
| 1 | **Two foreground children run** (siblings in one group) | All running children move in one synchronous stretch, each with its own `sa-N` (Q-A). The group's one commit carries both results (`agent.ts:1581-1589`) |
| 2 | **A later `agent_task` of the round has not started yet** | It never held a slot, so it runs in the foreground; a second write moves it (Q-B). Under `subagents.execution: "sequential"`, the steer waits for it, as it does today |
| 3 | **Detach races the child's end** | `finished` set: `move` returns, the normal report goes out. A move in the gap before that `.then`: `agentId` wins, `drive` ends it at once, exactly one report (as a note). The tool has already returned: slot gone, the steer is a plain steer |
| 4 | **Full `maxParallel` (F8)** | No cap check in `adopt`: a slot is exchanged for an entry. A later spawn of the same round may then be refused at the cap, with the running children named: the honest 6a error |
| 5 | **Send-now (Q13)** | Detach, then `abort`. The call's result is pushed and committed (P8), the old turn ends `cancelled`, the successor starts. The child is unlinked, so the abort does not touch it. Its report arrives as a note |
| 6 | **A steer while the child's ask is open** (reachable from a second attached client at least) | The ask is withdrawn (`permission_resolved{cancelled}`, its `turn.pending` cleared by the settle path) and asked again as `sa-N` on the background path, in the same lane (Q-C). A human answer that landed first stands |
| 7 | **An answer racing the withdrawal** | The old id is settled: its late answer is a no-op, a `reply` reaches `onAnswerLost`. The re-asked prompt is answered instead |
| 8 | **`/clear` or quit right after a detach** | The child is a normal 6a child. `/clear`: idle only, keeps it, and its marker is re-emitted in the new segment. Quit: counted by `agentJobsRunning`, `dispose` aborts it (P13) |
| 9 | **Disconnect or `serve` reload mid-detach** | Marker durable before the tool result commits (P6). A restart: `bg` with no `end` gives the lost note once (6a #5); the cut turn is closed honestly. A retried `enqueue`/`send_now` hits its id guard and never detaches twice (`hosted-session.ts:1697-1703`, `:2311`) |
| 10 | **Detach between rounds** | `foreground` is empty: a no-op, the steer drains normally. No marker, no id consumed |
| 11 | **Turn already cancelled when the steer lands** | `own.signal.aborted`: `move` returns. The child ends with the turn, as today |
| 12 | **`launched` throws** | Caught in `detachForeground`: the child stays foreground, the steer is queued. `used()` is unchanged |
| 13 | **Second steer after a move** | The child has left `foreground`: no-op. Only a child still foreground can move |
| 14 | **Esc on a later turn** | Unlinked: only `agent_kill`, close or the panel stop it (eval F9) |
| 15 | **No tool call id / no runtime** (a one-shot) | Not movable: today's path |
| 16 | **Version skew** | The optional field is stripped by an older client, which shows `✗ background` and the tool's text: readable, and no turn fails (P12) |

The tool result the agent sees: exactly `movedText` above, never `isError`. As in 6a, its PostToolUse hooks run twice for that call id (`core/src/tool.ts:118-120`): once on this line, once on the report.

Accepted, same as 6a: a detached child's open ask holds the session's single permission lane, so a later ask of the parent waits for it to be answered (P11).

### Tests

Red before green for each; for T15, T19, T20 also confirm non-vacuity by mutation (§9), as noted.

**`packages/core/test/agent-jobs-detach.test.ts`** (new, `AgentJobs` with a fake host)
- T1 `adopt` at a full cap succeeds, `used` unchanged, a new spawn is still refused.
- T2 `detachForeground` calls each `move` once; a second call does nothing.
- T3 a throwing `move` does not lose the next one; a throwing `launched` leaves the child in `foreground`.
- T4 `adopt` after `release` or after `dispose` returns `undefined`, no id minted.
- T5 the row carries the seed and the slot's `startedAt`; one `ended`, one exit.

**`packages/tools/test/task-detach.test.ts`** (new, fake runner and `AgentJobs`)
- T6 detach returns the exact `movedText`, no `isError`.
- T7 a turn abort before the move aborts the child; after it, does not (the exact unlink property).
- T8 after the move, progress reaches `bg.progress` and never `emitProgress`; `subagent_end{background, agentId}` is emitted once, before the result.
- T9 run settled and move in the same tick: exactly one report in total (result or exit, not both).
- T10 an already-aborted child does not move; no marker.
- T11 no `toolCallId`: not movable, today's result.
- T12 the moved report passes through `shapeResult` with the child's signal.
- T13 a foreground run that rejects before any move still fails the call as today.

**`packages/agent/test/subagent-detach.test.ts`** (new, `subagentRequester` with a fake requester)
- T14 foreground ask carries `withdraw`, no `agent.id`; after the move a new ask has `agent.id` and the child's signal; `dismissed` + moved re-asks once on the background path; a plain `{allowed:false}` + moved is not re-asked.

**`packages/daemon/test/subagent-detach.test.ts`** (new, the `rig` of `subagent-background.test.ts`)
- T15 **the load-bearing assumption:** with a gated child, `hosted.enqueue` then microtask hops only reaches the next model request; its tail is `[tool: moved…sa-1, user: steer]`; the `subagent_background` marker precedes the tool message. *Mutation:* make the trigger run on a `setTimeout`: the microtask-only assertion fails.
- T16 **M1:** `session.enqueue` directly, a retried `enqueue` id, and a `NoTurnRunning` enqueue never detach.
- T17 two siblings (`execution: "parallel"`) both move, in one commit.
- T18 cap 1 with the one slot held: the detach still succeeds.
- T19 send-now: the child survives, the old turn ends `cancelled`, the tool message is in history, the successor's prompt follows, the report later arrives. *Mutation:* swap detach and `abort`: the child dies.
- T20 a steer with the child's ask open: `permission_resolved{cancelled}` for the old id, a new `permission_request` with `agent.id` and the spawn `turnId`, `pendingList` empty, answering runs the tool. *Mutation:* drop `withdraw` from `awaitDecision`: the old ask stays open.
- T21 a refusal settled just before the move is not re-asked; the tool does not run.
- T22 Esc on the next turn leaves the child running; `agent_kill` ends it `cancelled`.
- T23 `/clear` after a move: the marker is in the new segment, the end lands there, the row stays.
- T24 `close` after a move: the child aborts, no exit frame.
- T25 restart with a real `LogSessionStore` (as 6a's T33): marker with no end gives one lost note.
- T26 a steer between rounds: no marker, no id consumed.

**Display.** T27 `packages/client/test/`: `subagent_end` maps `agentId` through `progressText`. T28 `packages/tui/test/subagent-view.test.ts`: the closing row and `movedTo`, not `✗`. T29 `packages/tui/test/render-lines.test.ts`: a moved block shows the row and no report body. T30 `bun run schema:export` leaves no diff.

**End to end.** T31 `packages/cli/test/subagent-detach.e2e.test.ts` (new, the real `createLocalRuntime` ↔ `Connection` stack of `clear-fork.e2e.test.ts`, with the gated model of `cli/test/parallel-agents.test.ts`): a foreground `agent_task` runs, `RemoteSession.enqueue` over RPC; the client stream shows `subagent_end{background}`, the tool result and the steer, the model's next request has the moved result then the steer, `subagents` lists `sa-1`; the child ends; the exit note reaches the next model request. T32 same stack, `RemoteSession.sendNow`: the child survives and its report arrives.

**Validation.** Narrow file per slice during work; `bun run check` before done (§4), lint clean (§6).

**Notes / debt.** The TUI fallback send-now (`tui/src/send-now.ts`, a daemon without `session/send_now`, `App.tsx:1717-1724`) cancels then sends, so it still stops the child: it cannot be reached with this build's daemon. The child's tool trail stays unpersisted (6a).

## Owner questions

*— claude-opus-5-5, 2026-11-10*

**Q-A. You write while two sub-agents of the same round run.**
- **(a) Both move to background (recommended).** Your message cannot reach the model until every call of the round has answered (`agent.ts:1581-1589`), so moving only one would not deliver it.
- (b) Only the most recent moves; the other stays foreground, and your message waits for it.

**Q-B. You write during the first `agent_task` of a round, and another of that round has not started yet.**
- **(a) It starts normally in the foreground; write again to move it (recommended).** The smallest change, and it never starts work in a state you did not ask for. Cost: under `subagents.execution: "sequential"`, your message still waits for that later child unless you write again. The default is `parallel`, which starts siblings together, so this is the less common case.
- (b) It starts already in the background. Your message reaches the model sooner, but a child that has not started is moved with no sign to you, and a round's remaining calls all become background ones. The plan would need a per-round latch in `AgentJobs`.

**Q-C. You write while a sub-agent's permission prompt is open.**
- **(a) The prompt is withdrawn and shown again at once, marked as `sa-N`; the sub-agent moves now (recommended).** Writing behaves the same with or without a prompt, and send-now keeps the work (with (b), a send-now would cancel the ask). Cost: the prompt redraws once, and a click landing in that instant must be repeated.
- (b) The sub-agent moves only after you answer the prompt. Nothing redraws, but the message waits for the answer, and a send-now would refuse that tool call for the child.

### Answers (decided by the orchestrator overnight — to confirm by the owner)

Owner delegated the night of 2026-11-09→10 ("Decidi e fai merge"); each answer is the plan's recommendation:
- **Q-A: (a)** both foreground children of the round move to background.
- **Q-B: (a)** a not-yet-started `agent_task` of the same round starts in foreground; a later write moves it too.
- **Q-C: (a)** an open permission prompt of the child is withdrawn and re-asked at once as `sa-N`; the child moves now.

*— orchestrator (claude-opus-5-5), 2026-11-10*

# feat/parallel-tools — Run a round's independent tool calls concurrently

> **Status:** execution (approved 2026-11-04 with the orchestrator rulings in "Owner questions")
> **Branch:** `feat/parallel-tools`
> **Size:** L · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (ideally a different model from the executor) that red-teams the §7 *Persistence* invariant ("pending on disk ⇒ never started"), the single-broker path, the steering window of `drive`, and the laptop's "Not run" label

Type: feat · Size: L · Blast: load-bearing · Suited: strong model + fresh-context Review

## Context

*— claude-opus-5-5, 2026-11-04*

This is task 6 of [`docs/eval/parallel-execution-plan.md`](../eval/parallel-execution-plan.md)
(split table, `:575`). Tasks 1–5 are merged in `main`:
- 1 `fs-path-locks` (`PathLocks`, RMW tools hold it);
- 2 `subagent-progress-wire`; 3 `model-retry-429`;
- 4 `permission-call-attribution` (asks carry `toolCallId`/`origin`; the daemon no
  longer guesses the call);
- 5 `round-groups-persistence` (record v8: `pending[]` with `groupStart`,
  `turn.inFlight`, `beforeRun → Promise<boolean>`, exact reload labels);
- and `fix/resumed-call-pending` (task-5 F3: `beforeResumedCall`, an awaited clear
  of the carried pending entries before a resumed call allowed without an ask runs).

Task 5 built the *disk side* of a parallel round but no producer: every call is
still its own group. This task builds the producer — the two-phase group
executor — plus the classification that decides which calls may share a group,
and a per-call display signal that tells clients when a call really starts.

**Today's round is strictly serial.** `Agent.runToolCalls`
(`packages/agent/src/agent.ts:1090-1163`) loops `for (const call of calls)`
(`:1097`): each call is `tool_start` (`:1131`), authorized and run by `runTool`
(`:1140`), its result transformed (`:1146`), pushed and committed
(`:1158-1160`) before the next starts. Two calls of 200 ms take ~400 ms (repro).

**Earlier owner decisions this task implements:**
- **PE-Q1 (2026-10-26, eval `:611`):** default = **read-only parallel** (level B:
  read-class tools run together; every write and shell call stays one at a time).
  `sequential` and full `parallel` (commuting resource keys, incl. writes on
  different files) remain selectable.
- **PE-Q2:** R2 (durable `inFlight`) — disk side done in task 5; the call site is here.
- **PE-Q5:** trust MCP `readOnlyHint` by default, with a per-server override.
- **Task-5 owner decision (2026-11-04, `round-groups-persistence.md:484-489`):**
  when `beforeRun` resolves `false` (the awaited `inFlight` write did not land),
  that group runs one at a time — never parallel without a durable record.

### Owner decisions (2026-11-04)

Answers to this plan's first pass. Decisions 5 and 6 replace the earlier "defer
`queued`" and "whole group Interrupted" recommendations.

1. **YES:** `tools.execution: "sequential" | "read-only" | "parallel"`, default
   `read-only`, env `TENTACLE_TOOL_EXECUTION`.
2. **YES:** `tools.maxParallel` default 8 (`1` = sequential).
3. **YES:** `mcpServers.<name>.readOnlyTools: "hint" | "none" | string[]`, default `"hint"`.
4. **YES:** a result-processing failure inside a group → that call's `isError`, the
   turn goes on; sequential keeps today's behaviour.
5. **DO IT NOW, option A:** a new per-call "now running" signal from the agent,
   carried as a DISPLAY-class `session/update` (§7: `UPDATE_CLASS`, union member +
   reverse mapping in `client/mapping.ts`; older clients ignore it → "running" as
   today). The TUI shows a call approved in phase 1 but not yet started as dim
   `◌ <tool> <arg> · queued`, then the normal running spinner when the signal
   arrives. Pure view logic in a module. The mobile app may ignore it for now.
6. **EXACT labels using that signal:** on a laptop cut, "Interrupted" only for calls
   that got "now running"; "Not run" for approved-but-queued and unapproved ones.
   Pod runs: the laptop sees the same updates.
7. **YES:** sub-agents' own rounds stay sequential until task 7; `agent_task` is
   always alone in its group.

**Out of scope (task 7, `feat/parallel-agents`):** `agent_task` keys,
`subagents.execution`/`maxParallel`, the shared session grant store (PE-Q4),
slot detection (PE-Q6). The **mobile app** has no tool rendering
(`apps/mobile/src/spike.ts`) and ignores the new update.

**What the default actually buys today.** The only built-in read-class tool is
`fs_read` (`packages/tools/src/builtins.ts:77-99`); there is no grep/glob/fetch
tool. So the default parallelises `fs_read` runs and MCP tools that declare
`readOnlyHint`. The eval's 2026-10-19 data (4.3 % of calls would leave the
serial path) was not re-measured.

**Repro** (the eval's repro A, 2026-10-26, `main` @ `5e8b538`, script at
`parallel-execution-plan.md:103-121`; the code path has the same shape on
`8bf116f`, `agent.ts:1097-1161`). Output:

```
A. sequential round: ask t1 → t1 start → t1 end → ask t2 → t2 start → t2 end  (408ms for 2×200ms)
```

Not re-run by the planner (read-only brief). The executor re-runs it from
`.tentacle/tmp/parallel-tools/` before any edit, with imports pointed at this
worktree and the two tools changed to `permission: "none"` + a read-class
`concurrency`, and turns it into the red test T-E1 ("two read calls overlap":
`t2 start` before `t1 end`).

## Implementation

*— claude-opus-5-5, 2026-11-04 (re-verified on `8bf116f`: since the first pass only
`agent.ts`, `session.ts`, `hosted-session.ts` and their tests moved among the source
paths cited here; every citation below is current)*

### Load-bearing assumption

> **The only point where a round's own call suspends on a human is
> `gate.authorize`, which settles before that call executes; and in this task no
> call that can raise an ask while executing ever shares a group.** So splitting
> `runTool` into *authorize* (phase 1, serial, call order) and *execute* (phase 2,
> concurrent) keeps both properties the disk relies on: "pending on disk ⇒ never
> started" and "no ask is pending at a `history_commit`".

Proof on `8bf116f`:
- `runTool` authorizes first (`agent.ts:1466-1472`), re-checks the abort
  (`:1477-1479`), handles a refusal (`:1480-1482`), awaits `beforeStart`
  (`:1484-1490`), and only then executes (`:1493`, `:1498`). Nothing between them
  asks anyone.
- The requester is called from exactly two places: the gate
  (`permission-gate.ts:168-172`) and the sub-agent wrapper (`subagent.ts:107`),
  which only `agent_task`'s child reaches (`subagent.ts:205-219`).
- `agent_task` (`tools/src/task.ts:51`) gets no `concurrency` in this task ⇒
  `exclusive` ⇒ always a group of one (decision 7).
- MCP tools cannot ask mid-call: the client rejects a server's `input_required`
  (elicitation/sampling) outright (`mcp/src/client.ts:482-491`).
- Hook-trust asks happen at turn start, never in a round (`agent.ts:675-681`).

**Holds.** The executor must not add a requester call anywhere in phase 2.

**A second property the exact laptop labels stand on** (decision 6): *a "now running"
frame is emitted before its call starts, in stream order*. Today nothing provides
this; the design creates it by yielding the event from the generator and starting
the call only when `drive` pulls again (Design 4, 7). `drive` emits synchronously
on each event (`hosted-session.ts:1384-1440`).

### Preconditions

- **P1. The `beforeRun` contract is written, with no call site.**
  `RunOptions.beforeRun` (`agent.ts:128-140`, type `:153`): awaited after a group of
  more than one call is authorized and before any of its calls runs; `ids` = the
  calls that will run; never for a call alone; abort re-checked after it; `false` ⇒
  one call at a time; absent ⇒ nothing to persist.
- **P2. The daemon side exists.** `HostedSession.beforeRun`
  (`daemon/src/hosted-session.ts:747-759`) sets `this.inFlight`, returns `true`
  without a persister or for a non-writable id (`:752-754`), else awaits the write
  under `untilAborted`. Passed on both sends and the resume (`:488`, `:1153`,
  `:1334`). `inFlight` is cleared at `history_commit`, `context_reset`, `finishTurn`
  (`:1403-1404`, `:1414-1415`, `:1507-1508`), all synchronous stretches.
- **P3. Group anchors.** `GateCall.groupStart?` (`permission-gate.ts:96-102`) is
  forwarded to the requester (`:171`); the daemon records it (`hosted-session.ts:539-551`).
  A call alone must send NO `groupStart` (task-5 drift D1: `cli/test/wiring.test.ts`
  pins the options exactly); `runTool` passes none (`agent.ts:1469-1471`).
- **P4. The reload already reads groups.** `classifyPending`
  (`persisted-session.ts:415`) and `resumableTurn` (`:595-620`) use `suspendedInGroup`
  (`agent/src/resume.ts:55`). A record with `inFlight` is never resumed (`:599`) and
  is labelled per call (`reconcileOnReload`, `:642`, labels `:666-675`).
- **P5. Carried entries.** Set at resume (`hosted-session.ts:472`), filtered at a
  re-ask (`:579`), dropped on ANY settled ask before the awaited write (`:603-609`,
  F1) and at a commit (`:1403`).
- **P6. F3's seam (new since the first pass).** `RunOptions.beforeResumedCall`
  (`agent.ts:149`, type `:156`), passed ONLY to the resumed round's `runToolCalls`
  (`:690-696`; the later rounds' call `:915` passes none), then to `runTool`
  (`:1140`), awaited after an allow and before execution with an abort re-check
  (`:1484-1490`). Daemon: `beforeResumedCall` (`hosted-session.ts:771-778`) is a no-op
  when `carried` is empty; else clears ALL carried entries and awaits that write.
  `carried` is never refilled after the constructor (`:472`), so once cleared it stays
  empty for the turn. `session.ts:46-47`, `:161-163` pass it through. Review finding 2
  of `docs/fix/resumed-call-pending.md:201-207` requires the one-at-a-time fallback
  to keep this hold.
- **P7. Pods and the worker never persist.** `beforeRun` resolves `true` at once
  there (P2); only `startDaemon` gives `SessionHost` a persister (AGENTS §7).
- **P8. Execution never throws; the steps around it can.** `ToolRegistry.execute`
  catches everything (`tools/src/registry.ts:73-100`). `gate.authorize` and
  `transformResult` (`agent.ts:1405-1433`) can throw; today such a throw leaves
  `runToolCalls` and fails the turn (`hosted-session.ts:1441-1461`).
- **P9. Result transforms are safe to run concurrently.** `applyResultTransforms` is a
  per-call fold (`agent/src/result-pipeline.ts:53-63`); `HookRunner.toolResult` keeps
  only locals (`agent/src/hooks.ts:564-591`). Spill paths carry the call id
  (`agent.ts:1417`) and `Bun.write` creates the directory
  (`exec/src/host-execution.ts:215-217`). `summarizeLargeOutput` makes one model call
  per large result (`result-pipeline.ts:248-260`), retried on 429/529
  (`providers/src/retry.ts:12-17`).
- **P10. Clients already handle several running tools.** TUI items are keyed by id
  (`tui/src/state.ts:284-320`); the permission router shows one dialog, the rest
  FIFO (`client/src/permission-router.ts:8`, `:84-112`); wire updates are keyed by
  `toolCallId` (`daemon/src/mapping.ts:215-235`, `client/src/mapping.ts:216-245`).
- **P11. A laptop sees every frame past the cut.** The ring never evicts past the
  history cut and an attach replays from it (`hosted-session.ts:20-40`, `:934-948`).
  The cut moves only at a commit; a group commits once, at its end. So every
  `tool_call` and every new signal of the running group reaches any client that
  attaches, whenever it attaches.
- **P12. Display-update rules.** `UPDATE_CLASS` (`protocol/src/updates.ts:256-278`) is
  a `Record` (a new member without a class is a compile error); union at `:226`;
  an unknown display frame is `unsupported`, reported once per type then skipped
  (`client/src/mapping.ts:49-68`, `session-reducer.ts:276-282`, `tui/src/state.ts:482`).
  So an older client shows ONE notice line and otherwise behaves as today. Exported
  schema: `protocol/schema/protocol.json`. `tool_progress` (`:133-146`) is the
  precedent: free-string `kind`, unknown values skipped.
- **P13. A newer laptop can meet an older daemon with the same `PROTOCOL_VERSION`**
  — which is why this task BUMPS it (ruling 2, "Owner questions"): no capability.
  A pod's binary may lag the laptop's (`TODO.md`, "attach on a container whose pod binary
  is older"). `InitializeResult.agentCapabilities` is the place a daemon can declare
  a feature (`protocol/src/session.ts:77-80`, `:155-160`; set at
  `daemon/src/connection.ts:331`). Fields are free (§7). The client handshake result
  is available (`client/src/remote-client.ts:1099-1113`), today discarded on reconnect
  (`:1284`).
- **P14. Frames are handled in arrival order, synchronously, up to the session.**
  `onNotification` (`remote-client.ts:1046`) → reducer `step` → `listener.output`
  (`:1644-1693`) → `RemoteSession.output` (`client/src/remote-session.ts:893`). The
  `saved` wrapper (`cli/src/local-runtime.ts:362-382`) sees events only when a
  consumer pulls them, so it is too late for a label. `readBack` waits for a live
  stream (`remote-client.ts:871-885`).
- **P15. The laptop cut.** `quit` calls `cutTurn`, takes a last read-back, THEN closes
  (`cli/src/local-runtime.ts:703-735`). `cutHistory` (`:238-249`) labels via
  `answerUnansweredCalls` (`daemon/src/persisted-session.ts:483-489`), the general form
  being `labelUnansweredCalls` (`:497`).
- **P16. Status sites in the TUI.** `ToolStatus` (`tui/src/state.ts:15`). A new value
  falls into wrong branches at `render-lines.ts:458` (non-`ok` → red bullet),
  `:333`, `:437`, `:443`; `commands.ts:380`; `blink.ts:86`, `:151`; `render-lines.ts:405`,
  `:421`, `:455`, `:793`. `history_reset` rebuilds an unanswered call as running
  (`state.ts:465`); the replay past the cut then re-delivers its signals (P11).
- **P17. Tool and context shape.** `Tool` (`core/src/tool.ts:116-130`) has no
  concurrency field; `ToolContext.history` is the live array (`:102`, `agent.ts:663`)
  and `skill` reads it (`tools/src/skill.ts:189`), so `skill` stays exclusive.
  `McpToolDef` has no `annotations` (`mcp/src/types.ts:33-38`);
  `mcpToolToTool(server, client, def)` builds each tool (`tool-adapter.ts:44-63`,
  called at `connect.ts:120`); the client multiplexes by JSON-RPC id
  (`client.ts:365`, `:407`).
- **P18. Config.** `tools` and each MCP server are `.strict()` objects
  (`config/src/schema.ts:283-305`, `:55-77`); `pick(env, file, default)`
  (`resolve.ts:338-349`); the main `Agent` is built in `cli/src/wiring.ts:420-435`
 , child agents in `subagent.ts:205-219`.
  In `run`/`attach` the daemon resolves the pod's config, like `maxIterations`.
- **P19. Versions.** `PROTOCOL_VERSION` 14 → **15** (`protocol/src/version.ts:7`,
  ruling 2): the display kind alone would be free (§7), but a laptop meeting an older
  daemon would mislabel its cut (no `running` signal ⇒ every call "Not run"), a
  semantic change; the bump makes a mixed pair fail at `initialize` instead. Record stays v8
  (`persisted-session.ts:53`): the signal is rendering-only, never persisted (§7).

### Design

**1. The contract (`core`).**
```ts
type ResourceKey = { readonly mode: "read" | "write"; readonly resource: string };
type ToolConcurrency =
  | "exclusive"
  | ((input: unknown) => readonly ResourceKey[] | "exclusive");
interface Tool { readonly concurrency?: ToolConcurrency } // absent = "exclusive"
```
- Two keys **conflict** iff same `resource` and at least one is `write`. `exclusive`
  conflicts with everything. A key function must be total; a garbage input →
  `"exclusive"`, and a throw counts as `exclusive`.
- A call is **read-class** iff its keys are non-empty and all `read`.

**2. Built-in keys (`tools`).** Path key `p(path)` = case-folded **basename** of
`lockKey(path)` (`core/src/path-locks.ts:19`, to export). Deliberately coarse: it
unifies `a.ts` / `./x/../a.ts` / `/ws/a.ts` / `A.ts`, which `PathLocks` does not, at
the cost of serialising two different files with one basename. A false conflict only
serialises; a missed one is repro D. Only `parallel` mode depends on it. Symlinks with
different basenames stay undetected (documented, same as `PathLocks`).

| Tool | Concurrency |
|---|---|
| `fs_read` | `[read path:p]` |
| `fs_write`, `fs_edit`, `fs_multi_edit` | `[write path:p]` |
| `shell` (both modes), `shell_kill`, `skill`, `context_reset`, `agent_task` | absent ⇒ `exclusive` |
| `shell_output` | `[write job:<id>]` (advances a cursor, `background.ts:22-46`) |
| MCP `mcp__s__t` | `readOnly(s,t)` ⇒ `[read mcp:<s>]`, else `exclusive` |
| unknown tool | `exclusive` (planner: `tools.get` is undefined) |

`readOnly(s,t)` by `mcpServers.<s>.readOnlyTools` (decision 3): `"hint"` (default) →
`annotations.readOnlyHint === true`; `"none"` → never; a list → exactly those
tools, by their bare MCP name. A hint is untrusted, but each call stays ask-gated
(`tool-adapter.ts:51`) and the worst case is a reordering within that server.

**3. Pure planner + scheduler (`agent/src/round-plan.ts`, unit-tested).**
- `planGroups(calls, classOf, mode, maxParallel)` → contiguous index groups in call
  order, covering every call once:
  - `sequential`, or `maxParallel === 1`: every call alone;
  - `read-only`: maximal runs of consecutive **read-class** calls, the rest alone;
  - `parallel`: maximal runs of consecutive non-`exclusive` calls, `exclusive` alone.
  - `classOf` uses the **model's** input, so the cut is known before phase 1.
- `dependencies(keys)`: for each call, the EARLIER calls of the group whose keys
  conflict with it, computed after phase 1 from the **effective** input (a hook may
  rewrite a path). A call whose effective class is no longer its planned class is
  treated as `exclusive` (waits for all earlier; all later wait for it). So safety
  is the scheduler's, never the grouping's.
- `nextRunnable(state, cap)`: the lowest-index pending call whose dependencies have
  settled, while fewer than `cap` run. Deterministic.
- The executor addresses calls by **index**, never by id: ids may repeat across rounds
  (`tools/src/skill.ts:72`), and a misbehaving model could repeat one in a message.

**4. The two-phase executor (`agent.ts`).** `runTool` is split, in the generator:
`authorizeCall(call, ctx, {groupStart?, beforeStart?}) → Prepared` (`done` with a
result for cancel/denial, or `run`) and `executeCall(prepared, ctx) → ToolRun` (the
timed `execute` + the H4 banner). `runToolCalls` gets `opts` (from `:690` and `:915`)
and iterates the planner's groups. `context_reset` keeps its own branch and is alone.

A **group of one** runs today's sequence: `tool_start`, `authorizeCall` (which holds
`beforeStart`, exactly as `:1484-1490`), [signal], `executeCall` under the progress
drain, transform, `tool_result`, push, commit.

A **group of N>1**:
- **Phase 1 — authorize, serial, call order.** For each call: aborted → precomputed
  `CANCELLED_TOOL_NOTE`, no `tool_start` (as `:1111-1129`); else `tool_start`,
  `authorizeCall(…, groupStart = the group's first call)`. No `beforeStart` here.
  A denial/refusal/cancel is a precomputed result, its `tool_result` yielded at once.
  An allowed call yields `queued` (Design 7). Nothing is pushed. A throw from the gate
  fails the turn as today: nothing of the group ran.
- **Between phases, only if `toRun` is non-empty and not aborted, in this order:**
  1. `await opts.beforeResumedCall?.(signal)`, then re-check the abort (F3, Design 5);
  2. `landed = await opts.beforeRun?.(ids, signal) ?? true`, then re-check the abort.
     Called when the planned group has >1 call, so `ids` may have length 1 when siblings
     were denied: `inFlight` names exactly the call that may start, and the unanswered
     denials read "Not run".
  Aborted at any point → every `run` call is answered cancelled, none starts.
- **Phase 2a — `landed`: concurrent, driven from the generator.** One merged
  `EventQueue` (`agent/src/event-queue.ts:6`) carries progress, per-call completions.
  Loop: while `nextRunnable` gives a call and not aborted: `yield` its `running`
  signal, re-check the abort, start `executeCall` then `transformResult` then
  `keepDenialReply`, as a promise wrapped so a throw becomes that call's `isError`
  (decision 4). Then take one item from the queue: progress → yield; a completion →
  yield its `tool_result`, mark it settled, loop. After an abort, calls not started are
  answered `CANCELLED_TOOL_NOTE` without a signal; running ones are awaited. Never
  abandon a running sibling.
- **Phase 2b — `!landed`: one at a time.** Walk the group in call order: push a
  precomputed result, or signal + run the call (a transform throw → that call's
  `isError`, as in 2a) and push it, with a `history_commit` after each push. The first
  commit clears the daemon's in-memory `inFlight` (P2), after which the order rule is
  exact again.
- **Commit (2a).** Push every `tool` message in **call order**, then ONE
  `history_commit`. No ask can be pending (load-bearing assumption).

`AgentConfig.toolExecution?: { mode, maxParallel }`; **absent = `sequential`**, so every
existing `new Agent(…)` (tests, child agents) is unchanged. Child agents get none in
this task (decision 7).

**5. F3 in the executor.** The hold is "no carried entry is on disk once a call of
the resumed round may start". One hook point per path:
- group of one: inside `authorizeCall`, after the allow (unchanged, `:1484-1490`);
- group of N: once, between the phases, BEFORE `beforeRun`.

Consequences, for both landed and fallback:
- On 2b the entries are already gone before the first call runs; since `carried` is
  never refilled (P6), no per-call call is needed. This answers F3 Review finding 2.
- On 2a the record never holds stale carried entries beside `inFlight`. It would be
  safe anyway (`:599`), but the two records stay simple.
- A resumed group whose every call asked: the hook is a no-op, no extra write (P6).
- A resumed group with no asks: one extra write. Only on a resume, never on a live turn.
- A group entirely denied/cancelled: no hook, nothing runs; the commit clears.
- A failed clear write: same accepted rule as T10c (reported, the call runs). Then
  `beforeRun` likely fails too → 2b with a stale entry on disk: a crash re-runs one call.
  Unchanged class, and it fails loud through the persister.
- The mode can differ across a restart: `c2{groupStart:c1}` regrouped as singles still
  clears at c1 (T10b's shape).

The `beforeResumedCall` doc (`agent.ts:141-149`, `session.ts:46`) is updated to say
"awaited before the resumed round's first start of each group".

**6. MCP (`mcp`), config (`config` → `cli`).** Parse `annotations.readOnlyHint` into
`McpToolDef.annotations?`; thread `readOnlyTools` from the spec into `mcpToolToTool`.
`tools.execution` / `tools.maxParallel` (int ≥ 1) with env
`TENTACLE_TOOL_EXECUTION` / `TENTACLE_TOOL_MAX_PARALLEL` (`pick`), `readOnlyTools` on
both server schemas. `wiring.ts` passes `toolExecution` to the main `Agent` only.

**7. The per-call signal (protocol → daemon → client → agent).**
- `AgentEvent`: `{ type: "tool_phase", id, phase: "queued" | "running" }`.
- Wire: `tool_call_phase { toolCallId, phase: string }`, `UPDATE_CLASS` =
  `"display"`, union member, `protocol.json` regenerated. Free string as
  `tool_progress`: an unknown phase is skipped by the client mapping.
- `daemon/mapping.ts` → the update; `client/mapping.ts` reverse → the event;
  `cli/render.ts` returns `""`; `subagent.ts:241` ignores it by construction.
- **`running`** is emitted for every call that executes (group of one, 2a, 2b), after
  every gate/hook/write and immediately before the start, by `yield`, then the abort
  is re-checked (a cancel in that hop → cancelled, not started; its "Interrupted" on
  a cut is conservative). **`queued`** only in a group, after phase-1 approval.
- **Drift from decision 5, deliberate: the same update also carries `queued`.** Deriving
  "queued" from "tool_start without running" would (a) flash `queued` on every
  sequential call during its hooks and before its permission dialog, and (b) leave a
  call stuck `queued` forever when the daemon is older than the TUI (P13). With an
  explicit `queued`, an older daemon sends neither and the row spins as today. The
  "now running" meaning owner decision 5 asks for is `phase: "running"`.
- Not emitted for `runUserSkill` and `runContextReset`: both are their own bracket with
  no workspace effect before their commit (`:1177-1300`, `:1317-1369`).
- An older client: one `unsupported` notice line (P12, the §7 rule for display kinds),
  then as today. Pre-public; no filter added.
- **No capability (ruling 2).** §7 pre-public forbids negotiation for old peers:
  `PROTOCOL_VERSION` → 15, so every peer a v15 laptop talks to sends the signal, and
  an older one fails cleanly with `VersionMismatch`.

**8. TUI (`tui`), logic pure.** `ToolStatus` gains `"queued"`. `applyEvent`'s
`tool_phase`: `queued` moves `running` → `queued`; `running` moves `queued` →
`running`; a settled row (`ok`/`error`) never moves; an unknown id creates nothing (a
pod is not trusted). New pure module `tui/src/tool-phase-view.ts`: the row's glyph,
label and suffix for a queued call, `◌ <tool> <arg> · queued`, dim; the tool and arg
come from the existing `toolTitle` (`render-lines.ts`). The component only colours. Every
site in P16 is revisited: bullet and body have an explicit `queued` case; queued
never blinks and contributes no elapsed time; `commands.ts:380` shows it as queued.

**9. Exact laptop labels (`client` → `cli`, decision 6).**
- `RemoteSession` records ids on `phase: "running"` in `output`'s `update` case (P14),
  at receipt, before any consumer. Cleared at `turn_start` (ids repeat across
  turns). `RemoteSession.runningCalls(): ReadonlySet<string>`.
- `cutHistory(messages, running)`: `running === null` → today's rule
  (`answerUnansweredCalls`; only a session without the method, a test fake); else through `labelUnansweredCalls`:
  `running.has(id)` → `ENDED_INTERRUPTED_NOTE`, otherwise `ENDED_NOT_RUN_NOTE`.
  A fake session without the method (`?.`) → `null`.
- The read at label time, in `persistingController.run` after `readBack` resolves:
  the frames that preceded the reply on the ordered channel have been recorded (P14).
- This replaces the `tool_start`-based option (b) and its "first unanswered" floor.
- **Sequential too:** a running call has the signal, a later one has none: the same
  output as today's rule in that case. And more exact in one: a call cut in its ask
  (never started) now reads "Not run".
- Daemon-side labels stay R2 (`inFlight`): a queued call in `inFlight` reads
  "Interrupted" on a reload. Conservative and decided (PE-Q2); the signal is not durable,
  so the two can differ, only ever in that direction.
- Pod: the laptop label is a hint in the laptop's own copy of pod-supplied history;
  a hostile pod can already forge that history (§7).

**Single broker.** Untouched: phase 1 is one `requester` call at a time through the one
`PermissionBroker`. A round no longer asks twice after "Yes, always" (eval repro C)
because the second authorize runs after the first `remember` (`permission-gate.ts:173-175`).

**Pod not trusted.** Tools run in the pod; the only new laptop inputs are a
display frame (an id + a known phase, rendered from local text) and a capability flag.
No new laptop effect.

**RPC peer / steering.** No change to `transport/`. `drive` gains no await: all new
awaits are inside the agent's generator, and the new event is one more synchronous
`emit`. The iteration-top steering drain is unchanged.

### Files

Dependency order, about 22 source files in 9 packages.

1. `packages/protocol/src/updates.ts`, `version.ts`, `schema/protocol.json` — `tool_call_phase`, v15.
2. `packages/core/src/tool.ts`, `path-locks.ts`, `index.ts` — the contract; export `lockKey`.
3. `packages/tools/src/builtins.ts`, `background.ts` — keys.
4. `packages/mcp/src/types.ts`, `tool-adapter.ts`, `connect.ts` — hint and override.
5. `packages/agent/src/round-plan.ts` (new), `index.ts`.
6. `packages/agent/src/agent.ts` — `toolExecution`, split, executor, `tool_phase`, docs of `beforeRun`/`beforeResumedCall`; `session.ts` doc.
7. `packages/daemon/src/mapping.ts`. (`hosted-session.ts` unchanged: `beforeRun`, `beforeResumedCall` exist.)
8. `packages/client/src/mapping.ts`, `remote-session.ts`.
9. `packages/config/src/schema.ts`, `resolve.ts`.
10. `packages/cli/src/wiring.ts`, `render.ts`, `local-runtime.ts`.
11. `packages/tui/src/state.ts`, `tool-phase-view.ts` (new), `render-lines.ts`, `commands.ts`, `blink.ts` if needed.
12. Docs: `README.md` config, `docs/feat/round-groups-persistence.md` and `docs/fix/resumed-call-pending.md` (one line each), `TODO.md` at merge.

**Slices (one branch, in this order; narrow tests per slice):**
- **S1 refactor, sequential only.** Golden test of a mixed round's events + history,
  green before AND after. Split `runTool`, route through `planGroups(…, "sequential")`.
  Whole suite unchanged, including T10–T10e (F3).
- **S2 contract + planner.** `core`, `round-plan.ts`, built-in keys, MCP hint + override.
  Still nothing runs in parallel.
- **S3 executor.** Phases 1/2a/2b, `beforeRun` call site, F3 between the phases, merged
  events, error wrap, cap. Agent + daemon integration tests. Only via an explicit
  `toolExecution` in tests; the CLI is still sequential.
- **S4 signal, TUI, cut labels.** Protocol → daemon → client → agent; the TUI state +
  view; `cutHistory`. Tests pinning exact event lists gain `tool_phase` (e.g.
  `agent/test/agent.test.ts:93`): mechanical, logged as drift, the golden test too.
- **S5 config + wiring, last.** Schema, resolve, wiring: default `read-only` reaches the
  real CLI only when every other part is in. Docs.

### Failure modes

- **Crash in phase 1, an ask pending** (group `[a,b,c]`, `b` asking): disk
  `pending=[{b, groupStart:a}]`, no `inFlight` → reload resumes from `a`, re-asks (P4).
  Nothing ran. In a resumed phase 1 after the first answer → closed, `a` "Interrupted"
  (accepted task-5 Q1 class, P5).
- **Crash in phase 1, no ask outstanding:** `a` "Interrupted", rest "Not run".
  Conservative; nothing ran. On a resumed group with no ask yet, carried still says
  "resume from the head": correct, nothing started (the hook comes later).
- **Crash after the F3 clear, before `beforeRun` lands** (resumed): no pending, no
  `inFlight` → closed, first unanswered "Interrupted". Nothing ran. Conservative.
- **Crash mid-group (2a):** `inFlight=ids` → each id "Interrupted" (or the sub-agent
  note), others "Not run"; never resumed. Queued ids read "Interrupted": conservative.
- **Crash between the write and the first start:** ids "Interrupted". Conservative.
- **`beforeRun` → `false`:** 2b, one at a time with a commit per call — never parallel
  without a durable record. A crash before the first commit reloads an older record:
  first unanswered "Interrupted", the rest "Not run": exact, only that one can have
  started. On the resumed path, F3's clear already ran (Design 5).
- **The transform throw in 2b.** 2b is reached from a group: treated as 2a (decision 4:
  `isError` for that call, the rest continue). Only a planned group of one keeps today's
  turn failure. So "sequential keeps today's behaviour" means a group of one.
- **Several asks in one group:** one at a time, call order, one broker. The user approves
  `b` before seeing `a`'s result — only for non-exclusive calls (in the default mode:
  read-only MCP tools; `fs_read` never asks), never for `shell`.
- **Esc in phase 1:** the ask settles cancelled; remaining calls cancelled without asking;
  authorized siblings never start. One commit answers every id. Rows leave `queued`
  through their `tool_result`.
- **Esc during the F3 or `beforeRun` write:** `untilAborted` releases it; all cancelled;
  the commit clears `inFlight`.
- **Esc in phase 2:** running calls share `ctx.signal` (MCP honours it,
  `tool-adapter.ts:56`; fs is ms) and are awaited; not-yet-started ones are cancelled
  with no signal. Every id answered once; the next iteration top ends the turn. A
  signal-ignoring tool delays the cancel by its own duration.
- **One call fails:** `execute` never throws (P8); a `transformResult` throw → `isError`;
  siblings continue.
- **Ordering back to the model:** history in call order, pushed at group end.
  `tool_start` in call order; `tool_result` in completion order, by id (P10).
- **Signal missing or out of order.** `running` before `queued` cannot happen on one
  stream; the reducer ignores a stale move anyway (Design 8). A `tool_result` with no
  signal (an older daemon, cancel) settles the row.
- **Version skew (either direction):** `VersionMismatch` at `initialize` (v15, ruling 2);
  pod binaries are re-copied by tentacle. A kept pod with a stale binary already fails
  on attach (`TODO.md`, open fix); it now meets the clean mismatch.
- **A laptop that attached mid-group:** replay from the cut carries all signals (P11);
  a reconnect's `since` covers the rest; the set lives in the session across reconnects.
- **Link down when the cut runs:** `readBack` waits for live (P14) or fails (not saved,
  the workload is kept, unchanged).
- **Residual: read-back → close window (P15).** A queued call that starts after the last
  read-back reply and before the close reaches the daemon reads "Not run" though it
  began (and is aborted at once). Same class as today, where a next sequential call can
  start in that window. Not fixed: closing it needs a save after the close, against
  "on disk, before a close" (`local-runtime.ts:720`). Stated, not hidden.
- **Pod daemons / worker:** `beforeRun` → `true` at once; the signal flows as any update.
- **MCP without `readOnlyHint`:** `exclusive` (today's behaviour). Lying hint: bounded by
  the ask gate and `readOnlyTools: "none"`.
- **Spill / 429:** per-id paths, no collision. No main-model call during a round; only
  summaries (≤ `maxParallel`, retried) and an MCP server's own limits (that call's `isError`).
- **Replay ring:** a group holds the cut until its end, so its frames stay unevictable
  meanwhile (P11): memory bounded by one group's output. Two small frames more per call.
- **Config skew:** grouping is never recomputed at reload (`groupStart` stored); a mode
  change only regroups the resumed calls, all asked again or cleared (Design 5).
- **Sub-agent tool (task 7):** alone; its children stay sequential; their `tool_phase`
  events stop at `subagent.ts:241`. No two asks are live at once in this task.
  (Superseded by `docs/feat/parallel-agents.md`: spawns have their own lane, and children follow `tools.*`.)
- **Empty / single-call rounds:** a group of one.

### Tests

Red before green; non-vacuity by mutation (§9). Fakes: scripted `ModelProvider`, tools
with deferred promises (no sleeps), a `SpyBroker`-style requester, the daemon
persistence harness (`persistence.test.ts`, "round groups on disk", T10 family), the
hung-flush fake (`docs/fix/cancel-hung-disk.md`), ink-testing-library.

- **T-S1 golden (S1):** a mixed round (read, denied ask, edit, cancel-after-abort) in
  `sequential`: exact events + history, green before and after the split. Mutation:
  commit at round end → red.
- **T-P (S2):** grouping per mode (`[r,r,w,r,shell,r]`); `read-only` never groups a write;
  `parallel` groups writes on different paths; deps `[read a, edit b, read a]` → none,
  `[edit a, read a]` → 1 on 0; `A.ts`/`/x/a.ts` conflict; class change after hooks →
  exclusive; `maxParallel=1` → singles; cap and start order.
- **T-K (S2):** each built-in's keys; garbage input → exclusive; hint × each `readOnlyTools`.
- **T-E1 (S3, red = repro):** two read calls overlap in `read-only`.
- **T-E2:** results pushed in call order when completion is reversed; one commit per group.
- **T-E3:** `beforeRun` once per planned multi-call group with the to-run ids, awaited
  before any start (held → no tool started); never for a group of one or in
  `sequential`. Mutation: call it after the first start → red.
- **T-E4:** `beforeRun → false` → strictly one at a time, a commit after each. Mutation:
  ignore the boolean → red.
- **T-E5:** asks serial in call order with `groupStart` = head; a call alone sends none;
  "allow for session" on call 1 → call 2 not asked.
- **T-E6:** Esc in phase 1 (authorized sibling never starts), during `beforeRun`, in phase 2
  (not-started cancelled, every id answered once).
- **T-E7:** a throwing result hook in a group → that call's `isError`, siblings intact, turn
  goes on; in a group of one → the turn fails as today (both pinned).
- **T-E8:** `maxParallel=2`, 3 reads → never 3 running.
- **T-F3a (S3, real Agent + persister):** resumed record `pending=[{c2, groupStart:c1}]`,
  both no-ask, group mode, `beforeRun` landing: while the tools run, the disk does not
  resume and holds `inFlight`.
- **T-F3b:** the same with `beforeRun → false`: while c1 runs in 2b, `resume` is
  undefined. Mutation: skip the hook in the group path → red. (F3 Review finding 2.)
- **T-F3c:** cancel while the F3 write hangs in a group → no call starts.
- **T-F3d:** a hook `force: "allow"` variant (F3 Review finding 1, the missing pin).
- **T-D1 (S3):** while a group runs, the record holds `inFlight`; a reload labels exactly;
  gone after the commit; failed write → sequential.
- **T-W (S4):** `tool_phase` ↔ `tool_call_phase` both directions; unknown phase skipped;
  `UPDATE_CLASS` display; an unknown-to-the-client frame → one `unsupported`;
  `PROTOCOL_VERSION` is 15.
- **T-O (S4, the second property):** the `running` event precedes `execute` in every path
  (a tool recording "events seen by drive when I started"). Mutation: start, then yield →
  red. Abort in the hop → cancelled, not started.
- **T-L1 (S4, cli):** `running={c1}` over `[c1,c2,c3]` → Interrupted, Not run, Not run;
  `null` → today's output. Mutation: use `tool_start` → red.
- **T-L2 (S4):** read-back reply after the `running` frame, with NO consumer pulling
  events: c1 still "Interrupted" (proves recording at receipt, P14).
- **T-L3 (S4):** a fresh client attached mid-group gets the set from the replay (P11).
- **T-UI (S4):** pure-module unit tests; `applyEvent` moves (a settled row never moves, an
  unknown id creates nothing); ink frames: `◌ fs_read a.ts · queued`, dim, then spinner,
  then results in reverse order; sequential shows no `queued` frame.
- **Gate:** `bun run check` against the clean lint baseline. In a worktree without Expo,
  run the root steps separately (`docs/fix/resumed-call-pending.md:208-214`).

### Owner questions

None open. **Orchestrator rulings (2026-11-04)** on the three choices to confirm:
1. `queued` and `running` on the same update: OK.
2. NO `toolPhases` capability (§7 pre-public: no negotiation for old peers); bump
   `PROTOCOL_VERSION` to 15 instead (P13, P19, Design 7, 9, Failure modes).
3. The read-back → close residual: accepted, documented (Failure modes).

## Execution

*— claude-opus-5-5, 2026-11-04*

**Repro (before any edit, `.tentacle/tmp/parallel-tools/repro.ts`, two read-class
tools of 200 ms, `toolExecution: read-only`):**
```
before: A. t1 start → t1 end → t2 start → t2 end  (407ms for 2×200ms)
after:  A. t1 start → t2 start → t1 end → t2 end  (207ms for 2×200ms)
```

**Plan doc first:** the orchestrator rulings applied to the protocol section (P13,
P19, Design 7, 9, Failure modes, Files, T-W, Owner questions): no `toolPhases`
capability, `PROTOCOL_VERSION` 14 → 15.

**As built, in slice order** (each red first, then green, narrow file):
- **S1** — T-S1 golden (`agent/test/parallel-tools.test.ts`) green on the old code,
  then `runTool` split into `authorizeCall` (→ `Prepared`: `done` | `run`) and
  `executeCall` (`agent.ts`); the call-alone path is today's sequence. Agent suite
  unchanged (349/349).
- **S2** — `core`: `ResourceKey`, `ToolConcurrency`, `Tool.concurrency?`; `lockKey`
  exported, `pathResource` (case-folded basename). `agent/src/round-plan.ts`:
  `classOf`, `isReadClass`, `planGroups`, `dependencies`, `nextRunnable` (T-P, 15
  tests). `tools/src/concurrency.ts` + keys on `fs_read`/`fs_write`/`fs_edit`/
  `fs_multi_edit`/`shell_output` (T-K). MCP: `McpToolDef.annotations`,
  `McpReadOnlyTools`, `readOnlyTools` on both specs, `mcpToolToTool(…, readOnlyTools)`,
  `connect.ts` passes `spec.readOnlyTools`.
- **S3** — `AgentConfig.toolExecution` (absent = sequential); `runToolCalls` iterates
  `planGroups`; `runGroup` = phase 1 (serial authorize, `groupStart` = head) →
  `beforeResumedCall` → `beforeRun` (abort re-checked after each) → 2a (one merged
  `EventQueue`, `nextRunnable` under `maxParallel`, commit once in call order) or 2b
  (one at a time, a commit after each). `finishCall` turns a transform throw into
  that call's `isError` (groups only). `EventQueue.next()` added. Tests T-E1…E8 +
  "dependencies hold" (agent), T-F3a–d + T-D1 (`daemon/test/persistence.test.ts`,
  real daemon, a `NoInFlightStore` for `beforeRun → false`).
- **S4** — `tool_call_phase` (protocol, display, free-string `phase`, `protocol.json`
  regenerated), v15; daemon/client mappings; `AgentEvent` `tool_phase`, yielded by
  `signalRunning` before every start (call alone, 2a, 2b; abort re-checked after the
  hop) and `queued` after a phase-1 allow; `cli/render.ts` → `""`. TUI: `ToolStatus`
  `"queued"`, pure `tui/src/tool-phase-view.ts` (`nextToolStatus`, `queuedRow`),
  `applyEvent` `tool_phase` (latest row of the id; unknown id → nothing),
  `render-lines.ts` (one dim `◌ <label> <subtitle> · queued` row, no body),
  `commands.ts` export. Laptop: `RemoteSession.runningCalls()` recorded in `output`
  at receipt, cleared at `turn_start`; `cutHistory(messages, started)` exported,
  read after the read-back in `persistingController.run`. Tests T-W
  (`daemon/test/tool-phase.test.ts`, `client/test/mapping.test.ts`), T-O, T-UI
  (`tui/test/tool-phase-view.test.ts`), T-L1 (`cli/test/cut-labels.test.ts`), T-L2
  (`client/test/running-calls.test.ts`).
- **S5** — `tools.execution` / `tools.maxParallel` (schema, `DEFAULT_TOOL_*`,
  `resolve.ts` with `TENTACLE_TOOL_EXECUTION` / `TENTACLE_TOOL_MAX_PARALLEL`, sources),
  `readOnlyTools` on both MCP server schemas, `TentacleConfig.toolExecution`,
  `wiring.ts` passes it to the main `Agent` only (`config/test/tool-execution.test.ts`,
  `cli/test/wiring.test.ts`). Docs: README config table, the config template comment,
  one line each in `round-groups-persistence.md` and `resumed-call-pending.md`,
  `beforeRun`/`beforeResumedCall` docblocks (`agent.ts`, `session.ts`). `TODO.md`: at
  merge.

**Drift from the Implementation:**
1. **Protocol (ruling 2):** no capability; v15. `daemon/test/registry.test.ts`'s pin
   of 14 relaxed to `≥ 14`; `version-mismatch.test.ts`'s two version tests moved to
   14 ↔ 15 / 10 ↔ 15.
2. **`fs_read` keys both spellings** of a `path:start:end` range (the raw string and
   the range-stripped path): Design 2 keyed only `path`, which would miss a conflict
   with a write to the bare file in `parallel` mode.
3. **`classOf` also validates the key list's shape** (a key function returning garbage
   → `exclusive`), not only throws.
4. **Cancelled-without-starting calls of a group are not passed through the result
   transforms** (as today's pre-call abort path); a call alone cancelled after its
   allow still is (unchanged). A denial in a group IS transformed (in phase 1), as alone.
5. **Transform throw text in a group:** `Result processing failed: <message>`.
6. **`queuedRow` takes the row's title, not the item** (no import cycle with
   `render-lines.ts`).
7. **T-UI:** frames pinned at the `itemLines` level (SGR stripped, so "dim" is
   `theme.subtle` in code, not asserted); no ink `App` frame test. "Sequential shows
   no queued" is pinned by T-O (a call alone emits only `running`).
8. **T-L3:** pinned by the existing `cli/test/local-runtime.test.ts` "/quit for all in a
   running tool" (a TUI that attached mid-call: its `running` comes from the replay),
   shown red by mutation; no group variant over the cli harness.
9. **Mechanical test updates (S4, as planned):** `tool_phase` added to pinned event
   lists in `agent/test/agent.test.ts` (3), `client/test/context-reset.test.ts` (3),
   `cli/test/local-runtime.test.ts` (1: the phase crosses the wire),
   `daemon/test/mapping.test.ts` samples (1).

**Mutations** (each applied to a copy-backed file, run, reverted; `shasum` identical
to the backup after each — except the first, see below):
| Seam | Mutation | Red |
|---|---|---|
| planner | group every non-exclusive call in `read-only` | 3 T-P |
| scheduler | `nextRunnable` ignores dependencies | T-P nextRunnable, "dependencies hold" |
| `beforeRun` fallback | ignore the boolean | T-E4, T-D1 |
| `beforeRun` order | start call 0 during phase 1 | T-E3 |
| F3 hook in groups | drop `await hooks.beforeResumedCall` | T-F3b |
| golden | commit at round end | T-S1, T-E2 |
| signal order | 2a: start, then yield `running` | T-O (2a), T-O abort hop |
| cut record | record on `tool_call` instead of `running` | T-L2 (2) |
| cut record | record nothing | local-runtime "/quit … running tool" (T-L3) |
| cut labels | `cutHistory` ignores `started` | T-L1 (2) |

The first planner mutation was applied before a backup existed (the backup command
was refused) and together with the scheduler one; both were reverted by hand to the
exact original lines, the agent tests re-run green, backups taken, and the scheduler
mutation re-run alone.

**Gate (once, foreground, this worktree):** `bunx tsc --noEmit` → OK;
`bunx biome check .` → 632 files, no diagnostics; `bun test packages` → **4403 pass,
3 skip (the opt-in live-k8s / live-docker / slow-socket), 0 fail**.

**Unverified:** no live run of the default (`read-only`) on a real model/MCP server; to
verify, run `tentacle` with an MCP server marking `readOnlyHint` and ask for several
reads in one round (the TUI should show `◌ … · queued` briefly, then spinners together).

## Review

*— claude-opus-5-5, 2026-11-04 (fresh context; **same model as the executor**, so shared
blind spots can survive both passes — the plan asked for a different model "ideally")*

**Verdict: PASS (APPROVE-WITH-NITS).** No finding above LOW; no FIX round needed.

### Findings (all LOW, none fails today)

1. **Decision 7 has no pin.** `packages/agent/src/subagent.ts:205`: the child gets no
   `toolExecution`, which is correct, but giving it `read-only` leaves all 381 agent tests
   green (a surviving mutation). The first change to that constructor (task 7 touches it)
   could make a child's rounds parallel silently.
2. **`tool_result` hooks overlap in a group, in completion order.**
   `packages/agent/src/agent.ts:1447`, `:1462`. P9 proves our code is safe, but says nothing
   of the user's hook scripts: under the DEFAULT, a hook matching `fs_read` or a hinted MCP
   tool now runs concurrently with itself. README is silent. See owner question 2.
3. **A gate throw in phase 1 has no test, and leaves a `queued` row.** The plan's "fails the
   turn as today" holds by reading `runGroup`; no test pins it. An already approved sibling
   keeps `◌ … · queued` after the failed turn (`tui/src/state.ts` has no sweep; by reading,
   not run). Same class as today's stuck `running…` row on that path.
4. **No cli-level cut test on a real group** (drift 8). "Interrupted only for started" stands
   by composition: T-O (2a order), T-L2 (recorded at receipt), T-L1 (labels), and the
   single-call `/quit` test. Each link is mutation-checked; the chain is not run end to end.
5. **A typo in `TENTACLE_TOOL_EXECUTION` is silently ignored.** `packages/config/src/resolve.ts:144`
   falls through to the file or the default, while the same typo in the file is a schema error
   and `TENTACLE_ENGINE` errors. It matches the other numeric/boolean env parsers.
6. **Small leftovers.** The plan's Design still says "and a capability flag" ("Pod not
   trusted"), stale since ruling 2. `tui/src/render-lines.ts:463` is an unreachable branch, by
   its own comment. Execution pastes the repro's output but not its script (AGENTS §6).

### Gate (once, foreground)

`bunx tsc --noEmit` OK · `bunx biome check .` 632 files, no diagnostics · `bun test packages`
**4403 pass, 3 skip (the opt-in three), 0 fail**, 16923 expects, 4406 tests in 301 files.
**Not run:** `tsc -p apps/mobile` and therefore `bun run check` as one command (no Expo in this
worktree). The mobile app only logs `PROTOCOL_VERSION` (`apps/mobile/src/spike.ts:72`).

### Mutations (15; each restored, sha1 identical after every one)

| Origin | Mutation | Result |
|---|---|---|
| executor | ignore `beforeRun`'s boolean | RED: T-E4, T-D1 |
| executor | drop the F3 hook in groups | RED: T-F3b |
| executor | `read-only` groups any non-exclusive call | RED: 3 T-P |
| mine | effective class not forced exclusive | RED: T-P |
| mine | `started` not cleared at `turn_start` | RED: T-L2 |
| mine | `groupStart` not passed | RED: T-E5 |
| mine | cap ignored | RED: T-E8, T-E6c |
| mine | `fs_read` alias removed | RED: T-K |
| mine | wiring drops `toolExecution` | RED: wiring |
| mine | a settled row moves on a phase | RED: `nextToolStatus` |
| mine | `UPDATE_CLASS` → mandatory | RED: T-W |
| mine | `agent_task` groupable | RED: T-K |
| mine | `queued` not emitted | RED: T-O, T-E2, T-E4 |
| mine | no abort check between the phases | **survived, equivalent:** `beforeRun` → `false` reaches 2b's own abort check and 2a's loop guard; nothing starts either way |
| mine | sub-agent inherits `read-only` | **survived: finding 1** |

### End-to-end trace (scratch, real `Agent`, real fs tools, a real stdio MCP server)

Events went through `eventToUpdate` → `updateToEvent` → `applyEvent` → `itemLines`; no RPC
transport in this trace. The scratch folder is removed; the key output:

```
HEAD executor, two hinted MCP reads:  409ms  start c0 → result c0 → commit → start c1 → result c1 → commit
new, hint, read-only:                 208ms  start c0 → queued c0 → start c1 → queued c1 → running c0 → running c1 → result c0 → result c1 → commit
    asks c0/c0, c1/c0 · row: ◌ mcp__s__slow_read {} · queued · final ok,ok
new, readOnlyTools "none":            409ms  every call alone, no groupStart, no queued
new, hinted, unhinted writer, hinted: 605ms  all three alone
new, list ["slow_write"]:             409ms  the two listed run together, the unlisted alone
new, fs_read ×2 + fs_write:           the reads together (rows "◌ Read a.txt · queued"), the write alone
new, parallel, same.txt + ./SAME.txt + a read:  running c0, running c2, result c0, running c1: the second write waits, the read does not
```

**`sequential` against HEAD:** HEAD's `agent.ts` swapped in temporarily. A mixed round (read,
denied write, allowed write, unknown tool, broken JSON, edit, ranged read, missing file)
dumped asks, events and history: **byte-identical (5549 bytes)** once `tool_phase` is removed.
So "byte-for-byte" holds for the history, the asks and every other event; the one addition is
the `running` signal, which owner decision 6 requires.

### Premises

Opened and TRUE: the symptom (409 ms above); `permission-gate.ts:168-172`; `subagent.ts:205-219`;
`mcp/src/client.ts:482-491`; `persisted-session.ts:599`; `hosted-session.ts` `beforeRun`,
`beforeResumedCall`, `drive` (P2, P6, the commit clears); `remote-client.ts:871-885` plus
`whenLive`, which requires phase `live`, so buffered frames precede the read-back (P14);
`state.ts:284-320` (P10); `skill.ts:189` (P17); `parseArguments` is total, so classifying
before `tool_start` cannot change a failure; `listTools` keeps `annotations` raw, so the hint
really arrives. `hosted-session.ts`, `persisted-session.ts`, `task.ts` and `transport/` have no
diff. **Sampled, not exhaustive:** P9, P11, P12, P18 and the `agent.ts` line citations were
not each opened; `agent.ts`'s are superseded by the diff anyway.

### Attacks tried

- **A writer in parallel under the default:** `shell`, `skill`, `agent_task`, `context_reset`,
  unknown tools and garbage input are exclusive; a hook-rewritten input is re-classified after
  phase 1. Nothing found (trace, mutations).
- **Single broker:** phase 1 is one awaited `requester` call at a time, and nothing in phase 2
  asks; children never group. A session grant covers the sibling (T-E5). Nothing found.
- **`inFlight` and the fallback:** `beforeRun` is awaited before any start; `false` gives 2b with
  a commit per call, and the F3 hold runs first. A stale in-memory `inFlight` written during 2b
  only makes a label more conservative. Nothing found.
- **Esc:** in phase 1, during either write, in the hop after `running`, in phase 2: never a start
  after the abort, every id answered once. Nothing found (T-E6a–c, T-O, T-F3c).
- **Result order, one call failing:** history in call order with completion reversed (T-E2); a
  transform throw stays that call's (T-E7). `executeCall` cannot reject (P8), so the `void`
  promise in 2a cannot hang the group.
- **Scheduler deadlock:** dependencies only point backwards and a group implies `maxParallel > 1`,
  so the lowest pending call is always runnable once the earlier ones settle. Nothing found.
- **Protocol:** union member, `UPDATE_CLASS` display, both mappings, unknown phase skipped, v15,
  no capability (ruling 2). Pod-supplied frames add an id to a label hint and never create a row.
  Nothing found.
- **Repeated ids across rounds:** `started` keeps the older id, so the label errs towards
  "Interrupted", the conservative side. `tool_result`'s `findIndex` hitting the older row is
  unchanged from `main`, not this diff.
- **Another path to the same state:** `cutHistory` is the only laptop site using these labels;
  `new Agent` has two sites, and only the main one gets the mode; `HostExecution` is the only
  environment. Pods never persist: `beforeRun` resolves `true` with no persister, code unchanged.
- **RPC peer:** no `transport/` diff, no new await in `drive`.

### How the executor behaved

Honest and disciplined. Every reported mutation I re-ran matched. The unbacked first mutation
and the plan drifts are logged without being asked, and drift 7–8 state plainly what was not
pinned. The "Unverified" line was accurate; the scratch trace above now covers most of it,
except a real model and a real TUI window.

### Owner-level questions

1. **Second reviewer?** This review and the execution are the same model; the plan wanted a
   different one "ideally". Run one before merging, or accept?
2. **`tool_result` hooks overlapping under the default (finding 2):** accept with a README line,
   or run hooks serially within a group? Recommendation: accept with a README line.

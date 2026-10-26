# Parallel tools and parallel agents: evaluator analysis

Input for `docs/eval/parallel-tools.md` and `docs/eval/parallel-agents.md`
(both still at Context). I verified it against main `5e8b538` (worktree
`main-ro`). It builds on the two older deferred evals,
`docs/eval/parallel-tool-calls.md` (2026-10-19, DEFER, consecutive-batch design)
and `docs/eval/parallel-subagents.md` (2026-10-17). Where this analysis
disagrees with them, the reason is given.

*— claude-opus-5-5, 2026-10-26*

---

## 0. Shared facts (verified)

- **Today's round is strictly ordered.** `Agent.runToolCalls`
  (`packages/agent/src/agent.ts:732-781`) loops `for (const call of calls)`
  (`:738`). For each call it yields `tool_start` (`:759`), runs `runTool`
  (authorize, then execute: `:903-973`, the ask is at `:912`, execution at
  `:959/:962`), runs `transformResult`, yields `tool_result`, pushes the `tool`
  message and yields `history_commit` (`:776-779`). Only then does the next
  call start.
- **What that buys (the suspended-turn invariant).** `suspendedCalls`
  (`packages/agent/src/resume.ts:21-44`) accepts a history only when the last
  assistant message is followed by results for exactly the calls before
  `toolCallId`, in order (`:35-42`). Its doc says why: "only this shape means
  never started" (`:16-19`). The daemon uses the same definition three times:
  - at capture (`classifyPending`, `packages/daemon/src/persisted-session.ts:311-318`);
  - at reload (`resumableTurn`, `:398-416`);
  - in the agent's resume seam (`agent.ts:374-378, :417-419`).
- **The reload labels assume order.** When a turn cannot be resumed,
  `reconcileOnReload` gives only the FIRST unanswered call the "Interrupted"
  note. Every later unanswered call gets "Not run" (`:456-470`). The
  docstring says "only the FIRST unanswered call can have started — calls run
  in order" (`:425-427`).
- **The daemon assumes one ask at a time, attributed to the last
  `tool_start`.** `HostedSession.awaitDecision` builds `pending` and the wire
  `permission_request.toolCallId` from `this.currentToolCallId`
  (`packages/daemon/src/hosted-session.ts:480-489`). That field is set on
  every `tool_start` (`:1210-1212`). `pending` is a single slot (`:300`,
  `:504`, `:522`). Every `history_commit` clears it (`:1201-1208`), which is
  sound only because "no ask can be pending at a commit" (P2 in
  `docs/feat/suspended-turn-resume.md:97-100`). That doc's own Review already
  flagged that parallel calls would break P1 (`:597-599`).
- **The gate drops the call id.** `GateCall` carries `toolCallId`
  (`permission-gate.ts:86-90`), but the requester is called with the request
  only (`:153-154`). The gate's session grants are checked before the prompt
  and written after it (`:150-157`), with no lock.
- **Each Agent has its own gate.** `agent.ts:267` builds
  `new PermissionGate(...)`. A sub-agent is a new `Agent`
  (`packages/agent/src/subagent.ts:166-182`) sharing the requester. So a
  "Yes, always" given inside a sub-agent does not reach its siblings or its
  parent.
- **Execution never throws, but the steps around it can.**
  `ToolRegistry.execute` never throws (`packages/tools/src/registry.ts:56-82`).
  `gate.authorize` (hooks, requester) and `transformResult` (hooks, spill) can.
  Spill paths contain the call id (`agent.ts:879`), so concurrent spills
  cannot collide.
- **Client side is ready for several things at once.** The `PermissionRouter`
  already queues prompts FIFO, one dialog at a time
  (`packages/client/src/permission-router.ts:8, :67-99`). The daemon's `asks`
  map holds several asks (`hosted-session.ts:494`). The TUI reducer matches
  tool items by id (`packages/tui/src/state.ts:259-300`).
- **Sub-agent progress never crosses the wire.** `daemon/src/mapping.ts:224-234`
  maps `subagent_start/tool/end` to `null`. Nothing in `protocol/` or
  `client/` mentions sub-agents (`git grep -i subagent` is empty). Every
  runtime is RPC (AGENTS §7), so the TUI's sub-agent tree
  (`state.ts:317-346`) is unreachable today: an `agent_task` renders as an
  opaque running tool.
- **The phone app is a spike.** `apps/mobile` is `App.tsx`,
  `src/rn-websocket.ts` and `src/spike.ts`. There is no tool rendering at all.

### Load-bearing assumption (and the repro that proves it)

> **The only point where a round suspends on a human is a call's
> `gate.authorize`, and it settles before that call executes**
> (`agent.ts:912` before `:959`; sub-agent asks are marked non-resumable,
> `persisted-session.ts:303-318`). So a round that **authorizes a group of
> calls in order, then runs them**, keeps the property reload honesty stands
> on: "every unanswered call in a record with a resumable ask has never
> started". The parallel design stands or falls on this. Today's daemon code
> does NOT recognise that shape, so it must be generalised, not reused as is.

**Repro** (2026-10-26, run with
`bun /Users/gmeghnag/tentacle/.tentacle/tmp/parallel-eval/repro.ts`):

```ts
// Repro for docs/eval/parallel-tools.md + parallel-agents.md (2026-10-26, main 5e8b538).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ModelProvider, StreamEvent, Tool } from "@tentacle/core";
import { z } from "../../worktrees/main-ro/packages/tools/node_modules/zod/lib/index.mjs";
import { Agent } from "../../worktrees/main-ro/packages/agent/src/agent.ts";
import { PermissionGate } from "../../worktrees/main-ro/packages/agent/src/permission-gate.ts";
import { suspendedCalls } from "../../worktrees/main-ro/packages/agent/src/resume.ts";
import { classifyPending, type DaemonSessionRecord, reconcileOnReload }
  from "../../worktrees/main-ro/packages/daemon/src/persisted-session.ts";
import { HostExecution } from "../../worktrees/main-ro/packages/exec/src/host-execution.ts";
import { fsEditTool } from "../../worktrees/main-ro/packages/tools/src/builtins.ts";
import { ToolRegistry } from "../../worktrees/main-ro/packages/tools/src/registry.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A. Today's round: two "ask" tools sleeping 200 ms each, a fake model
//    emitting [c1 t1, c2 t2], then text. Log the asks and the start/end of each.
{ const log: string[] = [];
  const slow = (name: string): Tool => ({ name, description: name, inputSchema: z.object({}),
    permission: "ask", async execute() { log.push(`${name} start`); await sleep(200);
      log.push(`${name} end`); return { content: `${name} ok` }; } });
  const tools = new ToolRegistry(); tools.register(slow("t1")); tools.register(slow("t2"));
  let round = 0;
  const model: ModelProvider = { id: "fake", async *stream(): AsyncGenerator<StreamEvent> {
    if (round++ === 0) {
      yield { type: "tool_call", toolCall: { id: "c1", name: "t1", arguments: "{}" } };
      yield { type: "tool_call", toolCall: { id: "c2", name: "t2", arguments: "{}" } };
    } else { yield { type: "text", delta: "done" }; }
    yield { type: "done" }; } };
  const agent = new Agent({ model, tools, env: new HostExecution(), systemPrompt: "",
    requestPermission: async (req) => { log.push(`ask ${req.tool}`); return { allowed: true }; } });
  const start = Date.now();
  for await (const _ of agent.run("s", [{ role: "user", content: "go" }])) {}
  console.log(`A. sequential round: ${log.join(" → ")}  (${Date.now() - start}ms for 2×200ms)`); }

// B. The record an authorize-then-run group writes while c2 asks: c1 is approved
//    but not started, and nothing is answered. What does today's daemon do?
{ const messages: ChatMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "",
    toolCalls: [{ id: "c1", name: "fs_edit", arguments: "{}" },
                { id: "c2", name: "shell", arguments: '{"command":"ls"}' }] }];
  const resumable = classifyPending(messages, "c2", "shell", "shell");
  console.log(`B. classifyPending(c2) = ${resumable}; suspendedCalls(c2) = ${JSON.stringify(
    suspendedCalls(messages, "c2"))}; suspendedCalls(c1) = ${suspendedCalls(messages, "c1")?.map((c) => c.id)}`);
  const record = { kind: "tentacle.daemon-session", schemaVersion: 5, id: "s", createdAt: 0,
    updatedAt: 0, lastActiveAt: 0, messages, turns: [{ turnId: "T1" }], enqueueIds: [], returned: [],
    turn: { turnId: "T1", steering: [], pending: { toolCallId: "c2", tool: "shell", resumable, requestedAt: 0 } },
  } as unknown as DaemonSessionRecord;
  const r = reconcileOnReload(record);
  console.log(`B. reload resumes? ${r.resume !== undefined}`);
  for (const m of r.messages.slice(2)) console.log(`   ${m.toolCallId}: ${m.content.slice(0, 60)}…`); }

// C. Two concurrent authorize() calls on one gate, the user answers "allow always".
{ let prompts = 0;
  const ask = async () => { prompts++; await sleep(50); return { allowed: true, scope: "session" as const }; };
  const tool = fsEditTool as unknown as Tool;
  const call = (id: string) => ({ sessionId: "s", toolCallId: id, signal: new AbortController().signal });
  const gate = new PermissionGate(ask);
  await Promise.all([gate.authorize(tool, { path: "a" }, call("c1")), gate.authorize(tool, { path: "b" }, call("c2"))]);
  const concurrent = prompts; prompts = 0;
  const gate2 = new PermissionGate(ask);
  await gate2.authorize(tool, { path: "a" }, call("c1")); await gate2.authorize(tool, { path: "b" }, call("c2"));
  console.log(`C. prompts after "allow always" on call 1: concurrent=${concurrent}, serial=${prompts}`); }

// D. Two fs_edit calls on the same file, concurrently (real HostExecution).
{ const dir = mkdtempSync(join("/Users/gmeghnag/tentacle/.tentacle/tmp/parallel-eval", "ws-"));
  writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n");
  const ctx = { sessionId: "s", signal: new AbortController().signal, env: new HostExecution({ cwd: dir, root: dir }) };
  const [r1, r2] = await Promise.all([
    fsEditTool.execute({ path: "f.txt", old_string: "alpha", new_string: "ALPHA" }, ctx),
    fsEditTool.execute({ path: "f.txt", old_string: "beta", new_string: "BETA" }, ctx)]);
  console.log(`D. results: "${r1.content}" | "${r2.content}"`);
  console.log(`D. file now: ${JSON.stringify(readFileSync(join(dir, "f.txt"), "utf8"))} (both edits reported success)`); }
```

Output:

```
A. sequential round: ask t1 → t1 start → t1 end → ask t2 → t2 start → t2 end  (408ms for 2×200ms)
B. classifyPending(c2) = false; suspendedCalls(c2) = null; suspendedCalls(c1) = c1,c2
B. reload resumes? false
   c1: Interrupted: the daemon restarted while this tool was runnin…
   c2: Not run: the daemon restarted before this call ran (it was w…
C. prompts after "allow always" on call 1: concurrent=2, serial=1
D. results: "edited f.txt (+1 -1)" | "edited f.txt (+1 -1)"
D. file now: "ALPHA\nbeta\n" (both edits reported success)
```

What each part proves:

- **A.** Today's round is strictly serial: the second ask comes after the
  first tool ends, and the wall time is the sum of the two calls. This is the
  baseline a parallel mode improves on.
- **B (the load-bearing fact).** The authorize-then-run shape is honest:
  `suspendedCalls(c1)` returns `[c1, c2]`, both never started. But today's
  daemon cannot recognise it:
  - `classifyPending` marks the ask non-resumable.
  - The reload does not resume.
  - The reload says c1 "was running … may or may not have completed". That
    is false: c1 never started.

  So the shape argument holds, and the predicate has to change (§1.1).
  Fail-safe today, but dishonest.
- **C.** Concurrent asks race the session grants: the user is asked twice
  after answering "always". So asks must be serialised in the round, not
  merely queued in the UI.
- **D.** Concurrent read-modify-write on one path is a **silent lost
  update**: both calls report success and one edit vanishes. So same-path
  writers must never overlap. This holds within one round (tools) and across
  sub-agents sharing the workspace (agents).

**Not measured:**
- How much time the change saves. The 2026-10-19 data (4.3% of calls on
  Qwen3.8-27B would leave the serial path) could not be re-run: the session
  store `~/.config/tentacle/sessions/` is outside this sandbox.
- How many requests the local server serves at once. I could not reach the
  user's config or endpoint, and web lookup was denied. How to measure both:
  §2.3.

---

## Part 1: parallel tool calls

### 1.1 What a parallel round must change to keep reload honest

A parallel round runs in **groups**. A group is a run of calls in call order,
cut at every *exclusive* call (§1.2). Each group has two phases:

1. **Authorize in call order, one at a time.** Each call gets `tool_start`,
   then `authorize`, exactly as today. A denial or a cancel becomes that
   call's precomputed result. This is the prior eval's "approve-then-run".
2. **Run the authorized calls concurrently.** A dependency scheduler (§1.3)
   lets call *j* wait only for earlier calls whose resources conflict with
   it. Calls are capped by a semaphore. `tool_result` events are yielded as
   calls complete. The `tool` messages are pushed **in call order, when the
   whole group has settled**, followed by **one** `history_commit`.

An exclusive call is a group of one. That is exactly today's loop, so
`sequential` mode is every call alone: byte-identical to `main`, which
becomes the slice-1 refactor guard.

Committing only at the end of a group keeps P2 true: no ask is pending at a
commit, because every sibling, and its sub-agents' asks, has settled. It also
keeps the history valid: no partial result block is visible to a re-attaching
client's snapshot while siblings run.

Reload honesty needs three changes:

- **(a) Generalise the suspension predicate.** Today the call that asks must
  be the next call after the answered prefix. Instead: the answered prefix is
  in order, and the asking call lies in the first unanswered group. Resume
  from the **first unanswered call**: the group's earlier approvals are
  re-asked, because approvals are per incarnation by design (P5). Repro B
  shows this is exact.

  The group boundary must not be recomputed at reload, because a
  classification can change between builds (a config change, an MCP server
  change). Store it instead: `pending.groupStart` (the first call of the
  group). The predicate then checks "answered prefix ends exactly at
  `groupStart`, and the asking call is at or after it".

  One definition stays shared by `classifyPending`, `resumableTurn` and the
  agent's `resumeFrom`, the same discipline as today.
- **(b) Know which calls may have started.** Today's reload labels assume
  that only the first unanswered call can have run (`:425-427`). Once phase 2
  starts, every call of the group may have run. Two options:
  - **R1, generic note.** Every unanswered call gets a new note: "the daemon
    restarted during this round; this call may or may not have run". No
    format change. Honest, but it loses today's precise "Not run" for calls
    that were queued behind.
  - **R2, durable in-flight set (recommended).** The agent gains a seam
    `beforeRun(ids)`, awaited just before phase 2. In a `serve` daemon it
    sets `turn.inFlight = ids`, persists, and awaits `persisted()` under
    `untilAborted`. This is the same pattern as today's clear-before-run
    (`hosted-session.ts:521-530`). Pods and the worker have no persister, so
    it costs them nothing.

    The reload then labels each unanswered call:
    - in `inFlight` → "Interrupted", or the sub-agent note if that call had a
      sub-agent ask pending;
    - otherwise → "Not run".

    Every label is exact. Cost: a record format change (`DAEMON_RECORD_VERSION`
    6, allowed pre-public) and one awaited disk write per parallel group,
    only on `serve`.
- **(c) Attribute asks by id, not by "last `tool_start`".** With several
  `tool_start`s in flight, `currentToolCallId` names the wrong call, both in
  `pending` and in the wire `permission_request.toolCallId`. The requester
  must receive the call id: add `toolCallId` and
  `origin: "call" | "subagent"` to `PermissionRequestOptions`. Like `turnId`
  there, these are laptop-internal (`core/src/permission.ts:64-74`). The gate
  already has the id (`GateCall`).

  `resumable` becomes "origin is the call and the predicate in (a) holds".
  That is explicit, not today's inference from the tool name. `pending`
  becomes a list, because several sub-agents can ask at once (Part 2). It
  goes in the same record version bump.

### 1.2 Parallel-safety classification of every built-in tool

| Tool | Nature (source) | Class | Resource keys |
|---|---|---|---|
| `fs_read` | Pure read (`builtins.ts:71-99`) | shared | `read:path` |
| `fs_write` | Blind overwrite; reads "before" only for the diff (`:106-125`) | shared-by-path | `write:path` |
| `fs_edit` | Read-modify-write, **not atomic** (`:182-191`, repro D) | shared-by-path, plus an RMW lock (§2.1) | `write:path` |
| `fs_multi_edit` | Read-modify-write (`:216-239`) | as `fs_edit` | `write:path` |
| `shell` (foreground) | Unknown side effects (`:270-299`) | **exclusive** | everything |
| `shell` `run_in_background` | Returns at once with a job id (`:271-281`) | exclusive (no gain: instant) | everything |
| `shell_output` | Read that **advances a per-job cursor** ("since the last read", `background.ts:25,32`) | shared-by-job | `write:job:<id>` |
| `shell_kill` | Mutates a job; `permission: "none"` ≠ harmless (`:52-68`) | exclusive (no gain) | everything |
| MCP `mcp__s__t` | Unknown semantics, `permission: "ask"` (`mcp/src/tool-adapter.ts:51`); the client multiplexes calls by JSON-RPC id (`mcp/src/client.ts:365,407`) | exclusive; **shared if `annotations.readOnlyHint`** (not parsed today: `mcp/src/types.ts:33-37`) | `read:mcp:<server>` |
| `skill` | Read, but its "already loaded" check reads `ctx.history` (`tools/src/skill.ts:189`): two loads of one skill in a group would both load | exclusive (no gain: milliseconds) | everything |
| `agent_task` | Governed by `subagents.execution` (Part 2) | read-only type → shared; writer type → `agents` group | see §2.1 |
| `context_reset` (future) | Must be the only call of its message (context-reset decision 5) | **solo**: the tool refuses itself when its message has other calls (a message-level check, the same in both modes); the planner treats it as exclusive | everything |
| unknown tool / invalid args | Registry error at once (`registry.ts:57-75`) | exclusive | n/a |

Two keys conflict when they name the same resource and at least one is
`write`. `exclusive` conflicts with everything. The keys are computed from
the **effective** input after the `tool_call` hooks (`permission-gate.ts:112-137`),
because a hook may rewrite the path. Paths are normalised through the env:
resolve against the root, then case-fold on a case-insensitive volume. APFS
is case-insensitive by default, so `A.ts` and `a.ts` are one file. A false
conflict only serialises two calls, so the error is always on the safe side.

### 1.3 Static flag or per-call analysis?

I recommend **both, behind one contract**. `Tool` gains an optional
`concurrency?: "exclusive" | ((input) => ResourceKey[])`, defaulting to
`exclusive`.

- A static flag alone cannot express "two edits on different files", the
  common `[fs_edit, fs_edit]` shape (25× in the 10-19 data).
- Per-call analysis alone, with no default, would have to understand
  `shell`, which is rejected as security-adjacent and low-gain (10-19 data).

This replaces the prior eval's consecutive-batch rule. Within a group, the
dependency scheduler is strictly more parallel than that rule and just as
safe:
- `[read a, edit b, read a]` runs fully parallel under the scheduler (the
  prior rule cut it into three batches);
- `[edit a, read a]` still runs in order.

The planner stays a pure, React-free module (`agent/src/round-plan.ts`),
unit-tested, as AGENTS §7 asks.

### 1.4 Permissions with several calls at once

Options:
- (i) one prompt at a time, in call order, before the group runs
  (recommended);
- (ii) one combined prompt ("approve these 3 edits");
- (iii) concurrent prompts.

(iii) is rejected: repro C shows the grant race, and the client shows one
dialog anyway. (i) needs no protocol change, and the single broker is
untouched (AGENTS §7): every ask is still one `requester` call through the
one `PermissionBroker`. It also fixes C for free, because the second
authorize runs after the first remembered its rule.

The UX change is small. In one group, the user approves `edit b` before
seeing `edit a`'s result. That is acceptable because an exclusive call
(`shell`) is a group of one, so a command still sees everything before it.
(ii) is a later UX layer on top of (i).

**Pod trust is unchanged.** The gate is daemon-side, so it is UX; the guard is
the laptop prompt (AGENTS §7). A pod could already send N
`permission_request`s at once, and the laptop router already queues them FIFO
and never caches a grant (`permission-router.ts:11-14`). Parallelism opens no
new laptop-side effect.

### 1.5 Ordering

- The history keeps the model's call order (pushed at group end).
- Events (`tool_start`) come in call order, so TUI items are appended in a
  stable layout. `tool_result`s arrive in completion order and are matched
  by id (`state.ts:271-299`).
- The steering drain stays at the iteration top (`agent.ts:473-477`), so the
  no-await window (`:576-587`) is untouched.

### 1.6 Cancel and failures

- **Esc in phase 1.** The current ask settles cancelled through the abort
  (`hosted-session.ts:493,502`). The remaining calls get `CANCELLED_TOOL_NOTE`
  without prompting (the existing branch, `agent.ts:739-758`). Nothing runs.
- **Esc in phase 2.** All calls share `ctx.signal`. `shell` and MCP honour it
  (`builtins.ts:285`, `tool-adapter.ts:56`), and the fs operations take
  milliseconds. Wait with `allSettled`. Every id gets one `tool` message, and
  the next iteration top ends the turn cancelled. A tool that ignores the
  signal delays the cancel by its own duration. Today has the same parity,
  but a parallel group pays the slowest call.
- **One call fails.** Each run is wrapped so that a throw from
  `authorize`/`transformResult` becomes an `isError` result. The siblings
  continue, and the model decides. Fail-fast is rejected: the calls are
  independent by construction (non-conflicting keys).
- **Hooks.** `tool_call` hooks stay serial (phase 1). `tool_result` hooks
  (`transformResult`) now run concurrently. The executor must check that
  `HookRunner` has no per-call shared state. I have not verified this; check
  it by reading `agent/src/hooks.ts` `resultHooks` at Implementation.

### 1.7 TUI and phone

- **TUI.** Several running tools already render, since items are keyed by
  id. One gap: a call approved in phase 1 shows "running" while it waits for
  its siblings' prompts. A `queued` status, entered at `tool_start` and left
  at a new internal `tool_run` event, is a display nicety. It does not need
  the wire: the daemon can map it onto `tool_call{status:"pending"}` and then
  `in_progress`, and the ACP-style status field already exists
  (`mapping.ts:195-202`).
- **Phone.** It has no tool rendering yet (a spike). The wire is already
  keyed by `toolCallId`, so nothing changes.

### 1.8 Pod, MCP, spill, limits

- **Pod.** Tools run in the pod daemon. Nothing new reaches the laptop
  except prompts (§1.4).
- **MCP.** Calls are multiplexed by id, so concurrency is safe at the
  transport level. Parse `annotations.readOnlyHint`. The hint is supplied by
  the server and is untrusted, but each call is still ask-gated, and the
  worst case is a reordering within that server's calls. A per-server config
  override covers servers that lie or omit the hint (owner question 5).
- **Spill.** File names carry the call id (`agent.ts:879`), so there is no
  collision.
- **Limits.** `tools.maxParallel`, default 8: reads are cheap, the default
  bounds MCP fan-out, and it matches the prior design.

### 1.9 The setting

- `tools.execution: "sequential" | "parallel"`, beside the existing
  `tools.*` keys (`config/src/schema.ts:214-235`), plus `tools.maxParallel`.
- Scope: global/profile config. In `run`/`attach` it comes from the pod's
  config, like `maxIterations` (context-reset decision 12 precedent). A
  per-session toggle is not needed.
- **Recommended default: `parallel`.** This differs from the owner's first
  idea. Reason: under §1.2/§1.3, only calls whose resource keys commute ever
  overlap, so a parallel group's history and effects equal the sequential
  run's. Only timing differs. A `sequential` default would leave the parallel
  path almost never exercised, which is where bugs hide. `sequential` stays
  the switch for debugging, and for a user who wants prompts strictly
  interleaved with results. (Owner question 1.)

---

## Part 2: parallel sub-agents

### 2.1 Isolation (same files, shell cwd, jobs)

What children share and do not share (verified):
- They share the parent's `env` (`subagent.ts:169`): one workspace.
- They do not get `jobs` (`:166-182`), so `run_in_background` reports
  "background execution is not available here" (`builtins.ts:272-274`).
  Background jobs are therefore not a concurrency issue.
- The shell has no shared cwd state. Each `exec` is `/bin/sh -c` with an
  optional per-call `cwd` (`builtins.ts:248-249,284-289`), so a `cd` never
  leaks between calls or agents.

The real hazard is repro D across agents. Two agents' `fs_edit`s on one file
lose an update silently, even when each child's own round is sequential.

Options:
- **(a) A per-path RMW lock (recommended).** A `PathLocks` held across
  read→write in `fs_edit` / `fs_multi_edit` / `fs_write`, shared through
  `ToolContext` by the parent and every child of the session. It is
  in-process, so it also works in a pod: all agents live in the one daemon.
  With RMW atomic, `fs_edit`'s exact-match semantics turn a semantic clash
  into a visible error (`old_string not found`), not a lost write. A shell
  `sed -i` bypasses the lock; that stays documented.
- (b) Read-only types parallel, writers sequential. Safe, but it defeats the
  owner's idea for general-purpose agents.
- (c) A git worktree per writer agent. Full isolation, but it needs
  merge-back with conflicts, a non-git fallback, and pod support. That is
  heavy, and the conflict UX is bad. Owner question 3.
- (d) Plus prompt guidance in the `agent_task` description: "parallel
  sub-agents share the workspace; give them disjoint files".

**Classification of `agent_task` in a round:**
- A type whose tools are all shared (`explore` = `["fs_read"]`,
  `subagent.ts:58-63`) gets key `read:workspace`. It is compatible with reads
  and with other read-only agents.
- A writer type (`"all"`) gets `write:agents`, so it conflicts with shell,
  writes and other tools.

  With `subagents.execution: "parallel"`, writer agents are grouped together
  (key `agents` is shared among `agent_task`s only). With `"sequential"` the
  key is `write:agents`, so they serialise. This is how the agents setting is
  **independent** of the tools setting while riding the same scheduler.

### 2.2 Permissions from several sub-agents at once

- Several children may ask at once. The broker, the daemon `asks` map and the
  client FIFO already handle it (§0). The daemon side needs §1.1(c): `pending`
  as a list, and attribution by the parent call id. The child's requester is
  wrapped with the parent `toolCallId` and `origin: "subagent"` (passed
  through `TaskRunControls`, `tools/src/task.ts:18-21`).
- **Which sub-agent asks.** Add an optional
  `agent?: { type, description }` to `PermissionRequestUpdate`. Fields are
  free under the v10 strip schemas, so no version bump is needed. The TUI
  dialog then says, for example, *explore · "find callers" — Run a shell
  command*, and the dialog jumps to that agent's tree.
- **Grants.** Each child has its own gate (`agent.ts:267`). Five parallel
  agents asking for `bun test` mean five prompts even after "Yes, always".
  I recommend one session grant store shared by the parent and its children:
  "always" means the session, which is what the prompt says. Owner question 4.

### 2.3 Provider and local-server concurrency limits

- **Pod tunnel.** Concurrent `model/streamChunked` requests are independent:
  each has its own handlers (`daemon/src/proxy-model.ts:39-45`), and the peer
  dispatches concurrently (AGENTS §7). Nothing there serialises N agents.
- **Rate limits.** `RetryingModelProvider` retries only connection codes
  (`providers/src/retry.ts:11-15,20-25`). An HTTP 429 or 529 passes through,
  so a sub-agent hit by a rate limit fails its whole task (an `isError`
  result). Parallel agents make this likely on a cloud API with
  per-organisation request and token-per-minute limits. Recommendation: a
  small separate task to retry 429/529 pre-stream, honouring `retry-after`,
  with bounded attempts. It is useful for everyone.
- **Local servers (not measured, see §0).** llama.cpp `llama-server` serves
  as many requests at once as it has slots (`--parallel`/`-np`). Extra
  requests queue server-side, and the slots split the context window unless
  the KV cache is unified. On a one-slot server, "parallel" gives no speedup
  and each agent waits longer for its first token. To measure:
  `curl <base>/props` gives `total_slots` (llama.cpp), then time N=1 vs N=3
  concurrent `/v1/chat/completions` calls. Run it at Implementation against
  the owner's real endpoint.
- **Token budget.** Child `usage` events are dropped (`subagent.ts:187-200`
  forwards only text, `tool_start` and `turn_end`), so session totals already
  under-count sub-agents. Parallelism only makes that more visible. Forward
  usage to the parent (a display concern, same task as §2.4).
- **Cap.** `subagents.maxParallel`, default 4. Optionally the effective cap
  is `min(config, detected slots)` for a llama.cpp endpoint (owner
  question 6).

### 2.4 TUI and phone: several progress trees

There is a prerequisite that exists independently of parallelism: sub-agent
progress must cross the wire (§0, `mapping.ts:224-234`). Add a display-class
update, `tool_progress{toolCallId, kind: "subagent_start"|"subagent_tool"|"subagent_end", …}`,
in `UPDATE_CLASS` as display, with its reverse mapping in `client/mapping.ts`.
That revives the TUI's existing tree (`state.ts:317-346`), which is already
keyed by the parent call id, so N trees render side by side with no reducer
change. The order of results is §1.5. The phone gets the same update when it
gains tool rendering.

### 2.5 Cancel, failure, persistence

- **Cancel.** The child shares `controls.signal` (`subagent.ts:190`), so Esc
  fans out to every child. `allSettled` waits for them, and each child closes
  its own round validly (the existing abort branches).
- **Failure.** One child's thrown model error becomes its own `isError`
  result (`registry.ts:77-81`). The siblings go on.
- **Persistence.** Sub-agent asks stay non-resumable (D4). With R2, a reload
  marks each in-flight `agent_task` "Interrupted", or with the sub-agent note
  if it had an ask in the `pending` list. Every queued one is marked
  "Not run".

### 2.6 The setting

- `subagents.execution: "sequential" | "parallel"` and
  `subagents.maxParallel`, beside `subagents.enabled` and
  `subagents.maxIterations` (`schema.ts:187-199`). Scope as §1.9.
- **Default `parallel`.** This agrees with the owner: sub-agents are the one
  workload where a call lasts seconds to minutes. With the RMW lock (§2.1),
  the remaining risk is semantic overlap, which surfaces as errors, not
  corruption.
- **No per-type mode override.** A type's concurrency is derived from its
  tool list (read-only types are always safe). That is one fewer knob, and it
  is always correct.

---

## Size, blast and proposed split

**Overall: L, load-bearing.** It touches:
- the agent loop's round;
- the §7 persistence invariant (record v6);
- the single-broker path (requester options);
- the protocol (a display update and a field).

So it must be split (AGENTS §10). Each task below goes to a strong model with
a mandatory fresh-context Review wherever it is load-bearing. In dependency
order, one code task at a time:

| # | Task | Size · Blast | Content |
|---|---|---|---|
| 1 | `feat/fs-path-locks` | S · contained | `PathLocks` in `ToolContext`; RMW tools hold it; repro D as the red test. Fixes the agents hazard even with no parallelism in the loop. |
| 2 | `feat/subagent-progress-wire` | M · cross-module | `tool_progress` display update, `UPDATE_CLASS`, client reverse mapping, child usage forwarded. Valuable on its own today. |
| 3 | `feat/model-retry-429` | S · contained | Pre-stream 429/529 retry with `retry-after` in `RetryingModelProvider`. |
| 4 | `feat/permission-call-attribution` | M · load-bearing | `PermissionRequestOptions.{toolCallId, origin}`; the daemon stops using `currentToolCallId`; `pending` becomes a list; `agent?` on the wire. Sequential behaviour identical. |
| 5 | `feat/round-groups-persistence` | M · load-bearing | Generalised `suspendedCalls` with `groupStart`; `inFlight` + `beforeRun` seam (R2); reload labels; record v6. With groups of one, everything is identical to today (pinned), so it lands before any concurrency. |
| 6 | `feat/parallel-tools` | M–L · load-bearing | `Tool.concurrency` contract; built-in keys (§1.2); MCP `readOnlyHint` + per-server override; pure planner + scheduler; two-phase executor; `tools.execution` / `maxParallel`. Slice 1 is `sequential` = today's suite unchanged. |
| 7 | `feat/parallel-agents` | M · load-bearing | `agent_task` keys; `subagents.execution` / `maxParallel`; shared session grants (if approved); the agent label in the dialog; optional slot detection. |

Tasks 1–3 are independent and could go first. Tasks 4 → 5 → 6 → 7 are
strictly ordered.

---

### Questions for the owner

1. **Default for `tools.execution`.** You leaned toward `sequential`. I
   recommend **`parallel`**: only calls whose resources commute ever overlap,
   so results equal the sequential run and only timing differs, and the path
   gets exercised. Keep `sequential` as a switch.
2. **Reload honesty with calls in flight.** **R2** (a durable `inFlight`
   set: record v6 and one awaited write per parallel group on `serve`;
   exact "Interrupted"/"Not run" notes) or R1 (a generic "may or may not have
   run" note, no format change)? I recommend **R2**: it is the complete
   solution and the cost is small.
3. **Isolating writer sub-agents.** Shared workspace with per-path atomic
   edits and prompt guidance, or a git worktree per writer agent? I recommend
   the **shared workspace**: worktrees need merge-back conflicts, a non-git
   fallback and pod support, and their UX is worse.
4. **One "Yes, always" for the whole session tree.** Should it cover the
   parent and all its sub-agents? Today each sub-agent has its own grants, so
   N parallel agents mean N identical prompts. I recommend **yes**: "always"
   already says "rest of the session".
5. **MCP `readOnlyHint`.** Should the server's hint be trusted by default to
   run that server's tools in parallel, with a per-server config override? I
   recommend **yes**: each call stays ask-gated, and the worst case is a
   reordering within one server.
6. **Sub-agent cap.** `subagents.maxParallel` default 4. Should it also be
   automatically limited to a llama.cpp endpoint's slot count (`/props`)? I
   recommend **yes**: on a one-slot local server, "parallel" otherwise only
   adds waiting.

> **Owner decision PE-Q1 (2026-10-26 21:35):** default `tools.execution` = **read-only parallel** (level B: read/grep/glob/fetch-class tools run together; every write and shell call stays one at a time). `sequential` and full `parallel` (commuting-resource keys, incl. writes on different files) remain selectable in config. The orchestrator changed its recommendation from full parallel to B after weighing: most parallel batches are reads; parallel writes mostly queue on permission prompts anyway; full parallel depends on correct per-tool classification (and honest MCP hints).
> **Owner decision PE-Q2 (2026-10-26):** **R2** — durable `inFlight` set, exact "Interrupted"/"Not run" notes on reload; takes the NEXT record version (v8 is also claimed by permission-reply — whichever lands first takes v8, the other v9, or bundle them).
> **Owner decision PE-Q3 (2026-10-26):** **shared workspace** for writer sub-agents (per-path atomic edits via `PathLocks` + prompt guidance); worktree-per-agent possibly a later option.
> **Owner decision PE-Q4 (2026-10-26):** YES — one "Yes, always" covers the whole session tree (parent + all sub-agents); requests not covered by it are still asked one by one.
> **Owner decision PE-Q5 (2026-10-26):** YES — trust MCP `readOnlyHint` by default for parallel eligibility, with a per-server config override.
> **Owner decision PE-Q6 (2026-10-26):** YES — `subagents.maxParallel` default 4, automatically capped at a llama.cpp endpoint's slot count (`/props`); the config value stays the ceiling.

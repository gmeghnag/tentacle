# fix/subagent-error-report — a failed background sub-agent reaches its parent late, without its findings, and `status` denies it existed

> **Status:** fix round 1 done (Review round 1 findings 1–2 addressed; awaiting Review round 2)
> **Branch:** `feat/subagent-error-report` — the ACTUAL branch. The name is a misnomer
> (this task is a `fix`, so the doc stays in `docs/fix/`); renaming it is a merge-time
> or orchestrator act, not the executor's (AGENTS §10, Review 1 finding 2). Earlier
> header text said `fix/subagent-error-report`, a branch that never existed.
> **Type:** fix · **Size:** M · **Blast:** load-bearing (the agent loop's round-boundary drain) · **Suited:** DeepSeek exec; mandatory fresh-context Review (see Owner question 6)
> **Changelog:** `changelog.d/subagent-error-report.fixed.md` — written by the executor, not by the planner.

## Context

*— claude-opus-5-5, 2026-11-13*

**Owner report (2026-11-13, plain `tentacle` TUI, local Qwen3.8-27B, auto-accept on;
screenshot `.tentacle/tmp/subagent-error-report/owner-screenshot.png`).** The
transcript shows

```
● sa-3 ended (error) · 77 tool uses · Trace FA shared-mem root cause — report sent to the agent
```

and right after it the main agent writes "the sub-agent is still running", keeps
working, calls `agent_control status sa-3` and gets

```
no such background sub-agent: sa-3 — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.
```

then tells the user it will wait for "the full report (exact bytes, the 2-vs-4 table,
ranked fixes)" — from a child that FAILED and whose 77 tool uses of findings are gone.

**Symptom characterisation (AGENTS §1).**
- *Trigger:* a background child (`sa-N`; here a foreground `agent_task` moved to the
  background — `77 tool uses` comes from the move path's live counter) ends while the
  parent's turn is RUNNING.
- *Magnitude:* not a timing jitter — the parent learns nothing until its NEXT turn
  starts, whatever the number of rounds left in the current one.
- *Collateral:* the TUI notice says the report was sent; `agent_control status` denies
  the child; the eventual note carries only the exception message.

**Repro** (`.tentacle/tmp/subagent-error-report/repro.ts`, run 2026-11-13 on this
branch = `main` 5961917, `bun repro.ts`). Real `Agent` + real `createSubagentRunner` +
real `createTaskTool({ background })` + real `createAgentControlTool` on one
`AgentJobs`; scripted providers. The child writes a partial finding and makes one tool
call, then its provider throws. The parent: spawns the child in the background → runs
a 60 ms tool (the child fails meanwhile) → `agent_control status sa-1` → final text.
Then a second `runMessages` stands in for the auto-wake continuation.

```ts
// Repro: a background sub-agent that FAILS mid-run while the parent's turn is running.
// Imports by absolute path into the WORKTREE (not the main checkout).
import { AgentJobs, type ChatMessage, type ExecutionEnvironment, type ModelProvider, type StreamEvent, type ChatRequest } from "<worktree>/packages/core/src/index.ts";
import { ToolRegistry, createTaskTool, createAgentControlTool, shellTool } from "<worktree>/packages/tools/src/index.ts";
import { Agent } from "<worktree>/packages/agent/src/agent.ts";
import { createSubagentRunner } from "<worktree>/packages/agent/src/subagent.ts";
import { z } from "<worktree>/packages/tools/node_modules/zod/lib/index.js";

const log = (...a: unknown[]) => console.log(...a);
const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(3)}ms`;

type Step = readonly StreamEvent[] | (() => never);
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatRequest[] = [];
  private i = 0;
  constructor(private readonly name: string, private readonly script: Step[]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req);
    const step = this.script[this.i++] ?? [{ type: "text", delta: "ok" }, { type: "done" }];
    log(ts(), `${this.name} model round ${this.i}`);
    if (typeof step === "function") step();
    for (const e of step as readonly StreamEvent[]) yield e;
  }
}
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => { await new Promise((r) => setTimeout(r, 5)); return { stdout: "ran", stderr: "", exitCode: 0 }; },
  readFile: async () => "",
  writeFile: async () => {},
};
const call = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool_call", toolCall: { id, name, arguments: JSON.stringify(args) } });

// CHILD: round 1 writes partial findings + a tool call; round 2 the provider throws.
const child = new Scripted("child", [
  [{ type: "text", delta: "PARTIAL FINDING: smem needed 101KB > 99KB limit." }, call("k1", "shell", { command: "ls" }), { type: "done" }],
  () => { throw new Error("provider stream failed: HTTP 500"); },
]);
const { run } = createSubagentRunner({ model: child, env, tools: new ToolRegistry().register(shellTool), requestPermission: async () => ({ allowed: true }) });

let n = 0;
const jobs = new AgentJobs(2);
jobs.bind({ launched: () => `sa-${++n}`, ended: (id, sr, rep) => log(ts(), `host.ended(${id}, ${sr}) report=${JSON.stringify(rep)}`) });
// What the daemon does on this listener (hosted-session.ts:756-769): emit background_exit → TUI "report sent to the agent".
jobs.onExit((e) => log(ts(), `jobs.onExit → daemon emits background_exit {${e.agentId}, stopReason:${e.stopReason}, toolUses:${e.toolUses}} → TUI notice "...report sent to the agent"`));

const slow = { name: "probe", description: "slow", inputSchema: z.object({}), permission: "none" as const,
  execute: async () => { await new Promise((r) => setTimeout(r, 60)); return { content: "probe done" }; } };
const tools = new ToolRegistry()
  .register(createTaskTool(run, [{ name: "general", description: "g" }], { background: jobs }))
  .register(createAgentControlTool(jobs))
  .register(slow as never);

// PARENT: spawn bg child → slow tool (child fails meanwhile) → agent_control status → final text.
const parent = new Scripted("parent", [
  [call("p1", "agent_task", { description: "trace smem", prompt: "go", background: true }), { type: "done" }],
  [call("p2", "probe", {}), { type: "done" }],
  [call("p3", "agent_control", { action: "status", agent_id: "sa-1" }), { type: "done" }],
  [{ type: "text", delta: "the sub-agent is still running, I'll wait for its report" }, { type: "done" }],
  [{ type: "text", delta: "got it" }, { type: "done" }],
]);
const agent = new Agent({ model: parent, tools, env, agentJobs: jobs });

const messages: ChatMessage[] = [{ role: "user", content: "investigate" }];
log("=== TURN 1 (user turn) ===");
for await (const e of agent.runMessages(messages, "s1")) {
  if (e.type === "tool_end" || e.type === "background_exit" || e.type === "context_note" || e.type === "turn_end")
    log(ts(), "parent event", e.type, JSON.stringify((e as { result?: { content?: string } }).result?.content ?? (e as { text?: string }).text ?? (e as { reason?: string }).reason ?? (e as { jobId?: string }).jobId));
}
for (const m of messages) if (m.role === "tool") log("  tool result:", JSON.stringify(m.content));
const sawNote = parent.seen.some((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes("[background]") && m.content.includes("sa-1 (")));
log(ts(), `turn 1 over. parent model ever saw sa-1's note during turn 1? ${sawNote}. pendingExitCount=${agent.pendingExitCount}`);

log("=== TURN 2 (the auto-wake continuation) ===");
for await (const e of agent.runMessages(messages, "s1")) {
  if (e.type === "context_note") log(ts(), "parent event context_note:\n" + e.text);
}
log("partial finding reached the parent?", messages.some((m) => typeof m.content === "string" && m.content.includes("PARTIAL FINDING") && m.role === "user"));
```

Output:

```
=== TURN 1 (user turn) ===
+  2ms parent model round 1
+  4ms child model round 1
+  5ms parent model round 2
+ 11ms child model round 2
+ 11ms host.ended(sa-1, error) report="the sub-agent failed: provider stream failed: HTTP 500"
+ 11ms jobs.onExit → daemon emits background_exit {sa-1, stopReason:error, toolUses:0} → TUI notice "...report sent to the agent"
+ 67ms parent model round 3
+ 67ms parent model round 4
+ 67ms parent event turn_end "end_turn"
  tool result: "started in background as sa-1: trace smem. Its report will arrive later as a [background] note; you can keep working or end your turn."
  tool result: "probe done"
  tool result: "no such background sub-agent: sa-1 — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note."
+ 67ms turn 1 over. parent model ever saw sa-1's note during turn 1? false. pendingExitCount=1
=== TURN 2 (the auto-wake continuation) ===
+ 67ms parent event context_note:
[background] sub-agent sa-1 (trace smem) finished (error):
the sub-agent failed: provider stream failed: HTTP 500
+ 67ms parent model round 5
partial finding reached the parent? false
```

The owner's screenshot is this exact sequence (notice → "still running" → `status` "no
such" → "I'll wait for the report").

**Answers, with evidence.**

1. **Does the parent get a `[background]` note, what is in it, when?** Yes, but only
   at the start of its NEXT turn, never mid-turn. `Agent` queues every exit in
   `pendingExits` (`packages/agent/src/agent.ts:744-745`) and drains exits only in
   `flushBackgroundExits`, called once, at the turn's start (`agent.ts:1094`). The
   round-boundary drain (`agent.ts:1195`) and the late drain (`agent.ts:1400`) call
   `flushAgentMessages`, which takes ONLY a child's `agent_notify` notes and leaves
   every exit in place on purpose (`agent.ts:2425-2445`). In the repro the child dies
   at +11 ms, the parent makes two more model rounds and ends its turn without it.
   Content: the headline `finished (error)` (`agent.ts:2501`) and the report — which
   for a failure is ONLY `the sub-agent failed: <error.message>`; every partial
   finding is discarded (see root cause B).
2. **Does an errored child trigger the auto-wake like a successful one?** Yes — the
   child's stopReason is not an input anywhere. `pendingExitCount` counts every exit
   (`agent.ts:794-797`; repro: `pendingExitCount=1`); the TUI arms on every live
   `background_exit` and, during a turn, defers to the post-turn check
   (`packages/tui/src/App.tsx:1152-1173`); the `serve` gate looks only at the
   PARENT's last end (`packages/core/src/auto-wake.ts:45-61`). So the failure is
   eventually delivered by the wake turn (repro TURN 2) — unless auto-wake is off or
   the parent's turn ended `error`/`cancelled` (`lastEndBad`), in which case it waits
   for the user's next prompt.
3. **Why does `agent_control status` say "no such" for a just-ended child?** The
   registry forgets a child the moment it ends: `drive` deletes it from `running` and
   `live` (`packages/core/src/agent-jobs.ts:723-727`) BEFORE the exit listeners run,
   and nothing keeps an ended record. `status` reads only `jobs.rows()`
   (`packages/tools/src/agent-control.ts:131-137`) and answers the catch-all on a miss
   (`agent-control.ts:138-142`). Combined with (1), the parent is told "if it just
   finished, its report arrives as a [background] note" while the note is sitting
   undelivered for the rest of the turn.
4. **What does "report sent to the agent" claim vs reality?** The line is built from
   the daemon's LIVE `background_exit`, emitted at the child's exit
   (`packages/daemon/src/hosted-session.ts:756-769` → `packages/tui/src/state.ts:173-179`).
   At that instant the report has only been QUEUED in the parent's `pendingExits`; the
   model sees it at the next turn start (1). For an error the "report" is just the
   exception message (B), and the line shows no error text at all. The same wording is
   in the panel (`packages/tui/src/background-list.ts:523-531`).

**Root causes.**
- **A — exits are turn-start-only.** `agent.ts:1094` is the only drain of a child's
  exit; `flushAgentMessages` (`agent.ts:2431-2453`) skips exits. A child that ends
  while the parent works is invisible to the parent until the next turn.
- **B — a thrown child loses its partial report and its tool count.**
  `createSubagentRunner`'s catch rethrows the raw error (`packages/agent/src/subagent.ts:548-556`);
  the accumulated `report` (every `text` delta, `subagent.ts:502-504`) and `toolUses`
  die with the frame. The three catchers synthesise a message-only report:
  `packages/tools/src/task.ts:237-243` (moved child — keeps the live count),
  `task.ts:419-425` (`background:true` — `toolUses: 0`, the repro's `toolUses:0`),
  `packages/core/src/agent-jobs.ts:716-721` (generic, `toolUses: 0`).
- **C — no ended record.** `agent-jobs.ts:723-727` + `agent-control.ts:138-142`, see (3).
- **D — the notice over-claims.** `state.ts:178`, `background-list.ts:531`: "sent"
  is said at queue time; an error carries no error text.

Note: `stopReason: "error"` never comes from the `Agent` loop (`AgentStopReason`,
`agent.ts:93`, has no `error`): a child "ends (error)" only by THROWING (a provider
failure, a tunnel drop — eval F5, `docs/eval/subagent-live.md:493-496`). So B is the
whole error path, not an edge.

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**A sub-agent's exit note can be pushed at the round boundary exactly where a child's
`agent_notify` note already is, with no new history-validity or persistence risk.**
Proof: `flushAgentMessages` already pushes a user-role noted message at the round
boundary after steers (`agent.ts:1187-1201`) and at the late drain, followed by
`continue` so a model round answers it (`agent.ts:1399-1413`). The boundary is after
every tool result of the previous round, so a user message there is a valid history
(the comment at `agent.ts:1092-1093` forbids only "between an assistant's tool calls
and their results"). The sub-agent note's shape is unchanged (`subagentReportNote`,
`agent.ts:2499-2503`), and the daemon closes its ledger delivery on the
`background_exit` event wherever in the turn it is yielded
(`hosted-session.ts:2371-2376`), and clears `wakeUnflushed` on the same event
(`hosted-session.ts:2367-2370`).

### Preconditions

- Single exit queue: `pendingExits` gets sub-agent exits through one listener
  (`agent.ts:745`), and `pendingExitCount` / `retire` / `adoptExits` read it
  (`agent.ts:758-803`) — draining an exit early simply removes it from all three.
- The late-drain invariant: no `await` between the last drain and `turn_end`
  (`agent.ts:1387-1398`). The new drain stays synchronous, in the same function.
- Stale-wake guard: a client-armed continuation after a mid-turn delivery ends with no
  model request when `notesFlushedMidTurn` is set (`agent.ts:1099-1123`). The TUI arms
  that continuation on every live exit while a turn runs (`App.tsx:1152-1173`), so a
  mid-turn exit delivery MUST set the flag, or the wake turn re-runs a round over
  nothing.
- The TUI dedupes the live and the in-turn `background_exit` by `jobId`
  (`state.ts:256`), so a mid-turn event adds no second notice.
- `AgentJobs.drive` runs the listeners after `host.ended` (`agent-jobs.ts:738-751`): the
  durable marker carries the report, so a crash before delivery still derives the note
  at load (`packages/core/src/agent-job-ledger.ts:350-363`) — unchanged.
- §7 Protocol: no schema change is needed (the note and `background_exit` exist);
  `PROTOCOL_VERSION` is untouched. §7 Persistence: the note is the same typed
  `subagent_report` message, only earlier in the log.

### Design

1. **Deliver a sub-agent's exit at the next round boundary (A).** Generalise
   `flushAgentMessages` into a mid-turn drain that takes, in queue order, (a) every
   `agent_message` (as today) and (b) every SUB-AGENT exit (`"agentId" in job` and not
   a note/user-note), rendering (b) exactly as `flushBackgroundExits` does (the same
   `background_exit` event + `subagentReportNote` + `context_note`; extract that
   branch of `agent.ts:2488-2505` into one helper used by both). Shell-job exits and
   `user_note`s stay where they are (Owner question 1). Called at the two existing
   sites (`agent.ts:1195`, `agent.ts:1400`); any delivery sets `notesFlushedMidTurn`.
   At the late drain an exit causes one more round (the existing `continue`), so the
   parent reacts in the same turn instead of after a wake. NOT at the
   `max_iterations` end (no round left): the exit stays queued for the next start, as
   today.
2. **A failure keeps its partial report and its count (B).** Add to `@tentacle/core`
   (next to `AgentJobResult`) `class SubagentFailure extends Error { partialReport:
   string; toolUses: number; cause }` and a pure `subagentFailureResult(error,
   fallbackToolUses): AgentJobResult` that renders
   `the sub-agent failed after N tool use(s): <message>` + (when the partial is
   non-blank) `\n\nPartial output before the failure:\n<partial>`; a non-
   `SubagentFailure` error renders as today, with `fallbackToolUses`. The runner's
   catch (`subagent.ts:548-556`) throws `new SubagentFailure(...)` with `report` and
   `toolUses` (keeping the inbox close and `subagent_end` it does now). The three
   catchers (`task.ts:237-243` with `live.toolUses`, `task.ts:419-425`,
   `agent-jobs.ts:716-721`) call the helper. The report is still capped by
   `capSubagentText` (`agent-jobs.ts:734-737`) and shaped (`task.ts:385-393`). A
   foreground (non-moved) failure still surfaces as a tool error; its message gets the
   partial too, through the same helper (Owner question 3). The live headline for
   `error` reads `failed` instead of `finished (error)` (`agent.ts:2501`; the load
   headline `agent-job-ledger.ts:358` gets the same word).
3. **`status` answers truthfully for a recently ended child (C).** `AgentJobs` keeps a
   bounded `recent` map (last 16 ended, oldest evicted; cleared by `dispose`) of
   `{ agentId, description, stopReason, toolUses, endedAt (host clock), delivered }`,
   written in `drive` before the listeners, plus `ended(id)` to read it and
   `delivered(id)` to flip the flag. The `Agent` calls `agentJobs.delivered(agentId)`
   wherever it pushes a sub-agent note (start flush and the new mid-turn drain). A pure
   `formatEndedAgent(record, now)` in `packages/tools/src/agent-status.ts` (beside
   `formatAgentStatus`) renders e.g. `sa-3 ended (error) 12s ago after 77 tool uses.
   Its report — the error and any partial output — reaches you as a [background] note
   at your next step.` or `… was delivered to you as the [background] note "sub-agent
   sa-3 …".` `agent_control status <id>` falls back to it before the "no such"
   answer, `isError: false`. The no-id listing adds one `recently ended:` line (Owner
   question 4). "no such" is kept only for a truly unknown id.
4. **The notice says what is true (D).** `backgroundExitNotice`'s agent branch
   (`state.ts:173-179`) → `sa-3 failed · 77 tool uses · <desc> — the agent gets its
   error and partial output at its next step` for `error`; for the others `— the agent
   gets its report at its next step`. The panel meta (`background-list.ts:531`) →
   `✓ finished · report queued for the agent`. Pure-module change only (§7 "logic in
   pure modules"). Exact wording: Owner question 2.

### Files

Dependency order (no protocol change):
1. `packages/core/src/agent-jobs.ts` — `SubagentFailure`, `subagentFailureResult`,
   `recent` map + `ended()` / `delivered()`, `drive`'s catch uses the helper. Export
   from `packages/core/src/index.ts`.
2. `packages/core/src/agent-job-ledger.ts` — load headline word for `error`.
3. `packages/agent/src/subagent.ts` — throw `SubagentFailure` with the partial.
4. `packages/agent/src/agent.ts` — mid-turn sub-agent exit drain (one shared helper
   with the start flush), `delivered()` calls, `failed` headline.
5. `packages/tools/src/task.ts` — the two catchers use the helper (+ foreground
   error message, if Q3 = yes).
6. `packages/tools/src/agent-status.ts`, `packages/tools/src/agent-control.ts` —
   `formatEndedAgent` + the fallback; `AGENT_CONTROL` description unchanged.
7. `packages/tui/src/state.ts`, `packages/tui/src/background-list.ts` — wording.
8. Tests (below); `changelog.d/subagent-error-report.fixed.md` (executor).

### Failure modes

- **Exit lands during a tool call of a parallel group.** The drain is at the boundary
  after the whole group (`agent.ts:1187`): never between calls and results.
- **Exit lands after the late drain (between it and `turn_end`).** Impossible inside
  the synchronous stretch (`agent.ts:1387-1398`); an exit after `turn_end` stays in
  `pendingExits` and wakes as today (`pendingExitCount`).
- **Double delivery.** Draining splices the exit out of `pendingExits`; the start
  flush can't see it again. The TUI wake armed by the live notice hits the stale-wake
  guard (requires `notesFlushedMidTurn`, set by this drain). Test both.
- **Turn cancelled after the exit was queued but before the boundary.** Not drained;
  stays queued for the next start (today's path). A cancel AFTER delivery: the note is
  in `messages`, persisted with the turn's history like any steer.
- **Context reset / compaction mid-turn.** The note pushed before it is part of the
  replaced history; the daemon closed delivery on the event (`hosted-session.ts:2374`),
  so a reset never re-notes it (task 5 review L3, unchanged).
- **Retired agent (settings apply).** Undelivered exits move through `retire/adopt`
  (`agent.ts:758-803`); `delivered` lives on the session-level `AgentJobs`, so the
  status record survives the swap.
- **Child killed.** `cancelled` path unchanged; the partial is not involved (the
  runner returns, it doesn't throw, on a cancel).
- **Error thrown that is not an `Error`.** `subagentFailureResult` stringifies, as
  today.
- **Huge partial.** Capped by `capSubagentText` / `SUBAGENT_REPORT_MAX_CHARS` and the
  spill transform, as a normal report.
- **Many ended children.** `recent` bounded at 16 — an evicted id answers "no such",
  the same as today; no unbounded growth over a long session.
- **Pod (`run`/`attach`).** The partial is pod-supplied text, already treated as such
  (the report path is the same); no laptop-side effect added (§7 pod not trusted).
- **Version skew.** No wire change; an older TUI shows its old wording.

### Tests

Red-first on current code; each lists the mutation that must turn it red again.

1. `packages/agent/test/subagent-background.test.ts` — **"a sub-agent exit that lands
   mid-turn is delivered at the next round boundary"**: the repro's shape (bg child
   ends during a slow tool); assert the parent's NEXT model request contains the
   `[background] sub-agent sa-1` note and `pendingExitCount === 0` after the turn. Red
   today (`sawNote false`, count 1). *Mutation:* drop exits from the mid-turn drain.
2. Same file — **"…at the late drain it runs one more round"**: child ends while the
   parent's final-answer round streams; assert a further model request carries the
   note in the same turn. *Mutation:* remove the late-drain call.
3. Same file — **"a shell job's exit is still delivered at turn start only"** (pins
   Q1's scope). *Mutation:* drain all exits mid-turn.
4. Same file — **"the continuation armed by the live exit ends without a model
   request"**: after test 1's turn, `runMessages` with no user message → `turn_end`,
   zero new provider calls. *Mutation:* don't set `notesFlushedMidTurn` on exits.
5. `packages/agent/test/subagent.test.ts` (runner) — **"a thrown child carries its
   partial report and tool count"**: child streams text + 1 tool call then throws;
   `run` rejects with `SubagentFailure` whose `partialReport` contains the text and
   `toolUses === 1`. *Mutation:* rethrow the raw error.
6. `packages/tools/test/task-detach.test.ts` / a background task test — **both
   catchers** produce `failed after N tool use(s): … Partial output before the
   failure: …` (moved: N = live count; `background:true`: N from the failure, not 0).
   *Mutation:* revert either catcher.
7. `packages/core/test/agent-jobs.test.ts` — `recent`: ended record written before the
   listeners (a listener calling `ended(id)` sees it), `delivered` flips, eviction at
   17, `dispose` clears. *Mutation:* write after the listeners.
8. `packages/tools/test/agent-control.test.ts` — status of an ended, undelivered child
   → the ended text, `isError: false`; delivered → the "was delivered" text; unknown id
   → today's "no such" (keep the existing assertion at `agent-control.test.ts:110`).
   *Mutation:* remove the fallback.
9. `packages/tui/test/state.test.ts:300-307`, `background-list.test.ts:424` — new
   wording, incl. an `error` case. *Mutation:* old string.
10. Re-run the repro: expected `parent model ever saw sa-1's note during turn 1? true`,
    `pendingExitCount=0`, status text names `ended (error)`, partial reached the parent
    `true`; paste the output into Execution.

Gate: narrow files per slice, then `bun run check` (lint baseline clean, §6).

### Owner questions

1. **Scope of the mid-turn drain: sub-agent exits only, or shell-job exits too?**
   *Rec:* sub-agents only — a shell job is pollable (`shell_output`) and has no report
   to lose; keeps the change narrow. Shell jobs can follow in their own task.
2. **Notice wording.** *Rec:* `sa-3 failed · 77 tool uses · <desc> — the agent gets
   its error and partial output at its next step` (others: `… gets its report at its
   next step`); panel `✓ finished · report queued for the agent`.
3. **Foreground (non-moved) failure: put the partial output in its tool error too?**
   *Rec:* yes, through the same helper — same loss, one-line change.
4. **`agent_control status` without an id: add a `recently ended:` line?** *Rec:*
   yes, one line (id, outcome, age), max the same 16 records.
5. **Headline word for `stopReason: "error"` in the note (`finished (error)`):**
   *Rec:* `failed` in both the live and the load headline — the model read
   "finished" as success-ish in the report.
6. **Executor vs AGENTS §10:** the change touches the agent loop (blast
   load-bearing), where §10 asks for a stronger executor. *Rec:* keep DeepSeek as
   requested (the seam is pre-existing and fully specified), with the mandatory
   fresh-context Review red-teaming the late-drain invariant and the stale-wake guard.

## Execution

*— claude-opus-5-5, 2026-11-13*

**Signature correction (Review round 1, finding 2):** this Execution is signed
by `claude-opus-5-5` because that is the model that ran it — the commit subject
`exec (deepseek)` and the original note claiming "the executor was this model,
not DeepSeek — owner Q6's recommendation" were wrong on the second half: the
model never changed, so Q6's recommendation (DeepSeek executes) was **not**
honoured. The signature stays the truth; the mislabelled commit subject is left
as-is (the executor may not rewrite history), and this paragraph is the record.
A consequence: Review round 1 is the SAME model family as this Execution (fresh
context only), so shared blind spots survive both passes — the reviewer of
round 1 flagged exactly that.

Branch `feat/subagent-error-report` (worktree
`.tentacle/worktrees/subagent-error-report`, base `ed2baff`). Implementation
followed the plan's dependency order; every slice test was RED on the property
before the fix. All 13 mutation checks below were run and reverted.

**Drift from the plan noted up front:** (a) `formatEndedAgent` claims an age only
when the host gave a clock (`endedAt > 0`),
because the repro's host has none and computed an absurd `498496h 37m ago`; (b)
a test the plan's list implied but omitted was added for `drive`'s own catcher.

### Load-bearing check, re-run first

`bun repro.ts` on the branch's base (= plan's `5961917`), pasted:

```
+ 12ms host.ended(sa-1, error) report="the sub-agent failed: provider stream failed: HTTP 500"
+ 12ms jobs.onExit → {sa-1, stopReason:error, toolUses:0}
+ 68ms turn 1 over. parent model ever saw sa-1's note during turn 1? false. pendingExitCount=1
+ 68ms parent event context_note: [background] sub-agent sa-1 (trace smem) finished (error):
the sub-agent failed: provider stream failed: HTTP 500
partial finding reached the parent? false
```

It reproduces: the note waits for the next turn (`sawNote false`,
`pendingExitCount=1`), it says `finished (error)`, and the partial finding is
gone. The assumption (an exit note can be pushed at the round boundary exactly
where a child's `agent_message` note already is) held: no history-validity or
persistence change was needed, and `agent.ts:1195`'s existing boundary was the
only site touched.

### Slices, in order

1. **`packages/core/src/agent-jobs.ts`** — `SubagentFailure` (Error subclass with
   `partialReport`/`toolUses`/`cause`) and `subagentFailureResult(error,
   fallbackToolUses)`; `EndedAgentJob` + `AGENT_RECENT_ENDED_MAX = 16`; the
   bounded `recent` map written by a new private `remember()` **before** the exit
   listeners, read by `ended(id)` / `recentlyEnded()` and flipped by
   `delivered(id)`; `drive`'s catch is now `subagentFailureResult(error, 0)`;
   `dispose()` clears `recent`. Exported through `packages/core/src/index.ts`
   already (`export *`).
2. **`packages/core/src/agent-job-ledger.ts`** — `subagentReportNote`'s load
   headline reads `failed` for `stopReason: "error"` (owner Q5); every other stop
   reason is byte-identical.
3. **`packages/agent/src/subagent.ts`** — the runner's catch throws
   `new SubagentFailure(message, { partialReport: report, toolUses, cause })`,
   keeping the inbox close and the `subagent_end` progress event it already did.
4. **`packages/agent/src/agent.ts`** — `flushAgentMessages` became
   `flushMidTurn`: it takes `agent_message` notes **and** sub-agent exits
   (`isSubagentExit`: not a note/user-note and `"agentId" in job`), in queue
   order; shell jobs and `user_note`s stay for the turn's start (Q1). The
   `"agentId" in job` branch of `flushBackgroundExits` was extracted into one
   `subagentExitNote()` used by both drains (the `background_exit` event, the
   `subagentReportNote`, the `context_note`, `agentJobs.delivered(id)`, and the
   `failed` headline). Both existing call sites (`agent.ts:1195`, the late drain)
   call it, and both set `notesFlushedMidTurn`.
5. **`packages/tools/src/task.ts`** — both catchers call
   `subagentFailureResult` (moved: `live.toolUses`; `background:true`: `0`
   fallback, the failure's own count wins); a new `failureError()` puts the same
   text into the foreground (never-moved) tool error (owner Q3).
6. **`packages/tools/src/agent-status.ts` + `agent-control.ts`** —
   `formatEndedAgent(record, now)` and `formatRecentlyEnded(records, now)` (pure,
   `oneLine`-bounded, `AGENT_STATUS_MAX_CHARS`-capped); `status` falls back to
   `jobs.ended(id)` before "no such" (`isError: false`) and appends one
   `recently ended:` line to the no-id listing (owner Q4). `AGENT_CONTROL`'s
   description is unchanged.
7. **`packages/tui/src/state.ts`, `background-list.ts`** — the notice reads
   `sa-3 failed · 77 tool uses · … — the agent gets its error and partial output
   at its next step` (others: `… gets its report at its next step`), the panel
   `✓ finished · report queued for the agent` (owner Q2).
8. **`changelog.d/subagent-error-report.fixed.md`** — one bullet.

### Tests (10 of the plan's 10, plus one it implied but did not list)

1. `agent/test/subagent-background.test.ts` — mid-turn delivery at the boundary
   (`pendingExitCount === 0`, the note in the parent's NEXT request, exactly 3
   model rounds). RED before: `pendingExitCount === 1` and no note.
2. Same file — an exit during the final answer's round gets one more round
   (3 requests). RED before: 2.
3. Same file — a shell job's exit is still turn-start only, stays queued. RED
   before implementation is not the interesting leg; the mutation is (below).
4. Same file — the client-armed continuation ends with no model request. RED
   before: a third round ran.
5. `agent/test/subagent.test.ts` — the runner rejects with `SubagentFailure`
   carrying `PARTIAL FINDING…`, `toolUses === 1`, the message, the `cause`;
   plus a child that throws before any text (`partialReport` blank, 0 uses).
6. `tools/test/task-background.test.ts` + `tools/test/task-detach.test.ts` — the
   `background:true` catcher's count is the failure's (never 0); the MOVED
   catcher's too (never the folded live sink's 0); the foreground error carries
   the same text.
7. `core/test/agent-jobs.test.ts` — `recent`: written BEFORE the listeners (a
   listener sees it), host clock, `delivered` flips, eviction at 17, `dispose`
   clears; plus `drive` rendering a thrown `SubagentFailure` through the helper
   (a gap in the plan's list — `drive`'s own catcher had no test; added).
8. `tools/test/agent-status.test.ts` + `tools/test/agent-control.test.ts` — the
   ended text (undelivered / delivered / 0-`endedAt`), one bounded line, the
   capped `recently ended:` listing, an unknown id keeping `no such`.
9. `tui/test/state.test.ts`, `background-list.test.ts` — the new wording,
   including the `error` case.
10. The repro, re-run (below).

### The repro after the fix

```
+ 11ms host.ended(sa-1, error) report="the sub-agent failed after 1 tool use: provider stream failed: HTTP 500

Partial output before the failure:
PARTIAL FINDING: smem needed 101KB > 99KB limit."
+ 67ms parent event background_exit "sa-1"
+ 67ms parent event context_note "[background] sub-agent sa-1 (trace smem) failed:
the sub-agent failed after 1 tool use: … Partial output before the failure: PARTIAL FINDING: …"
  tool result: "sa-1 ended (error) after 1 tool use. Its report was delivered to you as the [background] note "sub-agent sa-1 (trace smem)"."
+ 67ms turn 1 over. parent model ever saw sa-1's note during turn 1? true. pendingExitCount=0
partial finding reached the parent? true
```

All four expected values from the plan hold. The `status` text names
`ended (error)` — with no age, because the repro's `AgentJobs` host binds no
`now` (`endedAt: 0`): a `Date.now()` age against a record with no clock read
`498496h 37m ago` in the first run, which is a lie, so an age is only claimed
when the host gave a clock. That is drift from the plan's example text (which
assumed a host clock); the shape is otherwise as designed.

### Mutation checks (each applied, run, reverted)

| # | Mutation | Red test |
|---|---|---|
| 1 | drop exits from the mid-turn drain | tests 1, 2, 4 |
| 2 | drain ALL exits mid-turn (shell jobs too) | test 3 |
| 3 | set `notesFlushedMidTurn` only for `agent_message` | tests 1, 4 |
| 4 | remove the late-drain delivery | test 2 |
| 5 | write `recent` AFTER the listeners | test 7 (before-listener) |
| 6 | `drive`'s catch back to inline message + `toolUses: 0` | the added `drive` test |
| 7 | ledger `failed` headline reverted | ledger Q5 test |
| 8 | runner rethrows the raw error | test 5 (both legs) |
| 9 | `background:true` catcher reverted | test 6 (background) |
| 10 | MOVED catcher reverted to `live.toolUses` | test 6 (moved) |
| 11 | remove `jobs.ended` fallback | test 8 (undelivered, delivered, and the old finished-child case) |
| 12 | drop the `recently ended:` line | test 8 (listing) |
| 13 | restore the old TUI wording | test 9 (both) |

### Failure modes from the plan, walked

- *Exit during a parallel tool group*: the drain is after the whole group — the
  existing test for the round boundary still passes, and 1's third request shows
  the note after both results.
- *Exit after the late drain*: nothing was added between the drain and
  `turn_end` (the new code is the same synchronous stretch); a shell job left in
  the queue by test 3 proves exits still survive to the next start.
- *Double delivery*: `flushMidTurn` splices, so the start flush cannot see it
  again — test 1's exact-3-rounds assertion and the repro's single
  `background_exit` cover it; the stale-wake guard is test 4.
- *Cancel before the boundary*: unchanged (not drained); nothing in the new code
  touches the cancel paths.
- *Context reset / compaction*: the note is the same typed `subagent_report`
  message, and `hosted-session.ts` still closes delivery on the
  `background_exit` event wherever in the turn it is yielded — unchanged, and
  the daemon suite is green.
- *Retired agent*: `delivered` lives on the session-level `AgentJobs`, so a
  swap keeps it; `retire/adopt` tests still pass.
- *Killed child*: `cancelled` still reads `killed` (test in
  `subagent-background.test.ts`, unchanged).
- *Non-`Error` throw*: `subagentFailureResult` stringifies (tested).
- *Huge partial*: still capped by `capSubagentText` in `drive` (existing cap
  test green); the `background:true` catcher's report goes through `shape`.
- *Many ended children*: bounded at 16, eviction tested; an evicted id answers
  `no such`, as before.
- *Pod*: no laptop-side effect added; the partial is pod-supplied text, treated
  as report text already is. No wire/schema change, so no `PROTOCOL_VERSION`
  bump and no `protocol.json` regeneration.
- *Version skew*: no wire change.

### Gate

`bunx tsc --noEmit` + `bunx tsc -p apps/mobile --noEmit` → clean.
`bun run lint` → `Checked 962 files. No fixes applied.` (the repo baseline is
0 errors/0 warnings). `bun test` → **7637 pass, 3 skip (the opt-in live-k8s,
live-docker and slow keepalive), 0 fail** across 544 files.

### Fix round 1

*— claude-opus-5-5, 2026-11-13*

Review round 1 raised no HIGH and two MEDIUMs; both are addressed. Code changed
in ONE test file; the other fix is the record itself.

**Finding 1 (MEDIUM) — `Agent` → `AgentJobs.delivered()` unpinned. FIXED.**
Two assertions, one per drain site, both in
`packages/agent/test/subagent-background.test.ts`:
- `"it counts, and the next turn flushes ONE noted report…"` (the TURN-START
  flush, `agent.ts:1137`/`2545` path): `expect(jobs.ended("sa-1")?.delivered).toBe(true)` after the drain.
- `"it is delivered at the next round boundary…"` (the MID-TURN drain,
  `agent.ts:1408` → `subagentExitNote`): the same assertion at the end.
They are two separate call sites of the one renderer, so pinning one would not
have covered the other; the reviewer's scenario is the mid-turn one.

**RED before green:** with `this.config.agentJobs?.delivered(job.agentId)`
(`packages/agent/src/agent.ts:2498`) replaced by a comment — the reviewer's exact
mutation — `bun test packages/agent/test/subagent-background.test.ts` → **2 fail**,
both on this assertion (`Expected: true / Received: false`, at the T16 and the
A-boundary test), the other 9 pass:

```
(fail) a sub-agent's exit in the parent agent (T16, T17) > it counts, and the next turn flushes ONE noted report before the first model round
444 |     expect(jobs.ended("sa-1")?.delivered).toBe(true);
error: expect(received).toBe(expected)   Expected: true   Received: false
(fail) A: a sub-agent exit that lands mid-turn > it is delivered at the next round boundary, and nothing stays queued
 9 pass · 2 fail
```

Reverted the mutation (file restored from a scratch copy, `git diff` on
`agent.ts` empty): 11 pass, 0 fail. So the new assertions fail on the exact
property (a `status` that promises a note the model already holds) and only the
wiring flip makes them green — non-vacuous by mutation, as §9 asks.

**Finding 2 (MEDIUM) — branch ↔ doc ↔ executor record. FIXED (record).**
- Header: `Branch:` now says `feat/subagent-error-report` (the real branch) with
  a note that the name is a misnomer (`fix` task, doc rightly under `docs/fix/`)
  and that renaming a branch is not the executor's act. `Status:` moves off
  "awaiting owner approval" (approved 2026-11-13) to fix-round-1-done.
- Execution signature: the signer is `claude-opus-5-5`, which **is** what ran it
  (verified: the session that produced this Execution and `b0b5701` carries only
  `"model":"claude-opus-5-5"`). The bogus claim "the executor was this model,
  not DeepSeek — owner Q6's recommendation" is replaced by the honest statement:
  Q6's recommendation (DeepSeek executes) was **not** honoured; the commit
  subject `exec (deepseek)` is wrong and is left as history (the executor may not
  rewrite it). The consequence the reviewer named is recorded: Review round 1 is
  the same model family, so it is not an independent pass.

**Mutations run this round (applied, run, reverted; tree verified clean after):**

| # | Mutation | Result |
|---|---|---|
| 14 | `agent.ts:2498` `delivered()` call removed | **2 red** (the two new assertions) ✔ |

No other code changed, so the previous 13 mutations still stand. No changelog
change (the fragment was already written; this round adds no user-visible
behaviour).

**Gate (this round):** `bunx tsc --noEmit` → clean · `bun run lint` →
`Checked 962 files. No fixes applied.` · `bun test` → **7637 pass, 3 skip (the
opt-in live-k8s, live-docker, slow keepalive), 0 fail**, 544 files, 71628
`expect()` calls · `bun run typecheck` (both projects) → clean.

**Unverified / left open:** (a) AGENTS §10's branch-slug 1:1 is still formally
violated by the branch name; only the orchestrator/owner can rename
`feat/subagent-error-report` → `fix/subagent-error-report`, and the doc cannot
fix it alone. (b) The task is still absent from `TODO.md`'s index — the same
orchestrator-level bookkeeping, not touched here to keep this round's diff to
code + this doc.

## Review

*— claude-opus-5-5, 2026-11-13*

**Verdict: REQUEST-CHANGES** (one MEDIUM test gap, one MEDIUM process mismatch; no HIGH).

**Gate (re-run):** `bun test` → 7637 pass, 3 skip (opt-in), 0 fail, 544 files;
`bun run lint` → 962 files, clean; `bun run typecheck` → clean. Touched files: 239 pass.

**Findings**
1. **MEDIUM — `Agent` → `AgentJobs.delivered()` is not pinned by any test.**
   `packages/agent/src/agent.ts:2498` (`this.config.agentJobs?.delivered(job.agentId)`).
   Mutation: commented it out → `packages/agent`, `packages/tools`, `packages/daemon`
   suites all green (1699 pass). Scenario: a regression drops the call; after a
   mid-turn delivery `agent_control status sa-N` says "Its report … reaches you as a
   [background] note at your next step" for a note already in history — the model
   waits again for a report it holds, the exact owner bug (root cause C) in a new
   form. The tests cover `AgentJobs.delivered` alone and `formatEndedAgent` alone,
   never the wiring. Fix: in `subagent-background.test.ts` assert
   `jobs.ended("sa-1")?.delivered === true` after the mid-turn and the start flush
   (or drive `agent_control status` as the repro does).
2. **MEDIUM — branch ↔ doc ↔ executor record disagree (AGENTS §10).** Branch is
   `feat/subagent-error-report`; the doc is `docs/fix/…` and its header says
   `Branch: fix/subagent-error-report` (and Status still "awaiting owner approval").
   The commit `b0b5701` says "exec (deepseek)" but Execution is signed
   claude-opus-5-5 and states "the executor was this model, not DeepSeek". One must
   be corrected; §10's 1:1 rule and the model signature are the point of the record.
   Consequence for this Review: if Execution really is claude-opus-5-5, this review
   is the SAME model (fresh context only) — shared blind spots survive both passes.

**Mutations (each applied with Edit, run, reverted; tree byte-identical after):**
drop sub-agent exits from `flushMidTurn` → 3 red (A: boundary, late round,
stale-wake) ✔; `failureError` returns the raw error → 1 red (foreground renderer) ✔;
no `delivered()` call → **0 red** ✘ (finding 1).

**Attacks tried**
- *Late-drain invariant* (`agent.ts:1407-1420`): the new drain is the same
  synchronous `flushMidTurn` call; no `await` added before `turn_end`. Holds.
- *Stale-wake / double wake:* every `background_exit` (turn-stream or live) reaches
  the TUI's exit listener (`remote-client.ts:2963`) and arms one deferred wake; the
  in-turn event is deduped by jobId; the continuation hits the guard because the
  drain sets `notesFlushedMidTurn` (both sites). `serve` wakes on
  `session.pendingExitCount` (`hosted-session.ts:2524`), which the drain zeroes. Holds.
- *Ledger delivery mid-turn:* `noteSeen` fires on any `background_exit` with
  `agent` in the drive loop (`hosted-session.ts:2374`) — position-independent;
  `wakeUnflushed` only matches a wake turn's id. Holds.
- *Clock skew in the age:* `endedAt` = host `now` (daemon `this.now`, `Date.now`),
  `agent_control` default `Date.now`; `endedAt 0` → no age. Holds.
- *Foreground path:* `settled` swallows the rejection but the not-moved path awaits
  `running` (`task.ts:288`), so the failure still fails the call, now with the
  partial. Holds (and pinned).
- *§7 protocol/persistence:* no schema change, note shape unchanged
  (`subagentReportNote`), only its position; pod partial text takes the same
  report path and caps. Holds.

**Executor behaviour:** plan followed in order, drift declared (age clock, extra
`drive` test), 13 mutations listed — but the list missed the one wiring seam above,
and the executor identity is recorded inconsistently.

#### Owner answers (2026-11-13)

Q1–Q6 all as recommended (Q6: DeepSeek executes, mandatory fresh Opus review). Implementation APPROVED.

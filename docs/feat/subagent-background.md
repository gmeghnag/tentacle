# feat/subagent-background — a sub-agent the agent launches in the background

> **Status:** implementation (awaiting approval; owner questions at the end)
> **Branch:** `feat/subagent-background` (6a-1), STACKED on `feat/subagent-ledger-log` @ `7cdc9b2`; `feat/subagent-background-ui` (6a-2) opens off `main` after 6a-1 merges
> **Type:** feat · **Size:** 6a-1 L, 6a-2 M (split: no XL) · **Blast:** 6a-1 load-bearing (AGENTS §7: one session path, single broker, protocol, pod lifecycle, the agent's exit path); 6a-2 cross-module · **Suited:** owner assigned deepseek-v4.1-flash to execute; mandatory fresh-context Review of 6a-1 that red-teams asks, liveness and the broker; in-context Review of 6a-2 with one TUI frame test per surface

Vocabulary (owner): **agent** = the main model; **subagent** (child) = the child of an `agent_task` call.
Source: `docs/eval/subagent-live.md` task 6a, Opus review H1–H4, M4, M5, M7, L2; owner answers Q2, Q5, Q7, Q15–Q17 and "Owner decision — slots"; TODO `feat/subagent-background`, `feat/clear-keeps-jobs`.

**The split, and which goes first.** One branch would hold about 40 files and two separate kinds of risk. So:

| | Branch | What | Size / Blast | Mergeable alone because |
|---|---|---|---|---|
| **6a-1, first** | `feat/subagent-background` | `background: true`, the runtime, the cap, exit + wake, the background ask (H3), liveness (H2), the carried line (M4), the pod save (M5), task 5's markers, `PROTOCOL_VERSION` 20 | L / load-bearing | The child runs, asks, reports and wakes correctly. Only the live view is missing: a launch and an exit notice are shown, nothing between them |
| **6a-2, second** | `feat/subagent-background-ui` | the `subagents` update (H1), the footbar count, the quit confirm (M7), the relay's keep-awake, `agent_kill` if owner Q1 says so | M / cross-module | Display only: no `PROTOCOL_VERSION` bump (a `display` update) |

This doc holds both plans. When the 6a-2 branch opens, its Part moves to `docs/feat/subagent-background-ui.md` (AGENTS §10: one branch, one doc).

**Stacking.** Task 5 is executed with fix round 1; its Opus review round 2 is pending. Rebase 6a-1 onto `main` once task 5 merges. Line numbers below are for `7cdc9b2`: if task 5 moves them, find the symbol.
Two owner questions are open on task 5; this plan assumes the reviewer's (a) for both:
- **Q3 (a)** a load note keeps `awaitsAnswer()` true. If the owner picks (b): nothing in 6a changes. `maybeWake` calls `prompt` and never reads `awaitsAnswer`.
- **Q4 (a)** `note` is fail-soft. If (b) or (c): nothing in 6a changes. `subagent_report` and `sa-N` fit every option's bounds.

## Context

*— claude-opus-5-5, 2026-11-09*

**Why.** Owner addition to the eval: the agent may launch a subagent straight into the background. The call returns at once (`started in background as sa-N`), the agent keeps working or ends its turn, and the report re-enters later as a job exit with an auto-wake. Task 5 built the durable half (ledger, two log types, load derivation) with nothing launching yet: `backgroundAgent` / `agentEnded` have no production caller.

**Binding decisions.** Q2: ONE cap, `subagents.maxParallel`, foreground and background together; slots decision: nothing else limits children. L2: over the cap a background launch is an error result naming the running ids; foreground spawns are not errored. Q5: a background child's ask is asked anyway, attributed to `sa-N`, queued behind the agent's own. Q7: the quit confirm lists running children. Q10/Q11: report in `subagent_end`, no wake at load. Q15: one background list (the rows are task 7; here a count only).

**Corrections to the eval and to its review (each proven in the Repro or cited):**

1. **H3 is not enough: a pending background ask can be LOST, three ways.** `HostedSession`'s module comment says a pending ask "sits past the cut, which cannot move while the agent is blocked on it". A background ask breaks that premise: the parent keeps committing.
   - A fresh attach replays only from the cut, so it no longer sees the ask (probe D: `replayed asks: 0`).
   - A compaction or context reset is a barrier. The client's reducer then keeps only the requests the replay re-offers, so the dialog is withdrawn while the daemon still waits (probe E: `keepRequests: []`; `session-reducer.ts:374,381`; `remote-client.ts:2163`).
   - The ring may evict it.

   Without a fix the child hangs for ever and holds a cap slot. **Fix:** re-emit the same request (same `requestId`, new `seq`) at every attach and right after every `history_replaced`. The router dedupes by id (`permission-router.ts:105-111`), and re-emitting past the barrier is kept (probe E, second line). At most ONE ask exists at a time: the ask lane is serial for the whole tree (`session-grants.ts:56`, `permission-gate.ts:167`).
2. **A background ask must not share `awaitDecision`'s persistence.** That path writes `turn.pending`, and clears `this.carried` when any ask settles (`hosted-session.ts:731`). A background ask settling during a resumed turn would make a reload run a call twice. It gets its own path, never on disk (the child is lost on a reload anyway).
3. **`ownRequest` does NOT "work unchanged" (H3).** `RemoteSession.ownsTurn` only knows the current turns (`remote-session.ts:256-261`). Once the spawning turn has ended, a TUI no longer owns it and auto-accept stops. `ownsTurn` must remember the turns this session minted.
4. **`subagent_exit` is not needed: extend `background_exit`.** It is already what the TUI, the relay, the backlog and `unflushedExits` run on. An optional `agent` field gives one exit path (eval A3: "reuse the exit path; do not build a second one").
5. **M5's "one line" would break the exit backlog.** `onBackgroundExit` feeds a backlog only while it has no subscriber (`remote-client.ts:2192`). A saver subscribing there would starve the TUI that mounts later. It needs its own listener set.
6. **A report must pass the result transforms.** The foreground report does (`agent.ts:1340`): redaction, hooks, spill. A background report must too, or a secret reaches the history through the new path.
7. **The idle ring is unbounded** (H1's coalescing does not fix it): nothing moves the cut while idle, and the ring never evicts past the cut (probe F: budget 600, 8092 bytes). 6a-2 moves the cut after each idle `subagents` frame.
8. `PROTOCOL_VERSION` is 19 now, so this is **20** (the eval's "18" is stale).

**Repro (2026-11-09, `7cdc9b2`).** `bun .tentacle/tmp/subagent-background/probe.ts`. The capability is missing (no `background` argument), and this proves the load-bearing assumption. Real `Agent`, `Session`, `createSubagentRunner`, `HostedSession` and ledger; the only stand-in is `launch_bg`, doing by hand what 6a's `agent_task{background:true}` will do. Output:

```
— A. a child outlives its tool call AND its turn, on its own controller
 turn over: true | frames end with: turn_end | child finished: false
 H2 today — liveness.busy: false | summary.jobs: 0 | ledger running: 1
 child finished: true stop: end_turn | report: THE REPORT
 own sink got: subagent_start,subagent_tool,subagent_end
 tool_progress frames while it ran: 0
 frames since release: background_exit,turn_start,context_note,agent_message_chunk,turn_end
— B. exit → wake: a pending exit starts ONE turn that flushes it (idle, wake on)
 turn starts: T1,wake
 unflushed after: 0 | user messages: go | [background] job sa-1 (`child`) exited w
 model requests: 3 | last request's last message: [background] job sa-1 (`child`) exited w
— C. H3: an ask with no turn is cancelled at once; with a later turn it dies with that turn
 idle ask → {"allowed":false} | permission_request frames: 0
 during T2: permission_request frames: 1
 Esc on T2 → {"allowed":false}
— D. a pending ask is lost to a fresh attach once the cut moves past it
 fresh attach, cut before the ask: replayed asks: 1
 fresh attach, cut after the ask (a later round committed): replayed asks: 0
— E. a barrier withdraws a pending ask nothing re-offers (client reducer)
 pending before barrier: r1 | keepRequests after the snapshot: []
 same id re-emitted past the barrier: keepRequests: ["r1"]
— F. ring: while idle nothing moves the cut, so frequent updates outgrow the budget
 budget 600, after 100 idle updates: ring bytes: 8092
 after one idle recordCut(null): ring bytes: 568
```

<details><summary>Probe source (`.tentacle/tmp/subagent-background/probe.ts`, gitignored; pasted per AGENTS §6)</summary>

```ts
import { Agent, Session, createSubagentRunner } from "@tentacle/agent";
import {
  type BackgroundJob, type ChatRequest, type ExecutionEnvironment, type JobController,
  type ModelProvider, PermissionBroker, type StreamEvent, type Tool,
} from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "../../../packages/core/node_modules/zod/lib/index.mjs";
import { initialStream, reduceStream } from "../../../packages/client/src/session-reducer.ts";
import { HostedSession } from "../../../packages/daemon/src/hosted-session.ts";

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 8) { for (let i = 0; i < n; i++) await macro(); }
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call", toolCall: { id, name, arguments: "{}" },
});
type Step = readonly StreamEvent[] | { gate: Promise<void>; events: readonly StreamEvent[] };
class Model implements ModelProvider {
  readonly id = "m"; readonly steps: Step[] = []; readonly seen: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req);
    const s = this.steps.shift() ?? [text("ok"), done];
    if ("gate" in s) { await s.gate; for (const e of s.events) yield e; return; }
    for (const e of s) yield e;
  }
}
class FakeJobs implements JobController {
  private readonly ls = new Set<(j: BackgroundJob) => void>();
  start(): BackgroundJob { throw new Error("unused"); }
  read(): undefined { return undefined; }
  kill(): boolean { return false; }
  list(): readonly BackgroundJob[] { return []; }
  dispose(): void {}
  onExit(l: (j: BackgroundJob) => void): () => void { this.ls.add(l); return () => this.ls.delete(l); }
  fire(id: string): void {
    for (const l of [...this.ls]) l({ id, command: "child", startedAt: 0, status: "exited", exitCode: 0 });
  }
}
const env: ExecutionEnvironment = {
  id: "noop", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "", writeFile: async () => {},
};
const free: Tool = { name: "free_read", description: "d", inputSchema: z.object({}), permission: "none", execute: async () => ({ content: "read" }) };
const needs: Tool = { name: "needs_ok", description: "d", inputSchema: z.object({}), permission: "ask", execute: async () => ({ content: "ran" }) };

function rig(ringBytes = 4 * 1024 * 1024) {
  const parent = new Model(); const child = new Model(); const jobs = new FakeJobs();
  const permissions = new PermissionBroker();
  const tools = new ToolRegistry().register(free).register(needs);
  const bag: { hosted?: HostedSession } = {};
  const progress: string[] = []; const timeline: string[] = [];
  const childRes: { ctl?: AbortController; report?: string; stop?: string } = {};
  const { run } = createSubagentRunner({ model: child, env, tools, requestPermission: (req, o) => permissions.request(req, o) });
  const launch: Tool = {
    name: "launch_bg", description: "d", inputSchema: z.object({}), permission: "none",
    execute: async (_i, ctx) => {
      const hosted = bag.hosted as HostedSession;
      const agentId = hosted.backgroundAgent({ callId: ctx.toolCallId ?? "?", agentType: "general", description: "map repo" });
      const ctl = new AbortController(); childRes.ctl = ctl;
      void run({ description: "map repo", prompt: "go", type: "general" }, {
        signal: ctl.signal, onEvent: (e) => progress.push(e.kind),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}), sessionId: ctx.sessionId,
      }).then((r) => {
        timeline.push("child_done"); childRes.report = r.report; childRes.stop = r.stopReason;
        hosted.agentEnded(agentId, r.stopReason, r.report); jobs.fire(agentId);
      });
      return { content: `started in background as ${agentId}: map repo` };
    },
  };
  tools.register(launch);
  const agent = new Agent({ model: parent, tools, env, jobs, systemPrompt: "s", maxIterations: 8, requestPermission: (req, o) => permissions.request(req, o) });
  const session = new Session(agent, "s1", {});
  const hosted = new HostedSession("s1", session, permissions, jobs, {}, ringBytes, Date.now, undefined, {}, {});
  bag.hosted = hosted;
  const frames: KnownSessionUpdateParams[] = [];
  hosted.attach({ send: (p) => frames.push(p) });
  return { parent, child, jobs, permissions, hosted, frames, progress, timeline, childRes, session };
}
const types = (f: KnownSessionUpdateParams[]) => f.map((p) => p.update.type);
const noteOf = (s: Session) => s.messages.filter((m) => m.role === "user").map((m) => m.content.slice(0, 40));

console.log("— A. a child outlives its tool call AND its turn, on its own controller");
{
  const r = rig(); const g = Promise.withResolvers<void>();
  r.parent.steps.push([call("c1", "launch_bg"), done], [text("started it"), done]);
  r.child.steps.push({ gate: g.promise, events: [call("k1", "free_read"), done] }, [text("THE REPORT"), done]);
  r.hosted.prompt("T1", [{ type: "text", text: "go" }]);
  await settle();
  console.log(" turn over:", !r.hosted.running, "| frames end with:", types(r.frames).at(-1), "| child finished:", r.timeline.includes("child_done"));
  console.log(" H2 today — liveness.busy:", r.hosted.liveness().busy, "| summary.jobs:", r.hosted.summary("/w").jobs, "| ledger running:", r.hosted.agentJobsRunning().length);
  const before = r.frames.length; g.resolve(); await settle();
  console.log(" child finished:", r.timeline.includes("child_done"), "stop:", r.childRes.stop, "| report:", r.childRes.report);
  console.log(" own sink got:", r.progress.join(","));
  console.log(" tool_progress frames while it ran:", r.frames.filter((p) => p.update.type === "tool_progress").length);
  console.log(" frames since release:", types(r.frames.slice(before)).join(",") || "(none)");
}
console.log("— B. exit → wake: a pending exit starts ONE turn that flushes it (idle, wake on)");
{
  const r = rig();
  r.parent.steps.push([call("c1", "launch_bg"), done], [text("started it"), done], [text("read the report"), done]);
  r.child.steps.push([text("THE REPORT"), done]);
  r.hosted.prompt("T1", [{ type: "text", text: "go" }]);
  await settle(12);
  console.log(" turn starts:", r.frames.filter((p) => p.update.type === "turn_start").map((p) => (p.update as { turnId: string }).turnId.slice(0, 4)).join(","));
  console.log(" unflushed after:", r.hosted.unflushedExits, "| user messages:", noteOf(r.session).join(" | "));
  console.log(" model requests:", r.parent.seen.length, "| last request's last message:", String(r.parent.seen.at(-1)?.messages.at(-1)?.content).slice(0, 40));
}
console.log("— C. H3: an ask with no turn is cancelled at once; with a later turn it dies with that turn");
{
  const r = rig(); const ask = { tool: "needs_ok", level: "ask" as const, title: "t", input: {} };
  const idle = await r.permissions.request(ask, { origin: "subagent", toolCallId: "c9" });
  console.log(" idle ask →", JSON.stringify(idle), "| permission_request frames:", r.frames.filter((p) => p.update.type === "permission_request").length);
  const g = Promise.withResolvers<void>();
  r.parent.steps.push({ gate: g.promise, events: [text("x"), done] });
  r.hosted.prompt("T2", [{ type: "text", text: "other" }]);
  await settle(2);
  const during = r.permissions.request(ask, { origin: "subagent", toolCallId: "c9" });
  await settle(2);
  console.log(" during T2: permission_request frames:", r.frames.filter((p) => p.update.type === "permission_request").length);
  r.hosted.cancel();
  console.log(" Esc on T2 →", JSON.stringify(await during));
  g.resolve(); await settle(2);
}
console.log("— D. a pending ask is lost to a fresh attach once the cut moves past it");
{
  const r = rig(); const ask = { tool: "needs_ok", level: "ask" as const, title: "t", input: {} };
  const g = Promise.withResolvers<void>();
  r.parent.steps.push({ gate: g.promise, events: [text("x"), done] });
  r.hosted.prompt("T3", [{ type: "text", text: "other" }]);
  await settle(2);
  void r.permissions.request(ask, { origin: "subagent", toolCallId: "c9" });
  await settle(2);
  const fresh1: KnownSessionUpdateParams[] = [];
  r.hosted.attach({ send: (p) => fresh1.push(p) });
  console.log(" fresh attach, cut before the ask: replayed asks:", fresh1.filter((p) => p.update.type === "permission_request").length);
  (r.hosted as unknown as { recordCut(t: string | null): void }).recordCut("T3");
  const fresh2: KnownSessionUpdateParams[] = [];
  r.hosted.attach({ send: (p) => fresh2.push(p) });
  console.log(" fresh attach, cut after the ask (a later round committed): replayed asks:", fresh2.filter((p) => p.update.type === "permission_request").length);
  r.hosted.close(); g.resolve(); await settle(2);
}
console.log("— E. a barrier withdraws a pending ask nothing re-offers (client reducer)");
{
  let st = reduceStream(initialStream, { kind: "open_sent" }).state;
  st = reduceStream(st, { kind: "open_result", created: true, resync: false, epoch: "e1", now: 1 }).state;
  const ask = { type: "permission_request", requestId: "r1", toolCallId: "c9", tool: "t", title: "t", options: [{ optionId: "a", name: "a", kind: "allow_once" }] };
  st = reduceStream(st, { kind: "update", params: { sessionId: "s", seq: 1, mandatory: true, update: ask }, now: 2 } as never).state;
  const barrier = reduceStream(st, { kind: "update", params: { sessionId: "s", seq: 2, mandatory: true, update: { type: "history_replaced", reason: "compact" } }, now: 3 } as never);
  const after = reduceStream(barrier.state, { kind: "snapshot", messages: [], since: { epoch: "e2", seq: 2 }, turn: null, now: 4 });
  const reset = after.out.find((o) => o.kind === "reset");
  console.log(" pending before barrier:", st.pending.join(","), "| keepRequests after the snapshot:", JSON.stringify(reset && "keepRequests" in reset ? reset.keepRequests : null));
  let st2 = barrier.state;
  st2 = reduceStream(st2, { kind: "update", params: { sessionId: "s", seq: 3, mandatory: true, update: ask }, now: 3 } as never).state;
  const after2 = reduceStream(st2, { kind: "snapshot", messages: [], since: { epoch: "e2", seq: 2 }, turn: null, now: 4 });
  const reset2 = after2.out.find((o) => o.kind === "reset");
  console.log(" same id re-emitted past the barrier: keepRequests:", JSON.stringify(reset2 && "keepRequests" in reset2 ? reset2.keepRequests : null));
}
console.log("— F. ring: while idle nothing moves the cut, so frequent updates outgrow the budget");
{
  const r = rig(600);
  const h = r.hosted as unknown as { emit(u: unknown): void; ring: { bytes: number }; recordCut(t: string | null): void };
  for (let i = 0; i < 100; i++) h.emit({ type: "queued", entries: [], returned: [] });
  console.log(" budget 600, after 100 idle updates: ring bytes:", h.ring.bytes);
  h.recordCut(null);
  console.log(" after one idle recordCut(null): ring bytes:", h.ring.bytes);
}
process.exit(0);
```
</details>

## Implementation — Part 1: 6a-1 `feat/subagent-background`

*— claude-opus-5-5, 2026-11-09*

### Plan change (owner Q2 b)

*— claude-sonnet-5-5, 2026-11-09*

**Owner (2026-11-09): Q1 → (a)** `agent_kill(id)` for the model, in 6a-2 (not in 6a-1). **Q2 → (b)**: a foreground `agent_task` at a full cap is REFUSED at once, like a background launch. No FIFO wait, no waiting row, no waiters queue. This note OVERRIDES D1, D2, failure modes 10/11 and tests T6/T7/T9/T12 below; where they disagree, this note wins.

- **D1.** `acquire(description)` is a synchronous try: `{ok:true, release} | {ok:false, reason}`. No `signal`, no `onWait`, no waiters, no `pump`. `used = running.size + foreground.size` (foreground entries keep their description for the refusal). `start` refuses on `used >= cap` only (no waiter clause). `release` is idempotent. `setCap` only stores the cap (nothing to admit). After `dispose`, `acquire` is refused.
- **D2.** Foreground path: `const slot = bg ? bg.acquire(args.description) : noSlot`; `!slot.ok` → `{content: slot.reason, isError: true}`, no child, no slot. `try { run } finally { slot.release() }`.
- **Refusal text** (both paths), naming the running children (`sa-N (description)`; foreground ones as `(foreground) description`): `at the sub-agent limit (subagents.maxParallel = N); running: …. Nothing was started. Either end your turn (you are woken by a [background] note when a background sub-agent finishes) or do this work yourself.` It does NOT say "run it in the foreground" (the foreground is equally full) and does not mention `agent_kill` (6a-2).
- **Failure modes.** #10: a cap-full launch, background or foreground, is an error result naming the running children; no child, no marker, no id, no slot. #11: a cap lowered by a sync kills nothing; new work is refused until `used < cap`.
- **Tests.** T6 → "foreground at full cap is refused naming the running ids; no child, no slot leaked; a release frees exactly one slot and is idempotent". T7 → dropped (no waiters). T9 → "setCap lowered: running children stay, new starts refused; raised: start works". T12 → "foreground at full cap: `isError`, names the ids, `run` never called; a throwing run still releases (the `finally`)".
- **Citations.** Task 5 is merged; every `file:line` below was written for `7cdc9b2` and is re-verified as I reach each slice (drift is recorded in Execution).
- **Task 5 L3 debt:** D5.9 pays it for a sub-agent report; see Notes / debt.

### Load-bearing assumption

**A child started from inside a tool's `execute`, on its own `AbortController`, keeps running after the tool returned and after its turn ended, and its exit, routed through the agent's existing `pendingExits` and `kickWake`, starts exactly one turn that flushes the note. The turn's stream is not involved.**

Proven by the probe with the real classes:
- **A**: `turn over: true`, `child finished: false`, then the child finishes while idle (`stop: end_turn`). Zero `tool_progress` frames reach a client: H1 holds, so progress needs its own path (Part 2).
- **B**: `turn starts: T1,wake`, `unflushed after: 0`, and the wake's model request ends with the note.

What it does NOT give, and this plan adds: H2 (`liveness.busy: false`, `summary.jobs: 0` with a child running: probe A); the ask (probe C: cancelled when idle, killed by an unrelated Esc; probes D/E: lost).

### Preconditions (verified on `7cdc9b2`)

| # | Fact | Where |
|---|---|---|
| P1 | A tool gets a per-call context; `signal` is the turn's | `core/src/tool.ts:89-114`; `agent.ts:1317-1321,1421-1423` |
| P2 | `agent_task` takes a `run` and awaits it | `tools/src/task.ts:153-186` |
| P3 | The runner honours `controls.signal` only; a child's asks go through `subagentRequester` | `agent/src/subagent.ts:255-268,121-136,299-303` |
| P4 | The gate passes NO signal to the requester; asks are serialised for the whole tree | `permission-gate.ts:167-177`; `session-grants.ts:56-90` |
| P5 | Exits are collected by a listener, counted, carried across a rebuild, flushed at a turn's start | `agent.ts:504,534,542-556,815,1838-1864` |
| P6 | The daemon streams an idle exit, then schedules a wake | `hosted-session.ts:573-583,1870-1924` |
| P7 | Task 5's seam: `backgroundAgent` (persists at launch), `agentEnded` (persists), `agentJobsRunning`; `recordCut` closes committed notes | `hosted-session.ts:1264-1306,1229-1234` |
| P8 | `subagentReportNote(job, headline)`; an EMPTY report takes the "before the session restarted" wording, so the live report must be non-empty | `core/src/agent-job-ledger.ts:354-364` |
| P9 | The relay's idle and `exitPlan` read `jobs` from `session/list`; `summary().jobs` is where it comes from | `relay-state.ts:183,268,273,324`; `relay.ts:533-537`; `local-runtime.ts:867-875`; `hosted-session.ts:1059` |
| P10 | The reaper reads `liveness().busy` | `session-reaper.ts:65,99`; `hosted-session.ts:1064-1072` |
| P11 | A pending ask is re-offered only by replay; reducer gaps are checked by contiguous `seq`, so every frame must go through `emit` | `hosted-session.ts:1094-1117`; `ring.ts:55-65`; `session-reducer.ts:267-273` |
| P12 | The router dedupes a re-offer by `requestId` | `client/src/permission-router.ts:105-111` |
| P13 | The client attributes an ask to the turn that carried it, and auto-accept needs that turn to be "own" | `remote-client.ts:2184`; `permission-ui.ts:60-68,324`; `relay-policy.ts:57`; `remote-session.ts:256-261` |
| P14 | `background_exit` is display, not turn-scoped, and ends in the TUI, the relay and the backlog | `updates.ts:90-96,294`; `remote-client.ts:2187-2203`; `local-runtime.ts:172-191`; `App.tsx:690-719`; `relay.ts:426` |
| P15 | The laptop's log reader is driven by `flush`; `onTitle` is the pattern for an idle-time save | `local-runtime.ts:349-361,373,481` |
| P16 | Results pass the transforms only in the loop | `agent.ts:1340-1344,1873-1913` |
| P17 | A settings sync rebuilds through `reuse`; `foreign` guards it | `session-host.ts:965-986`; `serve.ts:466-472`; `hosted-session.ts:1641-1651` |
| P18 | A context reset already names running shell jobs; compaction names none | `context-reset.ts:54-71`; `agent.ts:1736-1743`; `compact.ts:234-254`; `session.ts:238` |
| P19 | `PROTOCOL_VERSION` is 19; `UPDATE_CLASS` is total | `protocol/src/version.ts:10`; `updates.ts:287` |

### Design

#### D1. The runtime: `AgentJobs` (`core/src/agent-jobs.ts`, new; pure: no I/O, no clock, no React)

One per session, carried across a rebuild like `jobs`. It owns the controllers and the cap. The ledger stays the record of durable facts in `HostedSession`, so the id and the markers go through a host the session binds.

```ts
export interface AgentJobSpec { readonly callId: string; readonly agentType: string; readonly description: string }
/** Bound by `HostedSession`. Absent (a one-shot, `plain`): background launches are refused. */
export interface AgentJobHost {
  launched(spec: AgentJobSpec): string;                                  // sa-N; logs + persists
  ended(agentId: string, stopReason: string, report: string): void;      // logs + persists
}
export interface AgentJobResult { readonly report: string; readonly toolUses: number; readonly stopReason: string }
export interface AgentJobControls { readonly signal: AbortSignal; readonly agentId: string }
export interface RunningAgentJob extends AgentJobSpec { readonly agentId: string }
export interface AgentJobExit extends RunningAgentJob, AgentJobResult {}
export type AgentJobStart =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly reason: string };

export class AgentJobs {
  constructor(maxParallel: number);
  setCap(maxParallel: number): void;                 // pumps the waiters
  bind(host: AgentJobHost): void;
  start(spec: AgentJobSpec, run: (c: AgentJobControls) => Promise<AgentJobResult>): AgentJobStart;
  /** A foreground child takes a slot: waits, FIFO. `null`: aborted. Returns an idempotent release. */
  acquire(signal: AbortSignal, onWait?: (running: readonly RunningAgentJob[]) => void): Promise<(() => void) | null>;
  list(): readonly RunningAgentJob[];
  onExit(listener: (exit: AgentJobExit) => void): () => void;
  dispose(): void;                                   // aborts every child; no `ended`, no exit
}
```

Exact rules:
- `used = running.size + foreground`.
- `start`, in this order: disposed or no host → `{ok:false, reason:"background sub-agents are not available in this mode: run it in the foreground"}`. `used >= cap` OR any waiter queued (a launch never overtakes a waiting foreground call) → `{ok:false, reason:`at the sub-agent limit (subagents.maxParallel = ${cap}); running in background: ${ids with descriptions}. Wait for one to finish (its report arrives as a [background] note) or run this one in the foreground.`}`. Else: `agentId = host.launched(spec)`, a new `AbortController`, add to `running`, `void drive(...)`, return. Synchronous end to end.
- `drive`: `await run(...)`, with any throw becoming `{report:`the sub-agent failed: ${message}`, toolUses:0, stopReason:"error"}`. Then `running.delete`, `pump()`. If `disposed` return. Else report = `capSubagentText(report.trim() === "" ? "(the sub-agent produced no output)" : report, SUBAGENT_REPORT_MAX_CHARS)` (P8), `host.ended(...)` FIRST, then every listener in a `try/catch` (a throwing listener never loses the others).
- `acquire`: already aborted → `null`. `used < cap` and no waiter → `foreground++`, resolve at once. Else `onWait?.(list())`, queue FIFO; an abort removes the waiter and resolves `null`. `release` is idempotent: `foreground--`, `pump()`. `pump`: while waiters and `used < cap`, admit the first.
- `dispose`: `disposed = true`, clear listeners, abort every running child, resolve every waiter with `null`.

#### D2. The tool (`tools/src/task.ts`)

`TaskRunControls` gains `readonly agentId?: string`. `TaskToolOptions` gains `readonly background?: AgentJobs`.

The input schema is built as one `z.object({...})` from a base shape plus conditional spreads: `model` as today, and, when `options.background` is present:
`background: z.boolean().optional().describe("Run the sub-agent in the background: this call returns at once with its id (sa-N), you can keep working or end your turn, and its report arrives later as a [background] note that wakes you. Default false.")`.
If `spawnKind` or `execute` no longer type-check, keep their existing cast through `z.infer<typeof baseSchema>`.

`execute`, after the model check:
```ts
const bg = options.background;
const runOpts = { description: args.description, prompt: args.prompt, type, ...(model !== undefined ? { model } : {}) };
if (args.background === true && bg) {
  const started = bg.start(
    { callId: ctx.toolCallId ?? "", agentType: type, description: args.description },
    async ({ signal, agentId }) => {
      let result: TaskRunResult;
      try {
        result = await run(runOpts, {
          signal, agentId,
          ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
          sessionId: ctx.sessionId,
        });
      } catch (error) {
        result = { report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`, toolUses: 0, stopReason: "error" };
      }
      // The same transforms as a foreground report: redaction, hooks, spill.
      const shaped = ctx.shapeResult ? await ctx.shapeResult({ content: result.report }, signal) : { content: result.report };
      return { ...result, report: shaped.content };
    },
  );
  return started.ok
    ? { content: `started in background as ${started.agentId}: ${args.description}. Its report will arrive later as a [background] note; you can keep working or end your turn.` }
    : { content: started.reason, isError: true };
}
const release = bg
  ? await bg.acquire(ctx.signal, (running) =>
      ctx.emitProgress?.({ kind: "subagent_tool", label: `waiting for a free slot (running: ${running.map((r) => r.agentId).join(", ")})` }))
  : () => {};
if (release === null) return { content: "(sub-agent cancelled before it started)", isError: true };
try { /* today's `run` call and its report text, unchanged */ } finally { release(); }
```
The child is given **never** `ctx.signal`: that is what makes Esc on a turn harmless to it.

#### D3. Core additions

- `core/src/tool.ts` `ToolContext`: `readonly shapeResult?: (result: ToolResult, signal?: AbortSignal) => Promise<ToolResult>;`, documented "the loop's result transforms for this call, callable after the call returned".
- `core/src/jobs.ts` `BackgroundJob`: `readonly agent?: { readonly stopReason: string; readonly toolUses: number };`.
- `core/src/permission.ts:129`: `agent?: {type; description; id?: string}`. `id` present = a BACKGROUND child's ask.

#### D4. The agent (`agent/src/agent.ts`, `subagent.ts`, `compact.ts`, `context-reset.ts`, `session.ts`)

- `subagent.ts`: `SubagentRunControls.agentId?`. `subagentRequester(requester, parentCallId, agent, background?: { readonly id: string; readonly signal: AbortSignal })`: with `background`, the forwarded options carry `signal: background.signal` and `agent: {...agent, id: background.id}`. At `:263`, pass `controls?.agentId !== undefined && controls.signal ? { id: controls.agentId, signal: controls.signal } : undefined`.
- `agent.ts`:
  - `AgentConfig.agentJobs?: AgentJobs` next to `jobs` (`:337`).
  - `export type PendingExit = BackgroundJob | AgentJobExit`; `pendingExits`, `retire()`, `adoptExits` use it (`:504,542-556`). The two kinds differ by `"agentId" in exit`, so shell exits stay the same objects.
  - `unsubscribeAgentExits = config.agentJobs?.onExit((e) => this.pendingExits.push(e))` in the constructor (`:534`), removed in `retire`.
  - `AgentEvent` `background_exit` gains `readonly agent?: {stopReason; toolUses}` (`:269-273`).
  - Both `ctx` builders (`:1317-1321`, `:1421-1423`) gain `shapeResult: (result, sig) => this.transformResult(call, result, sig, { sessionId: toolContext.sessionId })`.
  - `flushBackgroundExits` (`:1844`), first branch of the loop, for an agent exit:
    ```ts
    if ("agentId" in job) {
      const status = job.stopReason === "cancelled" ? "killed" : "exited";
      events.push({ type: "background_exit", jobId: job.agentId, command: job.description, status, exitCode: null,
                    agent: { stopReason: job.stopReason, toolUses: job.toolUses } });
      const message = subagentReportNote({ ...job, state: "ended" },
        `[background] sub-agent ${job.agentId} (${job.description}) finished (${job.stopReason}):`);
      messages.push(message);
      events.push({ type: "context_note", text: message.content, reason: "background_exit" });
      continue;
    }
    ```
- **M4.** `compact.ts`: `stillRunningNote(jobs: readonly {id; command}[], agents: readonly {agentId; description}[]): string`. The shell paragraph is today's text exactly (`Background jobs still running (shell_output / shell_kill):\n- ${id}: \`${command}\``); the agents one is `Background sub-agents still running (each report arrives later as a [background] note):\n- ${agentId}: ${description}`; joined by a blank line, `""` when both are empty. `contextResetHistory` takes `agents` and uses it (`context-reset.ts:61-67`). `compactedHistory(messages, summary, skills, running = "")` appends `running` after the summary, before the skills note. `Agent.runningBackground()` returns both lists, used at `agent.ts:1739` and by `Session.compact` (`session.ts:238`).

#### D5. The daemon (`hosted-session.ts`, `session-host.ts`, `permission-map.ts`)

`permission-map.ts:51`: copy `id` into `agent` when present.

`session-host.ts`: `AgentFactory`'s return and `AgentReuse` gain `agentJobs?: AgentJobs`. `buildHosted` passes it as HostedSession's NEW LAST constructor argument. `updateSettings`: `reuse` includes it; `foreign` also compares `next.agentJobs !== reuse.agentJobs`, and its cleanup disposes a foreign one, as for `jobs` (`:971-978`). `newSessionContext` (`:296-312`) disposes it in `finally`.

`hosted-session.ts`:
1. Fields: `agentRuntime`, `unsubscribeAgentExit`, `spawnTurns = new Map<string, string>()`.
2. Constructor, next to the shell exit subscription (`:573-583`):
   ```ts
   this.agentRuntime = agentRuntime;
   agentRuntime?.bind({
     launched: (spec) => {
       const id = this.backgroundAgent(spec);
       if (this.activeTurnId !== null) this.spawnTurns.set(id, this.activeTurnId);
       return id;
     },
     ended: (id, stopReason, report) => { this.spawnTurns.delete(id); this.agentEnded(id, stopReason, report); },
   });
   this.unsubscribeAgentExit = agentRuntime?.onExit((exit) => {
     this.emit({ type: "background_exit", jobId: exit.agentId, command: wireLine(exit.description, 512),
                 status: exit.stopReason === "cancelled" ? "killed" : "exited", exitCode: null,
                 agent: { stopReason: exit.stopReason, toolUses: exit.toolUses } });
     this.kickWake();
   });
   ```
3. `PendingAsk.record` becomes `PendingPermission | null`; add `readonly reoffer?: PermissionRequestUpdate`. `pendingList` keeps non-null records only. Extract the promise body of `awaitDecision` (`:681-704`) into `private registerAsk(requestId, update, record, signal, reoffer?)`, returning `decided`; `awaitDecision` calls it with no behaviour change.
4. First line of `awaitDecision`: `if (options?.agent?.id !== undefined) return this.awaitBackgroundDecision(req, options, options.agent.id);`.
5. New, sharing no persistence with the turn's path:
   ```ts
   private awaitBackgroundDecision(req, options, agentId): Promise<PermissionResponse> {
     const signal = options.signal;
     if (this.closed || !signal || signal.aborted) return Promise.resolve(outcomeToResponse({ outcome: "cancelled" }));
     const unsupported = this.blockingUnsupported("permission_request");
     if (unsupported !== undefined) return Promise.resolve({ allowed: false, reason: unsupported });
     const requestId = crypto.randomUUID();
     const spawnTurn = this.spawnTurns.get(agentId);
     const update = { ...toPermissionRequestUpdate(requestId, options.toolCallId || "pending", req, options.agent),
                      ...(spawnTurn !== undefined ? { turnId: spawnTurn } : {}) };
     const decided = this.registerAsk(requestId, update, null, signal, update);
     const ask = this.asks.get(requestId);
     if (ask) ask.shown = true;
     try { this.emit(update); } catch (error) { this.reportTurnError(error); }
     return decided.then(({ outcome, reason, message }) => {
       if (reason !== undefined) return { allowed: false, reason };
       const response = outcomeToResponse(outcome);
       return message !== undefined ? { ...response, message } : response;
     });
   }
   ```
   It writes nothing and never touches `carried`, `inFlight` or `compacting`.
6. `private reofferBackgroundAsks()`: for each ask with `reoffer` and `shown`, `this.emit(ask.reoffer)` in a `try/catch`. Called (a) in `attach`, right after the `closed` check, BEFORE the replay is computed, so its frame is in the replay; (b) at the end of `historyReplaced`, after the `history_replaced` emit.
7. `summary().jobs`: shell running + `agentJobs.running().length`. `liveness().busy`: `this.running || this.agentJobs.running().length > 0`.
8. `agentEnded`, inside the `body !== null` path: `this.lastActiveAt = this.now();`. A child's end is the moment the session may become idle (`SessionLiveness`'s rule).
9. `drive` (`:1746`): also, for `event.type === "background_exit" && event.agent !== undefined`, `this.agentJobs.noteSeen({ kind: NOTE_KIND.subagentReport, id: event.jobId })`. This pays task 5's L3 debt: delivery is closed at the push, so a note wiped by a `context_reset` in the same window is not re-noted.
10. `close`: after `this.jobs?.dispose()`, `this.unsubscribeAgentExit?.(); this.agentRuntime?.dispose();`.
11. `reusable()` returns `agentJobs` too.
12. `session-reaper.ts`: comment only (a running background child is `busy`; shell jobs still are not: H2's "record it").

#### D6. Protocol (`protocol/src`)

- `version.ts`: 20, comment: "a `permission_request` may now arrive outside any turn and name the spawning turn; a sub-agent exit rides `background_exit` (docs/feat/subagent-background.md)".
- `permission.ts:79`: `agent: z.object({ type: z.string(), description: z.string(), id: z.string().optional() }).optional()`. New `turnId: z.string().optional()`, commented "the spawning turn of a background child's ask; no `.max()`, as `agent`: this update is blocking, and only an equality test reads it".
- `updates.ts` `BackgroundExitSchema`: `agent: z.object({ stopReason: z.string(), toolUses: z.number().int().nonnegative() }).optional()`, with the comment saying a sub-agent's exit rides this update.
- `session.ts:895` `jobs` doc: "background work running now: shell jobs and sub-agents".
- `bun run schema:export`.

No new update, no new method, no `UPDATE_CLASS` change in 6a-1.

#### D7. Client (`client/src`)

- `permission-router.ts:113`: `this.queue.push({ sessionId, update, turnId: update.turnId ?? turnId });`. `RouterAction.agent` and `next()` carry `id` through `progressText`.
- `mapping.ts:247`: copy `agent`.
- `remote-client.ts`: `BackgroundExitNotice` gains `agent?` (filled at `:2190`). New `agentExitListeners = new Set<(sessionId: string) => void>()`, `onAgentExit(listener)`. In `deliver`, after the backlog block, when `update.agent` is set, call them with `entry.id`. **Never register these in `exitListeners`** (Context 5).
- `remote-session.ts`: `onAgentExit(listener)`, filtered by `this.id` (pattern `onTitle`, `:373-379`). `private readonly mintedTurns = new Set<string>()`, a helper that adds and drops the oldest past 256, called where `this.turnId` is assigned (`:678,:816`). `ownsTurn` also returns `this.mintedTurns.has(turnId)`.

#### D8. CLI (`cli/src`)

- `wiring.ts`: `BuildAgentOptions.agentJobs?`. `const agentJobs = options.agentJobs ?? new AgentJobs(config.subagentMaxParallel); agentJobs.setCap(config.subagentMaxParallel);` after `jobs` (`:382`). `createTaskTool(..., { ..., background: agentJobs })` (`:527`). `new Agent({ ..., agentJobs })` (`:564`). `WiredAgent.agentJobs` (`:243,:600`).
- `worker.ts:130`: forward `agentJobs`. `serve.ts:469`: `...(options.reuse.agentJobs ? { agentJobs: options.reuse.agentJobs } : {})`.
- `local-runtime.ts`: `remoteJobsView` (`:183`) forwards `agent`; the persisting controller adds `const unsubscribeAgentExit = inner.onAgentExit?.(() => flush());` next to `:373` and removes it at `:481`. **M5**: a report that ends while idle reaches the laptop's log. The inner type gains the optional method.
- The relay needs NO change here (P9): `jobs` now counts children.

#### D9. TUI (`tui/src`), the minimum

- `state.ts:144`: `backgroundExitNotice(jobId, command, status, exitCode, agent?)`. With `agent`: `${jobId} ${agent.stopReason === "end_turn" ? "finished" : `ended (${agent.stopReason})`} · ${agent.toolUses} tool uses · ${command} — report sent to the agent`. Pass it at `state.ts:457`, `App.tsx:693`.
- `permission-ui.ts:96`: with `agent.id`: `${agent.id} · ${agent.type} · "${agent.description}" · background`. `PermissionAgent` gains `id?`.

#### D10. `feat/clear-keeps-jobs`, the follow-up

`/clear` closes the old `HostedSession`, which disposes both registries (`hosted-session.ts:2252` and D5.10). The follow-up keeps one `AgentJobs` across the two sessions: the old session unbinds without `dispose` and `handOver()`s its ledger; the new one receives the `AgentJobs` through `AgentReuse`, `bind`s it, `adopt()`s the jobs, and its `logSegmentFacts()` re-emits their markers. The exit path, the wake and the ask need no change, because everything hangs off `bind` and `onExit`. A handed-over child's ask carries no `turnId` (`spawnTurns` is per session), so it prompts. No log format, no protocol change.

Until it lands, `/clear` aborts running children silently, like shell jobs today (recorded in Notes).

### Files (dependency order; `bun test` on the named file per slice)

| Slice | Files | Slice's tests |
|---|---|---|
| 1 protocol | `protocol/src/{version,permission,updates,session}.ts`, `schema/protocol.json` | `protocol/test/` |
| 2 core | `core/src/agent-jobs.ts` (new), `index.ts`, `tool.ts`, `jobs.ts`, `permission.ts` | `core/test/agent-jobs.test.ts` |
| 3 tool | `tools/src/task.ts` | `tools/test/task.test.ts` |
| 4 agent | `agent/src/{subagent,agent,compact,context-reset,session}.ts` | `agent/test/subagent-background.test.ts` (new), `compact.test.ts`, `context-reset.test.ts` |
| 5 daemon | `daemon/src/{permission-map,hosted-session,session-host,session-reaper}.ts` | `daemon/test/subagent-background.test.ts` (new) |
| 6 client | `client/src/{permission-router,mapping,remote-client,remote-session}.ts` | `client/test/permission-router.test.ts`, `client/test/agent-exit.test.ts` (new) |
| 7 cli | `cli/src/{wiring,worker,serve,local-runtime}.ts` | `cli/test/wiring.test.ts`, `cli/test/local-runtime.test.ts` |
| 8 tui | `tui/src/{state,permission-ui}.ts` | `tui/test/state.test.ts` |
| 9 docs | `CHANGELOG.md`, this doc, `TODO.md` on merge | |

**CHANGELOG (planned line, `### Added`):** "**Background sub-agents.** The agent can start a sub-agent with `background: true` and keep working: the call returns at once with an id (`sa-1`), and the report comes back later as a note that wakes the agent, like a background shell job. They share the `subagents.maxParallel` limit with foreground sub-agents; over it, a background start is refused and the agent is told which ones are running. A background sub-agent's permission prompts are asked as usual and name it. The protocol version moved to 20: an older pod daemon or `serve` is refused at connect with \"update\"."

### Failure modes (each: how state converges)

| # | Case | Converges to |
|---|---|---|
| 1 | **Child crash** (a provider error, a throw) | The tool's closure turns it into `stopReason:"error"` and a report, shaped like any other; `AgentJobs` has a last net. The slot frees, `end` is logged, the note and the wake follow |
| 2 | **Parent turn cancelled** (Esc), or a later turn | Nothing happens to the child: it never sees `ctx.signal`. The exit stays pending. `lastEndBad` queues it without a wake (existing rule), and the next prompt flushes it |
| 3 | **Session closed / archived / deleted** while running | `close` → `dispose`: children abort, no `end`, no exit frame, a pending ask settles through the child's signal. At `reopen`, `bg` without `end` gives the lost note (task 5) |
| 4 | **Client detaches** | The child runs on. On `serve` the daemon wakes. In-process, pod: the next attach gets `unflushedExits`; the ask is re-offered at attach |
| 5 | **Daemon restart** (`serve`) | Children die with the process. Task 5's derivation: `bg` alone → lost note; `bg` + `end` undelivered → report note; no wake (Q10). A suspended turn + a note → closed honestly (task 5 Q1). The counter continues |
| 6 | **Pod** (never persists): TUI quits a plain `run` | The session closes; children abort. Laptop's copy holds the markers; the lost note at resume |
| 7 | **Pod, detached run** | `jobs` counts children, so the relay stays and `exitPlan` holds a `--rm` delete (P9). A child end while idle: `background_exit` → `job_exit` → the relay's wake. M5's flush saves the `end` on the laptop |
| 8 | **Pod: the model link drops** (`Connection` cancels only the TURN, `connection.ts:149-150`) | The child's next model call fails: `stopReason:"error"`. Its exit waits for the next attach. Same as any model failure |
| 9 | **Hostile pod** forges `turnId`, `agent.id`, a `background_exit` | `turnId` can make auto-accept treat an ask as own, the same trust as the stream's own brackets it replaces (AGENTS §7: a pod already picks which turn carries an ask). `agent` fields are bounded by `progressText` at the router. A forged exit wakes a turn, as a forged shell exit does. No new laptop effect |
| 10 | **Cap reached** | A background launch: `isError` naming the running ids, no child, no marker, no id consumed. A foreground spawn waits FIFO with a label, cancellable (owner Q2) |
| 11 | **Cap lowered by a settings sync** | No child is killed. New work waits until `used < cap` |
| 12 | **Version skew** | `PROTOCOL_VERSION` 20: a mismatched pair fails at `initialize` (`VersionMismatch`). Nothing else is needed pre-public |
| 13 | **A client that did not declare `permission_request`** (blocking class) | `blockingUnsupported` denies the child's ask with the reason, at raise and through `recheckAsks` at attach/detach (same rules as a turn's). The child reports it |
| 14 | **Ask with no client attached** | Held, no timer (AGENTS §7 "no socket event, nobody-attached ever settles it"). The child waits and holds its slot. `busy` protects it from the idle TTL, not from an admin cap. The next attach sees it (re-offer) |
| 15 | **Ask during a compaction or context reset** | Unaffected by `compacting`. Re-offered right after `history_replaced`; the dialog stays open (the same id, the router dedupes) |
| 16 | **Ask answered by client A while B reconnects** | `settle` is first-wins, and `asks` no longer holds it, so no re-offer. B gets `permission_resolved` or its absence: the existing rules |
| 17 | **Ask and the agent's own ask** | One lane for the tree (`session-grants.ts`): FIFO, shown one at a time (Q5). A background ask holds the lane until answered, so a turn's ask waits behind it: the user sees that dialog first |
| 18 | **Many children** | `running.size ≤ maxParallel`. The ledger holds only undelivered jobs; a re-offer is ≤ 1 frame (the lane) |
| 19 | **Report too large** | The result transforms spill it (preview + file path) as for a foreground report; `capSubagentText` then bounds it to 64 KiB, identically in the note and in `subagent_end` |
| 20 | **Empty report** | Replaced by a placeholder before the note, so the live text never reads "before the session restarted" (P8) |
| 21 | **Exit lands during a turn** | Queued (same as shell). The next turn's start flushes; the end of this turn kicks a wake |
| 22 | **Settings sync while a child runs** | The child keeps its old runner and the shared broker. `AgentJobs` is the same object (`foreign` enforces it). A new agent subscribes; undelivered exits move by `adoptExits` |
| 23 | **`/clear`, today** | As #3, silently: `feat/clear-keeps-jobs` |
| 24 | **Note pushed, then `context_reset` in the same window** | Closed at the push (D5.9), so no second note |
| 25 | **One-shot / `plain`** (no `HostedSession`) | No host bound: the launch is refused with the reason; foreground unchanged |

### Tests (red before green; existing fakes)

Order per slice: write the slice's tests, run them and paste the failing line into Execution (red: the symbol is missing, or the assertion fails), implement, run (green). Then run the mutation named on each load-bearing test once, record the red line, restore (check with `shasum`, as task 5 did). Daemon rig: `serve-autowake.test.ts`'s `Model`, `settle()`; a real `AgentJobs`, `Agent`, `Session`, `HostedSession`, and `SpyDaemonStore` where a persister is named.

| # | File · name | Property | Mutation that must kill it |
|---|---|---|---|
| T1 | `core/agent-jobs` · "start below the cap launches once" | `host.launched` once, `list()` holds it, the run gets a live signal | call `launched` twice |
| T2 | · "over the cap refuses and names the running ids" | no `launched`, no run; `reason` has `sa-1` | drop the cap check |
| T3 | · "no host refuses" | `ok:false`, no run | default a fake host |
| T4 | · "ended comes before the exit listeners; report capped; empty → placeholder" | call order, length ≤ cap | swap `ended` and the listeners |
| T5 | · "a throwing run ends as error and frees the slot" | exit `stopReason:"error"`, `start` works again | drop the catch |
| T6 | · "acquire waits FIFO; a child's end admits; an abort returns null and leaks nothing" | order, `used` afterwards | drop `pump` in the release path |
| T7 | · "a launch never overtakes a waiting foreground call" | `start` refused while a waiter queues | drop the waiters check |
| T8 | · "dispose aborts, no ended, no exit" | | remove the `disposed` return in `drive` |
| T9 | · "setCap raises and admits" | | no `pump` in `setCap` |
| T10 | `tools/task` · "background returns at once and the child does not get the turn's signal" | result before `run` settles; aborting `ctx.signal` leaves the child's signal alive | pass `ctx.signal` |
| T11 | · "over the cap is an error result with no child" | `isError`, no run | |
| T12 | · "foreground waits with a label, cancels to a no-child error, releases in finally" | label seen; release also after a throw | drop `finally` |
| T13 | · "no background option: no argument; a stray one is stripped and runs foreground" | definitions | always add it |
| T14 | · "the report passes shapeResult; a thrown run still passes it" | | skip `shapeResult` on the throw path |
| T15 | `agent/subagent-background` · "the requester forwards the child's signal and id" | `options.signal`, `agent.id`, origin `subagent` | drop `signal` |
| T16 | · "an agent exit counts, and the next turn flushes one noted report before the first model round" | `pendingExitCount`, `note{subagent_report, sa-1}`, `background_exit.agent`, the text is the live headline | no `agent` branch |
| T17 | · "retire/adopt carry agent exits, and the old agent stops collecting" | | no unsubscribe in `retire` |
| T18 | `compact` / `context-reset` · "both name running children and shell jobs; none → unchanged" | exact strings; today's vectors unchanged | leave one site without it |
| T19 | `daemon/subagent-background` · "a child outlives its turn; idle exit streams `background_exit{agent}`, logs `end`, wakes once" (the load-bearing test) | `turn_end` before the child's end; exactly one `wake-` turn; the last model message is the report note | remove `kickWake` from the subscription |
| T20 | · "no wake after a bad end; the next prompt delivers" | | ignore `lastEndBad` |
| T21 | · "H2: busy and jobs count a running child; lastActiveAt moves at its end" | `liveness().busy`, `summary().jobs`, stamp | leave `busy = this.running` |
| T22 | · "H3: an idle ask is shown with `agent.id` and the spawning `turnId`, and the answer runs the tool" | frame, tool ran | route through `awaitDecision` |
| T23 | · "H3: Esc on a later turn leaves the ask pending" | still pending after `cancel()` | use `this.controller.signal` |
| T24 | · "a fresh attach after the cut moved is shown the pending ask" | the frame reaches the new attachment | drop the re-offer in `attach` |
| T25 | · "a compaction keeps the ask: re-offered after `history_replaced`, and the client's `keepRequests` keeps it" | feed `reduceStream`; `keepRequests` has the id | drop the re-offer in `historyReplaced` |
| T26 | · "a background ask is never persisted and does not clear `carried`" | a later suspended turn's written `pending` has only its own; a resumed turn's `carried` survives the settle | give it a record |
| T27 | · "no client attached: held, shown at attach, answered" | | |
| T28 | · "a client that did not declare `permission_request` denies with the reason" | | |
| T29 | · "single broker: the child's ask reaches the requester HostedSession installed" | a second, spy broker is never called | wire a second broker |
| T30 | · "close aborts the child, settles its ask, emits no exit after `session_closed`" | | remove `dispose` from `close` |
| T31 | · "the note is closed at the flush: a reset in the same window re-emits nothing" | no `subagent_*` after the new `base` | drop D5.9 |
| T32 | · "a settings sync keeps the runtime; a child's exit reaches the new agent" | real `updateSettings` | build a fresh `AgentJobs` |
| T33 | · "restart: a live child at `stop()` is one lost note after the reload, and the counter continues" | real `LogSessionStore`, as task 5's L1 | |
| T34 | `client/permission-router` · "the update's turnId wins over the stream's" | | ignore it |
| T35 | `client/agent-exit` · "ownsTurn remembers an ended own turn, not a foreign one, bounded" | | current-only |
| T36 | · "onAgentExit fires for a sub-agent exit only, and subscribing leaves the exit backlog working" | a later `onBackgroundExit` still gets the backlog | subscribe through `onBackgroundExit` |
| T37 | `cli/local-runtime` · "an agent exit flushes the save (M5)" | one read-back while idle | remove the subscription |
| T38 | `cli/wiring` · "reuse passes the same AgentJobs and sets the cap; `background` is offered when sub-agents are on" | | |
| T39 | `cli/relay-state` · "jobs counting a child hold the idle exit and a `--rm` delete" | existing `jobs` cases with a child's count | |
| T40 | `tui/state` · "an agent exit notice reads as a sub-agent; a shell one is unchanged"; `permissionAgentLine` with an id | | |
| T41 | `protocol` · "version 20; `background_exit` with and without `agent`; `permission_request` with a long `turnId` parses" | | add `.max()` |

Gate before done: `bun run check` (typecheck → lint, baseline clean → full `bun test`, opt-in skips only). A live check with a real model is not part of the gate: list it in "not verified".

## Implementation — Part 2: 6a-2 `feat/subagent-background-ui`

*— claude-opus-5-5, 2026-11-09*

Opens after 6a-1 merges. Move this Part to `docs/feat/subagent-background-ui.md` then.

**Load-bearing assumption.** A full-state update with coalescing can carry the live list without growing the ring while idle: an idle `recordCut(null)` after each frame brings the ring back under budget (probe F: 8092 → 568), and a child's activity reaches an idle client and a second attacher through the same two channels as `queued` (live frame + snapshot at the cut). Re-prove it with T42 before anything else.

**Preconditions.** `queued` is the pattern: `updates.ts:225-229,310`; `hosted-session.ts:992-1003,1183,1222`; `session.ts:402`; `remote-client.ts:1830,2051,2207,2361`; `remote-session.ts:395-406,1254,1347`; `mapping.ts:279-281`. `maybeWake` already moves the cut while idle (`hosted-session.ts:1906`). The attach path for unflushed exits does not depend on the replay (`connection.ts:460`), so moving the cut idle is safe. Quit: `commands.ts:247-266`, `App.tsx:589-592,1740-1753,2295-2301,2384-2391,2777-2778`. Status: `status-line.ts` (`suffix` is whole or dropped), `StatusBar.tsx:92-109`, `App.tsx:2851`.

**Design.**
1. Protocol (`updates.ts`, `session.ts`). `SubagentRowSchema = {id, callId, agentType, description, state: z.string(), toolUses, tokens, startedAt, tail: z.array(z.string())}`, strip, no `.max()` (a client bounds what a pod sends). `SubagentsUpdateSchema = {type:"subagents", agents: z.array(row)}`, class `display`. `SnapshotResultSchema.subagents` optional. No version bump.
2. `AgentJobs`: `progress(agentId, event: ToolProgressEvent)` folds `subagent_tool` (tail, last 8, `toolUses`) and `subagent_usage` (tokens); `onChange(listener)`, fired on start, progress, end; `rows()`; `startedAt` passed in by the host (the class stays clock-free). The tool's closure passes `onEvent: (e) => bg.progress(agentId, e)`. **If owner Q1 is (a):** `kill(id): boolean` aborts one child (the exit is `cancelled`), and `tools/src/background.ts` gains `agent_kill` beside `shell_kill`, wired only where `background` is.
3. Daemon. New pure `daemon/src/subagents-view.ts`: `subagentRows(jobs)`, labels through `wireLine(label, 200)`, and `sameRows(a, b)`. `HostedSession`: `lastSubagents` (`Cut.subagents`, set like `queued`), and `kickSubagents()`: a `setTimeout(250)`, one at a time, cleared in `close`. On fire: compare, `emit({type:"subagents", agents})`, then **`if (this.controller === null) this.recordCut(null)`**. A start and an end publish immediately, a burst of progress coalesces to ≤ 4/s. `snapshotPage` adds `subagents` beside `queued`.
4. Client. `SessionEntry.subagents`, `subagentsChanged`, `onSessionSubagents`, `RemoteSession.onSubagents` (mirror `onQueued`, the state at once). Add `subagents` to the two "owned elsewhere" lists (`remote-session.ts:1252-1256,1344-1350`) and to `mapping.ts:279`. Router-style bounding at the client: at most 32 rows, 8 labels, through `progressText`. `local-runtime.ts` passes `onSubagents` through.
5. Relay. `RelayEvent {type:"agents", n}`, `RelayModel.agents`; `relay.ts` subscribes `session.onSubagents`. `wantsAwake`: `(turn running || agents > 0) && asks === 0 && !stopping && handover !== "done"`: a child in a pod needs the laptop for its model.
6. TUI. Pure `tui/src/background-view.ts`: `backgroundCount(rows)` and `backgroundSuffix(count)` → ` · 2 sub-agents`. `StatusBar` gets `background` and puts it in front of `suffix`. `quitCommandStep` gains `agents`: `agents > 0 && !detaches && !confirmed` → `"confirm"`. `quitConfirmText({others, agents, names})`: `2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)`; with others, `1 other terminal attached · 2 sub-agents running — close the session for all? (y/N)`. New pure `ctrlCQuitStep(input)`: idle Ctrl+C with `agents > 0 && !detaches && !confirmed` → `"confirm"`. `App`: `quitConfirm` holds `{others, agents, names}`. SIGHUP cannot ask: the lost note covers it.

**Files (order).** `protocol/src/{updates,session}.ts`, schema · `core/src/agent-jobs.ts` · `tools/src/{task,background}.ts` · `daemon/src/{subagents-view (new),hosted-session}.ts` · `client/src/{remote-client,remote-session,mapping}.ts` · `cli/src/{local-runtime,relay,relay-state}.ts` · `tui/src/{background-view (new),commands,App,components/StatusBar}.tsx|ts` · `CHANGELOG.md` · `docs/feat/session-log.md` untouched.

**CHANGELOG (planned line, `### Added`):** "**See your background sub-agents.** The status line shows how many are running, and quitting a session that would lose them asks first."

**Failure modes.**
| Case | Converges to |
|---|---|
| A second TUI attaches mid-run | The snapshot carries the list at the cut; the replay and the next frame fix it |
| Older client, same protocol version | `display`: shows `unsupported` once, then nothing |
| A frame burst during a long foreground tool | Coalesced; the ring is pinned only since the last commit (bounded by activity) |
| Hostile pod sends a huge list | No schema bound by design; the client cuts to 32 rows and 8 labels |
| Session closes with a timer pending | Cleared in `close` |
| A row without a `tail` (malformed) | A known type failing its member is a stream error; the schema is lenient so only a type mismatch can do it, the same class as `tool_progress` |
| `connect` | Quitting only detaches: no confirm |
| Detached run's `/quit` | `endsSession`: asks with the count, then closes |

**Tests.**
| # | File · name | Property | Mutation |
|---|---|---|---|
| T42 | `daemon/subagent-progress` · "an idle child's tool events reach an idle client, and a later turn's stream carries none" (H1) | frames between turns; no `tool_progress` | stamp progress into the turn |
| T43 | · "bursts coalesce to ≤ 1 frame per 250 ms; start and end publish at once" | injected timers | no timer |
| T44 | · "the ring stays under budget while idle" | small `ringBytes`, 1000 progress events | drop the idle `recordCut` |
| T45 | · "a fresh attach gets the list from the snapshot" | | drop it from `snapshotPage` |
| T46 | `client` · "rows are bounded and sanitized" | | |
| T47 | `cli/relay-state` · "keeps awake while a child runs" | | |
| T48 | `tui/commands` · confirm for `/quit` and Ctrl+C; not on `connect`; the combined text | | drop the `detaches` check |
| T49 | `tui/background-view` + `app.test.tsx` frame · the count shows, and at 46 columns it is dropped whole | | |
| T50 | `tools` · `agent_kill` (only if Q1 is (a)) | kills, a second time says not running | |

## Notes / debt

- The live exit notice has no Ctrl+O body: `background_exit` does not carry the report. After a resume it does (task 5). Task 7 can add it.
- `liveness().busy` counts children, not shell jobs: the reaper's gap for shell jobs stays (H2 said to record it).
- `/clear` aborts children until `feat/clear-keeps-jobs`.
- The child's tool trail is not persisted (Q9): after a resume only its report or the lost note exists.
- **Task 5 review L3** (a note pushed and wiped by a `context_reset` in the same uncommitted window is never seen by `noteSeen`): handled for sub-agent reports by D5.9 (`noteSeen` at the flush that pushes the note). Shell-job notes are not touched.
- No wake budget: a model that keeps relaunching keeps waking, as with shell jobs. Task 9 owns the budget.

## Owner questions (all, at once)

Numbered for this doc. Task 5's Q3 and Q4 are assumed (a), see the header.

**Q1. Can a running background sub-agent be stopped before the panel (task 7)?** Without it, a stuck child holds a slot until the session ends (`subagents.maxIterations: -1` has no bound).
(a) `agent_task`'s sibling tool `agent_kill(id)` for the model, in 6a-2 (about 30 lines, the mirror of `shell_kill`); the user's `x` key and the `session/agent_kill` method stay with task 7.
(b) Nothing until task 7.
**Recommend (a):** the model that launched it can also stop it, and it is what makes the shared cap safe.

**Owner (2026-11-09): (a).** `agent_kill(id)` for the model, in 6a-2 (NOT in 6a-1).

**Q2. A foreground `agent_task` when background children already fill `maxParallel`.** Owner Q2 is "one cap", and L2 says foreground calls are not errored; neither says what happens when the wait is long (with `maxParallel: 1`, one background child blocks every foreground spawn until it ends).
(a) It waits, FIFO, with a `waiting for a free slot (running: sa-1)` row, and Esc cancels it. The cap is exact.
(b) It is refused like a background launch, with the running ids, so the model decides.
(c) A foreground spawn ignores background children (the cap binds background launches only).
**Recommend (a):** it is what "one cap" means, the row explains the wait, and Esc is always available. This plan is written for (a); (b) or (c) is a change of a few lines in `task.ts` and `AgentJobs.acquire`.

**Owner (2026-11-09): (b), not the recommended (a).** A foreground `agent_task` at a full cap is refused at once with an error naming the running children, so the model chooses (end its turn and be woken, run the work itself, or later stop one). No FIFO, no waiting row. See "Plan change (owner Q2 b)".

## Execution

*— claude-sonnet-5-5, 2026-11-09*

**Scope: 6a-1 only.** Part 2 (6a-2: the `subagents` update, footbar count, quit confirm, relay keep-awake, `agent_kill`) is untouched. Owner answers Q1 (a: `agent_kill` in 6a-2) and Q2 (b: refuse at the cap, no waiting) are recorded in "Owner questions" and, for Q2, in "Plan change (owner Q2 b)" at the top of Part 1 (written BEFORE any code).

**Method.** Slice by slice in the plan's Files order; each test written and run RED first (assertion failures, or a missing symbol where the slice adds one), then the code, then GREEN; then one mutation per load-bearing property through `.tentacle/tmp/subagent-background/mutate.ts` (replace once, run the file, restore, sha1 check: every line below says `sha OK`). Scratch: `.tentacle/tmp/subagent-background/` (gitignored).

### As built, in order

1. **Protocol** — `version.ts` 20 (+comment); `permission.ts` `agent.id?`, `turnId?` (no `.max()`); `updates.ts` `background_exit.agent?`; `session.ts` `jobs` doc; `bun run schema:export` (`schema/protocol.json`, +21/−1). Three older tests that pinned `=== 19` now say `>= 19` (`protocol/test/{update-settings,session-settings,published-models}`, `daemon/test/session-settings`), and `daemon/test/version-mismatch.test.ts` follows `PROTOCOL_VERSION` (20). New: `protocol/test/subagent-background.test.ts` (T41; RED on 3/3, GREEN). Mutation `turnId: .max(10)` → KILLED.
2. **Core** — new `core/src/agent-jobs.ts` (`AgentJobs`: `start`, `acquire`, `setCap`, `bind`, `list`, `onExit`, `dispose`; `AgentJobHost`, `AgentSlot`, …), exported from `index.ts`; `tool.ts` `ToolContext.shapeResult`; `jobs.ts` `BackgroundJob.agent?`; `permission.ts` `agent.id?`. Tests `core/test/agent-jobs.test.ts` (10 tests; RED = `Export named 'AgentJobs' not found`). Mutations (all KILLED, sha OK): drop the cap check in `start` (T2); drop the `disposed` return in `drive` (T8); foreground not counted in `used` (T6); `ended` after the listeners (T4); catch → wrong stopReason (T5); a non-idempotent release (T6b — first SURVIVED because the test released twice before a re-acquire; the test was reordered, then KILLED); `launched` twice (T1).
3. **Tool** — `tools/src/task.ts`: `TaskToolOptions.background`, `TaskRunControls.agentId`; the schema is `z.object({...baseSchema.shape, ...model?, ...background?})`; background branch (child on its own signal, `shapeResult` on the report, also on the throw path); foreground branch takes a slot via `acquire` or returns the refusal as `isError`, releases in `finally`. Tests `tools/test/task-background.test.ts` (6; RED on 5 by assertion/timeouts). Mutations KILLED: `ctx.signal` to the child (T10); no `finally` release (T12); foreground ignores the refusal (T12b); `background` always offered (T13); skip `shapeResult` on the throw path (T14); launch refusal without `isError` (T11).
4. **Agent** — `subagent.ts` (`SubagentRunControls.agentId`; `subagentRequester(…, background?)` forwards `agent.id` and the child's `signal`); `agent.ts` (`PendingExit`, `AgentConfig.agentJobs`, a second exit subscription removed by `retire`, `background_exit.agent`, both `ctx` builders get `shapeResult`, the agent branch in `flushBackgroundExits` using `subagentReportNote`, `runningBackground()`); `compact.ts` (`stillRunningNote`, `compactedHistory(…, running)`); `context-reset.ts` (`agents?`); `session.ts` (`compact` passes the running note). Tests `agent/test/subagent-background.test.ts` (7), `agent/test/running-note.test.ts` (4); `replace-agent.test.ts` adjusted for the `PendingExit` union. Mutations KILLED: drop signal (T15), drop `agent.id` (T15b), no agent branch (T16), no collection (T16b), no unsubscribe in `retire` (T17), no `shapeResult` in either ctx builder (T14 sequential and a separate parallel-group test T14p), reset/compaction leave out agents/running, a changed shell paragraph (T18). `bun test packages/agent`: 469 pass, 0 fail after the slice.
5. **Daemon** — `hosted-session.ts`: new last constructor arg `agentRuntime`; `bind` (`launched` → `backgroundAgent` + `spawnTurns`; `ended` → `agentEnded`), the exit subscription (emit `background_exit{agent}` + `kickWake`); `PendingAsk.record` nullable + `reoffer`; `registerAsk` extracted from `awaitDecision` (no behaviour change; 632 daemon tests stayed green); `awaitBackgroundDecision`; `reofferBackgroundAsks` at `attach` (before the replay) and at the end of `historyReplaced`; `summary().jobs` and `liveness().busy` count children; `agentEnded` stamps `lastActiveAt`; `drive` calls `noteSeen` at the flush (task 5 L3); `close` unsubscribes and disposes; `reusable()` carries it. `permission-map.ts` copies `agent.id`; `session-host.ts` (`AgentFactory`/`AgentReuse.agentJobs`, passed to `HostedSession`, `foreign` compares it and disposes a stray, `newSessionContext` disposes); `session-reaper.ts` comment only. Tests `daemon/test/subagent-background.test.ts` (14: T19–T26, T27, T28, T29, T30, T31, T32) and `subagent-background-host.test.ts` (3: T32 through `SessionHost.updateSettings`, T33 over the real `LogSessionStore`). RED before the code: 13 of 14 failed (T31 passed vacuously because nothing bound the ledger yet; it was made non-vacuous with `wake:false` and then KILLED by the mutation below). Mutations KILLED (sha OK): remove `kickWake` (T19); ignore `lastEndBad` (T20); `busy = running` (T21); `jobs` shell-only (T21b); `lastActiveAt` not moved (T21c — SURVIVED at first because the wake turn's end moves the stamp; fixed with a `wake:false` rig, then KILLED); route the ask through the turn path (T22); the controller's signal for the ask (T23 — SURVIVED at first because the ask was raised with no turn running; the test now raises it DURING a later turn, then KILLED); no re-offer in `attach` (T24); none in `historyReplaced` (T25); give the ask a record (T26); skip `blockingUnsupported` (T28); remove `dispose` from `close` (T30); drop D5.9 (T31 — SURVIVED at first, same wake reason; fixed, KILLED); `reusable()` without it (T32); no spawn turn (T22b/c); the host-level: `buildHosted` without `agentJobs`, `foreign` without the compare, a stray not disposed.
6. **Client** — `permission-router.ts` (`update.turnId ?? turnId`, `agent.id` through `progressText`); `mapping.ts` (`agent` copied); `remote-client.ts` (`BackgroundExitNotice.agent`, `agentExitListeners`/`onAgentExit`, fired from `deliver` only for an agent exit, never in `exitListeners`); `remote-session.ts` (`onAgentExit`, `mintedTurns` bounded at 256 in `ownsTurn`, minted in `send` and in `install` for a non-foreign turn). Tests: `client/test/agent-exit.test.ts` (3: T35, T36 ×2), `permission-router.test.ts` (T34). Mutations KILLED: ignore `update.turnId` (T34); `ownsTurn` current-only (T35); unbounded (T35b); subscribe through `onBackgroundExit` (T36); fire for shell exits (T36b); not filtered by session (T36c — first SURVIVED, the test finished the wrong session's child; fixed, KILLED). `bun test packages/client`: 476 pass.
7. **CLI** — `wiring.ts` (`BuildAgentOptions.agentJobs`, `new AgentJobs(cap)` + `setCap`, `createTaskTool(…, {background})`, `new Agent({agentJobs})`, `WiredAgent.agentJobs`); `worker.ts` forwards it; `serve.ts` forwards `reuse.agentJobs`; `local-runtime.ts` (`remoteJobsView` forwards `agent`; `inner.onAgentExit?.(() => flush())`, unsubscribed at `close`). Tests `wiring.test.ts` (T38 ×2), `local-runtime.test.ts` (T37). Mutations KILLED: no `onAgentExit` subscription (T37); skip `setCap`, always a fresh `AgentJobs`, no `background` on the tool (T38).
8. **TUI** — `state.ts` (`backgroundExitNotice(…, agent?)`, used on the event path), `App.tsx` (the live path passes `job.agent`), `permission-ui.ts` (`PermissionAgent.id`, the `sa-N · type · "desc" · background` row). Tests `state.test.ts` and `permission-agent-line.test.tsx` (T40). Mutations KILLED ×3.
9. **Docs** — `CHANGELOG.md` `[Unreleased]` / Added (plain language, 6a-1 only); this doc (plan change note, owner answers, Notes/debt bullet for task 5 L3).

### Drift from the plan (each with the reason)

- **Q2 (b)** replaces D1's `acquire(signal, onWait)`/waiters/`pump` and D2's waiting row (owner decision; written first, see the note). Consequence: T6/T7/T9/T12 were rewritten as the note says; **T7 does not exist**.
- **`acquire(description)` returns `AgentSlot`** (`{ok:true, release} | {ok:false, reason}`), foreground slots are kept by token so the refusal can name them (`(foreground) …`). The reason text for `start` with no host still says "run it in the foreground" (true there: the foreground is not full); the cap refusal never does.
- **`contextResetHistory`'s `agents` is optional** (the plan says "takes agents"): existing vectors and call sites stay byte-identical. **Compaction now also names running shell jobs** (it named none before — plan P18, consequence of sharing `stillRunningNote`); with nothing running the text is unchanged (pinned).
- **T29 is folded into the daemon tests**: the ask reaches the requester `HostedSession` installed on the shared broker, and a second spy broker is never called (a daemon-level test). The wiring-level half ("`buildAgent` forwards `agent.id`/`signal` through the real broker") is **not** tested end to end: a scripted model shared by the parent and a concurrent background child makes the call order nondeterministic. It is covered in two halves: T15 (runner → requester options) and T22 (daemon).
- **T39 (relay-state) was not added**: the relay reads a number (`summary().jobs`), which T21 pins; no relay code changed.
- **T25** imports `reduceStream` from the client's `src` by relative path in a daemon test (the probe's pattern), to prove the client keeps the request through the barrier.
- **Re-offer at attach also reaches already-attached clients** (it goes through `emit`, as the plan requires for `seq` contiguity), and with nobody attached the replay holds the original frame AND the re-offer (same `requestId`): the router dedupes (P12). T27 asserts one id, ≥1 frames.
- **Existing tests touched** only for the version bump (`>= 19` or 20) and the `PendingExit` union in `replace-agent.test.ts`.
- The probe (`probe.ts`) was **not re-run before the edits** (the AGENTS "reproduce first" step): the capability gap is shown instead by the tests being RED on the unimplemented code (e.g. `background` absent from the schema, `Export named 'AgentJobs' not found`).

### Not done / not verified (explicit)

- **No live check with a real model**, a real pod, or the real TUI (plan: "not verified"). Nothing was run against a provider.
- **Part 2 (6a-2)** and `agent_kill`: not started, by design.
- **`feat/clear-keeps-jobs`** (D10): not built; `/clear` still aborts children silently (recorded in Notes).
- **End-to-end `buildAgent` → `agent_task{background}` → daemon ask** is not one test (see T29 above).
- T39 not added (above). The relay's behaviour with a child (P9) is argued from `jobs` being a count, not run.

### Gate

Run from the worktree root after the last code change (`biome check --write .` had only reformatted my own new/changed files; `git status` shows no unrelated file touched):

- `bunx tsc --noEmit` → no output (clean). `bunx tsc -p apps/mobile` → no output (clean).
- `bunx biome check .` → `Checked 781 files … No fixes applied.` (0 errors, 0 warnings; baseline clean kept).
- `bun test packages` → **6007 pass, 3 skip (the opt-in live-k8s / live-docker / slow keepalive tests), 0 fail**, 6010 tests in 409 files, 180 s.
- `bun run schema:export` re-run: `packages/protocol/schema/protocol.json` matches the zod schemas (the protocol drift gate is inside `bun test packages`).

Not run as one command: `bun run check` itself (I ran its three parts separately, above).

## Review

*— <model-id>, <YYYY-MM-DD>*

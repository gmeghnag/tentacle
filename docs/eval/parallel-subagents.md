# eval/parallel-subagents — should subagents run in parallel and/or in the background?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `feat` · Size: L (→ must be split) · Blast: load-bearing (the agent loop + the TUI progress stream) · Suited: strong model + mandatory fresh-context Review per §10 (it touches a §7-class seam).

## Context

*— claude-opus-4-8, 2026-10-17*

**The question being decided:** should tentacle support (a) **parallel** subagent
execution — more than one `task` running at once — and/or (b) **background**
subagents — a detached "fire-and-forget" `task` the parent doesn't block on? And
if so, by which mechanism, given the current loop is sequential by design?

**Evidence (verified) — today neither exists:**
- The `task` tool is **synchronous and blocking**: `packages/tools/src/task.ts:57`
  does `await run(...)` and returns only when the child finishes; the child's
  progress is interleaved into the parent's stream
  (`packages/agent/src/agent.ts:293`–296).
- Tool calls within a turn run **strictly sequentially**:
  `packages/agent/src/agent.ts:283` — `for (const call of toolCalls) { … await
  resultPromise }`. So even two `task` calls emitted in one assistant turn run
  one-after-another, never concurrently.
- **Background subagents do not exist.** The repo's `BackgroundJobs`
  (`packages/exec/src/background.ts:77`) backs long-running **shell commands**,
  not subagents — a different subsystem. There is no detached/`run_in_background`
  path for `task` (grep: none).

**Tracked as** `TODO.md:655` — "Sub-agents: background / parallel execution
(SA.d)", deferred as a single item.

**Why this is a real design question, not a quick fix.** Two distinct shapes,
each with a different blast radius:

1. **Parallel-in-turn** (run concurrent `task` calls of one turn at once): would
   make the agent loop's tool execution concurrent — a change to a load-bearing
   seam. Consequences to design out: the TUI today multiplexes *one* child's
   progress (`agent.ts:293`); N children need interleaved/labelled progress
   streams; tool *results* must still be appended to history in a deterministic
   order (the model expects a result per `toolCallId`); cancellation must fan out
   to all children. Note §7 "don't serialize the RPC peer" is about the RPC
   layer, which is *already* concurrent — this is the agent loop above it, which
   is sequential on purpose (deterministic history).
2. **Background/detached** (a `task` variant that returns immediately with a
   handle; the parent polls/joins later, à la Claude Code's `run_in_background`):
   lighter touch on the core loop (the child runs off to the side), but needs a
   handle registry, a `join`/`poll` tool, lifecycle on turn/session end, and a
   persistence story (a detached child's transcript).

## Implementation

*(empty — an eval is not built until promoted to a `feat`.)*

## Execution

*(empty.)*

## Review

*— claude-opus-4-8, 2026-10-17 (recommendation; owner decides)*

**Recommendation: keep as an open eval; if we build, do background first, split
into slices — do NOT make the core loop concurrent as a first step.**

- **Leaning: (2) background/detached before (1) parallel-in-turn.** It delivers
  most of the practical win (offload a long investigation, keep working) at a
  much smaller blast radius, and it is the shape a model already understands
  (`run_in_background` + a read-back tool). Making the agent loop concurrent (1)
  risks the deterministic-history and progress-multiplexing invariants for a
  benefit (wall-clock speedup of fan-out) we have no evidence we need yet.
- **Must be split.** This is `L` → per §10 it cannot ship as one task. Candidate
  slices: a detached-task handle + registry; a `task_status`/`task_result` tool;
  TUI rendering of background subagents; cancellation + session-end lifecycle;
  (only if still wanted) concurrent in-turn execution as a separate, later task.
- **Needs a motivating use-case before promotion.** No current workflow is
  evidenced as blocked by sequential subagents. Promote only when a concrete need
  appears (e.g. "fan out N independent explores and merge"), so we build the
  shape that need actually requires.

**Promotion trigger:** when the owner approves a *specific* first slice, `git mv`
this doc to `docs/feat/<slug>.md` and open that branch. Until then it stays an
open eval — exactly the kind of "may never be built" record `eval` exists for.

**What would change the recommendation:** a measured latency pain from serial
fan-out (→ prioritise parallel-in-turn), or a daily "leave it running" need
(→ prioritise background).

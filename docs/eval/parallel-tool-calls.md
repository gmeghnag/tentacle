# eval/parallel-tool-calls — should the tool calls of one round run in parallel?

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/parallel-tool-calls`.
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the agent loop's tool-execution path) · **Suited:** strong model executes; mandatory fresh-context Review.
> **Related:** [`parallel-subagents.md`](./parallel-subagents.md) — that eval covers *subagent* fan-out/background and lists "concurrent in-turn execution" as a later slice; this eval is that slice, generalised to every tool.

## Context

*— claude-opus-5-5, 2026-10-18*

**The question being decided:** when the model emits several tool calls in one
assistant round, should tentacle execute them concurrently instead of one after
the other? If so, under which rule: parallel by default with a per-tool opt-out
(pi), or only read-only tools in parallel with writes serialised (Claude Code)?

### Current behaviour (verified)

- The loop collects every tool call of the round (`packages/agent/src/agent.ts:212-224`),
  then runs them **strictly sequentially** (`agent.ts:283-300`). For each call it
  emits `tool_start`, drains the call's live progress, awaits `runTool`, applies
  `transformResult`, then appends the `tool` message before starting the next call.
- `runTool` (`agent.ts:415-432`) awaits `gate.authorize` *per call*, so permission
  prompts are naturally one at a time today.
- `Tool` (`packages/core/src/tool.ts:55-68`) has no read-only / concurrency
  marker. It only has `permission: "none" | "ask" | "deny"` (`tool.ts:13`).
  Whether `"none"` coincides with "no side effects" is **not verified**.
- No provider sets or reads `parallel_tool_calls`. The model is free to batch,
  and we just queue its calls.

### Prior art (2026-10-18)

| Harness | Behaviour | Source |
|---|---|---|
| **pi** (pi-mono) | Parallel **by default**, `Promise.all`. The whole batch goes sequential if `config.toolExecution === "sequential"` or any tool in it has `executionMode: "sequential"`. Results are emitted in call order. With `stopReason: "length"` the calls are **not run** and get error results instead (their args may be truncated). | `packages/agent/src/agent-loop.ts` (`executeToolCalls`), read from source |
| **Claude Code** | Tools marked concurrency-safe (Read/Glob/Grep/WebFetch/WebSearch; `Bash` classified per command) run in parallel. Edit/Write are serialised against everything. Tools start as soon as their `tool_use` block completes in the stream. Reported max concurrency is 10 (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`). | Third-party reverse-engineering write-ups, not official docs. Unverified detail. |
| **opencode** | Regular tools run in parallel (`Promise.all` in the processor). Task/subagent calls run sequentially (open issue anomalyco/opencode#14195). | GitHub issue |

We are the only one of the four that is fully sequential.

### What a change has to design out

- **Side-effect ordering:** two `fs_edit` calls on the same file, or `shell` +
  `fs_read` of its output, change meaning when reordered. This needs a
  concurrency rule (per-tool flag or a read-only class) and a story for `shell`
  and MCP tools (`readOnlyHint`?).
- **Permission prompts:** concurrent `gate.authorize` calls must still reach the
  user one at a time, through the single broker (§7). A denial must not leave
  siblings in an undefined state.
- **Deterministic history:** `tool` messages must be appended in call order
  (one per `toolCallId`), whatever the completion order.
- **Progress multiplexing:** today one call's progress is drained at a time
  (`agent.ts:287-296`). N concurrent calls need interleaved, `call.id`-labelled
  events, and the TUI must render several running tools.
- **Cancel:** Esc must abort every in-flight call of the batch. This overlaps
  the open 🔴 `proxy-model-cancel` tool-execution half.
- **Truncated round:** adopt pi's rule independently of parallelism. A round
  that ended on `length` should not execute its calls. This overlaps the open
  🟡 "Truncated tool-call persisted" (`docs/eval/sse-abort-truncated-toolcall.md`).

**Repro:** none needed. The sequential loop is evident at `agent.ts:283`. A
wall-clock measurement (N independent `fs_read`/`shell sleep 1` calls in one
round) should be taken before promotion to size the benefit.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-18 (author; a different model must review before promotion)*

**Verdict: OPEN.** Leaning towards the **pi shape** (parallel by default, an
opt-out `executionMode: "sequential"` on `Tool`, results appended in call
order), with the side-effecting built-ins (`fs_write`, `fs_edit`, `shell`)
marked sequential from day one. That gives the Claude Code safety profile with
pi's simpler mechanism.

Before promotion:
1. Measure the wall-clock benefit on a real multi-read round.
2. Decide the MCP default (sequential unless `readOnlyHint`?).
3. Sequence it after the 🔴 proxy-cancel fix, since both touch the
   tool-execution path.

The `stopReason: "length"` guard is worth splitting out as its own small fix,
whatever this eval decides.

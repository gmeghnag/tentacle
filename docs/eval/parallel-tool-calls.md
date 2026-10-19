# eval/parallel-tool-calls — should the tool calls of one round run in parallel?

> **Status:** eval — verdict **DEFER** (2026-10-19). The design below is ready, but the measured gain on today's workload is about nil. Promote it (`git mv` into `docs/feat/`, branch `feat/parallel-tool-calls`) when one of the **promotion triggers** in Review holds.
> **Branch:** none. An `eval` is committed directly to `main` (AGENTS §10).
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (the agent loop's tool-execution path) · **Suited:** strong model executes; mandatory fresh-context Review.
> **Related:** [`parallel-subagents.md`](./parallel-subagents.md) covers sub-agent fan-out and background runs. This eval is the general "concurrent in-round execution" seam that it would ride on.

## Context

*— claude-opus-5-5, 2026-10-19 (supersedes the 2026-10-18 draft)*

**The question being decided:** when the model emits several tool calls in one
assistant round, should tentacle execute them concurrently? If so, under which
rule? And is it worth building **now**?

### Current behaviour (verified 2026-10-19)

- The loop runs a round's calls **strictly sequentially**
  (`packages/agent/src/agent.ts:304`). For each call it emits `tool_start`
  (`:324`), drains that call's progress, awaits `runTool` (`:333`), applies
  `transformResult`, and then appends the `tool` message before the next call
  starts.
- `runTool` (`agent.ts:486`) awaits `gate.authorize` per call, so permission
  prompts are naturally one at a time.
- `ToolRegistry.execute` never throws. Bad JSON, schema failures and handler
  exceptions all come back as an `isError` result (`packages/tools/src/registry.ts:77-81`).
- `Tool` (`packages/core/src/tool.ts`) has no read-only or concurrency marker,
  only `permission: "none" | "ask" | "deny"`. `"none"` does **not** mean
  side-effect free: `shell_kill` is `"none"` (`packages/tools/src/background.ts:56`).
- MCP tools default to `permission: "ask"` (`packages/mcp/src/tool-adapter.ts:51`).
  The MCP `tools/list` type does **not** parse `annotations` (`packages/mcp/src/types.ts:23-25`),
  so `readOnlyHint` is not available today.
- The TUI matches `tool_result` to its item **by id** (`packages/tui/src/state.ts:218-219`),
  so results arriving out of order already render correctly.
- The Anthropic provider already refuses to surface a tool call cut off by
  `max_tokens` (`packages/providers/src/anthropic-provider.ts:213-222`). The
  OpenAI-compatible side is tracked in `sse-abort-truncated-toolcall.md`, not here.
- Dependency from the 10-18 draft is resolved: the 🔴 `proxy-model-cancel` fix
  (abort re-checks at every tool boundary) is merged.

### Prior art

| Harness | Behaviour |
|---|---|
| **pi** | Parallel by default (`Promise.all`). The **whole round** goes sequential if any tool in it is `executionMode: "sequential"`. Results are emitted in call order. |
| **Claude Code** | Concurrency-safe tools (Read/Glob/Grep/…; `Bash` classified per command) run in parallel. Edit/Write are serialised. Max concurrency is reportedly 10. (Third-party write-ups; details unverified.) |
| **opencode** | Regular tools in parallel; task/subagent calls sequential. |

### Evidence: what the workload actually batches

**Repro** (2026-10-19, `.tentacle/tmp/parallel-tool-calls/batches.ts` + `shells.ts`).
It mines the 53 persisted sessions in `~/.config/tentacle/sessions/`. All of
them are `Qwen3.8-27B-UD-Q6_K_XL`. `SHARED` is the proposed `shared` set
(`fs_read`, `shell_output`).

```ts
// batches.ts (core): per assistant round with ≥2 tool calls, count rounds that
// would gain concurrency under pi's rule (every call shared) and under the
// consecutive-batch rule (≥2 adjacent shared calls), plus the sequential
// slots saved (calls − batches).
let batches = 0; let prevShared = false;
for (const n of calls) { const sh = SHARED.has(n); if (!(sh && prevShared)) batches++; prevShared = sh; }
if (batches < calls.length) st.batchParallel++;
st.batchSavedSlots += calls.length - batches;
```

```
== Qwen3.8-27B-UD-Q6_K_XL
rounds with tools 1666 (calls 1946); multi-call rounds 235 (515 calls)
multi rounds gaining concurrency — pi rule: 51; consecutive-batch rule: 63 (sequential slots saved 83); rounds with >=2 agent_task: 0
tools in multi rounds: shell=208 fs_read=202 fs_edit=73 mcp__veil__fetch=13 fs_write=9 fs_multi_edit=6 agent_task=1 shell_output=1 mcp__playwright__browser_navigate=1 mcp__veil__backends=1
top shapes: 64× [shell,shell]  39× [fs_read,fs_read]  36× [fs_read,shell]  25× [fs_edit,fs_edit]  20× [shell,fs_read]  11× [fs_read,fs_read,shell]

shell calls in multi rounds: 208
grep=45 echo=38 ls=27 sed=18 git status=11 bun=8 cd=7 git log=6 rg=4 cat=3 python3=3 env=3 pwd;=2 ssh=2 git checkout=2 ps=2 git branch=2 git -C=2 head=2 export=2
```

What it says:

- **14% of tool rounds batch at all** (235/1666). With the proposed classification,
  **3.8% of rounds** gain any concurrency and **4.3% of calls** (83/1946) leave
  the sequential path.
- The calls that would go parallel are `fs_read`, which takes milliseconds.
  The wall-clock gain is in the noise.
- The biggest bucket, `[shell,shell]` (64×), stays sequential under any safe
  rule. Most of those commands are fast and read-ish anyway (`grep`, `ls`,
  `sed -n`, `git status`), so classifying shell would not buy much either.
- The calls where concurrency **would** pay off (slow, I/O-bound) are almost
  absent: `agent_task` was batched once and never twice in one round, and
  network MCP calls (`mcp__veil__fetch`) appear 13 times.
- Caveat: this is one model. A frontier model (Claude, GPT) batches much more
  aggressively, especially reads and sub-agents, so the numbers would move.
  Sessions store no per-call durations, so the gain is inferred from the call
  type, not timed.

## Implementation

*— claude-opus-5-5, 2026-10-19 (**proposed**, not approved. Kept so promotion starts from a verified plan. The executor re-verifies the `file:line` citations at promotion time, because the loop moves.)*

### Load-bearing assumption

**Permission prompts can be fully serialised before execution starts without
changing what the user sees.** Today each call already does `tool_start` →
`authorize` → run (`agent.ts:324,333,486`). Splitting that into "authorize
every call of the batch in order, then run the authorized ones together" keeps
one prompt at a time through the single broker (§7). Execution never overlaps
a pending prompt. If this did not hold, we would need concurrent prompts, which
the broker and TUI do not support.

### Preconditions

- `ToolRegistry.execute` never rejects (`registry.ts:77-81`), so a sibling's
  failure cannot orphan the others mid-batch.
- `transformResult` spill paths include `call.id` (`agent.ts:459`+), so
  concurrent spills cannot collide.
- The TUI reducer matches results by id (`state.ts:218`), so the protocol does
  not change: no new update variant and no `PROTOCOL_VERSION` bump.
- `EventQueue` is single-consumer, multi-producer: `push` from any number of
  callbacks, `drain` from the loop (`packages/agent/src/event-queue.ts`).
- Abort is re-checked before each tool and after approval (proxy-cancel fix,
  `runTool` re-check at `agent.ts:486`+).

### Design

**Rule: consecutive batches, not all-or-nothing.** Tools opt in with
`concurrency: "shared"`. The default is `"exclusive"`. A round is partitioned
into maximal runs of adjacent `shared` calls, and every `exclusive` call is a
batch of one and acts as a barrier. Example: `[read, read, edit, read]` →
`[[read, read], [edit], [read]]`.

This beats pi's rule on the data above: 63 rounds gain concurrency versus 51,
and any round with one write keeps its reads parallel. It also preserves the
order the model intended (read before edit, edit before re-read).

Initial classification:

| `shared` | `exclusive` |
|---|---|
| `fs_read`, `shell_output`; MCP tools with `annotations.readOnlyHint === true` | `fs_write`, `fs_edit`, `fs_multi_edit`, `shell`, `shell_kill`, `agent_task` (until `parallel-subagents` decides), every other MCP tool |

Read-only `shell` classification is **out of scope**. It is security-adjacent,
and the data shows little gain.

**Partition is a pure module** (§7):

```ts
// packages/agent/src/tool-batches.ts
export function planBatches<T>(
  calls: readonly T[],
  modeOf: (call: T) => "shared" | "exclusive",
): T[][];
```

**Execution of one batch, two phases** (replaces the body of the loop at `agent.ts:304`):

1. **Authorize, in order, one at a time.** For each call: if aborted, record
   the cancelled result. Otherwise `yield tool_start`, then
   `await this.authorizeCall(call)`. A denial or a cancel becomes a precomputed
   `ToolResult` for that call. Split `runTool` into `authorizeCall` (parse,
   gate, post-approval abort re-check) and plain `tools.execute`.
2. **Run concurrently, surface as they complete.** All authorized calls start
   together, limited by a small semaphore (`MAX_TOOL_CONCURRENCY = 8`). They
   share one `EventQueue<AgentEvent>`: each call's `emitProgress` pushes into
   it, labelled by `call.id`, and each call pushes its own `tool_result` after
   `transformResult`. The queue closes on `Promise.allSettled(runs)`. The loop
   drains it, then appends the `tool` messages **in call order**.

A batch of one behaves exactly like the current loop. That is what makes the
first slice a pure refactor (see Tests).

### Files

1. `packages/core/src/tool.ts`: optional `concurrency?: "shared" | "exclusive"` on `Tool`.
2. `packages/mcp/src/types.ts`: parse `annotations?: { readOnlyHint?: boolean }`. `packages/mcp/src/tool-adapter.ts`: map `readOnlyHint === true` → `"shared"`.
3. `packages/tools/src/builtins.ts`, `background.ts`: mark `fs_read` and `shell_output` `shared`.
4. `packages/agent/src/tool-batches.ts` (new) + export.
5. `packages/agent/src/agent.ts`: split `runTool`; batch executor replaces the `for (const call of toolCalls)` body.

No change to protocol, daemon, client, cli or tui.

### Failure modes

| Case | How state converges |
|---|---|
| Esc during phase 1 (prompts) | The current prompt is denied (TUI denies on Esc). Remaining calls get `CANCELLED_TOOL_NOTE` without prompting. Nothing runs. Every `toolCallId` is answered. |
| Esc during phase 2 | All in-flight calls share `ctx.signal` and stop. `allSettled` waits for all of them, and every call gets a `tool` message, so history stays valid. The next iteration ends the turn `cancelled`. |
| Denial of one call in a batch | That call gets "Permission denied". Its siblings still run. Same as today, per call. |
| Late approval after cancel | Unchanged: the `authorizeCall` re-check returns cancelled. |
| A tool rejects anyway (e.g. inside `transformResult`) | Wrap each run so a rejection becomes an `isError` result. Never let `Promise.all` reject with siblings still running. |
| Two `shared` calls touch the same path | Only read-only tools are `shared`, so reads commute. A tool that is not read-only must not be `shared`; this is pinned by a test on the built-ins' flags. |
| An MCP server lies with `readOnlyHint` | The hint is server-supplied and untrusted. Worst case is a reordering between two calls of that server; the permission prompt still gates each call (`"ask"`). Accepted. A pod-side MCP server does not touch the laptop. |
| Progress from N calls interleaves | Events are already keyed by `call.id`, and the TUI renders several running tools (`state.ts` items are per id). |
| Steering / `turn_end` no-await invariant | Untouched: it lives in the no-tool-calls branch (`agent.ts:~270-300`). |

### Tests

`packages/agent/test/agent.test.ts` with fake tools whose `execute` awaits a
hand-resolved deferred, so tests depend on resolution order and not on timers.
`SpyBroker` covers prompts.

1. **Slice 1, pure refactor:** everything `exclusive`. The existing suite must stay green **unchanged**.
2. `planBatches` unit tests: empty, all shared, all exclusive, `[s,s,e,s]` → `[[s,s],[e],[s]]`, leading or trailing exclusive.
3. **Concurrency (red on current `main`):** two `shared` calls; B starts before A resolves.
4. **Ordering:** A and B resolve in reverse; the `tool` messages are still `[A, B]`; the `tool_result` events come in completion order.
5. **Barrier:** `[read, edit, read]`: `edit` starts only after the first read settles, and the second read only after `edit`.
6. **Serial prompts:** two `ask` calls in one batch; the broker sees request 2 only after request 1 resolves; nothing executes while a prompt is pending.
7. **Cancel in phase 1 and in phase 2:** every `toolCallId` has exactly one `tool` message, and nothing starts after the abort.
8. **Non-vacuity (§9):** forcing `modeOf` to always return `"exclusive"` must turn test 3 red.

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-19 (author verdict; a different model should challenge it before promotion)*

**Verdict: DEFER.** The design is sound and cheap (M, no protocol change), but
**the measured benefit on today's workload is about zero**. Only 4.3% of calls
would leave the sequential path, and they are millisecond `fs_read`s. Building
a load-bearing change to the agent loop for that is a poor trade. The 10-18
draft's lean towards pi's all-or-nothing rule is **dropped**: consecutive
batches gain strictly more and lose no safety.

**Promotion triggers** (any one is enough):

1. **Parallel sub-agents** are approved (`parallel-subagents.md`). That is the
   only workload where per-call latency is seconds to minutes, and it needs
   exactly this seam.
2. **A frontier model becomes a regular driver.** Re-run `batches.ts` on its
   sessions: if more than ~15% of calls would go parallel, or slow tools
   (network MCP, `agent_task`) show up in batches, promote.
3. **Network MCP becomes common** (e.g. `mcp__veil__fetch`-style servers in
   most sessions). Then the readOnlyHint path alone pays for it.

**What does not change with this verdict:** the truncated-call guard stays a
separate fix (`sse-abort-truncated-toolcall.md`). It does not depend on
parallelism.

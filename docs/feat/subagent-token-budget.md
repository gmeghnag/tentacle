# feat/subagent-token-budget — a per-child token budget that forces the final report

> **Status:** context · **implementation** (drafted — NOT approved) · execution · review · done
> **Branch:** `feat/subagent-token-budget`
> **Type:** feat · **Size:** M · **Blast:** cross-module · **Suited:** DeepSeek exec
> **Review note:** the design touches the agent loop (`packages/agent/src/agent.ts`,
> `runMessages`). By §7's own definition that is *load-bearing*, whatever the
> metadata line says, so Review should be **fresh-context** and red-team the
> loop exit (§10: `contained` S–M is the only cheaper lane).

## Context

*— claude-fable-5-1, 2026-11-13*

A sub-agent's spend is bounded by **steps only**, and steps bound cost badly.

Cost grows ~quadratically with steps: every round resends the whole child
history, and a child has **no auto-compaction** (`compact` is a parent/turn
facility) and **no `context_reset`** — the reset tool is deliberately withheld
from every child (`packages/agent/src/subagent.ts:374-384`, the exclusion list).
So the only knob is `subagents.maxIterations` (default 50,
`packages/config/src/defaults.ts:18`; `-1` = unlimited). The TODO entry records
the observed failure on a review in another repo: two `explore` children ran
**183 and 97 steps for 18M / 6.3M tokens** with `subagents.maxIterations: -1`
(`TODO.md:486`). A step cap therefore either bites honest work at 50 steps or
lets a runaway spend tens of millions.

What exists already, and is reused:

- the child's token count is **already observed** per round, and already
  published: `subagent.ts:499-505` turns each model `usage` into a
  `subagent_usage` progress event, and `packages/core/src/agent-jobs.ts:194-195`
  folds it into the child's live row (`live.tokens`);
- the "forced final report" machinery exists: when a turn's **step** budget is
  spent, `Agent.runMessages` leaves the round loop and runs ONE tool-free model
  call that must answer in prose (`packages/agent/src/agent.ts:1458-1534`), then
  yields `turn_end{max_iterations}` (`agent.ts:1536-1537`).

The gap is that nothing consults tokens: the loop's only exit condition is
`iteration - budgetFrom < maxIterations` (`agent.ts:1158`).

**Repro** (run 2026-11-13, from the repo root; `.tentacle/tmp/` is gitignored, so
both scripts are pasted in full — AGENTS §6). A scripted child reports
1,000,000 prompt + 1,000,000 completion tokens on **every** round and calls a
no-op tool forever. `maxIterations: -1` (the owner's config in the report):

```ts
// .tentacle/tmp/subagent-token-budget/repro.ts
/**
 * feat/subagent-token-budget — evidence that a child's spend is bounded only by
 * STEPS, never by tokens: a scripted child that reports a huge `usage` on every
 * round still runs forever (here bounded only by an external abort).
 *
 * Run from the repo root:  bun .tentacle/tmp/subagent-token-budget/repro.ts
 */
// React/Ink live only in a package's own node_modules here, so workspace deps
// are imported by RELATIVE path (AGENTS §6, the repro pattern).
import type {
  ChatRequest,
  StreamEvent,
} from "../../../packages/agent/node_modules/@tentacle/core/src/index.ts";
import { ToolRegistry } from "../../../packages/agent/node_modules/@tentacle/tools/src/index.ts";
import { z } from "../../../packages/agent/node_modules/zod/lib/index.mjs";
import { createSubagentRunner, type AgentType } from "../../../packages/agent/src/index.ts";

/** 1M prompt tokens + 1M completion tokens per round — absurd on purpose. */
const HUGE_USAGE = { promptTokens: 1_000_000, completionTokens: 1_000_000 };

const noteTool = {
  name: "note",
  description: "no-op",
  inputSchema: z.object({}),
  permission: "none",
  execute: async () => ({ content: "ok" }),
};

/** A child that calls `note` forever, with a huge usage on every single round. */
const model = {
  id: "huge",
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    // Yield to the macrotask queue once per round, so the abort timer can fire:
    // an async loop of resolved promises alone starves `setTimeout`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield {
      type: "tool_call",
      toolCall: { id: `c${Math.random()}`, name: "note", arguments: "{}" },
    };
    yield { type: "done", usage: HUGE_USAGE };
  },
};

const type: AgentType = { name: "worker", description: "w", prompt: "work", tools: ["note"] };

const env = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const { run } = createSubagentRunner({
  model,
  env,
  tools: new ToolRegistry().register(noteTool as never),
  types: [type],
  // The owner's config in the report: no step cap at all.
  maxIterations: -1,
  // NOT a knob today (it does not exist): maxTokens.
});

let rounds = 0;
let total = 0;
const controls = {
  onEvent: (event: { kind: string; promptTokens?: number; completionTokens?: number }) => {
    if (event.kind === "subagent_usage") {
      rounds += 1;
      total += (event.promptTokens ?? 0) + (event.completionTokens ?? 0);
    }
  },
  /** Stops the otherwise-unbounded child so the repro terminates. */
  signal: AbortSignal.timeout(1_500),
};

const result = await run(
  { type: "worker", description: "d", prompt: "go", toolCallId: "t1" },
  controls as never,
);

console.log(`rounds that reported usage : ${rounds}`);
console.log(`cumulative child tokens    : ${total}`);
console.log(`stopReason                 : ${result.stopReason}`);
console.log(`toolUses                   : ${result.toolUses}`);
console.log(
  rounds > 0 && total > 50_000
    ? "NO TOKEN CAP: the child spent far past 50k tokens; only the external abort stopped it."
    : "unexpected",
);
```

```
$ bun .tentacle/tmp/subagent-token-budget/repro.ts
rounds that reported usage : 949
cumulative child tokens    : 1898000000
stopReason                 : cancelled
toolUses                   : 948
NO TOKEN CAP: the child spent far past 50k tokens; only the external abort stopped it.
```

The round count varies run to run (949 here, 1208 in an earlier run) because the
abort timer races the loop; the invariant is the point: **tokens never stop it**.
1.9 **billion** tokens, and the only thing that stopped it was the test's abort.
No configuration can express "stop this child past N tokens".

## Implementation

*— claude-fable-5-1, 2026-11-13*

### Load-bearing assumption

**The forced-final-report block is reachable from ANY loop exit reason, so a
token cap needs no new report machinery — only a new reason.** If it were
hard-wired to the step cap, this task would need a second report path (and the
whole "reuse the seam" shape would be wrong).

Cited: `packages/agent/src/agent.ts:1458-1534` is a plain post-loop block — it
reads nothing but `messages`, `signal` and the budget-agnostic nudge text
(`agent.ts:1478-1481`); it is entered by **falling out of the `for`** at
`agent.ts:1158`, and the only budget-shaped fact it publishes is the reason at
`agent.ts:1536-1537`.

PROVED empirically (not by reading): `.tentacle/tmp/subagent-token-budget/repro-forced-report.ts`
exits the loop through the *step* budget (`maxIterations: 1`) with a child that
would otherwise keep calling tools, and shows a second, tool-free request whose
last message is the nudge, whose text becomes the report:

```ts
// .tentacle/tmp/subagent-token-budget/repro-forced-report.ts
/**
 * feat/subagent-token-budget, part 2 — the forced-final-report seam.
 *
 * Proves the seam a token cap can reuse: when the child's loop is exited by a
 * BUDGET (`maxIterations: 1` here), the post-loop block still asks the model for
 * a prose report with no tools offered, and the child returns that report plus
 * `stopReason: "max_iterations"`. So a second, token-based exit needs no new
 * report machinery — only a new reason mapped through the same block.
 */
import type {
  ChatRequest,
  StreamEvent,
} from "../../../packages/agent/node_modules/@tentacle/core/src/index.ts";
import { ToolRegistry } from "../../../packages/agent/node_modules/@tentacle/tools/src/index.ts";
import { z } from "../../../packages/agent/node_modules/zod/lib/index.mjs";
import { createSubagentRunner, type AgentType } from "../../../packages/agent/src/index.ts";

const noteTool = {
  name: "note",
  description: "no-op",
  inputSchema: z.object({}),
  permission: "none",
  execute: async () => ({ content: "ok" }),
};

/** First round: a tool call. Every later round: prose (the forced report). */
let round = 0;
const requests: ChatRequest[] = [];
const model = {
  id: "scripted",
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    requests.push(request);
    round += 1;
    if (round === 1) {
      yield { type: "tool_call", toolCall: { id: "c1", name: "note", arguments: "{}" } };
      yield { type: "done", usage: { promptTokens: 900, completionTokens: 100 } };
      return;
    }
    yield { type: "text", delta: "FINAL REPORT" };
    yield { type: "done", usage: { promptTokens: 1200, completionTokens: 5 } };
  },
};

const type: AgentType = { name: "worker", description: "w", prompt: "work", tools: ["note"] };
const env = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const { run } = createSubagentRunner({
  model,
  env,
  tools: new ToolRegistry().register(noteTool as never),
  types: [type],
  maxIterations: 1,
});

let tokens = 0;
const result = await run({ type: "worker", description: "d", prompt: "go", toolCallId: "t1" }, {
  onEvent: (event: { kind: string; promptTokens?: number; completionTokens?: number }) => {
    if (event.kind === "subagent_usage") {
      tokens += (event.promptTokens ?? 0) + (event.completionTokens ?? 0);
    }
  },
} as never);

console.log(`model requests       : ${requests.length}`);
console.log(`last request tools   : ${JSON.stringify((requests.at(-1)?.tools ?? []).length)}`);
console.log(`last request nudge   : ${JSON.stringify(
  (requests.at(-1)?.messages ?? []).at(-1)?.content.slice(0, 40),
)}`);
console.log(`report               : ${JSON.stringify(result.report)}`);
console.log(`stopReason           : ${result.stopReason}`);
console.log(`cumulative tokens    : ${tokens}`);
console.log(
  result.report.includes("FINAL REPORT") && result.stopReason === "max_iterations"
    ? "SEAM OK: a budget exit forces a tool-free final report and returns it."
    : "unexpected",
);
```

```
$ bun .tentacle/tmp/subagent-token-budget/repro-forced-report.ts
model requests       : 2
last request tools   : 0
last request nudge   : "You've reached the step limit. Give your"
report               : "FINAL REPORT"
stopReason           : max_iterations
cumulative tokens    : 2205
SEAM OK: a budget exit forces a tool-free final report and returns it.
```

Two facts to carry into the design: the nudge **text names the step limit**
(`agent.ts:1480`) — it must be selected by reason, or a token-capped child is
told a falsehood; and the final report's own `usage` (`agent.ts:1500-1501`)
arrives **after** the last check, so it can overshoot the cap (see Design).

### Preconditions

Each verified in the source, not assumed:

1. **The child's usage already reaches the runner, per round.**
   `agent.ts:1218-1224` yields `usage` for every `done` with usage;
   `subagent.ts:499-505` re-emits it as `subagent_usage`, and folds it into the
   live row (`core/src/agent-jobs.ts:194-195`) — so no new plumbing is needed to
   *observe* spend.
2. **`promptTokens` already includes cache reads and cache writes.**
   `packages/providers/src/anthropic-provider.ts:213-221` sums
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; OpenAI's
   `prompt_tokens` includes cached tokens (`openai-provider.ts:243`). So
   `promptTokens + completionTokens` is the provider's own accounting of a round,
   with no price table on our side.
3. **A child inherits nothing but config from the parent's loop.**
   `subagent.ts:408-413` passes `maxIterations` into a fresh `Agent`; the child's
   conversation is one array (`subagent.ts:457-460`), driven by `runMessages`
   directly — the place a per-conversation counter can live and survive the
   `twoWay` continuation passes (`subagent.ts:481-528`).
4. **A WeakMap keyed by the message array is the established pattern for
   per-conversation memory**: `agent.ts:707` (`anchors`) + `agent.ts:1582-1587`
   (`anchorContext`), written from the same `done`-with-usage branch the counter
   joins.
5. **The reason vocabulary is a closed union, wired end to end**: `AgentStopReason`
   (`agent.ts:93`) → `stopReasonToProtocol` (`daemon/src/mapping.ts:180-189`,
   exhaustive `switch`, so a new member is a **compile error** until mapped) →
   `StopReasonSchema` (`protocol/src/session.ts:315-321`) →
   `stopReasonFromProtocol` (`client/src/mapping.ts:80-90`) plus the persisted
   turn-end validator (`daemon/src/daemon-state-file.ts:142`).
6. **`subagents.*` keys are carried laptop → pod and pinned**; adding a wire key
   forces its classification, because `CARRIED` is keyed by the wire's keys
   (`cli/src/carried-settings.ts:43`), and `key-docs.test.ts` T1 fails until
   `subagents.maxTokens` is documented (`config/src/key-docs.ts:530-545` is the
   neighbouring entry).
7. `stopReason` on a **`subagent_end` progress event is a free string**
   (`protocol/src/updates.ts:215`, `core/src/tool.ts:114`), so a child's reason
   can reach the TUI without a schema change.

### Design

**One knob, one counter, the existing exit.**

- `subagents.maxTokens` — a positive integer, or `-1` (unlimited), mirroring
  `subagents.maxIterations` exactly (`config/src/schema.ts:282-286`). Resolved
  env > profile > file > default via the existing `parseIterationLimit`
  (`config/src/resolve.ts:283-289`), like `subagentMaxIterations`
  (`resolve.ts:439-443`), and carried **pinned (P)** like it.
- **What counts:** `usage.promptTokens + usage.completionTokens`, per model call,
  summed for the child. `promptTokens` already contains cache reads **and** cache
  writes (precondition 2), so a cache read counts 1:1 with a fresh input token
  (owner Q2).
- **Cumulative per child, across continuation passes.** The counter is a
  `WeakMap<ChatMessage[], { tokens: number }>` on the `Agent`, incremented in the
  same `done`-with-usage branch as `anchorContext` (`agent.ts:1219-1223`) — keyed
  by the child's ONE conversation array (`subagent.ts:460`), so a `twoWay` child
  cannot refill its budget by being messaged. `WeakMap` also means a new
  conversation starts at 0 with no reset call.
- **The exit is the step cap's own exit.** The round header
  (`agent.ts:1158`) gains the token condition:

  ```ts
  for (let iteration = 0; iteration - budgetFrom < maxIterations && !overBudget(); iteration++)
  ```

  and after the loop the reason is chosen from the live counter:

  ```ts
  const capped: AgentStopReason = overBudget() ? "max_token_budget" : "max_iterations";
  ```

  A token cap therefore wins when both are spent in the same boundary (a
  spend-shaped stop is never blamed on steps), and everything between the loop
  and `turn_end` — the cancel-wins checks, the drain-before-report, the
  no-tools final request, the "keep only the summary" push — is **untouched**,
  because it is reason-agnostic (proved above).
- **Check granularity = round boundary**, exactly like `maxIterations`: the
  overshoot is at most one round (plus the final report, whose usage arrives
  after the last check). A hard mid-stream abort is deliberately not built
  (owner Q4): it would need a second report path, which is the one thing this
  design exists to avoid.
- **`context_reset` does not refund.** `budgetFrom` restarts the *round* budget
  (`agent.ts:1441`); the token counter is never reset by it, because a reset
  un-spends nothing. (Unreachable for a child today — the tool is withheld — so
  this is pinned at `Agent` level to keep the two budgets' semantics distinct
  when a parent-side budget adopts it.)
- **What the child tells its parent.** `subagent.ts` appends one line to the
  report when the cap trips — `(token budget reached: 2,000,041 of 2,000,000
  tokens used)` — since the runner owns both the cap and the count; and
  `packages/tools/src/task.ts` gets a third branch beside `cancelled` /
  `max_iterations` (foreground `task.ts:161-171`, background
  `task.ts:457-465`): `\n\n_(sub-agent hit its token cap)_`. The model reads that
  in the tool result, so it can narrow the task instead of re-spawning blindly.
- **What the TUI tells the person.** `subagent_end.stopReason` is a free string
  (`updates.ts:215`), so no wire change for the row: add
  `max_token_budget: "token cap"` to `CLOSING_LABELS` and the matching
  `_(sub-agent hit its token cap)_` to `OUTCOME_NOTES`
  (`tui/src/subagent-view.ts:114-129`), which is what renders `✗ token cap` and
  what `subAgentReport` strips (so the note is said once). The live row's `tokens`
  is already there (`core/src/agent-jobs.ts:328`).
- **Foreground and background children are identical** by construction: both run
  through the same `SubagentRunner` (`core/src/agent-jobs.ts:699-712` calls the
  same `run`), and the cap lives in the child's `Agent`. A background child's
  note carries the reason through
  `subagentReportNote`'s `(${job.stopReason})` (`core/src/agent-job-ledger.ts:354-363`).
- **Default: 2,000,000** (`DEFAULT_SUBAGENT_MAX_TOKENS`). Rationale: a healthy
  child is ~10–40 rounds with history growing to a few ×10⁴ tokens, i.e.
  ~0.2–1.0M summed prompt+completion; 2M is ~2–10× headroom, while the reported
  runaway (18M / 6.3M) trips it ~3–9× over. With `maxIterations: 50` and no
  compaction, 50 rounds cannot realistically stay under 2M — so the *step* cap
  stays the tighter bound for a fat child and this one catches the owner's
  actual failure (`-1`, or a wide child). Owner Q3 sets the number.
- **Out of scope** (deliberate): `feat/agent-status`'s "automatic note to the
  parent when a child crosses a threshold" (`TODO.md:470`) — that needs the
  read-only `agent_control{action:"status"}` path and a threshold policy, and the
  data (`live.tokens`) it would read is exactly what this task makes enforceable.
  Also out: a budget for the **parent's** turn (owner Q6), and weighting cache
  reads by price (Q2).

### Files

Dependency order; each diff is the smallest that wires the shared truth at both
ends (AGENTS §7).

1. `packages/config/src/schema.ts` — `subagents.maxTokens` beside `maxIterations` (`:282-286`), same `> 0 || -1` refinement.
2. `packages/config/src/defaults.ts` — `DEFAULT_SUBAGENT_MAX_TOKENS = 2_000_000` (`:18-22`) + the sample-config comment line (`:152`).
3. `packages/config/src/resolve.ts` — `pick(parseIterationLimit(env.TENTACLE_SUBAGENT_MAX_TOKENS), fileConfig.subagents?.maxTokens, DEFAULT_SUBAGENT_MAX_TOKENS)` (`:439-460`), the value/source pairs (`:592-595`, `:632-635`), and the `TentacleConfig`/`sources` fields (`:102`, `:176`).
4. `packages/config/src/load.ts` — `readonly subagentMaxTokens: number` (`:169`) + the pass-through (`:868`).
5. `packages/config/src/key-docs.ts` — a `"subagents.maxTokens"` entry after `"subagents.maxIterations"` (`:530-545`): summary, `IterationLimitSchema`-style details, `env: "TENTACLE_SUBAGENT_MAX_TOKENS"`, `carried: "pinned"`. (`key-docs.test.ts` T1 forces this.)
6. `packages/protocol/src/version.ts` + `packages/protocol/src/session.ts` — **if owner Q1 says a new reason**: `"max_token_budget"` in `StopReasonSchema` (`:315-321`), `PROTOCOL_VERSION` 23 → 24.
7. `packages/protocol/src/session.ts` — `subagentMaxTokens: IterationLimitSchema.optional()` beside `subagentMaxIterations` (`:814`). An additive optional field: no version bump (AGENTS §7, "fields are free").
8. `packages/agent/src/agent.ts` — `AgentConfig.maxTokens?: number` (beside `maxIterations`, `:499-500`); `spend` WeakMap (`:707`); the increment in the `done`-with-usage branch (`:1219-1223`); the header condition + `capped` reason (`:1158`, `:1536-1537`); a reason-selected nudge (`:1478-1481`); `notifyTurnEnd`'s reason union (`:1624-1626`).
9. `packages/agent/src/hooks.ts` — `turnEndNotify`'s `reason` union (`:669-677`), so a `turn_end` hook sees the honest reason.
10. `packages/agent/src/subagent.ts` — `SubagentDeps.maxTokens` (`:285`) → the child's config (`:408-413`); count the child's own spend from the `usage` branch (`:499-506`) for the report line; reword the no-report fallback's "higher step limit" (`:558-561`) to "a higher limit".
11. `packages/daemon/src/mapping.ts` — `stopReasonToProtocol` (`:180-189`) and `packages/client/src/mapping.ts` — `stopReasonFromProtocol` (`:80-90`); `packages/daemon/src/daemon-state-file.ts` — `STOP_REASONS` (`:142`).
12. `packages/cli/src/wiring.ts` — `maxTokens: config.subagentMaxTokens` next to `maxIterations` (`:551`).
13. `packages/cli/src/carried-settings.ts` — the `subagentMaxTokens` row, **class `P`**, after `subagentMaxIterations` (`:67-73`). (Compile-enforced: `CARRIED` is keyed by `SessionSettings` keys, `:43`.)
14. `packages/tools/src/task.ts` — the third note branch, both call sites (`:161-171`, `:457-465`).
15. `packages/tui/src/subagent-view.ts` — `CLOSING_LABELS` + `OUTCOME_NOTES` (`:114-129`).
16. Docs: `README.md:371` (the config table), `docs/feat/config-carry.md:224` (the carried-keys table), `TODO.md:487` (tick on merge only).

### Failure modes

- **A provider that reports no usage.** `done` without `usage`
  (`usage` is optional, `protocol/src/model.ts:68`) ⇒
  the counter never grows ⇒ the cap is inert, and the step cap is the only bound.
  Converges to today's behaviour rather than a wrong stop; the child's row shows
  `tokens: 0`, which is the honest signal. Notified in the doc, not fixed here.
- **Overshoot.** Boundary check ⇒ up to one round over, plus the forced report's
  own usage. Never unbounded; stated in the config's `details` so nobody reads
  the cap as a hard ceiling.
- **The forced report fails** (provider error / cut reply). Falls through exactly
  as `max_iterations` does today (`agent.ts:1517-1524` catch): the turn still ends
  `max_token_budget`, the runner's "finished without producing a report" text
  covers the empty case, and the parent's note says "hit its token cap". Nothing
  is silently empty.
- **Cancel vs cap.** An abort during the last tool or during the final stream
  still wins (`agent.ts:1450-1456`, `:1505-1513`): `cancelled`, never
  `max_token_budget`. Pinned by a test so a future refactor cannot mask a user's
  stop.
- **Continuation (`twoWay`) passes.** The counter lives on the conversation
  array, so a second pass starts already over budget and immediately takes the
  forced report (the header check runs at iteration 0 of the new pass). A message
  cannot buy more tokens.
- **Both caps spent at one boundary.** `overBudget()` is consulted first for the
  reason, so the spend-shaped stop is reported honestly.
- **Version skew.** The child's reason reaches the wire only as the free
  `subagent_end.stopReason` string (safe for an old client: it shows
  `✗ max_token_budget`), and a cap can only be set on a **child**, so no
  *persisted parent turn end* ever carries the new value — on-disk records and
  `daemon-state-file`'s validator stay readable both ways. If Q1 adds the enum
  member, an old client's `turn_end` parse would fail, which is why it bumps
  `PROTOCOL_VERSION` (§7) instead of being silently tolerated.
- **A daemon restart mid-child.** Children do not survive a reload (their reports
  are closed by load notes), so the in-memory counter is never resumed; a fresh
  child starts at 0. Consistent with "a reload starts permissive" for
  `resetsThisMessage` (`agent.ts:710-715`).
- **Empty/unset config.** `subagents.maxTokens` absent ⇒ the resolved default
  applies (as `maxIterations` does); `-1` ⇒ `let cap = Infinity` and the extra
  condition is always false.

### Tests

Red-first (§9) — each red on current `main`, then green. Fakes: the
`ScriptedProvider` pattern of `packages/agent/test/progress.test.ts:13-24`, and the
`createSubagentRunner` + `TreeModel` pattern of
`packages/agent/test/parallel-agents.test.ts:33-100`.

1. **NEW `packages/agent/test/subagent-budget.test.ts`** — *the cap forces the
   final report*: a child that calls a tool every round with usage summing to
   `> maxTokens` and `maxIterations: 50` stops with `max_token_budget`, its last
   model request offers **no tools** and carries the token-budget nudge, and its
   report is the final stream's text. RED today (`maxTokens` unknown).
   Mutation targets: (a) drop `&& !overBudget()` from the header → the child runs
   to 50 rounds and the `toolUses` assertion fails; (b) drop the counter
   increment → the cap never trips; (c) always yield `max_iterations` → the
   reason assertion fails; (d) move the check to the end of the round → the
   `toolUses` off-by-one assertion fails.
2. Same file — *cumulative across continuation passes*: a `twoWay` child
   (`deps.notify` + inbox) whose first pass nearly spends the budget gets no
   second productive round; `toolUses` does not grow past the cap. Mutation:
   key the counter on the turn (local) instead of the conversation array → fails.
3. Same file — *`-1` is unlimited*: a huge but finite spend runs to a clean
   `end_turn`. Mutation: treat `-1` as `0` → fails.
4. Same file — *cancel wins*: over budget + abort during the final stream ⇒
   `cancelled`. Mutation: choose the reason before the abort check → fails.
5. Same file — *`context_reset` does not refund the counter* at `Agent` level
   (rounds restart, tokens do not). Mutation: reset the counter where
   `budgetFrom` is reset (`agent.ts:1441`) → fails.
6. `packages/tools/test/task.test.ts` — the foreground note is
   `_(sub-agent hit its token cap)_` and **not** the iteration-cap note; same for
   the background path. Mutation: fall through to the `max_iterations` branch →
   fails.
7. `packages/config/test/resolve.test.ts` — env > file > default for
   `subagents.maxTokens`, `-1` allowed, `TENTACLE_SUBAGENT_MAX_TOKENS` parsed
   (mirroring the existing `maxIterations` test at `resolve.test.ts:74`).
8. `packages/cli/test/carried-settings.test.ts` — the key is **P** (pinned, beats
   the pod's own value), round-trips through `carriedSettings`, and joins
   `ALL_KEYS` (`:205-230`). Mutation: classify it `W` → fails.
9. `packages/tui/test/subagent-view.test.ts` — `max_token_budget` renders
   `✗ token cap`, and `subAgentReport` strips the tool's note. Mutation: no
   `CLOSING_LABELS` entry → fails.
10. `packages/daemon/test/mapping.test.ts` + `packages/client/test/mapping.test.ts`
    — the new reason survives both mappings, and `PROTOCOL_VERSION` is the bumped
    value (imported, never a literal). Only if owner Q1 says a new reason.

### Owner questions

1. **Stop-reason taxonomy** — a new `max_token_budget` on `AgentStopReason` +
   `StopReasonSchema` (+ both mappings, `daemon-state-file`'s set, and a
   `PROTOCOL_VERSION` bump to 24), or reuse `max_iterations` and only change the
   prose? **Recommended: the new reason.** Pre-public a bump is cheap (§7 "pick
   the cleanest shape"), the TUI and the parent can then say "token cap" rather
   than lie about a step cap, and a later parent-side budget reuses it. Reusing
   `max_iterations` would make `✗ iteration cap` wrong on screen and in the
   `turn_end` hook, and there is no way to add the meaning later without the same
   bump.
2. **Do cache reads count 1:1?** `promptTokens` already sums
   `input + cache_creation + cache_read`
   (`anthropic-provider.ts:213-221`). **Recommended: yes, 1:1.** The thing being
   bounded is a runaway *resend* loop, and a cache read is precisely a resent
   history token — counting it cheaper (`×0.1`) needs a per-provider price table
   that we would have to keep true, and would let the quadratic term through the
   cap. Cost accuracy is `agent_usage`' job; this knob bounds growth.
3. **The default.** **Recommended: `DEFAULT_SUBAGENT_MAX_TOKENS = 2_000_000`,
   with `-1` = unlimited** (parity with `maxIterations`). Healthy children in the
   repo's own history sit around 0.2–1.0M summed prompt+completion; 2M keeps
   ~2–10× headroom and still trips the reported 18M / 6.3M runaways. The
   alternative is "off by default" (`-1`), which fixes nothing for anyone who
   does not read the release notes — the exact audience of this task.
4. **Boundary check or hard mid-stream stop?** **Recommended: boundary**, like
   `maxIterations`. A mid-stream abort gives no report and would need a second
   report path — the one thing this design exists to avoid — while the overshoot
   is bounded by one round.
5. **Per child *lifetime*, not per pass?** **Recommended: lifetime** (one counter
   per child conversation). Otherwise a `twoWay` child's inbox message refills
   the budget, and the cap becomes advisory for exactly the children that talk
   back.
6. **Should the parent get the same knob (`maxTokens` per turn)?** **Recommended:
   no, not in this task.** A parent turn can already shrink its own context
   (`context_reset`, and `/compact` — there is no *automatic* compaction in this
   repo, `rg autoCompact` finds nothing), so it has an escape a child does not,
   and its turn is a person's request: cutting it off needs a UX decision (a
   "continue?" prompt), not a silent cap. The `AgentConfig` field it would use is
   built here, so the follow-on is small.

## Execution

*— (empty — not started; the Implementation above is not yet approved)*

## Review

*— (empty — an adversarial pass happens after Execution, AGENTS §10)*

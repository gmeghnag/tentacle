# fix/reask-budget-and-compact-length — the DSML re-ask eats two steps, and compaction keeps a summary cut at the output limit

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `fix/reask-budget-and-compact-length`
> **Type:** fix · **Size:** S · **Blast:** cross-module · **Suited:** DeepSeek exec (fresh-context Review: one line in the agent loop's budget arithmetic)
> **Changelog:** `changelog.d/reask-budget-and-compact-length.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-13*

Found by the Opus review of `fix/truncated-reply-silent` (2026-11-11, TODO entry
`fix/reask-budget-and-compact-length`); both defects predate that fix and are on
`main`.

**Bug 1 — the DSML re-ask shrinks the step budget.** The round loop runs while
`iteration - budgetFrom < maxIterations` (`packages/agent/src/agent.ts:1180`).
A DSML-leaked tool call is re-asked once (`agent.ts:1264-1271`) and, to make the
re-ask "replace the leaked round, not the turn's budget" (its own comment,
`:1268-1269`), does `budgetFrom--`. But `continue` also does `iteration++`, so
`iteration - budgetFrom` grows by **2**: the re-ask costs two steps instead of
zero. The truncated-reply re-ask does it right — `budgetFrom++` moves the window
WITH the iteration (`agent.ts:1433-1436`), and `docs/fix/truncated-reply-silent.md:502-505`
already measured that `budgetFrom--` is wrong. With `maxIterations: 2` (sub-agents
run with small caps) a single leak spends the whole budget: the turn goes
straight to the forced `max_iterations` report without doing any work.

**Bug 2 — compaction accepts a cut summary.** `summarizeConversation`
(`packages/agent/src/compact.ts:59-97`) reads only `text` events and ignores
`done.stopReason`. A summary cut by `finish_reason: "length"` (or a stream that
ended with no stop reason, `"other"`, `core/src/model.ts:130`) passes the
empty-text guard (`:87`) and `Session.compact` (`agent/src/session.ts:277-296`)
**irreversibly** replaces the whole history with it — the end of the brief (the
"open tasks / next steps" the system prompt puts last, `compact.ts:15-16`) is
silently lost. Same class as `truncated-reply-silent`, whose `done.stopReason`
plumbing is now on `main` (`model.ts:137`, mapped by every provider, e.g.
`providers/src/openai-provider.ts:11`). `summarizeText` (`compact.ts:105-125`,
tool-output summaries, opt-in via `summarizeLargeOutput`, `cli/src/wiring.ts:430-436`)
has the same blind spot, with a far smaller blast: the full output is spilled to
disk and the summary is labelled as such (`agent/src/result-pipeline.ts:255-264`).

**Repro** (2026-11-13, worktree at `5961917`): `.tentacle/tmp/reask-budget-and-compact-length/repro.ts`

```ts
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "../../worktrees/reask-budget-and-compact-length/packages/agent/node_modules/@tentacle/core/src/index.ts";
import { DsmlToolCallLeakError } from "../../worktrees/reask-budget-and-compact-length/packages/agent/node_modules/@tentacle/core/src/index.ts";
import { ToolRegistry } from "../../worktrees/reask-budget-and-compact-length/packages/agent/node_modules/@tentacle/tools/src/index.ts";
import { Agent } from "../../worktrees/reask-budget-and-compact-length/packages/agent/src/agent.ts";
import { Session } from "../../worktrees/reask-budget-and-compact-length/packages/agent/src/session.ts";
import { summarizeConversation } from "../../worktrees/reask-budget-and-compact-length/packages/agent/src/compact.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

// Bug 1: maxIterations 2. Round 0 leaks DSML; every later tool-offered round calls
// a tool; the forced final (no tools) answers. Count tool-offered rounds after the leak.
let calls = 0;
let toolRounds = 0;
const leaking: ModelProvider = {
  id: "l",
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const r = calls++;
    if (r === 0) {
      yield { type: "text", delta: "x" };
      throw new DsmlToolCallLeakError(42);
    }
    if (req.tools && req.tools.length > 0) {
      toolRounds++;
      yield { type: "tool_call", toolCall: { id: `c${r}`, name: "noop", arguments: "{}" } };
      yield { type: "done", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text", delta: "final report" };
    yield { type: "done", stopReason: "stop" };
  },
};
const tools = new ToolRegistry().register({
  name: "noop",
  description: "n",
  jsonSchema: { type: "object", properties: {} },
  inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  permission: "none",
  execute: async () => ({ content: "ok", isError: false }),
} as never);
const s = new Session(new Agent({ model: leaking, tools, env, maxIterations: 2 }));
const ends: string[] = [];
for await (const e of s.send("go")) if (e.type === "turn_end") ends.push(e.reason);
console.log(`bug1: real (tool-offered) rounds after the leak = ${toolRounds} (want 2), turn_end = ${ends.join(",")}`);

// Bug 2: a summary cut by the output limit is accepted as the brief.
const cut: ModelProvider = {
  id: "c",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "Goals: fix the parser. Decisions: use" };
    yield { type: "done", stopReason: "length" };
  },
};
try {
  const summary = await summarizeConversation(cut, [{ role: "user", content: "hi" }]);
  console.log(`bug2: accepted summary = ${JSON.stringify(summary)} (want CompactError)`);
} catch (e) {
  console.log(`bug2: rejected ${(e as Error).name}`);
}
```

Output (`bun .tentacle/tmp/reask-budget-and-compact-length/repro.ts`):

```
bug1: real (tool-offered) rounds after the leak = 0 (want 2), turn_end = max_iterations
bug2: accepted summary = "Goals: fix the parser. Decisions: use" (want CompactError)
```

(Imports go through `packages/agent/node_modules/@tentacle/*` on purpose: the
bare `@tentacle/core` from `.tentacle/tmp` resolves to the main checkout's copy,
a different `DsmlToolCallLeakError` class, and `instanceof` fails.)

Arithmetic for the fix (not run — a patched copy needed extra approvals):
`budgetFrom++` keeps `iteration - budgetFrom` at 0 after the leak, so iterations
1 and 2 run (2 real rounds), then the cap — the expected `want 2`.

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**A re-ask is "free" iff `budgetFrom` moves by +1 together with `iteration`.**
The loop's only step test is `iteration - budgetFrom < maxIterations`
(`agent.ts:1180`) and the `for` increments `iteration` on every `continue`, so
+1 on `budgetFrom` leaves the difference unchanged; −1 (today, `:1270`) adds 2.
The truncation re-ask relies on exactly this (`:1433-1436`), and its test
already passes on `main`. No other code reads `budgetFrom` except
the context-reset assignment (`:1470`, absolute, unaffected).

For bug 2: **every compaction goes through `summarizeConversation`** —
`Agent.summarize` (`agent.ts:900-906`) is its only caller, and
`Session.compact` (`session.ts:281`) the only caller of that; the daemon
(`hosted-session.ts:2755`), local runtime (`cli/src/local-runtime.ts:576`) and
sub-agent jobs (`cli/src/session-jobs.ts:157`) all reach `session.compact`. So a
throw there is the single seam, and `Session.compact` already guarantees a throw
before the replacement leaves the history untouched and unpersisted (the
empty-summary guard's test, `agent/test/compact.test.ts:98+`).

### Preconditions

- `StreamEvent` `done` carries `stopReason?: ModelStopReason`
  (`"stop" | "length" | "tool_calls" | "other"`, `core/src/model.ts:130,137`);
  `undefined` means a provider that does not say (`agent.ts:1224-1225`).
- `CompactError` already exists and reaches the user's `/compact` outcome with
  its message (`compact.ts:47-52`, `tui/src/send-now.ts:85`).
- The agent loop treats `"other"` as a cut stream, never a short answer (owner
  Q2a of `truncated-reply-silent`, `agent.ts:1294-1307`); compaction follows the
  same reading.
- `summarizeLargeOutput` turns any throw from `summarize` into the
  `[large … output — <path>; summary failed]` placeholder
  (`result-pipeline.ts:259-263`); the full output is already on disk.
- No protocol, persistence or terminal path is touched (§7): this is agent-side
  only; no `PROTOCOL_VERSION` bump.

### Design

1. **DSML re-ask** (`agent.ts:1268-1270`): `budgetFrom--` → `budgetFrom++`, and
   rewrite the comment to say what the truncation one says (moves WITH the
   iteration). Nothing else: `MAX_DSML_REASKS` (=1, `:198`) still bounds it, so
   the turn makes at most `maxIterations + 1` tool-offered model calls per leak
   — the same allowance the truncation re-ask already has.
2. **`summarizeConversation`**: record `done.stopReason`; after the loop, if it
   is `"length"` or `"other"`, throw `CompactError` (before the empty check, so a
   cut-and-empty reply names the real cause). Message, in the existing style:
   `"model's summary was cut off (<reason>) — conversation left intact — retry
   /compact, or raise the model's output limit"`. `"stop"`, `"tool_calls"` and
   `undefined` keep today's behaviour (no false failure on a provider that does
   not report a reason). No auto-retry (Owner Q2).
3. **`summarizeText`** (Owner Q1, recommended): same check, throwing a plain
   `Error` — the pipeline's existing catch renders the "summary failed"
   placeholder with the spill path. One shared helper in `compact.ts`
   (`collectSummary(model, request) → { text, stopReason }`) so both functions
   read the stream identically.

### Files

1. `packages/agent/src/agent.ts` — `:1268-1270` (one operator + comment).
2. `packages/agent/src/compact.ts` — stream-reading helper, the cut check in
   `summarizeConversation` (and `summarizeText` per Q1).
3. `packages/agent/test/dsml-leak.test.ts` — budget test.
4. `packages/agent/test/compact.test.ts` — cut-summary tests.
5. `packages/agent/test/result-pipeline*.test.ts` (whichever file covers
   `summarizeLargeOutput`; `rg summarizeLargeOutput packages/agent/test`) — only if Q1 = yes.
6. `changelog.d/reask-budget-and-compact-length.fixed.md` (already written by the planner).

### Failure modes

- **Leak on the last allowed round** (`iteration - budgetFrom = maxIterations-1`):
  after `++` the replacement round still runs; a second leak fails the turn
  (`MAX_DSML_REASKS`), so no loop. Pinned by test B2.
- **Leak + truncation in the same turn**: each has its own counter and both
  move `budgetFrom` +1 — at most `maxIterations + 2` tool-offered calls. Bounded.
- **Leak + context reset**: reset assigns `budgetFrom = iteration + 1`
  absolutely (`:1470`), so an earlier `++` cannot accumulate into a larger
  window. Unchanged.
- **`maxIterations: -1`** (∞): unaffected. **Token budget** (`overBudget()`):
  independent of `budgetFrom`; a leaked round throws before `done`, so it adds no
  spend either way. Unchanged.
- **Cut summary**: throws before `Session.compact` mutates anything → history
  intact, no persist, user sees the `CompactError` message. **Abort during the
  summary**: unchanged (the stream rejects; `signal.throwIfAborted`).
- **Provider without stop reasons** (`undefined`): accepted as today — the
  only false-negative left, deliberate (failing every compaction on such a
  provider would be worse).
- **Repeated `length` on retry** (context too large for a full summary): the
  user keeps getting a clean error and an intact conversation instead of a
  silently truncated brief. A real fix (a capped/staged summary) is out of scope
  — Owner Q2.

### Tests

All red on current `main` first (§9); record the red output in Execution.

- **B1** (`dsml-leak.test.ts`) "a DSML re-ask does not cost step budget": Agent
  with `maxIterations: 2`, a registered tool, provider = round 0 leaks, every
  tool-offered round calls the tool, the tool-free final answers (the repro's
  shape, using the file's `noopEnv` and a `Tool` like `agent-spill.test.ts:44`).
  Assert exactly **2** tool-offered rounds after the leak and `turn_end`
  `max_iterations`. Red today: 0.
  *Mutations:* `budgetFrom--` (today) → 0 rounds, red; deleting the line
  (re-ask costs one step) → 1 round, red; `budgetFrom += 2` → 3 rounds, red.
- **B2** "a leak on the last allowed round still gets its replacement round":
  `maxIterations: 1`, round 0 leaks, round 1 answers with text → one
  replacement model call happens and the turn ends `end_turn` with that text
  (today: goes straight to `max_iterations`).
- **C1** (`compact.test.ts`) `summarizeConversation` rejects with `CompactError`
  on `[text "partial", done{stopReason:"length"}]`; **C2** same for `"other"`;
  **C3** accepts `"stop"` and `undefined` (no false failure — mirrors the
  existing happy-path test with an explicit reason).
  *Mutations:* drop the check → C1/C2 red; check only `"length"` → C2 red;
  treat `undefined` as cut → C3 red.
- **C4** `Session.compact` on a length-cut summary leaves `messages` identical
  and `onPersist` uncalled — copy the empty-summary guard test
  (`compact.test.ts:98+`). *Mutation:* move the check after the history
  replacement (i.e. into `Session.compact` after `compactedHistory`) → red.
- **T1** (only if Q1 = yes): `summarizeLargeOutput` with a `summarize` built on
  `summarizeText` over a length-cut provider yields the `summary failed`
  placeholder, not the cut text.

### Owner questions

1. **Also guard `summarizeText` (tool-output summaries)?** Rec: **yes** — same
   one-line check through the shared helper; a cut summary falls back to the
   existing "summary failed, full output at <path>" placeholder, so the model
   never reads a half-summary as the whole.
2. **On a cut compaction summary: fail cleanly, or auto-retry once (e.g. with a
   "be shorter" instruction)?** Rec: **fail cleanly, no retry** — the history
   stays intact and the user retries; a retry hides cost and usually re-cuts on
   the same oversized context. A staged/capped summary is its own task.
3. **Treat `"other"` (stream ended with no stop reason) as cut for compaction
   too?** Rec: **yes** — consistent with owner Q2a of `truncated-reply-silent`
   (missing data, not a short answer).
4. **Is "free" the intended semantics for the DSML re-ask (turn may make
   `maxIterations + 1` tool-offered calls), matching truncation?** Rec: **yes**
   — the code comment already says so, and both re-asks then share one rule.

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*

#### Owner answers (2026-11-13)

Q1–Q4 all yes, as recommended. Implementation APPROVED.

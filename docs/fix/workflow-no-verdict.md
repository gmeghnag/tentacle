# fix/workflow-no-verdict — a step ends with the `step_verdict` TOOL, and its failure says why

> **Status:** execution done — awaiting review (fresh-context, Opus)
> **Branch:** `fix/workflow-no-verdict`
> **Size:** M · **Blast:** cross-module · **Suited:** DeepSeek plan+exec, Opus review (owner, `TODO.md:14`)
> **Changelog:** `changelog.d/workflow-no-verdict.fixed.md`

## Context

*— claude-sonnet-4-5, 2026-11-26*

Three defects sit on one behaviour: a workflow's agent step ends ONLY through the
typed `step_verdict` tool (docs/feat/agent-workflows.md D3, `workflow-verdict.ts:1-8`,
`workflow-driver.ts:1801-1835`), never through a grep of the report. In practice a
child model writes «PASS» as TEXT, never calls the tool, and the step fails
`no verdict` — with nothing on screen that says so.

Evidence (owner, `TODO.md:14`, session `fb10a61d`, run `wf-2`, 00:14:08, phone
screenshots): the `write` step of workflow `test` in `~/assistant` shows «error»
while its own report ends «PASS». Same failure on 24/11 in `rassegna-stampa`. And
the authoring agent's own "fix" was to ask the prompt for a text `PASS` line,
which teaches the wrong contract.

The three defects, each a code fact:

1. **No second chance.** `agentStep` runs the child ONCE (`workflow-driver.ts:1778`)
   and falls straight through to `fail: no verdict` (`:1824-1835`). A model that
   did the work and merely forgot the tool loses the step, its spend and the run's
   branch — there is no reminder turn today.
2. **The reason never reaches a phone.** The reason IS decided and IS on the wire —
   `setStep(..., reason: capWorkflowText(outcome.reason, 2000))` (`:1564-1569`) →
   `WorkflowStepRow.reason` (`protocol/src/session.ts:851`) → bounded for clients
   (`client/src/workflows.ts:117-121`) — but the phone's step body throws it away:
   `detailBlocks` puts it in the LOG block (`workflow-skeleton.ts:269`) and
   `stepBlocks` then REPLACES that log with the read's prompt/report
   (`apps/mobile/src/workflow-step-detail.ts:394`). So the detail shows
   `State error` and the report's «PASS», never the reason. The TUI already paints
   it in both places (`tui/src/workflow-view.ts:169-183` rail note, `:494-496`
   panel) and needs no code change.
3. **The authoring surface teaches the wrong contract.** The template prompt a
   workflow's review step runs says «Answer pass or fail, with the one reason that
   decides it» (`core/src/workflow-templates.ts:112-116`) — a TEXT answer, i.e.
   exactly the behaviour that fails. The `workflow` tool's description
   (`tools/src/workflow.ts:52`) never mentions the verdict at all, and the verdict
   tool's own description (`workflow-verdict.ts:29-31`) does not say that a text
   line is not a verdict.

**Repro** (run 2026-11-26 in `.tentacle/tmp/workflow-no-verdict/repro.ts` of the
task worktree; pasted in full because that folder is gitignored, AGENTS §6):

```ts
// imports (relative, like AGENTS §6's TUI repro):
import { WorkflowDriver, type WorkflowDriverDeps, type WorkflowHost } from "../../../packages/agent/src/workflow-driver.ts";
import type { SubagentRunner } from "../../../packages/agent/src/subagent.ts";
import { stepBody } from "../../../apps/mobile/src/workflow-step-detail.ts";

async function driverPart() {                       // a child that never calls step_verdict
  let calls = 0;
  const runner: SubagentRunner = async () => {
    calls += 1;
    return { report: "I think it works. PASS", toolUses: 0, stopReason: "end_turn" };
  };
  // deps: load() = a one-step `write` workflow, approvals.has() → true,
  //       request = allow-once, runnerFor = () => runner, publish → rows
  await driver.start({ name: "task", by: "user" });
  await flush();
  console.log(`driver: child runs = ${calls}`, rows.at(-1)?.at(-1)?.steps[0]);
}

function mobilePart() {                             // the phone's step detail, pure module
  const body = stepBody(undefined as never,
    { id: "write", kind: "agent", where: "local", state: "error", attempt: 0, round: 0,
      reason: "no verdict", next: null, onFail: null, retry: 0 },
    { kind: "loaded", detail: { prompt: "write it", report: "I think it works. PASS" } },
    (k) => k, (s) => s, 0);
  console.log("mobile: kv rows =", body.kv);
  console.log("mobile: log block =", body.log);
}
```

```
$ bun repro.ts
driver: child runs = 1 (a reminder would make it 2)
driver: step write state=error reason="no verdict"
mobile: kv rows = [["State","error"],["Kind","agent"],["Where","local"]]
mobile: log block = ["prompt:","write it","report:","I think it works. PASS"]
```

That is the bug in one frame: one child run, a bare `no verdict` token as the only
trace, and a phone body that lists no reason at all while the report says PASS.

## Implementation

*— claude-sonnet-4-5, 2026-11-26*

### Load-bearing assumption

**One more call of `deps.runnerFor(...)` IS one more child turn, and its spend needs
no new accounting.** The runner is a plain function `(opts, controls) =>
Promise<SubagentResult>` (`agent/src/subagent.ts:267-270`) with no conversation
carried between calls — so a second call starts a fresh child, and the ONLY channel
it shares with the first is the `step_verdict` slot, created ONCE per step before
any run (`workflow-driver.ts:1774`) and closed over `recorded` by the tool
(`workflow-verdict.ts:26`, `:34-50`), so a reminder's call lands in the same slot and
the "FIRST valid call wins" rule (`:43-50`) already covers it. The spend needs nothing
new either: both runs report `subagent_usage` into the SAME `tokens` accumulator
(`workflow-driver.ts:1791-1798`) which is what the step's `step_result` carries
(`:1803-1814`) and what the machine adds to the run's sum
(`core/src/workflow-machine.ts:344-345`).

If that assumption were false (a runner that resumes one conversation, or a per-step
accounting that only counts the first call), the reminder must not be a second call.

### Preconditions

- **`agentStep` is the one place an agent step ends**: `workflow-driver.ts:1759-1851`
  (verdict → `step_result` `:1803-1814`; `max_token_budget` → `budget_hit`
  `:1816-1823`; else `fail: no verdict` `:1824-1835`; a throw → `error: …`
  `:1836-1851`). `run`, `approve` steps are untouched (`:1729-1757` dispatch).
- **A token-capped child cannot call a tool again**: `max_token_budget` means the
  child was asked for one final TOOL-FREE report (`config/src/key-docs.ts:592`,
  enforced at `agent/src/subagent.ts:699`). So a reminder there would be a turn that
  cannot end correctly — it must be skipped, not attempted (decision 3).
- **The cap is PER CALL**: `controls.maxTokens` (`subagent.ts:186-190`) replaces the
  runner's default for that child only, and the driver passes the step's own
  `step.tokens` (`workflow-driver.ts:1789`, spec `core/src/workflow-spec.ts:253` —
  a POSITIVE integer, no `-1`). A reminder that reused `step.tokens` would DOUBLE
  the step's budget; the remainder is the honest cap.
- **Cut short is not "forgot the tool"**: `runStep` turns an aborted/timed-out step
  into `cancel`/`interrupted`/`timeout` AFTER the step returns
  (`workflow-driver.ts:1719-1727`, applied `:1744-1752`). An aborted step must not be
  reminded — its outcome is already decided.
- **The reason is ALREADY on the wire** and needs no protocol change: driver
  `:1564-1569` → `WorkflowStepRowSchema.reason` `z.string().max(2000)`
  (`protocol/src/session.ts:851`) → `client/src/workflows.ts:102-121`
  (`sanitizeWorkflowText`, same 2 000 cap) → `boundWorkflows`. **Therefore: no
  `protocol.d/` note and no `PROTOCOL_VERSION` touch for (b).**
- **Single broker (AGENTS §7)**: every ask a step raises must go through
  `stepRequester` (`workflow-driver.ts:1652`), which tags the step's `agentId` and
  arms `budget.wait`. The reminder child must be built from the same
  `stepRequester`, or its asks would be a second, ungated path.
- **Logic in pure modules (§7)**: the reminder decision + its text go in
  `workflow-verdict.ts` (React-free, no I/O — it already owns the verdict rules);
  the mobile row goes in `detailBlocks` (`workflow-skeleton.ts:233-270`), the ONE
  place the detail's kv list is decided (its own doc comment `:225-232`).

### Design

**(a) One reminder turn, then fail `no verdict` as today.**

In `agentStep`, after the first run (`workflow-driver.ts:1778-1835`), in this order:

1. `verdict.verdict()` set → `step_result(pass|fail, reason)` — unchanged (`:1801`).
2. `result.stopReason === "max_token_budget"` → `budget_hit` — unchanged (`:1816`).
3. `planVerdictReminder({...})` returns `undefined` → `fail: no verdict` (today's
   path, with the longer sentence).
4. otherwise: `setStep(run, step.id, { live: "asking for a verdict" })` + `publish()`,
   run ONE more child (same `description`, `type`, `model`, `agentId`, `toolCallId`,
   `stepRequester`, `extraTools: [verdict.tool]` and the SAME `onEvent`
   accumulator), then read the slot again:
   - a verdict now → `step_result` with it (this is a normal end: `pass` or `fail`,
     whose reason is the child's own);
   - `max_token_budget` → `budget_hit` (the cap ended it; honest);
   - still nothing → `fail: no verdict`, sentence below.

Loop-free by construction: step 4 runs at most once, and the three reads after it are
the same three reads as today. The per-step `live` line says what is happening, so
the rail/phone shows `asking for a verdict` instead of a frozen step.

The decision and the prompt are pure (`workflow-verdict.ts`), the driver only applies
them:

```ts
export const NO_VERDICT_REASON = "no verdict — the step ended without calling step_verdict";
export const STEP_REMINDER_REPORT_MAX = 4_000;

export interface StepReminder { readonly prompt: string; readonly maxTokens?: number }

/** ONE more child turn for a step that ended without a verdict, or `undefined`. */
export function planVerdictReminder(input: {
  readonly stepId: string;
  readonly report: string;
  readonly usedTokens: number;          // both runs so far (this is the first)
  readonly tokens: number | undefined;  // the step's own cap (`agent.tokens`)
  readonly aborted: boolean;
}): StepReminder | undefined;           // gates in Preconditions, in order
```

The prompt (a string in the pure module, so a test can pin it verbatim) says: the step
ended without a verdict and is about to fail; call the `step_verdict` tool NOW,
exactly once, `pass` if the goal is met else `fail`, with a one-line `reason`; a text
line saying PASS or FAIL is NOT a verdict; then — only when the first report is
non-empty — the report's LAST `STEP_REMINDER_REPORT_MAX` chars under «Your work ended
with this report:», because a report's conclusion is at its end and the reminder
child shares no history with the first.

**The reason string** becomes `NO_VERDICT_REASON` for BOTH the event and the returned
reason (`:1828`, `:1832`), so one truth reaches the log entry, the step row, the
machine's `step ${id} failed — …` sentence (`core/src/workflow-machine.ts:385`) and
both clients. Nothing parses the old literal (only `:1828`, `:1832` and tests hold
it).

**(b) The reason on screen, in the pure module — the TUI already does it.**

- Mobile: `detailBlocks` gains a `Reason` kv row (`workflow-skeleton.ts:233-270`),
  fed by `step.reason` and `oneLine`d — the same shape the approve path already uses
  for a denial (`workflow-step-detail.ts:340`). The kv list is decided before the read
  lands, which is `stepBlocks`'s stated property ("no box above the log block can move
  when it does", `workflow-step-detail.ts:364-367`), so the reason is visible
  immediately, not after a tap.
  The `log: logLines(step.reason)` fallback at `:269` goes away (the reason now has
  its own row; `stepBlocks` overrides `log` anyway, `workflow-step-detail.ts:394`).
- **Approve steps are excluded** from the kv `Reason` row: their answer block already
  carries `["Reason", …]` for a denial (`workflow-step-detail.ts:329-345`), and two
  identical rows would read as two reasons.
- TUI: **no code change.** The rail's note column paints `step.reason`
  (`tui/src/workflow-view.ts:169-183`) and the panel's detail column paints it under
  the head (`:494-496`); both improve for free from (1)'s sentence. A frame test
  pins it (Tests 9).

**(c) The authoring surface says it plainly.**

Three exact edits, one sentence each:

1. `core/src/workflow-templates.ts:112-116` — the review prompt becomes: «Review the
   change against the plan and END THE STEP by calling the `step_verdict` tool:
   `pass` or `fail`, with the one reason that decides it. Never write the verdict as
   text — a PASS/FAIL line is not a verdict.» (The template is the authoring starting
   point that lands in the user's project, `apps/mobile/src/workflow-edit-controller.ts:826`.)
2. `tools/src/workflow.ts:52` — the `workflow` tool's `DESCRIPTION` gains: «A
   workflow's `agent` step ends only by calling the `step_verdict` tool (pass|fail +
   reason) — a child that ends without it is asked once more, then the step fails
   `no verdict`. Write that into the step's prompt; never ask for a text PASS line.»
3. `workflow-verdict.ts:29-31` — the tool's own description gains «A PASS/FAIL line in
   your text is NOT a verdict.» (the child reads this at the moment it decides).

Also `docs/feat/agent-workflows.md` D3 (`:236-238`) and its failure-mode table row 4
(`:356`) record the reminder, so the design doc stays the source of truth (§8).

#### Orchestrator decisions

Owner delegated every open question; each is decided here with its one-line reason.
The Implementation is therefore **APPROVED**.

| # | Question | Decision | Why (one line) |
|---|---|---|---|
| 1 | What does the reminder child get? | The report's LAST 4 000 chars + the reminder sentence; no re-sent step prompt | A conclusion lives at a report's end, the two children share no history, and the cap keeps a 100 KiB report from doubling the step's spend. |
| 2 | Which report does the step keep when the reminder's verdict lands? | The FIRST run's report; the reminder's only if the first was empty | The first run did the work; the reminder's report is a placeholder ("verdict recorded"). |
| 3 | Remind a child that hit its token budget? | No | Its final report is tool-free by construction (`subagent.ts:699`), so the turn cannot end correctly. |
| 4 | Remind a cancelled / timed-out / interrupted step? | No | `cutEvent` already decided that outcome (`workflow-driver.ts:1719-1727`); an extra child would fight it. |
| 5 | Reminder budget when the step sets `tokens`? | `tokens - usedTokens`, and NO reminder when that is `≤ 0` | The cap is per call (`subagent.ts:186-190`); reusing it verbatim would double the step's budget. |
| 6 | Reminder budget when the step sets no `tokens`? | No `maxTokens` — the runner's default applies, exactly like the first run | Same rule as `:1789`; inventing a cap would be a second, undocumented budget. |
| 7 | One reminder sentence or two (ignored vs never sent)? | ONE: `no verdict — the step ended without calling step_verdict` | Honest for both, keeps one string to test, and the log's step order already shows whether a reminder ran. |
| 8 | Where does the reason go on the phone — kv row or log block? | A kv `Reason` row in `detailBlocks`, excluded for `approve` | It is available before the read lands (no reflow), and it matches the approve path's own `Reason` row instead of a second rendering idea. |
| 9 | Reuse `agentId`/`toolCallId` for the reminder child? | Yes, both | They only attribute asks (`subagent.ts:224-250`) and no wire row is keyed by them (`subagent_start` carries no id, `subagent.ts:446-452`); one step keeps one identity. |
| 10 | Protocol change for (b)? | None — `reason` is already a `WorkflowStepRow` field | `session.ts:851` + `client/src/workflows.ts:117-121` carry it today; no `protocol.d/` note, `PROTOCOL_VERSION` untouched. |

### Files

Dependency order; the smallest diff that lands the three parts.

1. `packages/agent/src/workflow-verdict.ts` — `NO_VERDICT_REASON`,
   `STEP_REMINDER_REPORT_MAX`, `StepReminder`, `planVerdictReminder` (pure; the
   reminder prompt text lives here), and the tool description's new sentence.
2. `packages/agent/src/workflow-driver.ts` — `agentStep`: a local `runChild(prompt,
   maxTokens)` closing over the one `onEvent`/`agentId`/`toolCallId`/requester, the
   reminder step between `:1823` and `:1824`, and `NO_VERDICT_REASON` at `:1828`/`:1832`.
3. `packages/core/src/workflow-templates.ts` — the review prompt's text (`:112-116`).
4. `packages/tools/src/workflow.ts` — `DESCRIPTION` (`:52`).
5. `apps/mobile/src/workflow-skeleton.ts` — the `Reason` kv row in `detailBlocks`
   (`:233-270`), and its `log` becomes `[]` (the log block is the READ's, `detailLog`).
   `apps/mobile/src/workflow-step-detail.ts` needs **no change**: the input the plan
   named (`log: logLines(step.reason)`, `:269`) is that one line inside `detailBlocks`,
   not a call site — `stepBlocks` overrides `log` anyway (`:394`). *(Corrected in
   Execution: the plan's `:387` edit had no site.)*
6. `docs/feat/agent-workflows.md` — D3 (`:236-238`) + failure-mode row 4 (`:356`).
7. `changelog.d/workflow-no-verdict.fixed.md` — one `fixed` bullet.

No `packages/protocol` change, no `apps/mobile/src/screens/WorkflowStep.tsx` change
(it already renders `blocks.kv`, `:289-300`, and `blocks.log`, `:352-361`), no TUI
change.

### Failure modes

| # | Case | How it converges |
|---|---|---|
| 1 | The reminder child also ends without a verdict | `fail: no verdict` with the sentence — the run's `on_fail`/retry rules act exactly as today (`workflow-machine.ts:346-392`). |
| 2 | The reminder child calls `step_verdict` twice | The tool already refuses the second with «the verdict is already recorded … stop now» (`workflow-verdict.ts:43-50`); the first wins. |
| 3 | The reminder child throws (`SubagentFailure`) | The existing catch (`:1836-1851`) yields `error: <message>` with the partial report — never a silent `no verdict`. |
| 4 | The reminder hits the cap | `budget_hit` → run `stopped: budget` with the driver's sentence (`workflow-machine.ts:330-337`), same as a first-run budget hit. |
| 5 | The step's `tokens` already spent by the first run | No reminder (`remaining ≤ 0`), `fail: no verdict`; the child did not hit the runner's cap, it merely used up the step's. |
| 6 | The run is cancelled / the session closes between the two runs | `signal` is already aborted → `planVerdictReminder` returns `undefined`; `cutEvent` (`:1719-1727`) then reports `cancel`/`interrupted`. A throw from the second run lands in the same catch. |
| 7 | Disposed mid-reminder | `run.controller.signal` is the same signal the child got; the abort path is #6. |
| 8 | A harness child (structured verdict) | It never reaches the no-verdict branch when `caps.structuredResult` is set (`harness/child.ts:239-250`); when it does (no `structuredResult`), a second harness run is a normal child turn. |
| 9 | Two children under one step identity | `agentId`/`toolCallId` only attribute asks; `subagent_start` carries no id (`subagent.ts:446-452`), so no row is duplicated or orphaned. |
| 10 | An older daemon + new client, or the reverse | No new field and no meaning change: the reason is a longer STRING in an existing field (`session.ts:851`), so both directions render it as text. |
| 11 | A step is retried after a `no verdict` | Nothing new: `retry`/`on_fail` count executions as today; each attempt creates its own verdict slot (`:1774`) and gets at most one reminder. |
| 12 | The reason is 2 000 chars × a wrapping kv row | The wire cap is 2 000 (`session.ts:851`) and the client caps it again (`client/src/workflows.ts:63`); the row wraps, exactly like an approve denial does today (`workflow-step-detail.ts:336-341`). |

A silent drop is designed out: every path that does not get a verdict ends in a
`step_result` (fail) or a `budget_hit`, both of which the machine turns into a logged
step and a run-level sentence.

### Tests

Red-before-green, with the existing fakes (`SpyBroker`, `FakeClock`, `ChildScript`,
`setup()` — `packages/agent/test/workflow-driver.test.ts:39-183`). The driver's fake
runner dispatches by step id (`:147-152`), so a two-call script keeps its own counter.

1. **`a child that ends without a verdict is asked ONCE, and its late verdict ends the
   step`** (driver) — the script returns no verdict the first call and calls
   `step_verdict(pass, "late")` the second; asserts `runs === 2`, the second call's
   `opts.prompt` contains `step_verdict`, the step ends `ok`, the reason is `late`,
   and the tokens are the SUM of both runs (proves the shared accumulator). **Red
   today: `runs === 1`.**
2. **`a child that ignores the reminder fails no verdict`** (driver) — the existing
   test at `:330-341` extended: `runs === 2` and `reason ===
   "no verdict — the step ended without calling step_verdict"`. **Red today** (the
   run count and the sentence).
3. **`a child that hit its token budget is NOT reminded`** (driver) — script returns
   `stopReason: "max_token_budget"`; `runs === 1` and the run ends `stopped` /
   `stopReason: "budget"`. **Red today** only after the fix would exist the other way
   round: mutate the gate to remind here and this test fails (non-vacuity, §9).
4. **`the reminder gets the step's REMAINING budget`** (driver) — the workflow YAML
   sets `tokens: 100`, the first run reports 60 usage, the second run is asked to
   assert `controls.maxTokens === 40`. **Red today** (`runs === 1`).
5. **`a step whose budget is already spent is not reminded`** (driver) — `tokens: 10`,
   the first run reports 15; `runs === 1`, step `error`, reason the sentence.
6. **`a cancelled run is not reminded`** (driver) — `driver.stop("wf-1")` while the
   first child runs; `runs === 1` and the run stops `cancelled`. **Red today** only
   by mutation (the gate is what it pins).
7. **`planVerdictReminder`: the pure gates** (new
   `packages/agent/test/workflow-verdict.test.ts`) — aborted ⇒ `undefined`; spent
   budget ⇒ `undefined`; `tokens` absent ⇒ no `maxTokens`; the prompt carries the
   report's LAST chars, capped at `STEP_REMINDER_REPORT_MAX`, and says
   `step_verdict`; an empty report adds no report block. **Red today** (the function
   does not exist).
8. **`a failed step's reason is a `Reason` row in the body`** (mobile,
   `apps/mobile/test/workflow-step-layer.test.ts:452` block) —
   `stepBody(...)` kv contains `["Reason", "no verdict — …"]` for an `agent` step and
   does NOT contain a second one for a denied `approve` step (its answer block keeps
   the only `Reason`). Plus: the row is present while `detail` is `undefined`
   (no reflow when the read lands). **Red today** — the repro prints
   `[["State","error"],["Kind","agent"],["Where","local"]]`.
9. **`the TUI paints a failed step's reason`** (tui,
   `packages/tui/test/workflow-frames.test.tsx`, whose fixture already carries
   `reason: "REQUEST-CHANGES"` at `:51`) — the frame contains that string in the rail
   row and in the panel column. Green today: a regression guard for the reason text,
   not the fix's red test.
10. **Non-vacuity (§9)**, done once and reported in Execution: (i) drop the reminder
    gate → test 1 fails; (ii) move the reason back into the log block → test 8 fails;
    (iii) fire the reminder on `max_token_budget` → test 3 fails. Revert each.
11. **Two existing skeleton tests pinned the old shape and were updated** (drift,
    recorded in Execution): `apps/mobile/test/workflow-morph-skeleton.test.ts` — the
    kv label list gains `Reason` (7 → 8 bars, `:265-280`) and the log-line-height case
    now supplies its log from a read (`detailBlocks` no longer makes one, `:306-316`).

Iterate with `bun test packages/agent/test/workflow-driver.test.ts` (+ the new pure
file, the mobile file, the TUI file); full `bun run check` before done (§4).

## Execution

*— claude-sonnet-4-5 (executor), 2026-11-26*

Worktree `.tentacle/worktrees/workflow-no-verdict`, branch `fix/workflow-no-verdict`
(HEAD `f2567452`, the plan commit). No `git` state was changed.

**Load-bearing check — PASSED, statically and empirically.** `SubagentRunner` is a
plain `(opts, controls) => Promise<SubagentResult>` with no conversation carried
(`packages/agent/src/subagent.ts:148-152`, `:267-270`), the verdict slot is created
ONCE before any run (`workflow-driver.ts:1774`, closed over `recorded` by the tool,
`workflow-verdict.ts:22-60`, first valid call wins), and both runs report
`subagent_usage` into the SAME `tokens` closure, which is what `step_result` carries
and the machine adds to the run (`workflow-machine.ts:344-345`). The repro below
confirms it: two runs → the run's `tokens` is the SUM (test 1 asserts 30 = 15 + 15).

**Repro before** (`bun .tentacle/tmp/workflow-no-verdict/repro.ts`, pasted per §6):

```
driver: child runs = 1
driver: step = {"id":"write",…,"state":"error",…,"reason":"no verdict"}
mobile: kv rows = [["State","error"],["Kind","agent"],["Where","local"]]
mobile: log block = ["prompt:","write it","report:","I think it works. PASS"]
```

**Repro after**: `child runs = 2`, `reason: "no verdict — the step ended without
calling step_verdict"`, `kv rows = [["State","error"],["Kind","agent"],["Where","local"],
["Reason","no verdict"]]`.

### As built, in order

1. **Tests first (red).** `packages/agent/test/workflow-driver.test.ts` — the existing
   `no verdict` test extended + 5 new ones (late verdict & token sum, budget-capped not
   reminded, remaining budget, spent budget, cancelled not reminded). Run before any
   production edit: **4 fail / 50 pass**, on the assertions the fix must move
   (`Expected: 2, Received: 1` for `runs`; `Expected: "no verdict — …", Received:
   "no verdict"`; `caps` `[100]` vs `[100, 40]`). Not on an import.
2. **Slice (a) — `packages/agent/src/workflow-verdict.ts`**: `NO_VERDICT_REASON`,
   `STEP_REMINDER_REPORT_MAX` (4 000), `StepReminder`, `planVerdictReminder` (pure: the
   `aborted` gate, then the remaining-budget gate, then the prompt = sentence + the
   report's LAST chars), and the tool description's «A PASS/FAIL line in your text is
   NOT a verdict» sentence. New `packages/agent/test/workflow-verdict.test.ts` (7 tests:
   every gate, the cap, the empty report, the sentence).
3. **Slice (a) — `packages/agent/src/workflow-driver.ts`**: `agentStep` now builds one
   `requester` + a local `runChild(prompt, maxTokens)` (same `onEvent` accumulator,
   `agentId`, `toolCallId`, `extraTools`), then: verdict → `step_result`;
   `max_token_budget` → `budget_hit`; `planVerdictReminder` → one more turn under a
   `live: "asking for a verdict"` line; its verdict → `step_result`, its
   `max_token_budget` → `budget_hit`, still nothing → `fail: NO_VERDICT_REASON`. The
   kept report is the first run's, the reminder's only when the first was empty
   (decision 2). Driver file: **54 pass**.
4. **Slice (b) — `apps/mobile/src/workflow-skeleton.ts`**: `detailBlocks` appends a
   `Reason` kv row (`oneLine`d, absent when empty, **excluded for `approve`**) and no
   longer returns a log from the row (`log: []`). Mobile: **5435 pass**.
5. **Slice (c)**: `packages/core/src/workflow-templates.ts:113` (review prompt ends the
   step with the tool; a PASS/FAIL line is not a verdict),
   `packages/tools/src/workflow.ts:52` (`DESCRIPTION` gains the contract + the reminder
   + «never ask for a text PASS line»), `workflow-verdict.ts` tool description (step 2).
6. **Docs**: `docs/feat/agent-workflows.md` D3 and failure-mode row 4 record the
   reminder, the skipped cases and the new sentence. Changelog:
   `changelog.d/workflow-no-verdict.fixed.md` (one `fixed` bullet). No protocol change
   (`reason` was already `WorkflowStepRow.reason`), so no `protocol.d/` note and no
   schema regeneration; no TUI code change.
7. **Non-vacuity (§9) — three mutations, each run and reverted** (results below).

### Drift from Implementation (and why)

- **Files item 5, second half did not exist.** The plan said to drop `log:
  logLines(step.reason)` at `workflow-step-detail.ts:387`; there is no such call site —
  the input is the ONE line inside `detailBlocks` (`workflow-skeleton.ts:269`), which
  `stepBlocks` already overrides. So the change is `detailBlocks` returning `log: []`,
  and `workflow-step-detail.ts` is untouched. The doc's Files item now says so.
- **Two existing tests pinned the old shape** and were updated (Tests item 11):
  `apps/mobile/test/workflow-morph-skeleton.test.ts` — the kv label list gains `Reason`
  (7 → 8 bars) and the log-line-height case now supplies its own log, because
  `detailBlocks` no longer produces one. Both failed as predicted before the update
  (`Expected 7 / Received 8`; `Expected length: 3 / Received length: 0`).
- **`NO_VERDICT_REASON` replaced the two literals** in the driver as planned; nothing
  else in the repo held `"no verdict"` except the old driver test (now asserting the
  sentence) and doc prose.

### Mutation checks (§9 / Tests 10)

| # | Mutation | Result |
|---|---|---|
| i | `if (reminder !== undefined && false)` — drop the reminder gate | **3 fail** (`reminded ONCE`, `tokens land in ONE sum`, `REMAINING budget`), 51 pass |
| ii | `detailBlocks`: Reason row off, `log: logLines(step.reason)` back | **2 fail** (`Reason row`, `multi-line reason`), 37 pass |
| iii | `if (first.stopReason === "max_token_budget" && false)` | **1 fail** (`a child that hit its token budget is NOT reminded`), 53 pass |

All three reverted; the suites are green again afterwards.

### Verification actually run here

- `bun test packages/agent/test/` — 1029 pass, 0 fail (after the revert).
- `bun test apps/mobile/test/` — 5435 pass, 0 fail.
- `bun test packages/tui/test/workflow-frames.test.tsx` — 15 pass (incl. the new rail +
  panel reason guard, Tests 9).
- `bun test packages/core/test/workflow-draft.test.ts` + the two mobile files + the TUI
  file — 133 pass.
- Scoped typechecks: `bunx tsc --noEmit -p packages/agent`, `-p packages/core`,
  `-p packages/tools`, `-p apps/mobile` — all clean.
- `bunx biome check` on the 11 changed files — clean.
- **Not run here (by the owner's budget):** the full `bun run check` (whole-repo
  typecheck + lint + parallel suite). The orchestrator runs it; nothing else was
  touched, and the four scoped typechecks + the changed-file lint are clean.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context, a different model family from the
executor — sonnet)

**Verdict: REQUEST-CHANGES** (1 MEDIUM).

**Findings**

1. **MEDIUM — a reminder that runs out of the step's remaining budget stops the whole
   run as `budget`, and the cause (no verdict) disappears.**
   `workflow-driver.ts:1861` maps a reminder that ends `max_token_budget` with no
   verdict to `budget_hit`. The reminder's cap is the REMAINDER
   (`workflow-verdict.ts:103`), and its first round alone costs a full prompt (system
   prompt + tools + a tail of up to 4 000 chars). `Agent` ends any round that goes over
   the cap as `max_token_budget`, even a prose-only one (`agent.ts:1941`). Example:
   `tokens: 20000`, run 1 spends 16 000 and ends with the text «PASS»; the reminder gets
   4 000 tokens, answers in prose again, and its first round goes over. The step gets
   `budget_hit`, and the machine stops the run `budget` (`workflow-machine.ts:328-337`).
   No `retry` and no `on_fail` run, and the reason is «step X reached its token budget».
   Before this change the same step failed `no verdict` and the `retry`/`on_fail` rules
   ran. So, under a tight remainder, the fix makes its own target case worse: a model that
   ignores the tool is exactly the kind that ignores the reminder too. Failure mode 4
   accepted this case but missed that a small remainder makes it likely, and that it
   hides the reason that (b) is meant to show. Fix: without a verdict, a reminder
   that ends `max_token_budget` should end `fail: NO_VERDICT_REASON`, because the first
   run did not hit the cap. Or skip the reminder below a minimum remaining budget. Add a
   driver test for it (second call returns `max_token_budget` with no verdict → step
   `error`, `retry`/`on_fail` still apply).

**Gate (run here):** touched files (driver, verdict, 2 mobile, TUI frames) **138 pass /
0 fail**; `bun run lint` clean (2554 files); `bun run typecheck` clean (root + mobile +
relay). I did not run the full parallel suite.

**Mutation non-vacuity** (each reverted; `cmp` against the backups shows the files are
byte-identical, and `git status` is clean):
A. drop the `aborted` gate → 5 fail (incl. `cancelled run is not reminded`, `stop`/`dispose`/`timeout`).
B. reminder cap = full `tokens` → 2 fail (`REMAINING budget`, pure gate).
C. the step keeps the reminder's report → 1 fail (`tokens land in ONE sum`, report assertion).
The executor's mutations i–iii cover the remaining properties.

**Attacks tried**
- Single broker (§7): the reminder reuses the ONE `stepRequester`. Its asks carry the
  same `agentId` and `budget.wait`. Holds.
- Abort or timeout between the two runs: `signal` combines `run.controller` and
  `stepAbort` (an ask timeout aborts `stepAbort`). The gate sees it, and `cutEvent`
  still overrides the result. Holds (mutation A).
- `live` is left set: «asking for a verdict» is cleared by the step-end `setStep`
  (`live: undefined`). Holds.
- Retry or a new attempt shows the old reason on the phone: the step start clears
  `reason`. Holds.
- Harness child: only `claude-code` exists (`structuredResult: true`). The reminder
  there is a second full external run in a NEW snapshot worktree, and its
  worktree/cost footer is dropped because the step keeps run 1's report. This is
  low-impact and not blocking, but worth a note in the docs.
- Other callers of mobile `detailBlocks().log`: only `stepBlocks` uses it, and it
  overrides `log`. Holds.
- Protocol: no new field, and `reason` is already in `WorkflowStepRow`. No
  `protocol.d/` note is needed. Holds.

**Executor behaviour:** wrote the tests first and showed them failing, kept the logic in
the pure module, recorded the drift honestly, and listed the full gate as not run.
Clean work. The one gap is a design choice the plan made (Failure mode 4), not a
slip in execution.

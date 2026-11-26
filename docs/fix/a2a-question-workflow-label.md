# fix/a2a-question-workflow-label — a remote question keeps its workflow label

> **Status:** implementation (approved) · **Branch:** `fix/a2a-question-workflow-label`
> **Type: fix · Size: S · Blast: cross-module · Suited: DeepSeek** (execute), standard in-context Review (§10: cross-module, not load-bearing)
> **Changelog:** `changelog.d/a2a-question-workflow-label.fixed.md` — user-visible (the phone's run screen labels a remote question as the run's own).

## Context

*— claude (model id not exposed by this harness), 2026-11-26*

Found in the merge review of `feat/a2a-client` (TODO.md:19, LOW). A remote A2A agent's question (`docs/feat/a2a-client.md` C6) raised **inside a workflow agent step** loses its run attribution on the way to a surface:

- the workflow driver tags **every** ask a step raises with the step's structured origin — `workflow: {name, runId, stepId, index, count}`, applied **after** `...options` so a child cannot claim another's (`packages/agent/src/workflow-driver.ts:1811-1821`, returned through `this.deps.request` at `:1841-1850`) — and a remote question goes through exactly that requester (`packages/agent/src/harness/permissions.ts:296-310` calls `perms.requester`, which for a step is `stepRequester`, `workflow-driver.ts:1930-1931`);
- the daemon's `toAskUpdate` forwards `workflow` **only** for a permission request (`packages/daemon/src/permission-map.ts:127-139`; the comment at `:134-135` says the field has no place to go);
- `question_request` indeed has no such field (`packages/protocol/src/question.ts:45-64`), so a client cannot recover it: the router reads `workflow` only off a `permission_request` (`packages/client/src/permission-router.ts:428-429`).

Effect on the phone: the run screen pairs an ask with a step by the **structured origin first** and by the `<runId>.<stepId>` agent id only as a fallback for an older daemon (`apps/mobile/src/workflow-run-controller.ts:115-141`). A remote question's agent id is the *child's* (`sa-N`, set by `subagentRequester`, `packages/agent/src/subagent.ts:248-258`), never `<runId>.<stepId>` — so the ask falls through to the `foreign` bar («Open the session», `workflow-run-controller.ts:255-282`, `screens/WorkflowRun.tsx:92-110`). The question is still asked and answerable (via the session's sheet) — it just is not shown over the run it belongs to, which C6's whole point was.

**Repro** (2026-11-26, current `main` = `07a0c2ca`, script `.tentacle/tmp/a2a-question-workflow-label/repro.ts`, imports by relative path so it needs no workspace link):

```ts
import type { PermissionRequest } from "@tentacle/core";
import { toAskUpdate, toPermissionRequestUpdate } from "../../../packages/daemon/src/permission-map.ts";
import { type AskUpdate, PermissionRouter } from "../../../packages/client/src/permission-router.ts";
import { askForRunStep } from "../../../apps/mobile/src/workflow-run-controller.ts";

const wf = { name: "rassegna", runId: "wf-1", stepId: "generate", index: 1, count: 5 };
const question: PermissionRequest = {
  kind: "question", tool: "a2a:acme", level: "ask", title: "acme asks",
  detail: "Remote question: which branch?", input: {}, reply: { maxChars: 4000 },
};
const approval: PermissionRequest = { tool: "shell", level: "ask", title: "Run", input: {} };
const agent = { type: "a2a:acme", description: "review", id: "sa-1" }; // the child's own id

const q = toAskUpdate("r-q", "c1", question, agent, wf);
const p = toAskUpdate("r-p", "c1", approval, undefined, wf);
console.log("1. question_request.workflow   =", JSON.stringify((q as { workflow?: unknown }).workflow));
console.log("   permission_request.workflow =", JSON.stringify((p as { workflow?: unknown }).workflow));
for (const a of new PermissionRouter().request("S", q as AskUpdate, "t1")) {
  if (a.kind === "prompt") console.log("2. router prompt.workflow     =", JSON.stringify(a.workflow),
    "\n   router prompt.agent        =", JSON.stringify(a.agent));
}
const asks = [{ requestId: "r-q", agent: { id: agent.id }, title: "acme asks", detail: "" }];
console.log("3. askForRunStep(wf-1/generate) =", JSON.stringify(askForRunStep(asks, "wf-1", "generate")));
```

Output on current `main`:

```
1. question_request.workflow   = undefined
   permission_request.workflow = {"name":"rassegna","runId":"wf-1","stepId":"generate","index":1,"count":5}
2. router prompt.workflow     = undefined
   router prompt.agent        = {"type":"a2a:acme","description":"review","id":"sa-1"}
3. askForRunStep(wf-1/generate) = undefined
```

Line 1 is the defect, line 2 the client's only source of the label, line 3 the phone's failure to pair (⇒ `foreign`). Line 3 is also why the **agent id cannot be the fix**: `sa-1` is not `<runId>.<stepId>`, and `askForStep` is an exact match by design (`packages/client/src/workflows.ts:212-222`).

The decision this serves: one additive field, one source of truth (the driver's origin), so a question of a run is shown as that run's — with **no** version bump (§7: fields are free).

## Implementation

*— claude (model id not exposed by this harness), 2026-11-26* — **APPROVED** (owner delegated the open questions; each recommendation below is the decision).

#### Orchestrator decisions

- **D1 — the field mirrors `permission_request.workflow`, extracted into ONE shared schema.** Move the inline object at `packages/protocol/src/permission.ts:89-97` to an exported `AskWorkflowSchema` and reference it from both update schemas. *Reason:* the two wire types cannot drift, and both ends already sanitize exactly this five-key shape.
- **D2 — no `PROTOCOL_VERSION` bump and no `protocol.d/` note.** An optional field on an existing update is a "free" field (§7): the schemas are strip schemas, so an older client drops it and behaves as today, and an older daemon sends none. *Reason:* nothing changes meaning and no update class changes; a note is for a break.
- **D3 — the daemon forwards `options.workflow` as given; nothing is derived from `agent.id`.** *Reason:* the driver is the only place that knows the step's position and it already overrides a child's claim (`workflow-driver.ts:1811-1821`); a second derivation would be a second truth.
- **D4 — the run screen's bar says «Answer» for a question and its tap opens the sheet's own text field.** The choice is taken in the pure `askBarFor` (`AskBar` gains `action: "review" | "answer"`), the component only prints it, and the tap goes through the ONE resolve path the controller already uses (`answerFor`, `workflow-run-controller.ts:550-557`) — never a second send. *Reason:* §7 (branching in a pure module, component renders) + «never a second resolve path» (`workflow-run-controller.ts:14-18`).
- **D5 — `answerFor(requestId, "reply")` opens the field and unparks, and does NOT honour the age guard.** *Reason:* the guard protects a *decision* from a stray tap; opening a text field sends nothing, and the send (`sendReply`) stays guarded (`permission-sheet.ts:612-620`). Keyed on `requestId`, it can never touch another ask.
- **D6 — scope stays at S as pinned by the TODO/owner** even though eight files move: every diff is the same field threaded, ≤25 lines each, and anything not listed under *Files* is out of scope. *Reason:* the approach is fully specified; widening it is a new task.
- **D7 — no TUI change.** The TUI's prompt does not render an ask origin (no `askOrigin` caller outside the phone, `packages/client/src/ask-origin.ts:59`). *Reason:* nothing to display there; adding a second renderer is not this fix.
- **D8 — a push banner still names no run.** `PushAsk` carries title/preview/options only (`apps/mobile/src/push-render.ts:113-175`, `packages/daemon/src/push-notifier.ts:325`). *Reason:* the banner's own vocabulary is a separate surface; recorded as a follow-up, not silently half-done.

### Load-bearing assumption

**The workflow origin reaches the daemon's ask for a remote question exactly like it does for a permission request — so only the mapper and the schema drop it.** Proven, not assumed:

- the a2a question is asked through `perms.requester` with no `workflow` of its own (`packages/agent/src/harness/permissions.ts:296-310`), and `subagentRequester` forwards `...rest` while setting only `agent`/`signal`/`withdraw` (`packages/agent/src/subagent.ts:246-258`);
- for a step, that chain ends in `stepRequester(run, step.id)` (`packages/agent/src/workflow-driver.ts:1930-1931`), which passes `workflow` **after** `...options` to `this.deps.request` (`:1841-1848`) — `deps.request` is the session's `PermissionRequester` (`:315`);
- in the daemon, both ask paths already receive it and hand it to `toAskUpdate` — the turn path (`packages/daemon/src/hosted-session.ts:1573-1576`) and a background child's (`:1749-1756`) — which routes it to the permission branch only (`packages/daemon/src/permission-map.ts:127-139`).

So the fix is: schema field + one mapper argument + one router read. If the executor finds `workflow` absent in a step's question at the daemon (step **2** of the repro, after the mapper is fixed), the assumption is false — **stop and report**, do not derive the origin from `agent.id` (D3).

### Preconditions

- `AskUpdate` is the union of the two updates and the router holds both in ONE queue (`packages/client/src/permission-router.ts:39-41`); both carrying an optional `workflow` of the same shape makes line `428-429` a plain read (`entry.update.workflow`) — no cast.
- The router's `prompt` action's `workflow` is delivered to the broker as `options.workflow` (`packages/client/src/remote-client.ts:4999-5006`), and the phone's sheet builds the origin from it (`apps/mobile/src/permission-sheet.ts:392-395`). That is the ONLY hop from the wire to the run screen's pairing.
- `askOrigin` prefers `workflow` over `agent` and bounds it (`packages/client/src/ask-origin.ts:59-80`); `askForRunStep` pairs on `origin.kind === "workflow" && runId && stepId` (`apps/mobile/src/workflow-run-controller.ts:115-141`).
- The question surface already renders a question correctly: options `Answer…`/`Skip` (`permission-sheet.ts:244-255`), card actions `Skip` + `Answer…` (`apps/mobile/src/ask-card.ts:96-130`). This fix changes **nothing** about how a question is answered.
- Questions are never resumable (`hosted-session.ts:1583-1587`), so nothing on disk gains a field: no `DAEMON_STATE_VERSION`/log-schema change (§7 persistence rule). A pending ask reaches a late client from the replay ring the emitted update went into (`attach` → `replayFrom`, `hosted-session.ts:2488-2499`), and a `session/watch` state from `ask.update` (`:3468-3470`) — both the ONE update object built at the ask, so the label survives a re-attach.
- `question_request` is `blocking` (`packages/protocol/src/updates.ts:583`); its class does not change, and its "declared by a client, else fallback" rule is untouched (`packages/protocol/src/question.ts:7-14`, `hosted-session.ts:1560-1571`).
- `protocol.json` is generated: the branch must run `bun run schema:export` and commit the diff, or `packages/protocol/test/json-schema.test.ts:38-40` (the drift gate) fails (§6/§10).

### Design

One additive field, threaded through the existing seams — no new update, no new method, no new class.

1. **Protocol (one truth).** `packages/protocol/src/permission.ts`: extract the inline `workflow` object (`:89-97`) to `export const AskWorkflowSchema = z.object({ name: z.string(), runId: z.string().optional(), stepId: z.string().optional(), index: z.number().optional(), count: z.number().optional() })` (identical keys — no `.max()`/`.int()`, that update is blocking) and use it in `PermissionRequestUpdateSchema`. `packages/protocol/src/question.ts`: `workflow: AskWorkflowSchema.optional()` in `QuestionRequestUpdateSchema`, with the same doc comment (display only, absent on an older daemon or a non-workflow ask).
2. **Daemon.** `packages/daemon/src/permission-map.ts`: one private `workflowOrigin(workflow)` that builds the five keys field-by-field and drops the whole thing unless `typeof workflow.name === "string"` (lifted verbatim from `:78-90`); both builders use it. `toQuestionRequestUpdate` gains the `workflow` parameter; `toAskUpdate` passes it to **both** branches and the `:134-135` comment is replaced by «the question carries it too (docs/fix/a2a-question-workflow-label.md)». Both hosted-session call sites already pass `options?.workflow` — no daemon change beyond the mapper.
3. **Client.** `packages/client/src/permission-router.ts:428-429`: `const workflow = entry.update.workflow;` (both members have it), comment updated. The bounding block (`:448-459`) is unchanged — a pod's numbers still go through `progressText`/`Number.isFinite`.
4. **Phone, one tap to the field.** `apps/mobile/src/permission-sheet.ts` `answerFor` (`:590-605`): handle `"reply"` — commit `{...state, parked: false, replyOpen: true, replyText: ""}` and return `"typing"`, only when `state.requestId === requestId` and the option is offered; never settle, never send. `apps/mobile/src/workflow-run-controller.ts`: `CardAsk` gains `question?: boolean` (set in `askSourceFromSheet` from `view.request.kind === "question"`, `:130-157`); `AskSource.answerFor`'s `optionId` becomes `"allow_once" | "reject_once" | "reply"` (`:89-95`, `:128-135`); `AskBar`'s `ask` variant gains `action: "review" | "answer"`, decided in `askBarFor` from `ask.question` (`:255-282`) — `foreign` and `open-session` are unchanged; new `openAnswer()` beside `reviewAsk()` (`:559-561`) which calls `deps.asks?.answerFor(ask.requestId, "reply")` for the bar's ask and raises `RUN_ASK_GONE` on `"ignored"`.
5. **Screen (presentation only).** `apps/mobile/src/screens/WorkflowRun.tsx`: `AskPanel` prints `bar.action === "answer" ? "Answer" : "Review"` for `kind: "ask"` (`:92-110`) and calls a new `onOpenAnswer` prop (`:56`); `apps/mobile/App.tsx:2203` wires `onOpenAnswer={() => controller.openAnswer()}` next to `onReviewAsk`. **Plan corrected during Execution:** the prop was planned as `onAnswerAsk`, which the existing wiring guard `expect(RUN).not.toContain("onAnswer")` (`apps/mobile/test/workflow-screens-wiring.test.ts:53`, pinning "no inline answer on the run screen") forbids by substring; renamed, behaviour identical.
6. **Changelog fragment** `changelog.d/a2a-question-workflow-label.fixed.md` (one bullet: a remote agent's question inside a workflow step is shown over its run, with `Answer`).

### Files

| # | File | Change |
|---|------|--------|
| 1 | `packages/protocol/src/permission.ts` | export `AskWorkflowSchema` (extracted from `:89-97`), use it |
| 2 | `packages/protocol/src/question.ts` | `workflow: AskWorkflowSchema.optional()` in `QuestionRequestUpdateSchema` (`:45-64`) |
| 3 | `packages/protocol/schema/protocol.json` | regenerated only (`bun run schema:export`) |
| 4 | `packages/daemon/src/permission-map.ts` | shared `workflowOrigin`; `toQuestionRequestUpdate(..., workflow?)`; `toAskUpdate` forwards to both (`:101-139`) |
| 5 | `packages/client/src/permission-router.ts` | read `entry.update.workflow` for both types (`:428-429`) |
| 6 | `apps/mobile/src/permission-sheet.ts` | `answerFor(..., "reply")` opens the field + unparks (`:590-605`) |
| 7 | `apps/mobile/src/workflow-run-controller.ts` | `CardAsk.question`, `AskSource` argument, `AskBar.action`, `openAnswer()` (`:78-160`, `:255-282`, `:550-561`) |
| 8 | `apps/mobile/src/screens/WorkflowRun.tsx` | label + `onOpenAnswer` prop (`:49-60`, `:92-110`; renamed from `onAnswerAsk`, see Design 5) |
| 9 | `apps/mobile/App.tsx` | wire `onOpenAnswer` (`:2196-2207`) |
| 10 | `changelog.d/a2a-question-workflow-label.fixed.md` | new fragment |
| 11 | tests (see *Tests*) | 6 files, new cases only |

Dependency order for the executor: 1 → 2 → 3 → 4 → 5 (the gate is green here) → 6 → 7 → 8 → 9 → 10 → tests per slice (§4: run the one file).

### Failure modes

| Case | Convergence |
|---|---|
| **Older client, new daemon** | strip schema drops `workflow` (`packages/protocol/test/question.test.ts:39-43`); the question shows as today (session sheet, `foreign` on a run screen). No error, no half-state. |
| **New client, older daemon** | no `workflow` → `askForRunStep` falls back to the exact `agent.id` match, which a remote question's `sa-N` does not satisfy → `foreign` («Open the session»), i.e. today's behaviour. Never a wrong pairing (exact match, `workflows.ts:212-222`). |
| **A pod forges `workflow`** (AGENTS §7: not trusted) | display only: the daemon rebuilds the five keys field-by-field and drops a non-string `name`; the router bounds with `progressText`/`Number.isFinite`; `askOrigin` cuts 64/64 and validates `index`/`count` (`ask-origin.ts:33-56`). It never feeds a decision, an option set, or a grant. |
| **The step left the spec** (a rerun from an edited file) | `origin.stepId` matches no card → `foreign`; still answerable in the session. No throw, no skeleton. |
| **Answered elsewhere first, then the bar is tapped** | the sheet's `answerFor` refuses an id it does not hold (`permission-sheet.ts:591-593`) → `"ignored"` → `RUN_ASK_GONE`, nothing sent (existing behaviour, `:264-276` tests). |
| **Two asks race; the sheet moved on** | `answerFor` is keyed on `requestId`: opening the field can never touch the other ask, and `sendReply` validates against the ask on screen. |
| **Nobody attached (push only), then attach** | the ask is replayed from the ring the emitted update went into (`hosted-session.ts:2488-2499`; `session/watch` from `ask.update`, `:3468-3470`), label included — the fix is in the update built once, not in a second path. |
| **A client that did not declare `question_request`** | unchanged blocking fallback: skipped at raise with the reason (`hosted-session.ts:1563-1571`). The new field changes no class. |
| **Empty `index`/`count` or hostile numbers** | no `.int()`/`.max()` on the schema (blocking update must parse), `askOrigin` yields `position: null` → the label simply omits «n of m». |
| **Protocol drift gate** | `protocol.json` regenerated and committed with the branch; `bun run schema:export` is the only writer. |

### Tests

Red before green — each case names the mutation that must turn it red (§9). Fake/injected seams only; no real I/O.

**Protocol — `packages/protocol/test/question.test.ts`**
- a question with `workflow` parses and round-trips the five fields; **an update WITHOUT `workflow` still parses** (older daemon). Mutation: make the field required → red.
- hostile numbers (`index: -1`, `count: 1e9`, a float) and a 10 000-char name still parse. Mutation: add `.int()`/`.max()` → red (this update is blocking).
- the existing "unknown field is dropped" case stays green (it pins that an *older* client loses the label, not the question).

**Daemon — `packages/daemon/test/permission-map-workflow.test.ts`** (mirror the permission cases at `:14-70`)
- `toQuestionRequestUpdate("r1","c1",question,undefined,wf).workflow` equals `wf` and `QuestionRequestUpdateSchema` accepts it. Mutation: revert the mapper argument → red (this is repro line 1).
- absent stays absent (`"workflow" in update === false`). Mutation: unconditional key → red.
- field-by-field: a forged `{...wf, trusted: true}` loses the extra key; a non-string `name` drops the whole field. Mutation: a spread → red.
- `toAskUpdate` forwards to the **question** branch (and the permission branch still gets it). Mutation: the current `:137-138` two-argument call → red.

**Daemon — `packages/daemon/test/question-ask.test.ts`** (end-to-end, through `SessionHost`)
- raise the fake question with `workflow` in the requester options (the harness at `:64-104`) → the streamed `question_request` carries it and parses; the permission path is unchanged. Mutation: the daemon forwarding reverted → red.

**Client — `packages/client/test/question-map.test.ts` / `permission-router.test.ts`**
- the router's `prompt` for a `question_request` carries `workflow` bounded by `progressText` (a hostile name/stepId is cut, a non-finite `index` is dropped). Mutation: keep `:428-429`'s `type === "permission_request"` guard → red.

**Phone — `apps/mobile/test/workflow-run-controller.test.ts`** (fakes at `:52-120`)
- a question whose origin names `wf-1/generate` pairs with that step card and the bar's `action` is `"answer"`; an approval's is still `"review"`. Mutation: hard-code `"review"` → red.
- its tap calls `answerFor(requestId, "reply")` with THAT id and sends no allow/reject. Mutation: route it through `allow_once` → red.
- a question of **another** run stays `foreign` («Open the session»). Mutation: drop the `runId` test in `askForRunStep` → red.
- an ask settled meanwhile → `RUN_ASK_GONE`, nothing sent.

**Phone — `apps/mobile/test/permission-sheet-question.test.ts`**
- `answerFor(id, "reply")` on a *parked* question unparks and opens the field, returns `"typing"`, settles nothing (no `session/answer_question`); a different `requestId` → `"ignored"`; `sendReply` with blank text still sends nothing (unchanged guard). Mutation: settle on "reply" → red.

**Phone — `apps/mobile/test/workflow-screens-wiring.test.ts`** (source-text, cheap)
- the run screen takes `onOpenAnswer`, `App.tsx` passes it, `AskPanel` prints from `bar.action` (`"Answer"`/`"Review"`, both literals present — the existing guard at `:57` pins `"Review"`). This is a wiring pin only — the behaviour is proven by the controller test above.

Gate: `bun run test` + `bun run typecheck` + `bun run lint` (§4), narrow files during iteration. Repo style: double quotes, trailing commas, no `!`.

## Execution

*— claude (model id not exposed by this harness), 2026-11-26*

Branch `fix/a2a-question-workflow-label` off `main` (`98d9a14c`, the plan commit).

**Load-bearing check first.** The Context's repro was re-run on the branch (script
`.tentacle/tmp/a2a-question-workflow-label/repro.ts`, in the owner-designated
scratch dir, imports by ABSOLUTE path into this worktree — the doc's relative
paths resolved against the main checkout, a different tree). Output, before any
edit — identical to the doc:

```
1. question_request.workflow   = undefined
   permission_request.workflow = {"name":"rassegna","runId":"wf-1","stepId":"generate","index":1,"count":5}
2. router prompt.workflow     = undefined
   router prompt.agent        = {"type":"a2a:acme","description":"review","id":"sa-1"}
3. askForRunStep(wf-1/generate) = undefined
```

After slices 1–5 the same script prints lines 1 and 2 as the five-key origin —
so the workflow DOES reach the daemon's question ask (the plan's load-bearing
assumption holds; nothing was derived from `agent.id`, D3). Line 3 stays
`undefined` by construction: the fake ask in that script carries no `origin`, so
that line says nothing after the fix (the pairing itself is proven by the
controller test). The script is gitignored and does not survive; its text is in
Context above with the one change noted here.

**As built, in the plan's order.**

1. `packages/protocol/src/permission.ts` — the inline five-key object extracted to
   an exported `AskWorkflowSchema` (identical keys, no `.int()`/`.max()`: the
   update is blocking), referenced by `PermissionRequestUpdateSchema`.
2. `packages/protocol/src/question.ts` — `workflow: AskWorkflowSchema.optional()`
   on `QuestionRequestUpdateSchema`, with the display-only doc comment. No
   `PROTOCOL_VERSION` edit, no `protocol.d/` note (D2: free field).
3. `packages/protocol/schema/protocol.json` — regenerated by `bun run
   schema:export` (nothing hand-edited).
4. `packages/daemon/src/permission-map.ts` — private `workflowOrigin(workflow)`
   (field-by-field, dropped unless `name` is a string) used by BOTH builders;
   `toQuestionRequestUpdate` takes `workflow` and `toAskUpdate` forwards it to the
   question branch too; the old "has no place to go" comment replaced.
5. `packages/client/src/permission-router.ts` — `const workflow =
   entry.update.workflow;` (both union members carry it, no cast); the bounding
   block untouched.
6. `apps/mobile/src/permission-sheet.ts` — `answerFor(..., "reply")` unparks,
   opens the field, returns `"typing"`, sends nothing; it does NOT consult the age
   guard (D5) and requires the reply option to be offered. The interface's return
   type gained `"typing"` and its doc comment was rewritten.
7. `apps/mobile/src/workflow-run-controller.ts` — `CardAsk.question`,
   `askSourceFromSheet` sets it from `view.request.kind === "question"`,
   `AskSource.answerFor` accepts `"reply"` and returns `"typing"`, `AskBar`'s
   `ask` variant gained `action: "review" | "answer"` (decided in `askBarFor`),
   new `openAnswer()` beside `reviewAsk()` (raises `RUN_ASK_GONE` when the sheet
   answers `"ignored"`).
8. `apps/mobile/src/screens/WorkflowRun.tsx` — `AskPanel` prints
   `bar.action === "answer" ? "Answer" : "Review"` and routes the tap to the new
   `onOpenAnswer` prop; the screen forwards it.
9. `apps/mobile/App.tsx` — `onOpenAnswer={() => controller.openAnswer()}`.
10. `changelog.d/a2a-question-workflow-label.fixed.md` (one bullet).

**Drift from Implementation (one, plan corrected in place).** The prop was
planned as `onAnswerAsk`. That name is forbidden by an EXISTING guard —
`expect(RUN).not.toContain("onAnswer")` (`apps/mobile/test/workflow-screens-wiring.test.ts`,
pinning "no inline answer on the run screen") — which failed on the first run.
Renamed to `onOpenAnswer` (behaviour identical, the guard's intent preserved
rather than relaxed); Design step 5, the Files table and the wiring-test bullet
were corrected in the doc, per §8.

**Tests (red before green).** New cases only, in the six files the plan named:
`packages/protocol/test/question.test.ts` (3), `packages/daemon/test/permission-map-workflow.test.ts`
(4 + extended assertion), `packages/daemon/test/question-ask.test.ts` (1, through
`SessionHost`), `packages/client/test/permission-router.test.ts` (2),
`apps/mobile/test/workflow-run-controller.test.ts` (5), `apps/mobile/test/permission-sheet-question.test.ts`
(4), `apps/mobile/test/workflow-screens-wiring.test.ts` (1). The controller
harness's `answerFor` fake now mirrors the sheet: `"reply"` returns `"typing"` and
keeps the ask on screen, the settle options clear it.

**Non-vacuity — every mutation the plan named, applied, run, reverted (§9):**

| Mutation | Result |
|---|---|
| `question.ts`: `workflow` required | 4 fail, incl. "round-trips … and is absent on an older daemon's update" |
| `permission.ts`: `index: z.number().int()` | 1 fail: "a bad value never makes the blocking update unparseable" |
| `permission-map.ts`: question branch without `workflow` | 1 fail: "toAskUpdate forwards it to BOTH branches" |
| `permission-map.ts`: `...workflow` spread | 2 fail: the forged-origin cases (both builders) |
| `permission-router.ts`: restore the `type === "permission_request"` guard | 1 fail: "a QUESTION carries it too, bounded the same way" |
| `workflow-run-controller.ts`: `action: "review"` hard-coded | 1 fail: "the question pairs with its step and the bar's action is `answer`" |
| `workflow-run-controller.ts`: tap routed to `allow_once` | 1 fail: "its tap opens the field BY ID and sends no allow/reject" |
| `workflow-run-controller.ts`: drop `origin.runId === runId` | 2 fail: the foreign-run pairings (the new question one + the S8 one) |
| `permission-sheet.ts`: no `"reply"` branch (settles/ignores like a grant) | 1 fail: "a PARKED question unparks and opens the field; nothing is settled" |

One test expectation was corrected against the schema rather than the code: the
hostile-numbers case used `count: Number.NaN`, which `z.number()` rejects — the
PRE-EXISTING `permission_request.workflow` behaves the same way, so the plan's
"a float" reading is the right one and the case uses `index: 1.5, count: 1e9`
(no new constraint added to a blocking update).

**Gate fix round 1 (orchestrator's gate, after exec).** One pre-existing case was
left stale by D5: `apps/mobile/test/permission-sheet.test.ts` «the age guard holds
for a card too, and the reply option is not a card answer» (from
`docs/feat/workflows-ui.md` D4) asserted `answerFor(id, "reply") === "ignored"` —
exactly what D5 reverses, and the file is one the executor never ran (it ran the
new `permission-sheet-question.test.ts` instead). Production code is UNCHANGED
(D5 is the approved decision, and both new reply tests depend on it; a
guarded-reply implementation fails them). The case was rewritten to D5: the
guard still holds for a DECISION (an unarmed `reject_once` is `"ignored"`, both
before and after the field opens), while `"reply"` opens the refusal field
unarmed (`"typing"`, `replyOpen: true`, nothing settled) — non-vacuity re-proven
by mutation (`answerFor`'s reply branch honouring the guard → red).

**Checks run here (narrow, per the owner's budget).** The 8 touched/covering test
files: **133 pass, 0 fail**; `packages/protocol/test/json-schema.test.ts` +
`version.test.ts` (regenerated schema, no version bump): 25 pass;
`bunx tsc -p apps/mobile` clean (the `.tsx` side no test can typecheck);
`bunx biome check` on every changed file: clean. The FULL `bun run check` was not
run here — the orchestrator's gate runs it after this branch.

**Not done deliberately:** no TUI change (D7), no push-banner run name (D8), no
`PROTOCOL_VERSION`/`protocol.d/` note (D2), no persistence change (a question is
never resumable), `TODO.md` untouched.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; same model family as the plan/orchestrator, different from the DeepSeek executor)

**Verdict: REQUEST-CHANGES** (one MEDIUM; the wire/daemon/client half is sound).

**Findings**

1. **MEDIUM — the new «Answer» tap wipes a typed draft.** `apps/mobile/src/permission-sheet.ts:611-612` always commits `replyText: ""`. Scenario: run screen → «Answer» → type an answer → swipe the sheet down (a swipe while asking PARKS it and keeps `replyOpen`/`replyText`, `SessionScreen.tsx:1634-1640`) → the bar shows «Answer» again → tap → the draft is gone. «Review» (`unpark`) keeps it. Before this branch the run bar had only «Review», so this loss path is new. Repro (`.tentacle/tmp/a2a-question-workflow-label/draft.ts`): `after park: "a long typed answer"` · `Review (unpark) keeps: "a long typed answer"` · `after 2nd Answer tap: ""`. Fix: when `replyOpen` is already true, only unpark (keep `replyText`), plus a test that pins it. (Design 4 specified `replyText: ""`, so the plan has the same defect.)

**Gate (narrow, as instructed):** the 8 touched test files + `json-schema`/`version`: **181 pass, 0 fail**. `bun run lint`: clean (2591 files). `bun run typecheck` (root + mobile + relay): clean. Full `bun run test` not run here.

**Mutations (each red, then reverted; `git status` clean afterwards):** router `type === "permission_request"` guard restored → «a QUESTION carries it too» red; `toAskUpdate` question branch without `workflow` → «forwards it to BOTH branches» + the SessionHost e2e case red; `askBarFor` `action: "review"` hard-coded → «the bar's action is `answer`» red.

**Premises:** the mapper dropped `workflow` for a question (TRUE, `permission-map.ts` on main); the router read it only off `permission_request` (TRUE); both hosted-session call sites already pass `options?.workflow` (TRUE, `hosted-session.ts:1574`, `:1755`); `sheetOptions` gives a question `reply` + `reject_once` only (TRUE, `permission-sheet.ts:254-260`), so a paired question can never get a grant option.

**Attacks tried**
- §7 pod not trusted: does `workflow` on a question feed any decision? No. The only reader is `askOrigin` and the run-bar pairing (display only). The daemon rebuilds it key by key; the router bounds it. Holds.
- Protocol: an additive optional field on a strip schema, `UPDATE_CLASS` unchanged, `protocol.json` regenerated (the drift test passes). Having no `protocol.d/` note is correct. A pod sending `workflow.name` that is not a string makes the blocking `question_request` unparseable, but `permission_request` already has the same risk (shared schema), so this branch adds no new risk.
- The step card offers a grant on a paired question: no. Only the bar consumes the pairing (`WorkflowRun.tsx:633-636`).
- D5's unguarded `answerFor("reply")` on a permission request: it only opens the refusal field, and `sendReply` is still guarded. Holds.
- The draft loss above: found.

**Executor behaviour:** followed the plan in order, renamed `onAnswerAsk`→`onOpenAnswer` honestly instead of relaxing a guard, and the claimed mutations reproduce. It missed the stale `permission-sheet.test.ts` case until the orchestrator's gate caught it (recorded in Execution).

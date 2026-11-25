# fix/workflow-edit-segments — a segmented option follows the SHAPE, not its content

> **Status:** implementation (APPROVED — owner delegated the open questions; see *Orchestrator decisions*)
> **Branch:** `fix/workflow-edit-segments` (worktree `.tentacle/worktrees/workflow-edit-segments`, off `main` @ `3c427613`)
> **Type: fix · Size: S · Blast: contained · Suited: DeepSeek** (pure mobile editor module + one leaf pure-draft edit; standard in-context Review, no §7 invariant touched)
> **Changelog:** `changelog.d/workflow-edit-segments.fixed.md` — `- **Workflow editor: picking Docker or "Go to step" now sticks.** …`

## Context

*— claude-sonnet-5-5, 2026-11-26*

The owner, on the phone, in the workflow editor's step sheet for a `run` step:
«non mi fa cliccare né su docker né su go to step, non avviene lo switch» — tapping
**Docker** leaves **Local** selected, tapping **Go to step** leaves **Stop**
selected. Nothing appears, so the two features are unreachable from the phone.

Root cause, in one sentence: both controls WRITE a shape with an empty content
(`where: {docker: ""}`, `on_fail: {goto: ""}`) but READ their selected option from
that content being non-empty, so the choice erases the very evidence it is drawn
from — and for `then` the draft is not written at all, because
`applySheetAction` treats an empty target as "not a target" and drops it.

The three links of the chain, cited from the CURRENT code:

1. **what the segment writes** — `apps/mobile/src/workflow-edit-sheets.ts:1117-1121`
   (`Where`→Docker ⇒ `patch {kind:"run", where:{docker:""}}`; `Local` ⇒ `where:"local"`)
   and `:1112-1116` (`Then`→`Go to step` ⇒ `target: gotoOf(model) ?? ""`, which is
   `""` while the step stops — `gotoOf`, `:1139-1142`, reads the `goto` pick row,
   which does not exist while the step stops, `:461-481`).
2. **what the draft ends up holding** — `packages/core/src/workflow-draft.ts:547-551`:
   `patchStep`'s run branch writes `out.where = { docker: patch.where.docker }` for
   any non-`"local"` target, so `{docker: ""}` lands (intact). For `then`,
   `applySheetAction`'s `then` case (`:1204-1209`) refuses to call `setFail` at all
   when `action.target === ""`, so the draft keeps no `on_fail` — full self-undo.
3. **what the field reads back** — `Where`: `:555` `{label:"Local", on: docker === ""}`
   / `:556` `on: docker !== ""`, with `docker` read at `:527`; so `{docker: ""}`
   draws **Local** and hides the container row (`:559-573`). `Then`: `:457`
   `{label:"Stop", on: goto === ""}`, `goto` read at `:422`; so a pending `on_fail`
   (or none) draws **Stop** and hides the goto picker (`:461-481`).

**Repro** (run 2026-11-26 in this worktree; scratch dir
`.tentacle/worktrees/workflow-edit-segments/.tentacle/tmp/workflow-edit-segments/`,
gitignored — the sandbox refused `/Users/gmeghnag/tentacle/.tentacle/tmp/workflow-edit-segments/`
as outside the worktree's writable root; same `<repo root>/.tentacle/tmp/<slug>/`
rule). It drives the pure module exactly as
`App.tsx:2549-2555` does — build the sheet, fire `segmentAction`, apply through
`patchStep`/`setFailTarget`, rebuild, read the options back:

```ts
import { type WorkflowDraft, draftProblems, patchStep, setFailTarget, setPrompt } from "@tentacle/core";
import { applySheetAction, segmentAction, settingsSheet, stepSheet, withInput } from "../../../apps/mobile/src/workflow-edit-sheets.ts";

const draft: WorkflowDraft = {
  schemaVersion: 1, name: "demo", version: 1,
  steps: [
    { id: "lint", run: "bun run lint" },
    { id: "exec", run: "bun test" },
    { id: "review", agent: { prompt_text: "review it" } },
  ],
};
// applied(draft, key, option, id) == what App.tsx's `control` does: the sheet's
// model, the segment's action, then the controller seam for that action.
// report(draft) == "Where [<on labels>] · container row present|ABSENT | Then [<on labels>] · \"Go to\" row present|ABSENT".
```

```
start          : Where [Local] · container row ABSENT | Then [Stop] · "Go to" row ABSENT
Where->Docker  : Where [Local] · container row ABSENT | Then [Stop] · "Go to" row ABSENT | action {"do":"patch","id":"lint","patch":{"kind":"run","where":{"docker":""}}}
               draft where = {"docker":""}
Then->Go to    : Where [Local] · container row ABSENT | Then [Stop] · "Go to" row ABSENT | action {"do":"then","id":"lint","target":""}
               draft on_fail = undefined

-- Save-off sentence for the incomplete shape (draftProblems[0]) --
empty container: steps[0].where: needs a container name — {docker: <container>}
no goto yet    : steps[0].on_fail: needs a step id — {goto: <step>, max: 1..10}

-- The other segmented controls, same probe --
agent promptMode: ["File"] -> Inline -> ["Inline"] | action {"do":"prompt","id":"review","prompt":{"text":""}}
  draft agent  : {"prompt_text":""}
  -> File -> ["File"] {"prompt":"prompts/review.md"}

-- input-required: (Settings) --
  required: Required -> Has a default -> Has a default
  inputs: {"slug":{"required":false,"default":""}}
```

Reading it: `Where` writes the correct shape and the field still says **Local**
(bug 1). `Then` writes nothing at all — `on_fail` is still `undefined` after the
tap (bug 2, the more severe). Both incomplete shapes already have the *field's own*
sentence in the spec (`packages/core/src/workflow-spec.ts:592-595` and `:614-617`),
which is exactly what the owner's fix asks Save to report. The other two
segmented controls in the editor (`promptMode`, `input-required:`) switch
correctly: their write names the key that distinguishes the mode, so content and
shape agree today. `promptMode` still *reads* content (`:597`), which is the same
defect waiting for a malformed draft — audited below.

## Implementation

*— claude-sonnet-5-5, 2026-11-26*

**APPROVED.** The owner delegated every open question; the picks are recorded
under *Orchestrator decisions* with a one-line reason each.

### Load-bearing assumption

> A segmented control's selected option must be derived from the **shape** of the
> value it wrote (a `where` object, an `on_fail` object, an `agent.prompt` key),
> never from that value's **content** — because the shape is what the write always
> produces and the content is exactly what is still empty at the moment the user
> has just chosen it.

Proven, not asserted: the repro above shows the write produces
`where: {docker: ""}` (`workflow-draft.ts:547-551`, the patch faithfully applied)
while the read at `workflow-edit-sheets.ts:555` reports Local on — so *shape* says
Docker, *content* says Local, and they disagree for one and the same draft. The
`then` half of the assumption (the write produces `on_fail: {goto: ""}`) is the
part that does not hold yet: `applySheetAction:1204-1209` drops the empty target,
so the fix must first make the write exist (Decision D1) before the shape rule has
anything to read.

### Preconditions

- **The sheet is a pure projection of the draft on screen, re-derived every
  render** — `apps/mobile/App.tsx:2434-2449` builds `sheetModel` from `state.draft`
  each render; `App.tsx:2549-2555` computes the action from that model and applies
  it through `applySheetAction`; the screen `screens/WorkflowEditSheets.tsx` only
  paints (`:107-140` Segmented, `:279-294` pick). So one pure-module change is the
  whole fix; **no component and no route change** (AGENTS §7). Pinned by
  `apps/mobile/test/workflow-edit-wiring.test.ts:278-300`.
- **An incomplete draft is a legal editor state, and Save reports it.** Review is
  not reachable while a problem exists: `beginReview` no-ops on `saveOff !== null`
  (`apps/mobile/src/workflow-edit-controller.ts:911-915`). `draftProblems`
  (`workflow-draft.ts:641-649`) → `refresh` (`workflow-edit-controller.ts:435-449`) →
  `saveOffReason` returns the FIRST problem verbatim (`:300-318`) →
  `canSave()` is `phase === "editing" && saveOff === null` (`:994-996`) → the Save
  pill is `disabled={!props.action.on}` and the bar prints that line
  (`screens/WorkflowEdit.tsx:548-551`, `workflow-edit-actions.ts:419-431`).
- **The core already refuses both incomplete shapes at save**, with the sentence
  the sheet will surface: `{docker: ""}` → `needs a container name`
  (`workflow-spec.ts:592-595`); `{goto: ""}` → `needs a step id`
  (`workflow-spec.ts:614-617`). Neither can reach disk: a save needs `canSave`.
- **`patchStep` writes `{docker: ""}` faithfully** (`workflow-draft.ts:547-551`) and
  `"local"` removes the key — so `Local` is a shape too (`where` absent), and the
  read must accept `undefined` as Local (it does, `workflow-edit-sheets.ts:527`).
- **`setFailTarget` already owns `on_fail`** and `"stop"` removes the key
  (`workflow-draft.ts:254-286`, `:275-279`), clamping `max` to 1..10 (`:280-284`).
- **The graph draws no `✗` edge for a blank goto** (`workflow-edit-graph.ts:208-220`),
  so a pending fail target can never be tapped as a label — the step sheet is the
  only way in, which is what we want.
- Baseline: `bun run lint` clean, `bun run check` green on `main` @ `3c427613` for
  the files touched (nothing in `changelog.d/` for this slug).

### Design

One rule, applied to every segmented control: **the option is on iff the value's
SHAPE is that option's; the dependent field is rendered iff the same shape holds,
and shows whatever content the draft has (possibly empty); Save stays off with
that field's own sentence until it is filled.**

1. **`Then` (the fail target).** *On* = `onFailOf(step) !== undefined` (an
   `on_fail` object exists), `Stop` = otherwise. The `goto` pick row and the `max`
   stepper render under the same test (`onFail !== undefined`) instead of
   `goto !== ""`. `Stop` keeps removing the key (`setFailTarget(…, "stop")`,
   `workflow-draft.ts:275-279`), which clears both rows — "switching back clears it".
2. **The pending write must exist** (Decision D1): `setFailTarget` accepts `""` as
   "the `✗` edge exists, its step is not picked yet" and writes
   `on_fail: {goto: "", max}` (skipping the `idsOf` membership check for it); and
   `applySheetAction`'s `then` case stops dropping the empty target
   (`workflow-edit-sheets.ts:1204-1209`). The two halves are one change: with only
   the read fixed the control still does nothing; with only the write fixed the
   control still draws Stop.
3. **`Where`.** *Docker* on = `step.where` is a plain object; *Local* on = it is
   `undefined` or `"local"`. The container row renders on that same test and shows
   `text(where.docker)` — empty at first (placeholder `name`). `Local` writes
   `where: "local"`, which `patchStep` turns into "key removed" — cleared.
4. **The container field writes what it shows** (Decision D2): `textAction`'s
   `docker` case sends the raw value even when blank, so the draft keeps
   `{docker: ""}` and Save keeps naming it, instead of silently re-injecting the
   old name on the next render. This is what the case's own comment already
   promises (`workflow-edit-sheets.ts:1015-1020`).
5. **`promptMode` reads the key** (Decision D3): `File` on = `agent.prompt !==
   undefined`, `Inline` on = otherwise; the following field renders on the same
   test. No behaviour change for a valid draft (probe above), but the rule becomes
   uniform, so the next writer cannot reintroduce the bug by "reading the value".
6. **`input-required:` is left as it is** (Decision D4): its discriminator is the
   boolean `input.required`, a shape with no empty-content state — the probe shows
   it switching both ways.
7. **Presentation gaps the pending shapes expose** (both one line, same module):
   the empty `goto` pick gets `sub: "not picked yet"` (a `pick` row draws its
   `value` as plain text — `screens/WorkflowEditSheets.tsx:291` — so an empty one
   is a blank line); and the graph row stops saying `docker ` with an empty name
   (`workflow-edit-graph.ts:236-244`; Decision D5).

The shared source of truth stays the draft (`where` / `on_fail` keys), which the
validator also reads — no second representation, no sheet-local state, nothing new
on the wire: the daemon never sees `{docker: ""}` or `{goto: ""}` because a save
requires `canSave()`.

### Files

In dependency order (pure core → mobile pure module → mobile graph → tests → changelog):

1. `packages/core/src/workflow-draft.ts` — `setFailTarget` (`:254-286`): accept
   `target === ""` as the pending target (skip `idsOf` for it), write
   `on_fail: {goto: "", max: clamped}`; extend the doc comment above it (`:250-253`).
2. `apps/mobile/src/workflow-edit-sheets.ts` —
   `stepSheet`'s fail block (`:452-484`): `then` options from `onFail !== undefined`,
   gate `goto`+`max` on the same; the foot stays `null` until a target exists
   (unchanged expression, `:483`).
   `bodyFields` run branch (`:527`, `:552-573`): `onDocker` from the object shape.
   `bodyFields` agent branch (`:587-620`): `promptMode` from key presence.
   `textAction`'s `docker` case (`:1037-1040`): send the raw value through.
   `applySheetAction`'s `then` case (`:1204-1209`): pass `""` through to `setFail`.
3. `apps/mobile/src/workflow-edit-graph.ts` — the run row's `where` text
   (`:236-244`): name a blank docker instead of writing `docker `.
4. `apps/mobile/test/workflow-edit-sheets.test.ts` — the red-first tests (below).
5. `packages/core/test/workflow-draft.test.ts` — `setFailTarget(…, "")` writes the
   pending shape (red today, observed: `refused: 'no step ""'`).
6. `changelog.d/workflow-edit-segments.fixed.md`.

Untouched on purpose: `screens/WorkflowEditSheets.tsx`, `App.tsx`,
`workflow-edit-controller.ts`, `workflow-spec.ts` (its sentences are already
right), the protocol, and anything persisted.

### Failure modes

- **A pending target/container left behind, then the sheet closes.** The draft
  holds `{goto: ""}` / `{docker: ""}`; `canSave()` is false and the bar prints
  `steps[1].on_fail: needs a step id — {goto: <step>, max: 1..10}`. Converges:
  reopening the step sheet shows the choice on with the field empty, or **Stop** /
  **Local** clears it, or Undo drops it (one `push` per edit, `workflow-edit-controller.ts:450-457`).
- **Undo / a refusal re-renders the sheet from the file's own numbers.** The sheet
  is re-derived (`App.tsx:2434-2449`), the option follows the draft, so an Undo of
  the Docker tap shows Local again — never a control's last position.
- **Answers typed while the picker is open.** An empty container name is
  *unsavable but legal* — exactly the existing contract for `timeout`
  (`workflow-edit-sheets.ts:1041-1047` sends only a parseable duration).
- **`{goto: ""}` on a step whose fail label someone taps.** The graph draws no `✗`
  edge for a blank target (`workflow-edit-graph.ts:208-220`), and `maxSheet`
  returns `null` for it (`workflow-edit-sheets.ts:789-793`), so there is no such
  label and no such sheet: the sheet view draws nothing for a `null` model
  (`screens/WorkflowEditSheets.tsx:375`) over the graph. No dead end, no silent
  edit — the step sheet is the way back in.
- **A step deleted while a pending goto names it.** Nothing names it yet (`goto`
  is `""`), so `deleteStep`'s dangling logic has nothing to rewrite
  (`workflow-draft.ts:456-469`).
- **A hand-written file with `prompt: ""`** (not producible from the phone): after
  D3 the sheet shows **File** with an empty File row instead of pretending it is
  Inline; Save refuses it with the spec's sentence. Strictly more honest, and the
  old behaviour could not have fixed it either.
- **Empty input** (a run step with `where` absent) is the common case and must
  read Local with no container row — pinned by the existing test at
  `apps/mobile/test/workflow-edit-sheets.test.ts:204-221`.
- **Version skew / persisted format**: none — no wire, no on-disk shape change
  (`{docker: ""}`/`{goto: ""}` cannot be saved, and no stored format gains a field).

### Tests

Red first, then green (AGENTS §9; each was shown failing on current `main`).
Baseline on `main` @ `3c427613`: `bun test apps/mobile/test/workflow-edit-sheets.test.ts
packages/core/test/workflow-draft.test.ts` → **94 pass, 0 fail** — so any failure
below is a new test, never a pre-existing one.

In `apps/mobile/test/workflow-edit-sheets.test.ts` (module level, existing `DRAFT`
/`spy` seams at `:33-80`, no renderer):

1. **`Where`→Docker sticks** — `segmentAction(sheet, "where", "Docker")` ⇒
   `patch {kind:"run", where:{docker:""}}` **and** re-deriving the sheet from the
   patched draft reports `options[1].on === true` and a `docker` text field with
   `value: ""`. (Red today: the re-derived sheet still reports Local and no
   container row.)
2. **`Where`→Local clears it** — from `{docker:""}`, `"Local"` ⇒ `where:"local"`
   ⇒ the row disappears and `options[0].on === true`.
3. **`Then`→Go to step sticks** — `segmentAction(stopping, "then", "Go to step")`
   ⇒ `{do:"then", id, target:""}`, `applySheetAction` calls `setFail exec ""`
   (the `spy` records it — red today: no call at all), and the re-derived sheet
   reports `options[1].on === true` with a `goto` pick whose `value` is `""` and
   whose `opens` is the `fail` picker.
4. **`Then`→Stop clears it** — from a pending target, `"Stop"` ⇒ `setFail exec stop`
   ⇒ no `goto`/`max` row, `options[0].on === true`.
5. **`promptMode` reads the key** — a draft whose agent carries `prompt: ""` shows
   **File** (this is the one test that fails before D3 and cannot be reached from
   the UI); a normal draft is unchanged, pinned by the existing test at `:184-199`.
6. **Empty container name reaches the validator** — `textAction(docker, "docker", "")`
   ⇒ `patch {kind:"run", where:{docker:""}}` (red today: `null`), and
   `draftProblems` on the result says `steps[?].where: needs a container name`.

In `packages/core/test/workflow-draft.test.ts`:

7. **`setFailTarget(loop(), "review", "")`** writes `on_fail: {goto: "", max: 1}`
   (keeps an existing `max`), and `draftProblems` reports
   `needs a step id` — red today, observed: `setFailTarget(draft, "review", "")`
   returns `refused: 'no step ""'` (`workflow-draft.ts:269-271`).

Non-vacuity (§9): each of 1, 3, 6, 7 is a test that *must* fail on the unpatched
code — the repro output above is the failure they encode. Test 5 is the only one
whose red state needs a synthetic draft, stated as such.

## Execution

*— claude-code 2.1.332 (Claude; the harness exposes no model id string), 2026-11-26*

**Load-bearing check re-run first (before any edit).** The Context's repro, rebuilt
from the plan's own sketch at the worktree-local scratch dir
`.tentacle/worktrees/workflow-edit-segments/.tentacle/tmp/workflow-edit-segments/repro.ts`
(AGENTS §6; the worktree is the sandbox root, as the planner also found). It
drives `stepSheet`/`segmentAction`/`applySheetAction`/`textAction` plus the CORE
(`patchStep`, `setFailTarget`, `draftProblems`, `editGeometry`) exactly as
`App.tsx:2549-2555` does. Output on `main` @ 5c9a1e10 (plan commit), BEFORE the
fix:

```
start          : lint: where [Local] · docker row ABSENT | then [Stop] · goto row ABSENT
Where->Docker  : lint: where [Local] · docker row ABSENT | then [Stop] · goto row ABSENT
  action       : {"do":"patch","id":"lint","patch":{"kind":"run","where":{"docker":""}}}
  draft where  : {"id":"lint","run":"bun run lint","where":{"docker":""}}
Then->Go to    : lint: where [Local] · docker row ABSENT | then [Stop] · goto row ABSENT
  action       : {"do":"then","id":"lint","target":""} · calls []
  draft step   : {"id":"lint","run":"bun run lint"}
textAction(docker, "") : null
setFailTarget("")      : "no step \"\""
problems(docker "")    : steps[0].where: needs a container name — {docker: <container>}
problems(goto "")      : steps[0].on_fail: needs a step id — {goto: <step>, max: 1..10}
graph run sub          : "run · docker "
```

Every number the Context cites holds: the write lands (`{docker: ""}`) and the
field still draws Local (bug 1); the `then` tap writes nothing at all (bug 2);
both validator sentences already exist; the pill reads `run · docker ` (D5). Same
script after the fix:

```
start          : lint: where [Local] · docker row ABSENT | then [Stop] · goto row ABSENT
Where->Docker  : lint: where [Docker] · docker row present | then [Stop] · goto row ABSENT
Then->Go to    : lint: where [Local] · docker row ABSENT | then [Go to step] · goto row present
  draft step   : {"id":"lint","run":"bun run lint","on_fail":{"goto":"","max":1}}
textAction(docker, "") : {"do":"patch","id":"lint","patch":{"kind":"run","where":{"docker":""}}}
setFailTarget("")      : {"id":"lint","run":"bun run lint","on_fail":{"goto":"","max":1}}
graph run sub          : "run · docker · not named"
```

**As built, in the Implementation's order (red before green at every slice).**

1. **Core** — `packages/core/src/workflow-draft.ts:250-272`: `setFailTarget`
   accepts `""` as the pending target (the `idsOf` membership check is skipped for
   it, the `itself` refusal still fires first) and writes `{goto: "", max}`
   keeping the current `max`; doc comment extended. RED first
   (`packages/core/test/workflow-draft.test.ts:234`, new test 7 — failed with
   `Received: "no step \"\""`, exactly the plan's prediction) → green.
2. **Mobile sheets** — `apps/mobile/src/workflow-edit-sheets.ts`:
   - `stepSheet` `:425` + `:460-464`: `failing = onFailOf(step) !== undefined`
     drives both `then` options and the `goto`/`max` rows; the pending `goto`
     row carries `sub: "not picked yet"` (D-point 7); the foot expression is
     unchanged, so it stays `null` until a target exists.
   - `bodyFields` run branch `:532-590`: `container` (a non-array mapping) is the
     Docker shape (`:532`), `docker` its content (possibly `""`), used for the
     option states (`:566`), the row's presence (`:570`) and its `value` (`:578`).
   - `bodyFields` agent branch `:602-621`: `isFile = agent.prompt !== undefined`
     drives `promptMode` (`:610`) and which prompt row renders (`:614`) (D3).
   - `textAction`'s `docker` case `:1051-1054`: a blank name is SENT (D2).
   - `applySheetAction`'s `then` case `:1218-1221`: `""` is passed to `setFail`
     (D1's other half).
3. **Graph** — `apps/mobile/src/workflow-edit-graph.ts:238-247`: a blank docker
   is named `docker · not named` (D5).
4. **Tests** — 6 new tests in `apps/mobile/test/workflow-edit-sheets.test.ts`
   (`describe("a segmented option follows the SHAPE, not its content")`, `:277-426`)
   = the plan's tests 1-6, 1 new in `workflow-edit-graph.test.ts` (`:146-164`).
5. **Changelog** — `changelog.d/workflow-edit-segments.fixed.md` (D7).

**Drift from the Implementation (and why).**

- **One EXISTING test had to be rewritten, not only added.**
  `refusals: the sheet never guesses > "Go to step" with no target picked yet sets
  no fail target` (`:483`, now `… writes the PENDING shape`) asserted `calls == []`
  — i.e. it pinned the very bug (the dropped write) that Design point 2 removes,
  so it now asserts `setFail plan ""`. The plan's Tests section listed only
  additions; a plan-time read of that test would have caught it. Its red state was
  shown in the same run as the new tests (`Received: []`).
- **A graph test was added** (the plan's Tests list had no item for Design point 7,
  though Files item 3 named the change): §9 needs a red-first test for every fixed
  line. `apps/mobile/test/workflow-edit-graph.test.ts:146` — red with
  `Received: "run · docker "`.
- **`draftProblems(draft, prompts)` takes the prompts map**, so the new tests pass
  `PROMPTS` (`:329`, `:372`, `:423`); no production impact, noted only because the
  plan's sketches spelled it `draftProblems(draft)`.
- No other file was touched: `screens/WorkflowEditSheets.tsx`, `App.tsx`,
  `workflow-edit-controller.ts`, `workflow-spec.ts` unchanged. No schema, no wire,
  no persisted shape ⇒ `packages/protocol/schema/protocol.json` untouched (nothing
  to regenerate) and no `protocol.d/` note.

**Non-vacuity (§9), by mutation — each change reverted alone, the suite re-run,
then restored (final `git diff` reviewed line by line):**

| mutation (single line reverted to the pre-fix code) | result |
| --- | --- |
| core: `setFailTarget` membership check without the `target !== ""` skip | 2 fail — `setFailTarget > "" is the PENDING target`, and the mobile `Then`→Go to step test (it applies through the core) |
| sheets: `then` options/rows back to `goto === ""` / `goto !== ""` (the exact pre-fix read) | 1 fail — `Then`→Go to step sticks; **no pre-existing test moves**, which matches the repro (nothing else observed the bug) |
| sheets: the `if (action.target !== "")` guard restored in `applySheetAction` | 2 fail — `Then`→Go to step sticks + `Go to step … writes the PENDING shape` |
| sheets: `where` options/row back to `docker === ""` / `docker !== ""` | 1 fail — `Where`→Docker sticks |
| sheets: `docker` text case back to `value === "" ? null : …` | 1 fail — a blank container name reaches the VALIDATOR |
| sheets: `promptMode` back to `path !== ""` / `path === ""` | 1 fail — `promptMode` reads the KEY |
| graph: blank docker back to `` `docker ${oneLine(docker)}` `` | 1 fail — a pending container is NAMED on the pill |

The two "clears" directions (`Where`→Local, `Then`→Stop) pass on both old and new
code by construction — they guard the reverse move rather than the bug, as the
plan says.

**Gate status.** Narrow suites green after every slice; final run of the six files
the change touches (`workflow-edit-sheets`, `workflow-edit-graph`,
`workflow-edit-wiring`, `workflow-edit-controller`, `workflow-edit-actions`,
core `workflow-draft`): **264 pass, 0 fail**. `bunx biome check` on all six
changed files: clean (3 format-only fixes applied by `--write`: the graph ternary,
one long test line, one draft literal). `bunx tsc -p apps/mobile --noEmit`:
clean — this caught one real slip first (`LOCAL.steps` was `unknown`), fixed by
typing the fixture `satisfies WorkflowDraft` instead of `: WorkflowDraft`. The
full `bun run check` is run by the orchestrator's script, not here: the only part
of it I did not execute is the root `tsc --noEmit` and the full suite.

## Review

*— claude-sonnet-5-5, 2026-11-26* (planner; left empty — a fresh-context Review fills it)

#### Orchestrator decisions

The owner delegated every open question; the recommended option was taken in each
case, with its reason, and the Implementation is marked APPROVED on that basis.

- **D1 — how "Go to step" expresses "not picked yet": widen `setFailTarget("")`**
  (rather than a sheet-local mode, or a new controller verb). Reason: the empty
  target then lives in the draft — the one thing the sheet and the validator both
  read — so Save's sentence is the spec's existing one (`workflow-spec.ts:614-617`)
  and no state exists that the sheet does not show.
- **D2 — the container field sends a blank through** (rather than the current
  no-op). Reason: a field that shows empty while the draft keeps the old name
  breaks the module's own first rule (`workflow-edit-sheets.ts:11-13`), and the
  validator already has the sentence.
- **D3 — `promptMode` is tightened to key presence in the same change.** Reason:
  the audit's point is a uniform rule ("a segment reads a shape"); it is two lines
  and provably changes nothing for a valid draft (probe above).
- **D4 — `input-required:` is left alone.** Reason: it is already shape-driven
  (`input.required === true`) and the probe shows it switching both ways; touching
  it would be churn on a control that works.
- **D5 — the graph's run row names a blank docker** (`docker · not named`) instead
  of `docker ` with a trailing space. Reason: a pending container otherwise makes
  the pill and the sheet disagree, which reads as a second bug; one line.
- **D6 — the fail picker's missing tick is NOT fixed here** (its options are all
  `on: false`, `workflow-edit-sheets.ts:749-763`). Reason: cosmetic, unrelated to
  the switch, and it would widen an S task; recorded as debt in Review.
- **D7 — the changelog fragment is `fixed`**, one bullet naming the two controls.
  Reason: user-visible behaviour repaired (AGENTS §10).

#### Adversarial review (fresh context)

*— claude-opus-5-5, 2026-11-26* (fresh context; a different model from the executor, DeepSeek, and the same family as the planner, Sonnet)

**Verdict: APPROVE.** No HIGH or MEDIUM findings.

- **Gate, partial on purpose:** the six touched or neighbouring test files (`workflow-edit-{sheets,graph,wiring,controller,actions}`, core `workflow-draft`) give **264 pass, 0 fail**. `bun run lint` is clean on 2553 files. `bun run typecheck` (root + mobile + relay) is clean. I did not run the full suite; the orchestrator's merge gate does that.
- **Premises checked against the code, all TRUE:** the validator's sentences (`workflow-spec.ts` `needs a container name` / `needs a step id`); the graph draws no edge for a blank goto (`workflow-edit-graph.ts:208-220`); `maxSheet` returns null on a blank goto (`workflow-edit-sheets.ts:806-807`); `patchStep` writes `{docker: ""}` as given and treats `"local"` as removing the key (`workflow-draft.ts:549-553`); Inline rebuilds `agent` with no `prompt` key (`workflow-draft.ts:566-576`), so the key-based `isFile` cannot get stuck on File.
- **Mutation check (reverted, `git status` clean afterwards):** the sheets `failing` check back to `goto !== ""` makes 1 test fail; `isFile` back to `path !== ""` makes 1 fail; the core skip removed (`!idsOf…` only) makes 2 fail. Combined with the executor's 7-row table, every changed line has a test that goes red without it.
- **Attacks tried:**
  1. **End to end through the real `createWorkflowEditController`** (scratch `.tentacle/tmp/workflow-edit-segments/e2e.ts`). Tapping Docker holds Docker on and Save is off with the validator's sentence. Typing a name and then clearing it holds Docker and brings the sentence back. "Go to step" holds. `beginReview` with something pending sends nothing (0 saves). Undo ×4 goes back to Local / Stop.
  2. **Other callers of `setFailTarget`:** the ✗-drop `saveFail` passes `target.id` (`workflow-edit-actions.ts:75,98`), a real step id, so `""` is no new input there.
  3. **Other readers of `goto`:** `renameStep` and `deleteStep` compare it to a real id, so `""` never matches. `setGotoMax` on a pending goto keeps `{goto: "", max}`, which the validator still refuses.
  4. **Hand-written `on_fail: "stop"` and `where: "local"` (strings):** `onFailOf` and the `container` check accept only a mapping, so these read as Stop / Local, the same as before.
  5. **The docker field fires on every keystroke** (`onChangeText`): a blank value now reaches the draft and Save names it. That is the intended D2 behaviour, with no silent fallback to the old name.
- **§7:** none touched. No wire or persisted shape changes, components are untouched, and the logic stays in the pure modules.
- **Nit (not blocking):** tapping "Go to step" again while the target is still pending rewrites the same `{goto: "", max}`. It probably adds an empty Undo step; I did not check this.
- **Executor behaviour:** stayed in scope and recorded where it drifted from the plan (the graph test, the `PROMPTS` argument). Its red-first mutation table matches what I reproduced. It said plainly that it had not run the full gate.

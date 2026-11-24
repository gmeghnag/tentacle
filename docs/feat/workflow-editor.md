# feat/workflow-editor — Create and edit a workflow on the iPhone graph view

> **Status:** implementation — **APPROVED** (owner 2026-11-24, all four recommendations)
> **Branch:** `feat/workflow-editor`
> **Size:** L · **Blast:** cross-module (app + serve write path + approval) · **Suited:** Opus plan; DeepSeek exec per slice; Opus review per slice group (mandatory fresh-context: L)
> **Changelog:** `changelog.d/workflow-editor.added.md`

## Context

Owner (22/11 ~22:55, queued 23/11 ~12:20 right after feat/workflows-ui, now merged bb67dd2b): workflows can be run, viewed and approved from the iPhone graph view (workflows-ui), but creating or editing one still means writing YAML by hand or asking the model. The owner wants to create and edit a workflow directly on the iPhone graph.

Owner decisions (binding):
- **Variant A — direct manipulation** in edit/create mode: a ＋ on each edge inserts a step; drag the ✗ (failure) port onto the target step; the `✗ ×2` / `↻ ×1` edge labels are tappable to edit retries/loops. Mockup: https://claude.ai/artifact/GKErgFVG5s8Gmf3G7WcAvZ (sources `.tentacle/mockups/workflow-editor/`).
- This REVERSES the agent-workflows plan's «Mai: editor visuale drag-and-drop» (docs/eval/agent-workflows*.md, ~line 1014) — update that doc as part of this task.
- A template creates the YAML AND its prompt files (`workflows/prompts/*.md`), all under the approved hash (22/11 ~23:00).
- Open owner question (recommendation: yes): Save writes the file via `serve`.
- Mockup-kit gaps to fix first: `kit.js:271` permissionSheet options, `:316` row/band controls + filled button, `:278` toast action, `:369` extend wrapper.
- Phone/Mac parity rule applies (memory phone-mac-parity): say what the Mac/TUI side gets (the TUI editor stays a parked eval: eval/tui-workflow-editor).

*— orchestrator (claude-opus-5-5), 2026-11-24, from TODO.md + owner decisions*

## Implementation

> **APPROVED** — owner «ok» 2026-11-24 to all four recommendations (#### Owner answers below).

### Load-bearing assumption (named first, proved against the source)

**"Saving a workflow writes bytes and NOTHING else. The approval store is written only after an
`allowed` answer, from the session's ONE broker, to a `workflow_approve` ask over that exact hash.
So a save, from any client, can only produce an UNAPPROVED hash, which the next start asks about
again. A pod cannot reach the write path at all."** If this were false, the editor would be a way
around the hash approval (agent-workflows D2), and the plan would need an approval redesign
rather than a write method. Proof:

| Fact | Where |
|---|---|
| The approval store's only writer is `approvals.add`. Its ONLY two call sites both run after `answer.allowed` from `deps.request`: `requestApproval` and `approveHash` | `agent/src/workflow-driver.ts:730-733`, `:1019-1021` |
| `deps.request` IS the session's ONE broker (`permissions.request`), the same requester as every other ask (single-broker invariant, §7) | `cli/src/wiring.ts:862` |
| Every start checks `approvals.has(path, hash)` before step 1 and otherwise asks `workflow_approve` | `workflow-driver.ts:1001-1018` |
| Auto-accept never answers a `workflow_approve`. The phone offers allow-once / deny only | `core/src/permission.ts:310-318`; `apps/mobile/src/permission-sheet.ts:213` |
| The hash covers the YAML bytes **and every referenced prompt file**: one byte changed anywhere gives a new hash | `core/src/workflow-spec.ts:914-934`; prompts collected at `:811-835` |
| Store records are keyed `{project, path, hash}`, so a new hash has no record: fail-closed | `cli/src/workflow-approvals.ts:78-88` |
| A driver exists ONLY when `workflows === true && !tunnelled` (worker, `serve`), so a pod daemon has no driver. The new `save` dep is wired in the same block, never elsewhere | `cli/src/wiring.ts:852-861` |
| With no driver, the daemon refuses a workflow request | `daemon/src/hosted-session.ts:2530-2534` (pattern reused) |
| The laptop-side client serves only `ModelStream*`, `ModelCountTokens` and `HooksTrust`. Anything else is `MethodNotFound`, so a pod daemon cannot ask the laptop to write a file | `client/src/remote-client.ts:3305-3326` |
| The client's trust bit refuses locally on a pod session and sends nothing | `client/src/remote-session.ts:1315-1317`, `:1338-1340` |
| A run in flight holds its own snapshot (`source`, `spec`, `hash`). A resume or rerun after an edit is refused `changed`. A schedule pinned to the old hash skips `changed` | `workflow-driver.ts:838-842`, `:817-822`, `:660-667` |

**How this answers "without the phone gaining a lasting approval for its own input".** The save
RPC is a write and nothing more. The test below pins it: a spy store sees zero `add`, and the next
start raises exactly ONE `workflow_approve` through the ONE broker (mutation: `add` inside save →
red). The approval is always a separate, explicit human answer to an ask that shows every `run`
command verbatim. A pod reaches neither the write nor the store (rows 7–10).

What stays open: should the PHONE be allowed to answer the ask for a hash it just wrote, or must
that come from the Mac? Today (workflows-ui D6) the phone may approve. That is a policy choice,
not a code fact → **Q4**.

**Empirical check (executor runs it FIRST, pastes the output into Execution; STOP if any value differs):**
`.tentacle/tmp/workflow-editor/lb.ts` prints:
- `rg -n "approvals\.add\(" packages/*/src`: exactly the two driver lines above;
- `"WorkflowSource" in Method` and `"WorkflowSave" in Method`: both `false` today;
- `typeof validateWorkflowValue`: `undefined` today;
- whether `WorkflowDriver.prototype` has `save` / `source`: `false` today.

### Preconditions (verified invariants relied on)

- **The phone cannot parse YAML.** `validateWorkflow` uses `Bun.YAML` and otherwise returns
  "cannot read YAML here" (`core/src/workflow-spec.ts:607-611`). So the phone edits a STRUCTURED
  draft, and the YAML is produced and hashed on the daemon. The phone already imports
  `@tentacle/core` (`apps/mobile/src/artifact-gallery.ts:21`, `apps/mobile/package.json:11`), so
  a validator split from the YAML parse runs on the phone unchanged.
- **One validator, one hash.** `prepareSource` is the single validate+hash implementation
  (`workflow-driver.ts:896-929`). The catalogue and `start{hash}` already share it (`:582`,
  `:495-505`). The save reuses it too: a preview's `hash` is exactly what `start{hash}` and the
  catalogue then report.
- **The folder and the no-links rule live in one place.** `PROJECT_PATHS.workflows` and
  `resolveInside(…, "no-links")` (`cli/src/workflow-files.ts:57-68`, `:123`, `:195`). The writer
  uses them and never builds its own paths.
- **Peer not serialized (§7).** Workflow requests return without awaiting a turn
  (`daemon/src/connection.ts:449-470`). The save's check-and-write is ONE synchronous block (no
  `await` between reading the base hash and the last `rename`), so two saves through one daemon
  cannot interleave, and NO lock is added.
- **New methods are free (§7 forward compat).** An older daemon answers `MethodNotFound`, mapped to
  `{unsupported:true}` (pattern `remote-session.ts:1333-1342`). No `PROTOCOL_VERSION` move and no
  `protocol.d/` note. `protocol.json` is regenerated with `bun run schema:export`.
- **Pure modules, dumb components (§7).** Graph-edit logic, geometry, hit-testing and the editor
  state machine are `.ts` modules with tests. `.tsx` files only paint. RN screens are pinned by
  source-reading tests plus e2e shots (`apps/mobile/test/workflow-screens-wiring.test.ts` pattern).
- **Diffs are the existing shape.** Unified patch plus counts (`tools/src/builtins.ts:40-52`
  `makeDiff`), the same shape a permission diff reaches the phone in.

### Design

**D1 — Core: split the validator from the YAML parse; a canonical emitter.** (`core/src/workflow-spec.ts`, new `core/src/workflow-yaml.ts`)
- `validateWorkflowValue(raw: unknown, ctx)` = today's body from `:619` to the end. `validateWorkflow(text, ctx)` keeps the BOM
  strip and the `Bun.YAML.parse`, then calls it. No behaviour change: `core/test/workflow-spec.test.ts`
  is NOT edited and stays green, which is the proof.
- `WorkflowDraft` = the parsed YAML mapping itself (`schemaVersion, name, version, description?,
  inputs?, budget?, steps[]` with `agent`/`run`/`approve`, `where`, `timeout`, `retry`, `on_fail`,
  `next`: the `zWorkflow` input shape, `:278-309`). Prompt files travel beside it, as
  `prompts: Record<relPath, text>`.
  `asDraft(raw) → {draft} | {unreadable: string}`: a structural check only (types and shape,
  none of the semantic rules), so a file the model wrote with a dangling `next` still OPENS (and
  shows the problem), while a non-mapping or a wrong-typed field does not.
- `workflowYaml(draft): string`: a deterministic emitter in a fixed key order (the order of the
  `zWorkflow` schema). A string is plain only if it matches a conservative safe pattern; otherwise
  it is JSON-quoted (valid YAML 1.2). A multi-line string is a `|-` block only when every line is
  safe; otherwise JSON-quoted. Default budget values are omitted (mockup: "defaults never land in
  the file").
  Round-trip property: `Bun.YAML.parse(workflowYaml(d))` deep-equals `d`. The emitter is total
  over what YAML can hold (a block refuses every C0 control except tab), and it THROWS, naming
  the path, on a lone UTF-16 surrogate, which no YAML file can hold (fix round 1, review #2).
- `isCanonical(text, draft)` = `workflowYaml(draft) === text` (BOM stripped). False means a save
  rewrites the file's layout or comments → **Q3**.

**D2 — Core: draft edit operations + templates.** (new `core/src/workflow-draft.ts`, `core/src/workflow-templates.ts`)
All of these are pure, immutable `(draft, …) → {draft, …}`. They live in core, not in the app, so
the parked TUI editor (eval/tui-workflow-editor) reuses them unchanged (parity).
- **Edge ＋:** `insertStep(draft, at, kind)`.
  - `at: {after: id}` on a fall-through edge inserts at `index(after)+1`.
  - On an explicit `next` edge (`A.next = B`, not adjacent), the new step S goes after A and
    gets `A.next = S`, `S.next = B`.
  - `at: {end: true}` appends.
  - The new id comes from `stepIdFor(kind, seed, taken)`, which slugs the command or prompt
    stem (`bun run lint` → `lint`) and is unique (`lint-2`).
  - Kind defaults: run `{run:"", timeout omitted}`, agent `{agent:{prompt_text:""}}`, approve
    `{approve:{title:""}}`. These fail validation until filled in: they are visible problems,
    never a silent placeholder.
- **✗ port drop:** `setFailTarget(draft, id, target | "stop", max?)`.
  - A target that is the step itself is refused `{refused:"itself — use Retry"}` (mockup goto
    sheet).
  - `max` defaults to the step's current value, else 1.
- **Edge labels:** `setRetry(draft, id, 0..5)` (`↻ ×n`) and `setGotoMax(draft, id, 1..10)`
  (`✗ ×n`). Out-of-range input is clamped to the validator's range (`WORKFLOW_MAX_RETRY`, `:286`).
- **Other operations:** `setNext(draft, id, target | undefined)`, `moveStep(draft, id, ±1)` and
  `duplicateStep`.
- **`renameStep(draft, old, new, prompts) → {draft, prompts}` rewrites every `next` /
  `on_fail.goto` reference and every `{{steps.<old>.reason|report}}`** in a step's `run`,
  `agent.prompt_text`, `approve.title|detail` and the prompt files the draft's steps read (fix
  round 1, review #1). The user named the step, so rewriting the references is what they asked for.
- **`deleteStep(draft, id, prompts) → {draft, dangling: string[]}` NEVER rewrites references.** Fall-through
  reconnects by array order. `next`/`goto` references that named the deleted step stay as they
  are and become validator errors, drawn as a ghost pill. `dangling` (which counts a
  `{{steps.<id>.…}}` in the same texts, prompt files included) feeds the menu note
  "1 link points here" before the delete (mockup decision).
- **Per-kind field edits:** `patchStep(draft, id, fields)`, typed per kind; it never touches
  another step.
- **Prompt files:** `setPrompt(draft, id, {path} | {text})` switches an agent step between a
  `prompt:` file and `prompt_text`. A path must be relative, without `..`, `.md`
  (`prompts/<stem>.md` by default).
- **Problems:** `draftProblems(draft, prompts, ctx)` = `validateWorkflowValue(draft, {name,
  models, agentTypes, readPrompt})`. The errors are the daemon's exact text: the bar shows the
  first one with its YAML path (mockup "same text, word for word").
- **Undo:** `EditHistory` (push / undo / redo, capped at 50) backs the "Deleted gate · Undo"
  toast.
- **Version:** `nextVersion(base)`, applied once at the first edit of a loaded file (mockup: "the
  version goes up by itself").
- **Templates:** `WORKFLOW_TEMPLATES` = `blank` (one empty step) and `plan-build-review-merge`
  (the mockup's 6 steps). Each is `{id, label, sub, inputs, draft(name, description, inputs),
  prompts: Record<"prompts/<x>.md", text>}` — `inputs` are the ones the sheet opens with, and the
  ones its prompts interpolate.
  - The template's prompt files are referenced by its steps, so they are inside its hash (owner
    decision, 22/11 ~23:00).
  - Test: every template that carries a graph, once named, passes `draftProblems` with 0 errors, and
    every one of its prompt paths is referenced by a step. **`blank` is the one exception and it is
    deliberate**: it IS one of D2's own empty bodies, so it reports `steps[0].run: should not be
    empty` until the user fills it in (a 0-errors template would have to smuggle in a placeholder,
    which D2 forbids two bullets above).

**D3 — Protocol: two methods, additive.** (`protocol/src/session.ts`, `methods.ts`)
- **`session/workflow_source {sessionId, name}`** returns `{ok, path, text?: ≤ WORKFLOW_FILE_MAX_BYTES,
  draft?, prompts?: Record<path, text> (only files the draft references), hash?, version?,
  canonical?, errors?: ≤20×300, unreadable?: line(300), context: {models: name[] ≤ 64,
  agentTypes: name[] ≤ 64}, unavailable?}`.
  - `draft` is present iff `asDraft` succeeded. `hash` is present iff the file validated. `errors`
    are present iff it did not.
  - `context` carries model NAMES only, never ids or URLs (§7, as the catalogue's `model`, `session.ts:994-995`).
    It feeds the phone's pickers, and its local `draftProblems` then equals the daemon's.
- **`session/workflow_save {sessionId, name, mode: "create" | "replace", draft, prompts, baseHash?, dryRun: boolean}`**.
  - **Payload bounds:** `draft` is bounded JSON **TEXT** — `z.string().max(WORKFLOW_DRAFT_MAX_CHARS)`
    (512 KiB), the mapping serialized. *Amended by slice 3a (drift, executor): the plan said
    `z.record(z.unknown())` refined to ≤ 512 KiB, but the JSON-schema export represents neither a
    `z.record` (the `WorkflowInputValueSchema` precedent) nor a `.refine()` (the `attachment.ts` /
    `daemon.ts` precedents), and a `.refine`-only cap would be invisible to every non-zod client.
    Text keeps the cap part of the contract; the daemon parses it into the same mapping the strict
    validator reads, so an unknown draft field is still an ERROR, never a silent drop.*
    `prompts` ≤ 32 entries, each ≤ 64 KiB. **Frame check (executor, as the plan asks):** the
    transport's cap is `DEFAULT_MAX_FRAME_BYTES = 8 MiB` (`daemon/src/device-accept.ts:40`), so
    512 KiB + 32 × 64 KiB + envelope ≈ 2.6 MiB fits one frame; no bound was lowered.
  - **Unknown draft fields are refused, not dropped.** The authority on the draft is the
    strict validator, so a newer client's unknown field becomes an ERROR, never a silent drop
    from a file the user saves.
  - The executor checks both bounds against the transport frame limit (`rg -n "MAX_FRAME|maxFrame"
    packages/transport/src`) and lowers them if needed.
  - **Result:** `{ok, refusal?: WorkflowRefusalSchema (changed | exists | invalid | unavailable),
    reason?, errors?, hash?, version?, path?, files?: [{path, status: new | changed | unchanged,
    patch ≤ 64 KiB, added, removed}] ≤ 33, approved?: boolean, alsoChanges?: name[] (other
    workflows whose hash this save changes: a shared prompt), running?: runId (a run of this
    workflow is in flight), schedules?: id[] (schedules pinned to the old hash)}`.
  - **`dryRun: true` is the Review screen.** It returns everything and writes nothing.
    `dryRun: false` re-does every check and writes.
- Method table rows for both. Regenerate `protocol.json` (`bun run schema:export`).

**D4 — The writer (serve host only) and the driver.** (`cli/src/workflow-files.ts`, `cli/src/wiring.ts`, `agent/src/workflow-driver.ts`)
- **`cli/src/workflow-files.ts`:** `writeWorkflowFiles(cwd, plan, currentHash, hooks?)`.
  - **Synchronous.** No `await` between the base check and the last rename.
  - **The plan carries the DRAFT, not bytes.** *Amended by slice 3a (drift, executor): the plan's
    `plan` shape was not spelled out beyond `{mode, name, …}`; the writer therefore takes
    `{mode, name, draft, prompts, baseHash?, basePrompts?}` and calls `workflowYaml` itself, so no
    caller-supplied `text` can drift from the draft it validated. `workflowYaml` throwing (a lone
    surrogate) is `invalid`, naming it — nothing written. `basePrompts` is the base read's
    `Object.keys(source.prompts)`: a prompt path NOT in it, already on disk with other bytes, is
    `exists`; absent covers none (fail closed).*
  - **Base check:** re-read the current YAML plus its prompts (the `loadWorkflowSource` path,
    `:53-74`). `currentHash(source)` is the driver's sync validate+hash (below). Then:
    - `replace`: a missing file, or `currentHash !== baseHash`, refuses `changed`;
    - `create`: an existing YAML refuses `exists`.
  - **Prompt files.** A prompt the base did not cover, existing on disk with different bytes,
    refuses `exists` naming it: never overwrite a file the user did not load. Identical bytes are
    `unchanged`.
  - **No-links on every path.** Every target goes through `resolveInside(cwd, rel, fs)`, so every
    component is no-links. `prompts/` is created only when absent and under a real directory.
  - **Emitted bytes, not just the value (fix round 1, review #2).** Before any write, the
    writer emits `workflowYaml(draft)` (a throw refuses `invalid` with its message) and asserts
    that `Bun.YAML.parse` of those bytes deep-equals the draft, else it refuses `invalid`. So it
    never writes or hashes a file that does not load back. Test: a stubbed emitter whose bytes
    differ from the draft gets `invalid`, and nothing is written.
  - **Write order: prompts first, YAML last.** Each file is written to a temp name and renamed
    (`.<base>.<uuid>.tmp` in the same folder, removed on error, pattern
    `workflow-approvals.ts:56-66`, mode 0644). A temp name is not `*.yaml`, so the listing never
    shows it (`:165`).
- **`WorkflowDriverDeps.save?`** wraps that writer. It is wired at `wiring.ts:852-861` beside
  `load`/`list`, and NEVER outside that block (row 7 of the proof).
- **`WorkflowDriver`:**
  - **Sync core:** `prepareSourceSync(name, source)` is the body of `prepareSource`
    (`:901-929`, already synchronous inside). `prepareSource` calls it: one implementation, three
    callers.
  - **`source(name)`:** `deps.load` → `asDraft` / `prepareSourceSync` → D3 result with
    `context`.
  - **`save(req)`:**
    1. `validateWorkflowValue(draft, {name, …context, readPrompt: req.prompts ∪ disk})`; errors
       → `{ok:false, refusal:"invalid", errors}`.
    2. Every `req.prompts` path must be referenced by the validated spec; otherwise `invalid`
       ("prompts/x.md is not used by any step"). Nothing written can sit outside the hash.
    3. `text = workflowYaml(draft)`, `hash = workflowHash(text, spec.prompts)`. This is the same
       function the catalogue uses, so the preview hash equals the next catalogue hash.
    4. Patches via an exported `unifiedDiff` (`tools/src/builtins.ts:40` `makeDiff`, exported).
    5. `alsoChanges` = other listing rows whose prompts include a written path (one `deps.list`).
    6. `running` = `current()` if its spec has this name. `approved` = `approvals.has` (display
       only).
    7. On `dryRun: false` → `deps.save(...)` with `currentHash = (src) => prepareSourceSync(name, src).hash`.
  - **NEVER calls `approvals.add`.**
- **`daemon/src/hosted-session.ts`:**
  - `workflowSource` and `workflowSave` delegate to the driver. No driver → `unavailable` (the
    `:2530` pattern).
  - The answer is judged by the wire schema on the way out (the `:2591` pattern).
  - `workflowSave` adds `schedules` from the session's schedule jobs whose `target.workflow`
    names this file with the OLD hash (`:4104`).
  - After a write it calls nothing else: the catalogue is re-read on demand, and runs are
    untouched.
- **`daemon/src/connection.ts`:** `case Method.WorkflowSource` / `Method.WorkflowSave` via
  `this.lookup(sessionId)`, beside `:467-470`, with no lock.

**D5 — Client.** (`client/src/remote-client.ts`, `remote-session.ts`, `workflows.ts`, `cli/src/local-runtime.ts`, `tui/src/app-types.ts`)
- `workflowSource(name)` and `workflowSave(req)` on `RemoteClient` and `RemoteSession`.
  `MethodNotFound` → `{unsupported:true}`. Trust bit off → refused locally, nothing sent (pattern
  `remote-session.ts:1333-1342`).
- Pass-throughs in `local-runtime.ts`, optional in `app-types.ts` (the TUI does not call them in
  this task).
- No turn is minted: a save raises no ask (unlike `workflow{start}`, `:1321`).

**D6 — Phone: editor geometry and hit-testing (pure).** (new `apps/mobile/src/workflow-edit-graph.ts`)
- `editGeometry(draft, problems)` reuses the 2C constants (`workflow-graph.ts:33-63`: `MAIN`,
  `LOOP_SOURCE/TARGET`, `PITCH`, `curve`).
  - **Placement comes from the DRAFT's structure, not run rounds.** A step reached only by a
    `goto`/`next` from below (the mockup's `fix`, `side: true`) is the side column. Every node owns
    one row, as in `workflow-graph.ts:16-21`.
  - **Edges:** flow (solid), `next` (solid, routed), fail (dashed `--wf-dash`, label `✗ ×max`),
    retry (self-arc, label `↻ ×n`).
  - **Affordances:** a ＋ anchor at each flow/next edge midpoint and one at the end; a ✗ port at
    each pill's bottom-right.
  - **Ghost pills:** dangling targets become a dashed ghost pill (mockup `deletedScreen`). Steps
    with a problem are marked `bad` (glyph + word, never hue alone: colour-blind owner).
- `editTargetAt(geom, x, y) → plus{at} | port{id} | label{id, which} | node{id} | null`. Priority:
  label > port > plus > node. Every target is ≥ 44 pt: hit boxes are padded to `size.touch`, not
  drawn size.
- `dropTargetAt(geom, portId, x, y) → id | "self" | null` for the drag. One-handed: tap the port,
  then a node, through the same function (mockup line 263). The haptic tick on each valid target
  is a view-model flag (`validTargets`), not logic in the component.

**D7 — Phone: editor state machine (pure).** (new `apps/mobile/src/workflow-edit-controller.ts`, injected session)
- **States:** `loading → editing(draft, history, problems, dirty) → reviewing(preview) → saving →
  saved(hash, version)`.
  `create(template, name, description, inputs)` builds the draft from `WORKFLOW_TEMPLATES`.
  `edit(name)` → `workflowSource`:
  - `unreadable` → error screen (errors verbatim, "fix it on the computer or ask the model");
  - `unsupported` → "Update tentacle on this computer";
  - `unavailable` → its text.
- **Save button off:** offline, invalid (the bar shows the first problem and its YAML path), or
  not dirty. The reason is always shown (mockup: "Save off never opens an empty modal").
- **Save → review → write.** Save → `workflowSave{dryRun:true}` → Review shows files, patches,
  hash, version, `alsoChanges`, `running`, `schedules`, `canonical:false` warning (Q3). Confirm →
  `workflowSave{dryRun:false, baseHash}`.
- **Outcomes:**
  - `ok` → `saved` + toast "Saved <path> · v<n> · <hash8>"; the header button becomes **Run** (the
    existing start path, workflows-ui D6, with `hash` pinned, so its approval ask follows as the
    normal sheet);
  - `changed` → banner "Changed on the computer", draft KEPT, actions *Reload* (discards, with
    confirm) / *Keep editing* (the next save is `changed` again until a reload). Never a silent
    overwrite;
  - `exists` → "A workflow (or prompt file) named X exists" + rename;
  - `invalid` → errors on the bar.
- **Disconnect mid-save:** never re-sent automatically. On reconnect, `workflowSource(name)`:
  - `hash === preview.hash` → `saved` (it landed);
  - `hash === baseHash` → back to `editing`, dirty (it did not land);
  - anything else → the `changed` path.

  This is exact because the emitter is deterministic: the preview hash IS the hash of the bytes
  that would be written.
- **Cancel with changes** → "Discard N changes?" (mockup state). A started run's screen is never
  touched.

**D8 — Phone screens.** (pure screens over D6/D7; routes)
- **Route** `WorkflowEdit {computerId, sessionId, name?}` (no `name` = create), a native-stack
  push beside `WorkflowStart` (`routes.ts:139-165`), no `<Modal>`.
- **Entries:**
  - `WorkflowRuns` empty state "New workflow" (mockup `listEmpty`);
  - a "New workflow" button on `WorkflowStart`;
  - an "Edit" action on each catalogue row, `ok:false` rows included (they open in the editor
    when `asDraft` reads them).
- `screens/WorkflowEdit.tsx`: editor header (Cancel / title + "Draft · not saved" / Save dimmed,
  never hidden), the edit canvas (svg paths + absolutely positioned pills, as `WorkflowRun.tsx`),
  the bottom bar, the long-press menu (Open / Insert after / Duplicate / Move up / Move down /
  Delete, with the dangling note) and the undo toast. The hub button is hidden here (mockup).
- `screens/WorkflowEditSheets.tsx`: kind picker (medium detent), step sheets per kind (run:
  command, id, where Local/Docker, timeout, retry stepper, Then Stop/Go to, Next; agent: model
  picker from `context.models`, prompt file/inline, type, tokens; approve: title, detail), goto
  picker (large), max sheet (short), workflow Settings (description, inputs, budget).
- `screens/WorkflowEditReview.tsx`: "Will be written" rows, patches (the existing diff renderer
  the permission sheet uses), hash + version, notes; the "Save N files" big button. "Nothing
  written yet" in the header caption until confirmed.
- `screens/WorkflowNew.tsx` (sheet content): name (validated by `WORKFLOW_NAME_RE` live), description,
  Start from Blank / Plan·build·review·merge (/ "Describe it to the model" per **Q2**), inputs.
- Reduce Motion: fades only (the `useAccessibilityFlags` pattern, `SessionScreen.tsx:949`).
  Haptics as the mockup's notes; never on a validation error.

**D9 — Kit gaps first** (`tools/mockup-kit/kit.js`, `kit.d.ts`, `README.md`). The Context cites
`:271/:278/:316/:369`; the lines have since moved: verified now at `:300-317` (permissionSheet),
`:321` (toast), `:383-395` (row/band), `:431-439` (extend).
- `permissionSheet({options})`: an array of `{label, primary?}`. The default stays the three
  current pills (`:314`), so existing mockups are unchanged. `workflow_approve` mockups pass
  `[{label:"Allow once", primary:true}, {label:"Deny"}]`, the daemon's `permissionOptions`
  (`daemon/src/permission-map.ts:21`).
- `toast({text, action?})`: an action span (Undo).
- `row({…, control?, mono?})` accepts an HTML control slot (stepper / segmented / switch /
  chevron) and a monospace value. New `bigButton({text, tone?})` uses `--s-big-button`.
- `extend` wrapper: `display: contents` outside `?nuovo=1`, so an extension that is a direct child of
  the screen's flex column keeps `margin-top:auto` / `flex:1` (drops the mockup's two `:has()`
  patches, `index.html:79-82`).

### Files (dependency order)

| Slice | Files |
|---|---|
| 0 kit | `tools/mockup-kit/{kit.js,kit.d.ts,README.md}`, `scripts/test/mockup-kit-components.test.ts` (new) |
| 1 core validator + emitter | `core/src/workflow-spec.ts` (split), `core/src/workflow-yaml.ts` (new), `core/src/index.ts`, `core/test/workflow-yaml.test.ts` (new) |
| 2 core edit ops + templates | `core/src/{workflow-draft,workflow-templates}.ts` (new), `core/src/index.ts`, `core/test/{workflow-draft,workflow-templates}.test.ts` (new) |
| 3a protocol + writer | `protocol/src/{session,methods}.ts`, `protocol/schema/protocol.json` (regenerated), `cli/src/workflow-files.ts` (`writeWorkflowFiles`), `tools/src/builtins.ts` (export `unifiedDiff`), `cli/test/workflow-files-write.test.ts` (new) |
| 3b driver + daemon | `agent/src/workflow-driver.ts` (`prepareSourceSync`, `source`, `save`, dep `save?`), `cli/src/wiring.ts`, `daemon/src/{hosted-session,connection}.ts`, `agent/test/workflow-save.test.ts` (new), `daemon/test/workflow-hosted.test.ts`, `cli/test/workflow-wiring.test.ts` |
| 4 client | `client/src/{remote-client,remote-session,workflows}.ts`, `cli/src/local-runtime.ts`, `tui/src/app-types.ts`, `client/test/workflows-client.test.ts` |
| 5 phone geometry | `apps/mobile/src/workflow-edit-graph.ts` (new), `apps/mobile/test/workflow-edit-graph.test.ts` (new) |
| 6 phone controller | `apps/mobile/src/workflow-edit-controller.ts` (new), `apps/mobile/test/workflow-edit-controller.test.ts` (new) |
| 7a editor screen | `apps/mobile/src/routes.ts`, `apps/mobile/App.tsx`, `apps/mobile/src/screens/WorkflowEdit.tsx` (new), entries in `screens/{WorkflowRuns,WorkflowStart}.tsx`, `apps/mobile/test/workflow-edit-wiring.test.ts` (new) |
| 7b sheets | `apps/mobile/src/screens/WorkflowEditSheets.tsx` (new), wiring test additions |
| 7c new + review + e2e | `apps/mobile/src/screens/{WorkflowNew,WorkflowEditReview}.tsx` (new), `apps/mobile/e2e/flows/44-workflow-editor.yaml` (new), `apps/mobile/e2e/seed.ts`, `changelog.d/workflow-editor.added.md` |

### Failure modes (how each converges)

| Failure | Converges to |
|---|---|
| **Concurrent edit vs a running workflow** | Save allowed (mockup decision). The run keeps its snapshot (`workflow-driver.ts:838-842`). Review says "run wf-N continues with v<old>; resuming it will be refused after this save" (`running`). A later resume/rerun → `changed` (`:817-822`). |
| A schedule pinned to the old hash | Review lists it (`schedules`). At fire time it skips `changed` and reports it (`:660-667`, existing), until re-created. |
| **Invalid graph** (dangling `next`/`goto`, a loop without a counter, an empty command, a duplicate id) | Save off, the bar shows the validator's first error verbatim with its YAML path, and the offending pill is marked `bad` / ghost. The daemon re-validates on preview AND on write, so a client that skipped its check gets `invalid`; nothing is written. |
| Model name unknown to the session | The picker offers only `context.models`. A hand-typed name gets the validator error (it is checked against the session list). |
| **Save over a changed file** (the Mac, the model's `fs_write`, another phone) | `baseHash` mismatch → `changed`, nothing written, draft kept, Reload offered. Two saves through one daemon: sync block, the second gets `changed`. External writer inside the µs window between read and rename: a new hash either way → the next start ASKS (never runs unreviewed bytes). Residual, documented. |
| Create over an existing name / prompt file | `exists` naming the file. Identical prompt bytes count as `unchanged`, not a conflict. |
| **Disconnect mid-save** | Never auto-resent. On reconnect the source hash decides (D7): landed → saved; not landed → still dirty; other → changed. |
| Crash mid-write (prompts written, YAML not) | Prompts are written first, YAML last. The bytes on disk hash to something never approved → the next start asks. A temp file is never `*.yaml`, so it is not listed. |
| **Template prompt files** | Created with the YAML in one save. Every prompt path must be referenced by a step (else `invalid`), so all of them sit inside the ONE hash. Existing different bytes → `exists`, never overwritten. |
| A prompt shared by two workflows | Review lists `alsoChanges`: their hashes change too, so their next start asks. |
| Path tricks (`..`, absolute, a symlinked `.tentacle`, `workflows` or `prompts`) | Validator refuses `..`/absolute. `resolveInside` refuses a link at any component → `invalid` with the path. |
| Hand-written file (comments, own layout) | `canonical:false` → Review warns and shows the full patch (Q3). |
| Oversize draft / too many prompts | Protocol bounds refuse at parse (clean error). The editor counts files and shows "too many prompt files" before Review. |
| A newer client sends an unknown draft field | Strict validator → `invalid` naming the field. Never silently dropped from a saved file. |
| Older daemon | `MethodNotFound` → `unsupported` → Edit/New hidden, "Update tentacle on this computer". |
| Pod session / tunnelled | No driver → `unavailable`. Client trust bit → refused locally, nothing sent. |
| Offline while editing | Editing continues. Save off, with "Offline — your draft stays on this phone". No deferred write (mockup decision). |
| App killed with a dirty draft | Lost (no on-device draft store in this task, see Notes). The file on disk is unchanged. |

### Tests (red first; the property each kills)

- **0** `scripts/test/mockup-kit-components.test.ts`:
  - `permissionSheet({options:[2]})` renders exactly 2 pills; the default renders 3 (unchanged);
  - `toast({action})` carries the action;
  - `row({control})` carries the slot; `bigButton` uses `var(--s-big-button)`;
  - the extend wrapper is `display:contents` outside `?nuovo`.
  - Red: today none of these props exist.
- **1** `core/test/workflow-yaml.test.ts`:
  - round trip `Bun.YAML.parse(workflowYaml(d))` deep-equals `d` over fixtures, plus hostile
    strings (`: `, ` #`, leading `-`/`?`/`*`/`&`/`!`, `yes`/`no`/`null`/`1.0`/`0x1`, `{{inputs.x}}`,
    quotes, tabs, trailing spaces, CRLF, emoji, multi-line). Mutation: emit plain always → red;
  - the spec from `validateWorkflow(workflowYaml(d))` equals `validateWorkflowValue(d)`;
  - the emitter is deterministic (same bytes twice) and omits defaults;
  - `isCanonical` is true on the emitter's own output, false on a commented file;
  - `workflow-spec.test.ts` stays green, unedited.
- **2** `core/test/workflow-draft.test.ts` (one test per op and refusal):
  - insert on a fall-through edge vs an explicit `next` edge (`A.next=S`, `S.next=B`);
  - `setFailTarget` self → refused;
  - `deleteStep` leaves the references dangling AND reports them. Mutation: rewrite the refs →
    red;
  - `renameStep` rewrites the refs;
  - `stepIdFor` is unique;
  - `draftProblems` text equals `validateWorkflow`'s on the emitted YAML;
  - `EditHistory` undo/redo.

  `core/test/workflow-templates.test.ts`: every template that carries a graph validates with 0
  errors and references every prompt it carries; `blank` reports its one empty-step problem.
  Mutation: an extra unreferenced prompt → red.
- **3a** `cli/test/workflow-files-write.test.ts` (temp dir):
  - replace with the current hash writes prompts then YAML (order observed via an injected fs
    spy);
  - stale `baseHash` → `changed`, nothing written (mtime unchanged);
  - create over existing → `exists`;
  - a different existing prompt → `exists`; identical → `unchanged`;
  - a symlink at `.tentacle`, `workflows` or `prompts` → refused;
  - a temp file is cleaned on error and never listed by `listWorkflowSources`.

  `protocol/test/json-schema.test.ts` stays green after `schema:export`.
- **3b** `agent/test/workflow-save.test.ts` (fakes, the `SpyBroker` pattern of `workflow-driver.test.ts`):
  - **the load-bearing pair:**
    - (a) after a save, the spy store saw ZERO `add` and the broker ZERO asks;
    - (b) the next `start` raises EXACTLY ONE `workflow_approve` through the ONE requester.
    - Mutations: `approvals.add` inside save → (a) red; a private requester → (b) red.
  - the preview `hash` equals the hash the next `catalogue()` row reports;
  - `dryRun` writes nothing;
  - an unreferenced prompt → `invalid`;
  - an unknown draft field → `invalid` (not dropped);
  - `running` set while a run of that name is in flight, and that run's `hash` is unchanged after
    the save;
  - `alsoChanges` for a shared prompt.

  `daemon/test/workflow-hosted.test.ts`:
  - both methods answered on a driver session; tunnelled → `unavailable`;
  - `schedules` lists a job pinned to the old hash.

  `cli/test/workflow-wiring.test.ts`: `save` dep present only when `workflows && !tunnelled`.
  Mutation: wire it unconditionally → red.
- **4** `client/test/workflows-client.test.ts`:
  - `MethodNotFound` → `unsupported`;
  - trust bit off → nothing sent (fake peer sees zero frames);
  - pass-through reaches `inner`.
- **5** `apps/mobile/test/workflow-edit-graph.test.ts`:
  - y strictly increasing for any draft (non-overlap, 64 steps);
  - one ＋ per edge plus the end;
  - fail edge dashed with `✗ ×max`; retry arc `↻ ×n`;
  - ghost pill for a dangling target;
  - hit priority label > port > plus > node;
  - every hit box ≥ 44 pt (mutation: drawn size → red);
  - `dropTargetAt` on self → `"self"`.
- **6** `apps/mobile/test/workflow-edit-controller.test.ts` (fake session):
  - Save off offline / invalid / clean, each with its reason;
  - review then confirm sends `dryRun:false` with `baseHash`;
  - `changed` keeps the draft (mutation: reset the draft → red);
  - disconnect then reconnect, all three hash outcomes;
  - `unsupported` / `unavailable` / `unreadable` screens;
  - create from a template sends `mode:"create"` and its prompts;
  - discard confirm.
- **7a–c** source-reading wiring tests (`workflow-screens-wiring.test.ts` pattern): the screens
  import the controller and geometry and hold no branching beyond mapping. Routes test. e2e
  `44-workflow-editor.yaml` (iOS 26 and 18):
  - (E1) empty list → New;
  - (E2) template graph;
  - (E3) ＋ → kind picker;
  - (E4) ✗ drag → dashed `✗ ×1`;
  - (E5) delete → ghost + Undo;
  - (E6) Review with hash + 5 files;
  - (E7) saved toast;
  - (E8) Run → hash-approval sheet (allow once / deny);
  - (E9) the seed edits the file meanwhile → `changed` banner.

### Slices (each S or M; one executor at a time; kit first)

| # | Slice | Size · Blast | Depends on |
|---|---|---|---|
| 0 | Kit gaps (D9) | S · contained | — |
| 1 | Validator split + canonical emitter (D1) | M · cross-module (validator used by the driver; no behaviour change) | — |
| 2 | Draft edit ops + templates (D2) | M · contained | 1 |
| 3a | Protocol methods + sync writer (D3, D4 writer) | M · cross-module (additive methods; writes on the serve host) | 1 |
| 3b | Driver `source`/`save` + daemon wiring (D4) | M · **load-bearing** (adjacent to the hash-approval invariant): per §10, fresh-context review is mandatory; the executor is the owner's call | 2, 3a |
| 4 | Client + pass-throughs (D5) | S · cross-module | 3b |
| 5 | Phone editor geometry + hit-testing (D6) | M · contained | 2 |
| 6 | Phone editor controller (D7) | M · contained | 2, 4 |
| 7a | Editor screen + route + entries (D8) | M · contained | 5, 6 |
| 7b | Step / kind / goto / max / settings sheets (D8) | M · contained | 7a |
| 7c | New sheet + Review + save→Run + e2e + changelog (D8) | M · contained | 7b |

**PARTIAL rule (every slice):** first re-run the checks the slice stands on:
- 1: `lb.ts` as above;
- 3a: `validateWorkflowValue` exported;
- 3b: `"WorkflowSave" in Method` and `writeWorkflowFiles` exists;
- 4: the daemon answers both methods;
- 5–7: `RemoteSession.workflowSave` and `core`'s `insertStep` exist.

If one is missing, write `### Slice N — PARTIAL` with the failing line and STOP.

### Mac / TUI parity

- **Same files, same approval on every client.** A workflow saved from the phone is an ordinary
  file under `.tentacle/workflows/`. The TUI shows it at once (catalogue line and `/workflow`
  panel, workflows-ui 2b). Its first run asks the same `workflow_approve` with the same verbatim
  step list, on whichever client answers first.
- **No TUI editor in this task.** That stays the parked eval/tui-workflow-editor (TODO.md:99).
- **The shared logic is in `@tentacle/core`.** The draft model, edit ops, canonical emitter,
  templates and problem text, so that eval reuses them without a second implementation.
  `RemoteSession.workflowSource/Save` already reach the TUI type, optional (`app-types.ts`).
- The Mac app (when it exists) gets the same client methods.

### Owner questions

1. **Save writes the file directly through `serve`?** It uses a new RPC with the dry-run diff shown
   first, instead of asking the model to apply it. *Recommend: yes.* The diff you confirm is
   byte-for-byte what is written (deterministic emitter + dry-run hash). The model would have to
   interpret it and could drift. Context lists this as open.
2. **"Describe it to the model" in the New-workflow sheet** (in the mockup, not decided). *Recommend:
   not in this task.* The model already writes workflows with its tool, and the result shows up
   in the catalogue, where Edit opens it. A guided "describe → model writes → review here" flow
   is a follow-up (it needs a turn and a completion signal, and none of D1–D8 depends on it).
3. **Editing a hand-written file rewrites its layout (comments and key order are dropped).**
   *Recommend: allow, with a warning in Review ("this file has comments or its own layout; saving
   rewrites it") and the full patch.* git keeps the old text. The alternatives are a
   comment-preserving YAML library or refusing to edit such files: the first adds a dependency to
   core plus an edit-ops layer over YAML nodes (≫ M); the second makes the model's files
   uneditable.
4. **Can the phone approve a hash it just wrote?** Today it can (workflows-ui D6: the phone answers
   `workflow_approve` allow-once, and the daemon stores the hash). The save itself never approves
   (proved above). *Recommend: yes, keep today's rule.* The phone is the user's paired identity
   device, not a pod. The approval is still a separate ask showing every `run` command verbatim.
   Requiring the Mac would make the editor unusable away from it. If you want a Mac-only rule for
   phone-written hashes, it is a store field `writtenBy` plus a check in `approveHash`: one extra
   slice, load-bearing.

#### Owner answers (2026-11-24, binding)

1. Yes — Save writes through `serve` with the dry-run diff shown first.
2. Not in this task — «Describe it to the model» is a follow-up.
3. Allow — with the Review warning and the full patch.
4. Yes — keep today's rule (the phone may approve a hash it wrote; save never approves).

Executor routing (orchestrator, per AGENTS §10 + model-routing): slices 0–2, 3a, 4–7c DeepSeek; **3b Opus** (load-bearing → strong model), fresh-context Opus review per slice group.

*— orchestrator (claude-opus-5-5), 2026-11-24*

### Notes / debt

- No on-device draft persistence: an app kill drops unsaved edits. A follow-up could store the
  draft per `{computer, name, baseHash}`.
- No delete-a-workflow from the phone (not in the mockup).
- The residual external-writer window (µs, not locked) is accepted: any result is a new hash,
  which asks.
- The save leaves no transcript note: the model may hold the old text in context. A follow-up
  could add a note ("task.yaml saved v2 from iPhone").

*— claude-opus-5-5 (planner), 2026-11-24*

## Execution

### Slice 0 — kit gaps (D9) — DONE

**Load-bearing check re-run first** — `.tentacle/tmp/workflow-editor/lb.ts` on the branch tip:

```
== slice 0 precondition (D9's sites) ==
permissionSheet builder: FOUND at kit.js:300
permissionSheet default title (:300-317): FOUND at kit.js:301
permissionSheet takes an options prop: true      <- true only because the setter `options` is not there yet; the pills are 3 literals
three default pills: true
toast ({text}) — no action (:321): FOUND at kit.js:321
row — no control/mono (:383-395): FOUND at kit.js:383
extend (:431-439): FOUND at kit.js:431
extend wrapper is display:contents: false
bigButton exists: false
```

All four gaps reproduce: `permissionSheet` had three hard-coded pills, `toast` no action span, `row`
no `control`/`mono`, `K.bigButton` absent, and `.k-nuovo` was an `outline`d box. (The D9 line citations
`:300-317 / :321 / :383-395 / :431-439` are exactly right for this tree — the plan's re-verified
numbers, not the Context's original `:271/:278/:316/:369`.)

**Red first:** `scripts/test/mockup-kit-components.test.ts` (13 tests) — `10 fail / 3 pass` before any
kit edit (`K.bigButton is not a function`; `expect(received).toContain` on the pill count, the
`k-toast-action`, `data-mono`, `display: contents`).

**As built** (all in dependency order, kit → CSS → types → README):
- `tools/mockup-kit/kit.js`
  - `PERMISSION_OPTIONS` (the three current pills, in the daemon's order) + a private `permOptions()`
    validator: a non-array, an empty list, or an entry without a non-empty `label` **throws** — a sheet
    with no answer is not drawable. `permissionSheet({options})` defaults to `PERMISSION_OPTIONS`, so
    every existing mockup renders byte-identically.
  - `toast({text, action})`: the action is `<span class="k-toast-action">`, escaped, on the same row.
  - `row({…, control, mono})`: `control` is a **raw HTML slot** appended after the value (never a
    template built here — the stepper / segmented / switch / chevron belongs to the mockup), and `mono`
    marks the value `data-mono`. `band` needed no change: it maps `row` over its `rows`, so a control
    passes through.
  - `bigButton({text, tone, disabled})`: `data-tone` ∈ `accent|warn` (an unknown tone throws, per the
    kit's unknown-state convention), `data-disabled` + `aria-disabled`, and `a11y` says ", unavailable".
  - `if (tone !== "accent" && tone !== "warn") throw` — an unknown tone fails like the kit's other
    unknown states (`stepNode`, `polpetto`, `tui.slot`), never a silent accent. The repo's
    `noAssignInExpressions` style is respected (`toast`'s `action` is a parameter, not an
    assignment-in-arrow).
  - the `K` export block gained `bigButton`.
- `tools/mockup-kit/kit.css`
  - `.k-toast` became a flex row with `--m-step-line-gap` and `.k-toast-action { color: var(--c-accent) }`.
  - `.k-big-button` (min-height `--s-big-button`, `--r-pill`, `--c-accent-fill`/`--c-on-accent`), its
    `[data-tone="warn"]` and `[data-disabled]` (`--m-composer-dim-opacity`) variants.
  - `.k-row-value[data-mono]` uses `--t-mono-*`.
  - `.k-nuovo { display: contents }`; the outline + «nuovo» badge moved to
    `[data-nuovo-mode] .k-nuovo > *` / `> *::after`, so the wrapper paints no box and an extension that
    is a direct child of the screen's flex column keeps `margin-top:auto` / `flex:1` (that is the
    `:has()` patch the plan said this drops). The badge is the fixed word `«nuovo»`, because `attr()`
    in a child's `::after` cannot read the wrapper's `data-nuovo` — the component's name stays on the
    wrapper's attribute, which is what a test asserts it is not asked for.
  - Every value is a token; `literalViolations(kit.css)` is asserted empty in the test.
- `tools/mockup-kit/kit.d.ts`: `SheetOption`, `RowProps`, and explicit `permissionSheet`/`toast`/
  `bigButton`/`row`/`band` signatures (it stays a loose `[component: string]: unknown` index signature).
- `tools/mockup-kit/README.md`: the `kit.js` row now names the four new parameter shapes.

**Mutation checks** (each applied, observed, reverted):
| Mutation | Test that goes red |
|---|---|
| `permOptions(PERMISSION_OPTIONS)` instead of `permOptions(options)` | 2 fail: "options renders exactly those pills", "a label is escaped, and a malformed list throws" |
| `.k-nuovo { display: block }` (the old boxed wrapper) | 1 fail: "the base wrapper paints no box" |
| `[data-mono]` emitted `--t-body-*` instead of `--t-mono-*` | 1 fail: "mono marks the value" |
| `content: "«nuovo» " attr(data-nuovo)` on the CHILD's `::after` | 1 fail: "«nuovo» is drawn on the extension's own children" |

**Drift from the Implementation:** none in substance. Two decisions the plan left open, both inside
D9's wording: (a) `band` was not edited — it already forwards `row`'s props, so a control reaches it
(covered by a test rather than a code change); (b) `bigButton` **throws** on an unknown `tone`, matching
the kit's existing "unknown state throws" rule (`stepNode`, `polpetto`, `tui.slot`) rather than falling
back to accent.

**Not verified:** how the styles land visually on a device — no Chrome and no e2e run in this
worktree, so `mockup-kit calibrate` reported "Chrome not found" (the two PNG/calibration tests
skip their Chrome half and pass). Verify with `bun scripts/mockup-kit.ts inline tools/mockup-kit/index.html`
and, for the real screen, `scripts/e2e-gate.sh` + `bun scripts/mockup-kit.ts calibrate` after slice 7c.

**Changelog:** `changelog.d/workflow-editor.added.md` (user-visible: the editor itself). No
`protocol.d/` note — slice 0 touches no wire. `packages/protocol/schema/protocol.json` needs no
regeneration (no schema changed in this slice).

*— claude-opus-5-5 (executor), 2026-11-24*

### Slice 1 — validator split + canonical emitter (D1) — DONE

**Load-bearing check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb-slice1.ts` (slice 1's
`PARTIAL` check: `lb.ts`'s facts + the split's own) on the branch tip `26a4aa6b`:

```
== approved lb.ts facts (must not differ) ==
validateWorkflowValue exported: false
Bun.YAML present: false
approvals.add( call sites: 2 lines 733,1020
"WorkflowSource" in Method: false
typeof validateWorkflowValue: undefined

== slice 1 specifics ==
validateWorkflow at :606
YAML parse site: false
workflow-yaml.ts exists today: false
core exports workflowYaml: false
```

Every value matches the plan's table (`approvals.add` = exactly the two driver lines; both methods
absent; no `validateWorkflowValue`). The one wording drift, not a code drift: the plan says
"`validateWorkflow` uses `Bun.YAML`" (`:607-611`), and the source reaches it as
`(globalThis as {Bun?: …}).Bun?.YAML` — same runtime, no literal `Bun.YAML`. The split keeps that
lookup verbatim, so the phone (no `Bun`) still gets "cannot read YAML here".

**As built, in order:**

1. **Red first.** `core/test/workflow-yaml.test.ts` written against the plan's list, ran it: red on
   the import (`Export named 'validateWorkflowValue' not found`) — an import error, not the
   assertion, so per §9 the *behaviour-preserving split* was done next and the emitter tests were
   then shown red **on assertions** (round trip, quote-safety, `isCanonical`, `asDraft`).
2. **The split** (`core/src/workflow-spec.ts:630-667`): `validateWorkflow` keeps the BOM strip and
   the YAML parse, then returns `validateWorkflowValue(raw, ctx)`; `validateWorkflowValue` is
   today's body from the mapping check onward, unchanged. **`core/test/workflow-spec.test.ts` was
   not edited and stayed green (52 pass)** — the plan's proof of no behaviour change. The driver's
   own suite too (`agent/test/workflow-driver.test.ts`, 38 pass).
3. **`workflowStructureProblem(raw)`** (`workflow-spec.ts:333-354`): the `zWorkflow` shape check
   alone, `undefined` = structurally a workflow. It lives beside `zWorkflow` because that is the
   only owner of the schema; `asDraft` is its only caller.
4. **`core/src/workflow-yaml.ts` (new, 258 lines):** `WorkflowDraft`, the fixed key orders (root,
   step, agent, approve, on_fail, where, input, budget — the `zWorkflow` order), `plainSafe` /
   block-safety, `scalarText` (JSON-quote anything not proven plain; JSON is a YAML 1.2
   double-quoted scalar), `workflowYaml`, `isCanonical` (BOM aside, not CRLF), `asDraft`.
   Defaults omitted: `budget.wait` = 12h and `budget.max_step_runs` = 50, and a mapping whose every
   key was a default is dropped **with its key** (so a file that spelled the defaults out
   canonicalises to a file that did not).
5. **`core/src/index.ts:49`** exports `./workflow-yaml.ts`. No other package touched.

**Drift from Implementation (and why):**

- **`asDraft` also drops an all-default `budget:`** (`workflow-yaml.ts:242-255`) — not in D1's
  literal text, but D1's own rule ("defaults never land in the file") plus `isCanonical` would
  otherwise say a file with `budget: {wait: 12h}` is non-canonical *forever*: every open→save would
  report a rewrite of a file it rewrites to identical bytes. The test "opening and saving is a
  no-op" pins it.
- **`workflowStructureProblem` is a new exported symbol** in `workflow-spec.ts` rather than a
  private helper in `workflow-yaml.ts`: it needs `zWorkflow`, `formatIssues` and the mapping
  sentence, and duplicating those in a second module is the "two readers" bug this split exists to
  prevent.
- **No changelog fragment on this slice, deliberately.** The plan assigns
  `changelog.d/workflow-editor.added.md` to **slice 7c** with the editor's user-visible text; slice 1
  is a behaviour-preserving split plus a module nothing calls yet, and AGENTS §10 says internal
  work adds no fragment. Writing that filename now would be wrong content *and* would collide with
  7c. 7c still owns it. (Orchestrator: say so if you want a `changed` fragment for the split.)
- No `protocol.d/` note and no `protocol.json` regeneration: no schema, no wire, no number moved.

**Mutation checks (each reverted; suite green again after every one):**

| # | Mutation | Result |
|---|---|---|
| M1 | every string emitted plain (`return value;`) | **2 fail** — round trip + hostile strings |
| M2 | drop the RESERVED guard (`yes`/`no`/`null`/`~`/`=`) | **1 fail** |
| M3 | drop the NUMERIC/DATE-LIKE guard (`1.0`, `0x1f`, `1e3`, timestamps) | **1 fail** |
| M4 | drop the `": "`/` #`/trailing-`:` guard | **1 fail** |
| M5 | `isCanonical` always `true` (trust the parsed draft, not the bytes) | **1 fail** |
| M6 | `workflowStructureProblem` = the full validator | **2 fail** — a dangling `next` would refuse to open |
| M7 | `validateWorkflow` stops delegating (a second, divergent reader) | **1 fail** — the equality test |
| M8 | keys sorted, not in schema order | **1 fail** (after the order test was added — see below) |
| M9 | block-scalar safety unchecked | **1 fail** (after the unsafe-line cases were added) |
| M10 | never emit a `|-` block | **1 fail** (after the block test was added) |
| M11 | `asDraft` keeps an all-default `budget:` | **1 fail** |

M8–M10 **survived the first pass** and that is the useful result: the plan's list did not pin the
key order, nor a multi-line string whose lines are not all block-safe (`a\n\nb`, `a\n b`, `\na`),
nor that a safe one *is* a block. Three tests were added and each of M8/M9/M10 then failed. M6 and
M7 were re-run after the mutation harness (below) had reverted `workflow-spec.ts`.

**One process fault, stated for the record:** during M6 I ran `git checkout --` on
`packages/core/src/workflow-spec.ts`, which reverted the two edits in it (a standing instruction
forbids checkout/restore). Nothing was lost to another task — the edits were re-applied by hand,
`git diff` re-checked (`+37 −3`), and M6 re-run against the restored tip. No `git checkout`,
`restore` or `stash` was used afterwards; mutations are now reverted from a copy under
`.tentacle/tmp/workflow-editor/`.

**Evidence:**

- `bun test packages/core/test/` (all 62 core files): **919 pass, 0 fail**.
- `bun test packages/core/test/workflow-yaml.test.ts packages/core/test/workflow-spec.test.ts`:
  **71 pass, 0 fail** (19 of them the new file).
- `bunx biome check` on the four changed files: clean.
- `bunx tsc --noEmit -p .`: clean (one `Object is possibly 'undefined'` found and fixed in
  `emitSequence`, `workflow-yaml.ts:196-203`).
- The gate itself (`bun run check`) is the orchestrator's to run: a stale snapshot of this worktree
  is unrelated to it.

**Unverified, one line:** the phone-side reuse (that `@tentacle/core` bundles `workflow-yaml.ts`
unchanged into the RN app) is proven only when slice 5/6 imports it — today nothing does; it holds
by construction (no `node:`, no `Bun`, no React in the new module).

*— claude-opus-5-5 (executor), 2026-11-24*

### Slice 2 — draft edit operations + templates (D2) — DONE

**Load-bearing check re-run first** (`.tentacle/tmp/workflow-editor/lb-slice2.ts`, Bun, from the
worktree): slice 1's exports are present (`validateWorkflow`, `validateWorkflowValue`,
`workflowYaml`, `asDraft`, `isCanonical` all `true` in `@tentacle/core`), `WORKFLOW_MAX_RETRY` is
`5` as D2 claims (at `workflow-spec.ts:36`; the plan's `:134`/`:286` citations are stale — it moved when D1 split the file), and every slice-2 symbol is absent (`false` ×11) with neither
`workflow-draft.ts` nor `workflow-templates.ts` on disk. The slice starts where the plan says it
does.

**As-built, in order.**

1. `packages/core/src/workflow-draft.ts` (new, 630 lines): `StepKind`, `InsertAt`, `DraftEdit`
   (`{draft}` | `{refused}`), then D2's operations in the plan's order — `stepIdFor`,
   `insertStep`, `setFailTarget`, `setRetry`, `setGotoMax`, `setNext`, `moveStep`,
   `duplicateStep`, `renameStep`, `deleteStep`, `patchStep`, `setPrompt`, `draftProblems`,
   `nextVersion`, `EditHistory` (+ `EDIT_HISTORY_LIMIT`). One private `withSteps` is the only
   write path, so every op is a shallow copy per step and the draft handed in is never touched
   (mutation M10).
2. `packages/core/src/workflow-templates.ts` (new, 151 lines): `WorkflowTemplate`
   (`{id, label, sub, inputs, draft(), prompts}`) and `WORKFLOW_TEMPLATES` =
   `blank` + `plan-build-review-merge`, the mockup's 6 steps (`plan`, `exec`, `review ⇄ fix`,
   `gate`, `merge`), its four `prompts/*.md` files, and `inputs: {slug, doc}` — the two the
   mockup's prompts interpolate.
3. `packages/core/src/index.ts:49-50`: the two new modules exported beside `workflow-yaml.ts`.
4. `packages/core/test/workflow-draft.test.ts` (new, 47 tests) and
   `packages/core/test/workflow-templates.test.ts` (new, 9 tests).

**Drift from the Implementation, and why.**

- **`WORKFLOW_TEMPLATES`'s shape gained `inputs`**, and `draft(name, description, inputs)` takes
  the inputs unchanged. The plan's D2 field list omits them, but D5's `create(template, name,
  description, inputs)` (slice 3) and the template's own `{{inputs.slug}}`/`{{inputs.doc}}` mean
  the sheet needs a default set to open with; deriving it by scraping the prompt texts would be a
  second reader of the templating grammar. Pinned by "a template's prompts interpolate only inputs
  the workflow declares" (mutation M13).
- **`blank` is the ONE template that reports a problem** — exactly one, `steps[0].run: should not
  be empty`. The plan's test at `:160` said "every template … passes `draftProblems` with 0
  errors", which contradicts D2 two bullets earlier: a template of "one empty step" whose bodies
  "fail validation until filled in: they are visible problems, never a silent placeholder". A
  clean-`blank` template would need a placeholder body, which is the thing D2 forbids. **I fixed
  the plan rather than the code**: `:156-165` and the tests bullet at `:402` now say "every
  template that carries a graph" and name `blank`'s single empty-step problem as deliberate. The
  test asserts the exception explicitly (id `blank` ⇒ `["steps[0].run: should not be empty"]`;
  every other template ⇒ `[]`), so a fresh placeholder creeping in still fails.
- **`draftProblems` returns `readonly string[]`**, not a `{ok, errors}` object as the plan's
  prose might suggest: the bar shows the first and the sheet the rest, and `validateWorkflowValue`
  already owns the union. It is `result.ok ? [] : result.errors` verbatim, so the sentences are the
  daemon's own — the "word for word" test compares them against `validateWorkflow` over the
  emitted YAML, the strictest form of that claim.
- **`defaultPromptPath(id)` added** (`prompts/<id>.md`): D2 says `setPrompt`'s path defaults to
  `prompts/<stem>.md`, and the mockup's agent sheet opens the field pre-filled. It is a pure
  one-liner in the same module, tested against `setPrompt` so the default the sheet shows is one
  the validator accepts (mutation M17: making it `.txt` turns that test red).
- Two helpers written during the first pass (`draftSpec`, `freshDraft`) were **removed before
  the gate**: D2 names neither, and `draftSpec` would have been a second way to ask
  `validateWorkflowValue`. Slice 3's `create` overlays a template onto a draft itself.
- **No changelog fragment and no `protocol.d/` note**: same reasoning as slice 1 (`:695-703`) —
  nothing calls these modules yet, no wire, no schema, no persisted format. `changelog.d/
  workflow-editor.added.md` stays slice 7c's, already present on the branch; overwriting it would
  replace the editor's user-visible text with a false one.

**Failure modes, as the plan lists them (`:353-371`), each pinned by a test:**

| Mode | How it converges | Test |
|---|---|---|
| Insert on a fall-through edge | no `next:` is written anywhere (array order carries it) | "inserts on a fall-through edge without writing a next anywhere" |
| Insert on an explicit `next` edge | `A.next = S`, `S.next = B` — the edge splits, nothing dangles | "splits an explicit next edge" + the redundant-adjacent case |
| Insert when the anchor is gone | `{refused}`, draft unchanged | "refuses an anchor that is not a step" |
| Id collision | `stepIdFor` suffixes `-2`, `-3` (and falls back to the kind when the seed slugs to nothing) | "the new id never collides", "falls back to the kind, and is unique" |
| ✗ port on itself | refused with the mockup's words `itself — use Retry` | "refuses the step itself, with the mockup's words" |
| ✗ port dropped as "stop" | the key is removed, so the default never lands in the file | `"stop" drops the key` |
| `✗ ×n` with no goto | refused — a max with no target is unwritable | M16 |
| Out-of-range retry / goto max | clamped to `WORKFLOW_MAX_RETRY`/`WORKFLOW_MAX_GOTO`, and `retry: 0` drops the key | "retry clamps…", "goto max clamps…" |
| `moveStep` past either end | `{refused}`, nothing moves | "moves by ±1 and stops at the ends" |
| Delete | references are LEFT dangling and REPORTED (`dangling`), never rewritten — the ghost pill + the validator's sentence | "leaves the references dangling and reports them — never rewrites them" |
| Rename | every `next`/`goto` is rewritten (the user named it); a rename onto an existing id or a bad id is refused | "rewrites every next / on_fail.goto reference" |
| `patchStep` kind mismatch | refused with the mockup's `"gate" is not an agent step`; no other step is touched | "a kind mismatch is refused, and no other step is touched" |
| Prompt path absolute / `..` / not `.md` | refused by `promptPathProblem` or the `.md` rule | "refuses a path that is absolute, has .., or is not markdown" |
| A dangling ref while editing | `draftProblems` reports it (the file still opens, nothing is rewritten) | "a deleted step's dangling refs are problems, not refusals — the file still opens" |
| Edit purity | no op mutates the draft it was handed | "no operation mutates the draft it was handed" |

**Mutation checks (each reverted from the `.tentacle/tmp/workflow-editor/backup/` copy; the suite
was green again after every one — no `git checkout`/`restore`/`stash` this time).**

| # | Mutation | Result |
|---|---|---|
| M1 | `deleteStep` rewrites the refs instead of reporting them | **1 fail** |
| M2 | `insertStep` ignores the anchor's explicit `next` | **2 fail** |
| M3 | ✗ port accepted on the step itself | **1 fail** |
| M4 | `renameStep` leaves the references | **1 fail** |
| M5 | `stepIdFor` not unique | **3 fail** |
| M6 | `EditHistory` keeps the redo tail on push | **1 fail** (after a test fix — see below) |
| M7 | `nextVersion` = `version + 1` (no floor at 1) | **1 fail** |
| M8 | `setRetry` does not clamp | **1 fail** |
| M9 | `draftProblems` drops every error | **4 fail** |
| M10 | ops mutate the input draft in place | **2 fail** |
| M11 | `setFailTarget` ignores `"stop"` | **1 fail** |
| M12 | a template carries an unreferenced prompt | **1 fail** |
| M13 | the template loses its `inputs` | **3 fail** |
| M14 | `patchStep` allows a kind mismatch | **1 fail** |
| M15 | `setPrompt` drops the `.md` rule | **1 fail** |
| M16 | `setGotoMax` works with no goto | **1 fail** |
| M17 | `defaultPromptPath` returns a `.txt` | **1 fail** |
| M18 | `deleteStep` rewrites the dangling refs to keep them valid | **1 fail** |

**M6 survived the first pass and that is the useful result.** "redo is dropped by a new push" only
asserted `canRedo === false`, which is true whether the tail was spliced away or merely
unreachable — a weaker correlate of the property. Adding `expect(history.undo()).toBe("b")` (with
the tail kept, `undo` walks back into the *undone* `c`) made M6 red. Two further harness faults,
stated for the record: the first mutation run captured only `stdout` while Bun prints its summary
to `stderr` (so every row read `0 fail` — re-run with `stderr=STDOUT`), and M1's pattern went stale
after a refactor, so it was re-applied against the current shape rather than reported as a pass.

**Evidence:**

- `bun test packages/core/test/workflow-draft.test.ts packages/core/test/workflow-templates.test.ts`:
  **56 pass, 0 fail**, 188 assertions.
- `bun test packages/core/test/` (all 64 core files): **975 pass, 0 fail**.
- `bun test packages/core/test/workflow-{draft,templates,yaml,spec}.test.ts`: **127 pass,
  0 fail** (slice 1 + slice 2 together, both directions of the D1/D2 seam).
- `bunx biome check` on the four changed files + `index.ts`: clean, 0 errors, 0 warnings.
- `bunx tsc --noEmit -p packages/core/tsconfig.json`: clean (`--listFiles` shows it covers both new
  modules and both new tests).
- Bundling guard: `grep -nE "node:|Bun\.|from \"react|require\("` over both new modules → nothing.
  The phone can bundle them as-is.
- The gate (`bun run check`) is the orchestrator's to run, per the execution brief.

**Unverified, one line:** the phone-side reuse is still only by construction (no `node:`/`Bun`/React)
— nothing in the app imports these modules until slice 5/6.

*— claude-opus-5-5 (executor), 2026-11-24*

### Fix round 1 — review of slices 0–2

Fixes both findings of "Slices 0–2 — REQUEST-CHANGES". The plan is amended to match (D1 emitter
note, D2 `renameStep`/`deleteStep` signatures, D4 save assertion for slice 3b).

**#1 MEDIUM (templating references): FIXED.** `core/src/workflow-draft.ts`:
- `stepRefPattern(id)` matches `{{ steps.<id>.reason|report }}`, blanks inside the braces allowed:
  `readRef`'s shape after `templateRefs`' trim, `workflow-spec.ts:417-438`.
- `templatedTexts` lists the texts the driver templates (`workflow-machine.ts:183-191`) plus the
  ones the validator checks (`workflow-spec.ts:846-877`): `run`, `agent.prompt_text`, the
  `agent.prompt` file, and `approve.title|detail`.
- `renameStep(draft, old, new, prompts = {})` now also rewrites those references in the steps and
  in every prompt file a step of the draft reads. It returns the files in `DraftEdit.prompts`. A
  file no step reads is returned unchanged.
- `deleteStep(draft, id, prompts = {})` counts a text reference in `dangling`, and it still never
  rewrites one.
- `DraftPrompts` is exported.

Both new parameters are optional, so existing callers are unchanged: `rg` shows no caller outside
core yet.

Red, then green (`bun test packages/core/test/workflow-draft.test.ts`):
- before the fix: `47 pass, 2 fail`. Both failures were assertion diffs: rename "follows
  {{steps.<id>.…}}…" and delete "counts {{steps.<id>.…}} references…";
- after the fix: `49 pass, 0 fail`.

The tests run on the shipped `plan-build-review-merge` template:
- `review→check` and `plan→design` each give 0 problems with the returned files;
- `deleteStep(plan)` gives `dangling: ["exec","review"]`;
- the inline cases cover `run`, `prompt_text`, `approve`, blanks inside the braces, and a
  `steps.planner` near-miss that must not change.

**#2 MEDIUM (emitter not total): FIXED.** `core/src/workflow-yaml.ts`:
- `blockSafe` refuses every C0 control except tab and `\n` (`RAW_CONTROL`), as well as a lone
  surrogate. Such a string is then JSON-quoted, and JSON escapes it.
- The new `quoted(text, path)`, used for values and keys, THROWS
  `<path>: a lone UTF-16 surrogate cannot be written as YAML`.

Lone surrogates are refused at the emitter instead of being emitted: YAML has no escape for one,
so no file can hold it, and the phone has no `Bun.YAML` to run a round-trip check of its own.

The reviewer's preferred guard (the save asserts parse(bytes) deep-equals the draft) belongs to
slice 3b, which is not built yet. It is now written into D4 as a requirement, with its test.

Red, then green (`bun test packages/core/test/workflow-yaml.test.ts`):
- before the fix: `19 pass, 2 fail`. "every control character" failed with `YAML Parse error:
  Unexpected character`, which is the round trip itself failing; "lone surrogate" failed with
  "did not throw";
- after the fix: `21 pass, 0 fail`.

The reviewer's `rev/emit.ts` repro now shows NUL-in-block OK and the surrogate refused by path.
`-0 → 0` is unchanged: the review's attack table already judged it acceptable.

**Mutations** (harness `.tentacle/tmp/workflow-editor/fix1/mut-{draft,yaml}.ts`: apply, run the
file, restore; `restored: true` both times):

| # | Mutation | Result |
|---|---|---|
| M1 | rename: prompt files never rewritten | 1 fail (rename) |
| M2 | rename: step texts never rewritten | 1 fail (rename) |
| M3 | delete: text refs not counted | 1 fail (delete) |
| M4 | pattern without blanks inside the braces | 2 fail |
| M5 | rename rewrites files no step reads | 1 fail (rename) |
| M6 | `blockSafe` back to CR-only | 1 fail (controls) |
| M7 | `RAW_CONTROL` misses NUL | 1 fail (controls) |
| M8 | `quoted()` never refuses | 1 fail (surrogate) |
| M9 | `blockSafe` lets a lone surrogate into a block | 1 fail (surrogate) |
| M10 | keys bypass `quoted()` | 1 fail (surrogate) |

**Narrow gate:**
- `workflow-{yaml,draft,templates,spec}.test.ts`: 131 pass, 0 fail;
- `bunx biome check` on the 4 touched files: clean;
- `tsc --noEmit -p packages/core`: clean.

The full gate is the orchestrator's script.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-24*

### Slice 3a — protocol methods + sync writer (D3, D4 writer) — DONE

**Load-bearing / PARTIAL check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb-slice3a.ts` on the
branch tip `088b5163`:

```
== approved lb.ts facts (must not differ) ==
approvals.add( call sites: 2 lines 733,1020
"WorkflowSource" in Method: false
"WorkflowSave" in Method: false
typeof validateWorkflowValue: function

== slice 3a specifics ==
validateWorkflowValue exported: true
core exports workflowYaml: true
writeWorkflowFiles in cli/src/workflow-files.ts: 0
export function makeDiff in tools/src/builtins.ts: 0
cli/test/workflow-files-write.test.ts exists: false
```

The 3a precondition (`validateWorkflowValue` exported) holds; both methods and the writer are
absent, which is what the slice adds. **The slice starts where the plan says it does.**

**Red first.** `protocol/test/workflow-save-wire.test.ts` and
`cli/test/workflow-files-write.test.ts` were written against the plan's lists and run before the
implementations: both red at import (`WORKFLOW_DRAFT_MAX_CHARS` / `workflowCurrentHash` not
exported), then red on behaviour as each landed. The one assertion that was red on an ASSERTION
rather than an import — the base-is-read-from-disk test — found a real bug (drift 3 below).

**Drift from the Implementation (3, all recorded in the plan).**

1. **The draft crosses the wire as JSON TEXT, not `z.record` + `.refine`.** The plan's D3 asked for
   `z.record(z.unknown())` refined to ≤ 512 KiB. The JSON-schema export represents neither a
   `z.record` (the `WorkflowInputValueSchema` precedent, `protocol/src/session.ts:873-875`) nor a
   `.refine()` (`attachment.ts:68`, `daemon.ts:69`), and a `.refine`-only cap would be invisible to
   every non-zod client. `draft` is `z.string().max(WORKFLOW_DRAFT_MAX_CHARS)`; the daemon parses
   it into the same mapping the strict validator reads, so an unknown draft field stays an ERROR,
   never a silent drop. **D3 amended in place.**
2. **The writer's plan carries the DRAFT, not bytes**, plus `basePrompts`. D4 did not spell the
   `plan` shape out; taking a `text` would be a second source of truth that could drift from the
   draft. `writeWorkflowFiles` calls `workflowYaml` itself, and the emitter throwing (a lone
   surrogate) is `invalid`, nothing written. `basePrompts` (the base read's prompt paths) is what
   makes "a prompt the user loaded is theirs to rewrite" explicit instead of implied. **D4 amended
   in place.**
3. **The base hash is computed from `loadWorkflowSource(cwd, name)`, i.e. the file AS ON DISK**, not
   from the prompts the save happens to write. My first version hashed only the written prompts,
   which refused `changed` for a legal edit: switching a step from `prompt: prompts/gate.md` to
   inline text leaves that file on disk, still referenced by the loaded YAML, so its hash differed
   and the save was impossible. D4 already said "re-read the current YAML plus its prompts (the
   `loadWorkflowSource` path)" — the code now does what that sentence says. Pinned by a test proved
   red on the wrong version (mutation M10).

**Protocol (`protocol/src/session.ts`, `methods.ts`, `schema/protocol.json`).**

- `WorkflowSourceParams/ResultSchema`: the file's `text`, its `draft` (JSON text, present iff
  `asDraft` read it), the prompt files its steps reference, `hash` (iff it validated), `version`,
  `canonical`, `errors` (iff it did not), `unreadable`, `unavailable`, and a `context` of model
  and agent-type NAMES only (never an id or a URL, §7).
- `WorkflowSaveParamsSchema`: `{sessionId, name, mode, draft, prompts, baseHash?, dryRun}` —
  `dryRun` is **required, never defaulted**, so a client that forgot it cannot write what it meant
  to preview.
- `WorkflowSaveResultSchema`: `{ok, refusal?, reason?, errors?, hash?, version?, path?, files?,
  approved?, alsoChanges?, running?, schedules?}`, one `WorkflowWriteFile` per file with its
  `status` and ≤ 64 KiB patch.
- Both methods registered (`session/workflow_source`, `session/workflow_save`); **additive only, so
  no `protocol.d/` note and no `PROTOCOL_VERSION` move** (§7). Bounds checked against the
  transport's cap as the plan asked: `DEFAULT_MAX_FRAME_BYTES = 8 MiB`
  (`daemon/src/device-accept.ts:40`) against ≈ 2.6 MiB worst case — nothing lowered.
- One naming collision found and fixed: `WORKFLOW_PROMPT_MAX_CHARS` already exists in
  `session-log.ts` for a different bound, so the prompt-file cap is `WORKFLOW_PROMPT_FILE_MAX_CHARS`.
- `bun run schema:export` regenerated `protocol.json` (+267 lines); `json-schema.test.ts`'s
  fixture-coverage test went red until both methods had fixtures, which were added.

**`tools/src/builtins.ts`:** `unifiedDiff(path, before, after)` exported — the same patch and counts
`makeDiff` already gives, without the `ToolDiffDetail` wrapper a non-tool caller cannot build.

**`cli/src/workflow-files.ts`:** `writeWorkflowFiles(cwd, plan, currentHash, hooks?)` and the
`WorkflowWritePlan` / `WorkflowWriteResult` / `WorkflowWriteRow` / `WriteHooks` types. Synchronous
(no `await` between the base check and the last rename, §7); emits the bytes itself; resolves every
path through `resolveInside` on all components (`.tentacle`, `workflows`, `prompts`, the file);
`replace` requires the file to still hash to `baseHash`, `create` requires the YAML to be absent;
a prompt path the base did not cover, already on disk with other bytes, is `exists`; prompts are
written FIRST and the YAML LAST; each file is temp + rename with the temp removed on failure (a temp
name is never `*.yaml`, so no listing can show one); **it never touches the approval store**.

**Mutations (applied one at a time, each run, each restored from a copy under
`.tentacle/tmp/workflow-editor/mut/` — no `git checkout`/`restore`/`stash`).**

| # | Mutation | Result |
|---|---|---|
| M1 | write the YAML before the prompts | 2 red (order + the loaded-hash test) |
| M2 | drop the `baseHash` check | 2 red (stale base, no-temp-on-refusal) |
| M3 | allow overwriting a prompt the base did not cover | 2 red (`exists`, base-prompts pair) |
| M4 | skip the no-links walk (`resolveInside`) | 6 red (all 4 symlink cases + 2) |
| M5 | write in place instead of temp + rename | 1 red (mid-write failure) |
| M6 | let `workflowYaml` throw instead of `invalid` | 1 red (surrogate) |
| M7 | drop the `baseHash` sha-256 regex | 1 red (params) |
| M8 | make `dryRun` optional | 1 red (params) |
| M9 | zero `unifiedDiff`'s counts | **survived** → 2 tests added, then red |
| M10 | hash the base from the written prompts (the pre-fix code) | 1 red (disk base) |

**M9 is the useful result**: the plan's test list never pinned the patch COUNTS, only the patch, so
zeroing them passed. Two tests were added (`added`/`removed` per status, and a real patch's `-old`/
`+new`), and M9 then failed. M6–M8 and M10 were run against the current tree.

**Failure modes, as the plan lists them (`:363-385`), each pinned:**

- a prompt shared by two workflows → Review's `alsoChanges` is **slice 3b's** (`deps.list`), not
  this writer's; the writer writes only what it is given.
- a stale / gone / newly-broken base file → `changed`, nothing written (mtime unchanged asserted).
- a prompt that appeared since the load → `exists`, the user's bytes untouched.
- a symlink at any component, including the file → `invalid`, naming the path.
- an interrupted write → temp removed, the old YAML intact, nothing listed.
- a draft the emitter refuses (lone surrogate) → `invalid`, naming it, no folder created.
- an absolute / `..` / empty-segment prompt path → `invalid`, nothing created.
- `.tentacle` present as a FILE → `failed`, never a silent skip.

**Evidence:**

- `bun test packages/cli/test/workflow-files-write.test.ts packages/cli/test/workflow-files.test.ts
  packages/cli/test/workflow-wiring.test.ts packages/cli/test/workflow-gitignored.test.ts
  packages/cli/test/workflow-approvals.test.ts packages/tools/test/ packages/protocol/test/`:
  **1116 pass, 0 fail** (25 of them the new writer file, 13 the new wire file).
- `bunx biome check` on the seven changed files: clean.
- `bunx tsc --noEmit -p .`: clean.

**No changelog fragment on this slice, deliberately.** The plan assigns the fragment to slice 7c and
one already exists on the branch (`changelog.d/workflow-editor.added.md`, whole-feature wording); a
second fragment for the same slug+category is the collision the changelog rules forbid, and a
different slug would invent a task that does not exist.

**Unverified, one line:** that an older client's `unsupported` mapping and the phone's screens
consume these two methods is proven only when slice 4 (client) and 6/7 import them — today nothing
outside the tests calls them; the wire shapes hold by construction and by the zod⇔Ajv agreement test.

*— deepseek-ai/DeepSeek-V4.1-Flash-1017 (executor, slice 3a), 2026-11-24*

## Review

### Slices 0–2 — REQUEST-CHANGES

Scope: `git diff main...HEAD`, slices 0, 1 and 2 only.

**Gate (narrow):** the touched tests (`workflow-{yaml,draft,templates,spec}.test.ts`, `mockup-kit-components.test.ts`) give **140 pass, 0 fail**. `bun run lint` is clean (2378 files). `bun run typecheck` is clean. `workflow-spec.test.ts` is unedited on the branch and green.

**Findings**

1. **MEDIUM — `renameStep` and `deleteStep` ignore `{{steps.<id>.…}}` references** (`core/src/workflow-draft.ts:324-352`, `:366-371`). The validator treats a templating reference as a step reference (`workflow-spec.ts:441-470`). The shipped template uses three of them (`workflow-templates.ts:110,117,122`). Repro (`.tentacle/tmp/workflow-editor/rev/rename.ts`), on `plan-build-review-merge` (0 problems before):
   - `renameStep(review→check)` gives `steps[3].agent.prompt: no step "review"`;
   - `renameStep(plan→design)` gives 2 errors;
   - `deleteStep(plan)` returns `dangling: []` but leaves 2 errors. The menu's "N links point here" note says 0 before the delete.

   The references sit in prompt FILES, which the op cannot see (it has no `prompts` argument). So on the phone, renaming a template step breaks it, and the user can only repair it by editing a prompt file. This is a gap in D2 itself, not executor drift.
   - **Fix:** `renameStep` takes `prompts` and rewrites `{{steps.<old>.` in `run`, `prompt_text`, `approve.*` and the referenced prompt files. `deleteStep`'s `dangling` counts templating references too.
   - **Tests:** pin both cases on the template.
2. **MEDIUM — the emitter is not total, so the round trip D1 and D7 rely on fails** (`core/src/workflow-yaml.ts:92-95`, `:106`). Repro (`rev/emit.ts`):
   - a multi-line string containing NUL (`"l1\nb\u0000"`) passes `blockSafe` and is emitted raw in a `|-` block, and `Bun.YAML.parse` throws;
   - a lone surrogate (`"a\ud800b"`) is JSON-escaped, and Bun refuses the escape.

   Slice 3b's save validates the draft VALUE (D4 step 1), not the emitted bytes. So it could write and hash a file that then fails to load.
   - **Fix:** `blockSafe` refuses C0 controls other than tab. Either refuse lone surrogates in a draft string, or have the save assert `parse(workflowYaml(d))` deep-equals `d` before writing (preferred: it fails loudly).

**Attacks tried**

| Attack | Result |
|---|---|
| Hostile strings: DEL, C1, U+0085, U+2028, BOM, `---`/`...` lines, ANSI escapes, `-0`, `1e21` | All round-trip, except NUL-in-block and lone surrogates (finding 2) |
| Templating references across rename, delete and template | Finding 1 |
| `patchStep` dropping unknown agent/approve fields | Holds: the strict schema covers exactly `prompt, prompt_text, model, type, tokens` (`workflow-spec.ts:243-247`) |
| `stepIdFor` producing an id the validator rejects | Holds: the slug always matches `idProblem`'s regex |
| Insert on a `next` edge leaving the old fall-through successor reachable | Holds: the new step carries the `next`, so array order is unchanged for the others |

**Mutation (own, restored with `cp` from `.tentacle/tmp/workflow-editor/rev/*.bak`; `git status` is empty after):**
- `insertStep` dropping `next: oldNext` turns 2 tests red;
- `blockSafe` returning `true` turns 1 test red.

The executor's M1–M18 tables look credible. I sampled them and did not re-run them all.

**§7:** slices 0–2 touch no wire, persistence or broker. These are pure core and kit modules, so no invariant is at stake yet. The load-bearing pair is slice 3b's.

**Executor behaviour:** disciplined. It recorded red-first runs, added tests when a mutation survived, and reported its own process fault (`git checkout` during slice 1) honestly. One discrepancy: the Execution sections are signed `claude-opus-5-5 (executor)`, but the three commits say `exec (deepseek)`. The owner should confirm which model executed, because §10 signatures exist to track exactly that.

Reviewer: same model family as the signed executor; only the context is fresh. Shared blind spots are possible.

*— claude-opus-5-5, 2026-11-24*

### Round 2 — PASS

Scope: `git diff HEAD~1` (`cc85cee5`).

- **Finding 1 is fixed.**
  - `renameStep(…, prompts)` rewrites `{{steps.<id>.…}}` in `run`, `prompt_text`, `approve.title/detail` and the prompt files the steps read, and returns the rewritten files in `prompts`. `deleteStep(…, prompts)` counts templating references in `dangling`.
  - Its pattern matches the validator's grammar exactly (`workflow-spec.ts:418`, `:431`: whitespace only inside the braces, and a `.` after the id, so `plan` does not match `plan-2`).
  - Probe `rev/rename2.ts` on `plan-build-review-merge`:
    - `review→check`, `plan→design` and `fix→repair` each leave **0** problems;
    - the input prompts are not mutated;
    - `deleteStep(plan)` gives `dangling: [exec, review]`, matching its 2 errors.
- **Finding 2 is fixed.** `blockSafe` refuses C0 controls other than tab and newline, and lone surrogates. A lone surrogate now throws, naming its YAML path, instead of writing bytes that cannot be read back. `rev/emit.ts` now has no failing case. The NUL-in-block case round-trips through JSON quoting. The `-0` case is benign (the value `0` is unchanged).
- **Mutations** (applied together, restored with `cp`, `git status` empty after) each turned their named test red, 4 fail in total:
  - the prompt-file rewrite disabled;
  - `refersByText` dropped;
  - `RAW_CONTROL` dropped;
  - the lone-surrogate check in `quoted` dropped.
- **Gate:** `bun test packages/core/test/ scripts/test/mockup-kit-components.test.ts` gives **992 pass, 0 fail**. `bun run lint` and `bun run typecheck` are clean.
- **Note (not a finding):** `prompts` defaults to `{}`. A caller that omits it gets the round-1 behaviour, which is loud (validator errors), not silent. Slices 6 and 7 must pass the editor's prompt files.

*— claude-opus-5-5, 2026-11-24*

## Execution

### Slice 3b — driver `source`/`save` + daemon wiring (D4) — DONE

**Load-bearing / PARTIAL check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb3b.ts` on the
branch tip `4c2208cb`:

```
WorkflowSave in Method: true
WorkflowSource in Method: true
writeWorkflowFiles: function
```

The slice's precondition (`"WorkflowSave" in Method` **and** `writeWorkflowFiles` exists) holds, so
the slice starts where the plan says. **Not a PARTIAL.**

**Inherited state.** A previous run of this slice was cut by a usage limit with its edits
uncommitted in the worktree: `workflow-driver.ts` (`prepareSourceSync`, `source`, `save`,
`checkedWorkflowBytes`, the dep types, +406 lines), `workflow-files.ts` (+`dryRun`), their tests,
and `daemon/test/workflow-hosted.test.ts`. It did **not** do `cli/src/wiring.ts`,
`daemon/src/hosted-session.ts`, `daemon/src/connection.ts` or `cli/test/workflow-wiring.test.ts` —
the daemon tests were red at `session.workflowSource is not a function` (4 fail), which is exactly
the daemon wiring this run added. The inherited driver work was kept and verified, not rewritten:
`agent/test/workflow-save.test.ts` already held every failure-mode test the plan lists for it (the
(a)/(b) load-bearing pair, preview-hash identity, dry run, unreferenced prompt, unknown draft field,
`running`, `alsoChanges`, `changed`, `unavailable`, `source`'s own cases) and passed 16/16.

**What this run built**

1. `daemon/src/hosted-session.ts` — `workflowSource` and `workflowSave`, both beside
   `workflowCatalogue`. No driver → `unavailable`, never an empty read. Both answers are judged by
   the wire schema on the way out (the `workflowCatalogue` pattern).
   - `workflowSave` decodes the draft text and the prompt list **here**, so a non-JSON draft or a
     path given twice is `invalid` before the driver — nothing is validated against a half-read
     request.
   - `schedules` is added here (the session's own job table), not by the driver.
   - Two helpers: `writeFileRow` (a Review row in the wire's shape, its patch cut to
     `WORKFLOW_PATCH_MAX_CHARS`) and `pinnedToOldHash`.
2. `daemon/src/connection.ts` — `case Method.WorkflowSource` / `Method.WorkflowSave` via
   `this.lookup(...)`, beside `WorkflowCatalogue`, no lock (§7).
3. `cli/src/wiring.ts` — `save: (plan, currentHash) => writeWorkflowFiles(config.cwd, plan,
   currentHash)` **inside** the existing `if (options.workflows === true && !tunnelled)` block, and
   nowhere else.
4. Tests: `cli/test/workflow-wiring.test.ts` (+1), `daemon/test/workflow-hosted.test.ts` (+3, and
   one missing `workflowYaml` import fixed), `daemon/test/workflow-step-detail.test.ts` (+1, the
   dispatch case), and type-level fixes in the inherited `agent/test/workflow-save.test.ts`.

**Drift from the Implementation (2, both reconciled against the code).**

1. **`schedules` means "the job THIS save breaks", not "every job whose hash differs".** D4 says
   "the session's schedule jobs whose `target.workflow` names this file with the OLD hash". Read
   literally against `target.workflow.name` (a NAME, `core/src/schedule.ts:91-95` — not a path),
   "the old hash" is ambiguous, and the naive reading re-reports a broken job on **every** later
   save forever. The test at `workflow-hosted.test.ts` pins the correct reading: a job is reported
   iff it is pinned to the hash this save **replaces** (`baseHash`) and the new hash differs —
   i.e. the save that breaks a pin reports it once. A job pinned to an even older hash was already
   reported by the save that broke it, and a job pinned to the very hash being rewritten unchanged
   is not broken. Both guards are individually pinned by their own test (mutations E and E′).
2. **`prompts` is present iff `draft` is, even when empty.** The wire schema makes it optional, and
   the hosted test pins `prompts: []` for a draft with no prompt files: "every step's prompts" must
   be answerable as the empty list, so a client never has to tell "none" from "not asked".

**Red before green.** The daemon tests were shown red first on the branch's own partial state —
`TypeError: session.workflowSource is not a function` / `session.workflowSave is not a function`,
4 fail — and green (17 pass) once the two handlers and the dispatch landed.

**Mutations (each restored with `cp`; `git status` + a `MUTATION` grep confirm nothing survived).**

| # | Mutation | Result |
|---|---|---|
| A | drop `!tunnelled` from the driver's wiring guard | 2 red (the pre-existing tunnelled test **and** the new wiring test) |
| B | remove only the `save:` dep line | 1 red — **only** the new wiring test (`save?.ok` was `false`) |
| C | `approvals.add` inside `save` | 2 red — **(a) and (b)**, the plan's named target |
| D | a save raising its own `workflow_approve` ask | 2 red — (a) sees 1 ask, (b) sees 2 asks |
| E | `pinnedToOldHash`: drop `target.hash !== oldHash` | 1 red — the older-pin test |
| E′ | `pinnedToOldHash`: drop `oldHash === newHash` | 1 red — the unchanged re-save test |
| F | lenient decode + last-wins prompts | 1 red — the non-JSON/twice-given test |
| G | remove both `connection.ts` cases | 1 red — the dispatch test (`MethodNotFound`) |

Mutations B, E, E′ and G each turned **exactly one** test red, and it was the test written for
that property — the non-vacuity check §9 asks for. Two of them **initially survived** and were the
reason tests were added: E survived until the "an older pin is not re-reported" test existed, and
E′ survived until the "spares a job pinned to the very hash being re-written unchanged" test did.
Mutation F also first survived against an assertion that only checked `refusal === "invalid"` — the
same verdict the *driver* gives — so the test was strengthened to name each cause
(`"the draft is not JSON"`, `"given twice"`) before it bit.

**Evidence**

- `bun test` over the six slice-3b files (`agent/test/workflow-save`, `daemon/test/workflow-hosted`,
  `daemon/test/workflow-step-detail`, `cli/test/workflow-wiring`, `cli/test/workflow-files-write`,
  `agent/test/workflow-driver`): **122 pass, 0 fail.**
- `bun test packages/protocol/test/{workflow-wire,workflow-save-wire,json-schema}.test.ts`:
  **49 pass, 0 fail** — the wire shapes and the zod⇔Ajv agreement still hold.
- `bunx biome check` on all eight changed files: clean.
- `bunx tsc --noEmit`: clean (whole root project).

**No protocol schema change, so no `protocol.json` regeneration on this slice.** `git status` shows
no diff under `packages/protocol/`; slice 3a already added both methods and regenerated the schema,
and this slice only *consumes* `WorkflowSourceResultSchema` / `WorkflowSaveResultSchema` /
`WorkflowSourceParams` / `WorkflowSaveParams`. Nothing breaks the wire, so no `protocol.d/` note.

**No new changelog fragment on this slice, deliberately.** `changelog.d/workflow-editor.added.md`
already exists on the branch and already carries this slice's user-visible sentence ("the saved file
is a brand-new hash, so the next run asks for approval as any hand-edited workflow does"); the plan
assigns the fragment to 7c, and a second fragment for the same slug+category is the collision the
changelog rules forbid.

**Unverified, one line:** that a **real** `writeWorkflowFiles` on a real `serve` session lands the
bytes end-to-end is proven only by the two fakes plus the wiring test's on-disk assertion — no test
drives `wiring.ts` → `save` → a real file through RPC; that path is exercised for the first time by
slice 4/6/7.

*— claude-sonnet-4-5-20250929 (executor, slice 3b), 2026-11-25*

### Fix round 1 — review of slices 3a + 3b

Both MEDIUM findings fixed. Each fix has a test that was red on the assertion of the property first,
and a mutation check.

**#1 — errors/reason not capped → `unavailable` (FIXED).**
- `daemon/src/hosted-session.ts` `workflowSource`: `errors` goes through the catalogue's
  `boundedWorkflowErrors` (20 lines, `+k more`). `unreadable` is one line, cut to 300.
  If the answer still fails its schema, it is `{ok:false, path, unreadable}` and never
  `unavailable`, which keeps its one meaning.
- `workflowSave`:
  - `errors` is bounded the same way.
  - `reason` is cut to 2000, ending in `…`.
  - `alsoChanges` is cut to the wire's 64. When cut, the reason counts the rest
    (`N other workflows also change; the first 64 are listed`).
  - If the answer still fails its schema:
    - a write that **landed** answers `ok:true` with its `hash`/`version`/`path`/`approved`
      and a reason `the rest of the save could not be reported: …`;
    - a refusal keeps its own word (`invalid`/`changed`/…).
  - It is never `unavailable`.
- Red first (`daemon/test/workflow-hosted.test.ts`, 2 new tests):
  - 60 steps with `run: ""` (the validator caps steps at 64, so the review's 25 became 60 here to
    also push the joined reason over 2000): `Expected "invalid" / Received "unavailable"`.
  - A landed write with 40 file rows and 70 `alsoChanges`: `Expected true / Received false`.

**#2 — the YAML is not bounded by the loader's cap (FIXED).**
- `WORKFLOW_FILE_MAX_BYTES` moved to `core/src/workflow-yaml.ts`. Both the driver (agent) and the
  writer (cli) need it, and agent cannot import cli. `cli/src/workflow-files.ts` imports it and
  re-exports it under the same name.
- `agent/src/workflow-driver.ts` `checkedWorkflowBytes`: refuses emitted bytes over the cap, in
  UTF-8 **bytes** (the loader's `stat.size`), before the hash or any write. So `save` answers
  `invalid`, for a dry run too.
- `cli/src/workflow-files.ts` `writeWorkflowFiles`: refuses ANY target over the cap (the YAML or a
  prompt file) before resolving or writing anything. This is defence in depth: the wire's 64 K-char
  prompt is ≤ 192 KiB, but the writer is not tied to the wire.
- Red first:
  - `agent/test/workflow-save.test.ts`: a ~300 KB YAML: `Expected "invalid" / Received undefined`.
  - `cli/test/workflow-files-write.test.ts`: `Expected false / Received true`.

**Mutations (each reverted, then `rg` confirmed none survived in `src`).**

| # | Mutation | Result |
|---|---|---|
| M1 | save `errors: [...outcome.errors]` (no capper) | 1 red — the 60-errors test |
| M2 | source `errors: [...view.errors]` | 1 red — the 60-errors test (`source.ok` false) |
| M3 | save `reason` uncut | 1 red — the 60-errors test |
| M4 | landed-write fallback forced to the refusal branch | 1 red — the landed-write test |
| M5 | `alsoChanges` not cut to 64 | 1 red — the landed-write test |
| M7 | driver measures `text.length`, not UTF-8 bytes | 1 red — the `é` boundary assertion |
| M8 | driver `>=` instead of `>` | 1 red — the exactly-at-cap assertion |
| M9 | writer cap check disabled | 1 red — the writer cap test |
| M10 | writer checks only the YAML, not prompts | 1 red — the prompt-file half of that test |
| M11 | source's schema-failure fallback also sets `unavailable` | 1 red — the source-fallback test |

There is no M6 (the plain "drop the driver check" mutation). The red-first run above is that
mutation.

**Evidence.**
- `bun test` over 10 files (`agent/workflow-save`, `agent/workflow-driver`,
  `daemon/workflow-hosted`, `daemon/workflow-step-detail`, `cli/workflow-wiring`,
  `cli/workflow-files-write`, `cli/workflow-files`, `core/workflow-yaml`,
  `protocol/workflow-save-wire`, `protocol/json-schema`): **199 pass, 0 fail**.
- `bunx biome check` on the 7 changed files: clean after `--write` (one formatting fix).
- `bunx tsc --noEmit`: clean.
- No wire change, so there is no `protocol.d/` note and no new changelog fragment.

**The source fallback has its own test.** With the caps in place, no real input reaches
`workflowSource`'s schema-failure fallback. A third hosted test stubs `driver.source` with a `text`
over 256 K chars and checks the answer is `{ok:false, path, unreadable}` with no `unavailable`
(mutation M11). The hosted file is now **20 pass, 0 fail**, so the 10-file run would be 200.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-24*

## Review

### Slices 3a + 3b — REQUEST-CHANGES

The load-bearing invariant **holds**: a save never approves, and it never asks. 2 MEDIUM findings
are wire/size contract bugs. Neither one is an approval bypass.

**Gate (narrow, as asked).** 8 touched test files (`agent/workflow-save`, `agent/workflow-driver`,
`daemon/workflow-hosted`, `daemon/workflow-step-detail`, `cli/workflow-wiring`,
`cli/workflow-files-write`, `protocol/workflow-save-wire`, `protocol/json-schema`): **157 pass,
0 fail**. `bun run lint` is clean (2381 files). `bun run typecheck` is clean.

**Findings**

1. **MEDIUM — the save and source answers do not cap the validator's output, so a long error list
   is reported as `unavailable`.**
   - Where: `daemon/src/hosted-session.ts:2709` (`errors: [...view.errors]`) and `:2781`
     (`errors: [...outcome.errors]`), plus the driver's joined `reason`
     (`agent/src/workflow-driver.ts` `invalid(...)`).
   - Cause: the validator does not bound its error list. The wire allows `errors` ≤ 20 × 300 and
     `reason` ≤ 2000. The catalogue already caps through the helper at `hosted-session.ts:683`;
     these two methods do not use it.
   - Repro (`.tentacle/tmp/workflow-editor/rv3b/errcap.ts`): a draft with 25 steps, each
     `run: ""`. The driver returns `invalid` with 25 errors, and
     `WorkflowSaveResultSchema.safeParse` fails (`too_big`).
   - Effect: the save answers `{refusal:"unavailable", reason:"the save could not be reported…"}`.
     `workflow_source` on a hand-written file with more than 20 errors answers `unavailable`.
   - The plan gives `unavailable` one meaning: "this session cannot edit workflows". So the phone
     shows the wrong screen instead of the errors, and the user cannot fix the file.
   - The same fall-through on a write that already landed (for example `alsoChanges` over 64)
     reports `ok:false` after the bytes are on disk.
   - Fix: run both through the catalogue's capper. A schema failure after a landed write should
     not be reported as `unavailable`.

2. **MEDIUM — the write path does not bound the emitted YAML by the loader's
   `WORKFLOW_FILE_MAX_BYTES` (256 KiB), while the wire allows a 512 KiB draft.**
   - Where: `cli/src/workflow-files.ts:456`; `agent/src/workflow-driver.ts:923`.
   - Repro (`rv3b/big.ts`): one step with an 80 000 × `"word "` `prompt_text` validates, and its
     YAML is 400 089 bytes.
   - Effect: the save answers `ok:true` with a hash. Then the listing marks the file `too-large`,
     so the catalogue never reports that hash and cannot start the workflow.
   - `workflow_source` returns text over `WORKFLOW_SOURCE_TEXT_MAX_CHARS`, so the answer fails its
     schema and is reported as `unavailable`. The editor cannot reopen its own file.
   - This contradicts D4 twice: "never writes … a file that does not load back" and "the preview
     hash equals the next catalogue hash".
   - Fix: refuse `invalid` when the emitted bytes are over the cap, before any write.

**Red-team of the §7 / hash-approval invariant (all hold)**
- `rg "approvals.add("` finds exactly the two driver sites (`requestApproval`, `approveHash`),
  and neither is reachable from `source` or `save`.
- `new WorkflowDriver(` has ONE construction site (`cli/src/wiring.ts:854`), and
  `writeWorkflowFiles` has ONE caller (`:861`), inside `workflows && !tunnelled`. A pod daemon has
  no writer: `source` and `save` answer `unavailable`.
- The approval store is `<configDir>/workflow-approvals.json`, outside `.tentacle/workflows/`. A
  prompt path is limited by `promptPathProblem` (no `..`, no absolute path) and by `resolveInside`
  (no links), so no save can reach the store.
- `draft.name` must equal the file stem (`workflow-spec.ts:681`), and `name` is
  `WorkflowNameSchema` on the wire, so a save cannot write to another workflow's path.
- A saved file is new bytes, so its hash is new and the next start asks. Re-saving bytes whose
  hash is already approved is approved, which is correct: they are the bytes that were reviewed.
- Two concurrent saves: the writer re-checks the base inside one synchronous block, so the second
  gets `changed` (or `exists`). No lock was added, so the peer is still not serialized.

**Mutation (mine).** I added `approvals.add(path, hash)` inside `save` on a write. Both (a) and (b)
went red (2 fail, 14 pass). I reverted with `cp` and checked that `git status` was clean. The
executor's mutations A–G are recorded above. I did not re-run them.

**Attacks that found nothing.**
- A prompt path naming another workflow's YAML: it is refused `exists` (not in `basePrompts`).
  Creating a new file through it gives an unapproved hash, which asks.
- A `replace` with no `baseHash`: refused `changed`.
- An unknown draft field: `invalid`.
- `dryRun`: writes nothing.

**Executor behaviour.**
- Faithful to the plan, with honest drift notes (the meaning of `schedules`, `prompts` always
  present) and a real mutation table.
- It missed reusing the catalogue's capper and the size cap.
- Its signature says `claude-sonnet-4-5`, dated 2026-11-25, while the routing named Opus for 3b.
  The orchestrator should check that.
- Reviewer: same family as the planner, in a fresh context. Shared blind spots are possible.

*— claude-opus-5-5, 2026-11-24*

### Round 2

**Verdict: PASS.** Both round-1 MEDIUM findings are fixed. Each fix is pinned by a test that bites:
I ran the four mutations below, each test went red, and I reverted with `cp`. `git status` was
clean afterwards.

**Gate.**
- 9 touched test files (the 8 from round 1 plus `core/workflow-yaml`): **183 pass, 0 fail**.
- `bun run lint`: clean (2381 files).
- `bun run typecheck`: clean.

**Finding #1 — fixed.**
- `hosted-session.ts` now passes both `errors` lists through the catalogue's
  `boundedWorkflowErrors` and caps `reason` at 2000. `alsoChanges` is cut to 64, and the reason
  gives the full count.
- A `workflow_source` answer that does not fit the wire becomes `unreadable` with its path, not
  `unavailable`.
- A save that does not fit the wire keeps its own refusal word. A save that landed keeps
  `ok:true`, its hash and its version.
- Mutation: uncapped `errors` → the 60-error test fails.
- Mutation: a bad `hash` in the landed fallback → the "LANDED is never `unavailable`" test fails.

**Finding #2 — fixed.**
- `WORKFLOW_FILE_MAX_BYTES` moved to core; the CLI re-exports it, so there is still one value.
- The size check runs twice, both counting UTF-8 bytes, so they agree with the loader's
  `size <= max`: in `checkedWorkflowBytes`, which the driver uses for both preview and write, and
  in the writer for every target, prompts included.
- Mutation: a 100× cap in the driver → the driver's size test fails.
- Mutation: a 100× cap in the writer → the writer's size test fails.

**Regressions looked for, none found.**
- The landed fallback drops `files` and `alsoChanges`, but says so in `reason`. That is honest and
  never a silent `ok:false`.
- The size refusal runs before the base check, so an oversize `replace` is `invalid` even when it
  is also stale. That order is harmless: nothing is written either way.
- The diff does not touch `approvals`, the broker or the wiring, so the round-1 invariant result
  still stands.

*— claude-opus-5-5, 2026-11-24*

## Execution

### Slice 4 — client + pass-throughs (D5) — DONE

**PARTIAL check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb-slice4.ts` on the branch tip
`83178d8d`:

```
connection.ts case Method.WorkflowSource: true
connection.ts case Method.WorkflowSave: true
hosted-session.ts workflowSource handler: true
hosted-session.ts workflowSave handler: true

== client side (must be ABSENT today) ==
  remote-client: workflowSource=false workflowSave=false
  remote-session: workflowSource=false workflowSave=false
  workflows: workflowSource=false workflowSave=false
  local-runtime: workflowSource=false workflowSave=false
  app-types: workflowSource=false workflowSave=false
```

The slice's precondition ("the daemon answers both methods") holds, so the slice starts where the
plan says. **Not a PARTIAL.**

**What this run built**

1. `client/src/remote-client.ts` — `workflowSource(sessionId, params)` and
   `workflowSave(sessionId, params)`, both through `sessionCall(…, "once")` like
   `workflowCatalogue`/`workflowStep`, both mapping `MethodNotFound` to `{unsupported: true}`
   (never a throw at a screen, never an empty file that blames the folder).
2. `client/src/remote-session.ts` — `workflowSource(name)` and `workflowSave(request)`. Both refuse
   locally with the trust bit off (`daemonWakes`, AGENTS §7) and send nothing; the read answers
   `{ok:false, unavailable}`, the write `{ok:false, refusal:"unavailable", reason}` — the same shape
   a daemon-side refusal uses, so a screen paints one kind of answer. **No `turnId` is minted**: a
   save raises no ask, so there is no turn for auto-accept to own.
3. `client/src/workflows.ts` — `WorkflowSaveRequest = Omit<WorkflowSaveParams, "sessionId">`, the
   same split as `WorkflowAction`: a caller cannot name another session's file, and a `dryRun`-less
   request cannot be built (`dryRun` is required by the wire).
4. `cli/src/local-runtime.ts` — both pass-throughs on `PersistingController` and its object literal,
   beside `workflowCatalogue`.
5. `tui/src/app-types.ts` — both methods optional on `SessionController` (the TUI ships no editor in
   this task, per the plan's Mac/TUI parity section), plus `WorkflowSaveRequestView`, mirrored
   structurally like `WorkflowActionView` (the TUI does not depend on `@tentacle/client`).

**Tests (red first, §9).** `client/test/workflows-client.test.ts` (+4) and
`cli/test/local-runtime.test.ts` (+1), plus the exact-set guard in
`cli/test/subagent-panel-controller.test.ts` (+2 entries: the guard's whole purpose is to fail when a
`SessionController` member a `RemoteSession` has is not forwarded, so the two new names are a
deliberate entry, as its comment requires).

- **Red before green.** On the branch's own state the 4 client tests failed with
  `TypeError: session.workflowSource is not a function` / `workflowSave is not a function` (4 fail,
  22 pass); the CLI test failed on `expect(received).toEqual(expected) … + undefined` (1 fail,
  80 pass); the guard failed on `+ "workflowSource" + "workflowSave"`. All green after the code.

**Drift from the Implementation (1, reconciled against the code).**

- **The "no turn" assertion had to read the RAW frame.** The first version asserted on the params the
  fake daemon *received*, and mutation B (routing the save through `mintTurn()`) **survived**: the
  transport parses inbound params through `WorkflowSaveParamsSchema`, a strip schema, so an unknown
  `turnId` is dropped before the handler ever sees it (`transport/src/peer.ts:340-345`). The fake now
  records the client's own frames (`raw`) *before* handing them to the peer, and the mutation bites.
  This is the §9 non-vacuity check doing its job, not a change to the plan.

**Mutations (each restored with `cp` from `.tentacle/tmp/workflow-editor/mut-s4/`; a final `bun test`
+ `git diff --stat` confirms nothing survived).**

| # | Mutation | Result |
|---|---|---|
| A | `workflowSource`: `MethodNotFound` → `{ok:false, unreadable}` | 1 red — the older-daemon test |
| B | `workflowSave` mints a `turnId` and sends it | 1 red — the "mints NO turn" test (**survived** the first, parsed-params assertion; see drift) |
| C | `workflowSave` ignores the trust bit and sends anyway | 1 red — the "trust bit off sends NOTHING" test |
| D | both CLI forwards deleted from the controller literal | 1 red — the pass-through test (and only it) |
| E | `workflowSave` client maps `MethodNotFound` → `{ok:false}` | 1 red — the older-daemon test (the save half) |

Mutations A, B, C, E each turned **exactly one** test red, and it was the test written for that
property. D turned exactly one red as well — the `subagent-panel-controller` guard stayed green,
because that guard checks a member is *present* on the wrapper (it is: the type declares it), while
the value-forwarding test is what actually exercises the forward — the two are complementary, and
before this slice neither existed for these two methods.

**Evidence**

- `bun test` over the three touched files (`client/workflows-client`, `cli/local-runtime`,
  `cli/subagent-panel-controller`): **111 pass, 0 fail.**
- `bun test` over the neighbouring workflow files (`tui/workflow-frames`,
  `client/workflow-mapping`, `client/workflow-permission`, `daemon/workflow-hosted`,
  `cli/workflow-wiring`): **54 pass, 0 fail** — no regression in the catalogue/run path these calls
  sit beside.
- `bunx biome check` on all eight changed files: clean (one import sort and one formatting fix,
  applied with `--write`).
- `bunx tsc --noEmit` (root project) and `bunx tsc -p apps/mobile --noEmit`: clean.

**No protocol schema change, so no `protocol.json` regeneration and no `protocol.d/` note.**
`git diff --stat packages/protocol/` is empty: this slice only *consumes* the two methods' params and
result types that slice 3a added.

**No new changelog fragment, deliberately** — same reason as slice 3b:
`changelog.d/workflow-editor.added.md` already exists on the branch, already carries this task's
user-visible sentence, and the plan assigns the fragment to 7c. A second fragment for the same
slug+category is the collision the changelog rules forbid.

**Unverified, one line:** that a phone-side `RemoteSession.workflowSave` reaches a real
`writeWorkflowFiles` on a real `serve` session end-to-end is proven here only by the fake peer plus
the slice-3b wiring test — no test drives this client method through a real RPC round trip; slices
6/7 and the e2e flow are where that path is first exercised.

*— claude-opus-5-5 (executor, slice 4), 2026-11-24*

## Execution

### Slice 5 — phone editor geometry + hit-testing (D6) — DONE

**PARTIAL check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb5.sh` on the branch tip `523c5dc8`:

```
== 1. core exports insertStep + draft opts (slice 2) ==
221:export function insertStep(
254:export function setFailTarget(
441:export function deleteStep(
641:export function draftProblems(
== 2. WorkflowDraft + workflowYaml (slice 1) ==
packages/core/src/workflow-spec.ts:341:export function workflowStructureProblem(raw: unknown): string | undefined
packages/core/src/workflow-yaml.ts:35:export type WorkflowDraft = Readonly<Record<string, unknown>>;
packages/core/src/workflow-yaml.ts:250:export function workflowYaml(draft: WorkflowDraft): string {
== 3. RemoteSession.workflowSave (slice 4) ==
1388:  async workflowSource(name: string): Promise<WorkflowSourceResult | { unsupported: true }> {
1411:  async workflowSave(
== 4. the 2C constants slice 5 reuses ==
33:GRAPH_WIDTH 36:PILL_H 45:PITCH 48:TOP_PAD 51:BOTTOM_PAD 58:MAIN 59:LOOP_SOURCE 60:LOOP_TARGET
== 5. does a workflow-edit-graph module already exist? ==
ls: apps/mobile/src/workflow-edit-graph.ts: No such file or directory
== 6. mobile imports @tentacle/core? ==
apps/mobile/package.json:11:    "@tentacle/core": "workspace:*",
```

The slice's precondition per the Slices table — "`RemoteSession.workflowSave` and `core`'s `insertStep`
exist" — holds (`remote-session.ts:1411`, `workflow-draft.ts:221`), and the module this slice adds is
absent as the plan expects. **Not a PARTIAL.**

**What this run built** (two new files, nothing else touched: `git status --short` shows only these)

1. `apps/mobile/src/workflow-edit-graph.ts` (634 lines) — the editor's drawing as VALUES.
   `editGeometry(draft, problems)` → `{nodes, edges, labels, ports, pluses, problems, width, height}`;
   `editTargetAt(geom,x,y)` = the tap in the priority order label > port > plus > node;
   `dropTargetAt(geom, portId, x, y)` = `id | "self" | null` for the drag; plus
   `validDropTargets(geom, portId)` (D6's view-model flag for the drag highlight and the haptic tick,
   kept to exactly the set `dropTargetAt` accepts, so a highlight can never promise a refused drop);
   `padHit`/`hitContains`, `KIND_GLYPH`, `PORT_SIZE`/`PLUS_SIZE`, `EDIT_MIN_HIT`.
   Reuses the 2C constants and `curve` from `workflow-graph.ts` (one source of truth for the pitch and
   the column widths) and `size.touch` from `theme.ts`. Imports only types from `@tentacle/core`
   (`WorkflowDraft`, `StepKind`, `InsertAt`), so the module is React-free and adds no runtime
   dependency to the phone bundle.
2. `apps/mobile/test/workflow-edit-graph.test.ts` (435 lines, 21 tests) — over the real template
   (`WORKFLOW_TEMPLATES.plan-build-review-merge`, its own four prompts) plus purpose-built drafts:
   y strictly increasing over 64 steps; the derived side column; the ＋ count and its `insertAt`;
   the `fail`/`retry` kinds and labels; ghost pills after a real `deleteStep`; the four-way priority;
   every hit box ≥ 44 pt; `dropTargetAt` self/ghost/nowhere; purity.

**Red before green (§9).** This slice is a NEW module, so a test file importing it can only fail on the
import — which proves nothing. The plan's own red criterion for D6 is therefore the one used, and each
row below is a real mutation on the finished code (backup in
`.tentacle/tmp/workflow-editor/mut-s5/`, restored with `cp`; final md5 of the module matches the
pre-mutation file):

| # | Mutation | Result |
|---|---|---|
| A | `padHit` → hit boxes at DRAWN size (no 44 pt floor) | 2 red (the ≥44 pt test, the priority test) |
| B | `editTargetAt` tests the node FIRST | 3 red — the port-over-pill, ＋-over-pill and ranking tests |
| C | dangling refs dropped instead of ghosted | 2 red — the ghost test and the ghost-is-not-a-drop-target test |
| D | the end ＋ placed a pitch INSIDE the last pill | 1 red — "the end ＋ sits below the last pill" |
| E | side column hard-coded to `id === "fix"` | **SURVIVED at first** (see the note below), 1 red after the fix |
| F | a ＋ on every pass edge, the loop's back edge included | 2 red — the ＋ count and "no ＋ on a back edge" |
| G | `validDropTargets` forgets to exclude the port's own step | 1 red — "the valid targets are exactly what a drop accepts" |
| H | `dropTargetAt` accepts a ghost pill | 1 red — "a ghost pill is not a drop target" |

**Mutation E survived the first pass, and the fix was a test, not code.** The original side-column test
only asserted `fix.side === true` on the mockup's own template, which a hard-coded `id === "fix"` also
satisfies — the property D6 actually states ("placement comes from the draft's STRUCTURE") was not
proven. A second test now draws a draft whose loop closes on a step called `repair` while a plain
step is called `fix`, so the derived rule and the hard-coded id disagree; E then went red. This is §9's
non-vacuity check catching a weak test, not a drift in the plan.

**Drift from the Implementation (2, both reconciled against the code).**

- **`LOOP_SOURCE` is not used.** The plan lists `MAIN`, `LOOP_SOURCE/TARGET` among the constants slice 5
  reuses, but D6's own placement rule has only two outcomes for a draft: main (wide, left) or the side
  column (narrow, right). The run view's narrow LEFT column exists because a live run marks the goto's
  SOURCE as narrow so the dashed back edge has somewhere to go — in an editor that pair is the side
  column itself, and narrowing the source too would spend 150 pt of a 318 pt canvas on a pill that no
  affordance needs. Using it would also contradict D6's "one row per node" uniformity. So: main or side,
  `LOOP_TARGET` only.
- **Ghosts are inserted as ROWS, not appended.** D6 says a dangling target becomes a dashed ghost pill
  but not where; `rowsOf` puts it directly BELOW the step that names it (`next` first, then the fail
  edge), so the break reads where it happens, and one ghost is drawn however many edges name it. The
  `＋` at the end is placed under the LAST drawn row (ghost included) so it can never sit inside a pill
  — mutation D pins that.

**Evidence**

- `bun test apps/mobile/test/workflow-edit-graph.test.ts`: **21 pass, 0 fail** (476 assertions).
- Neighbouring workflow tests (`apps/mobile/test/workflow-{list-graph,screens-wiring}.test.ts`):
  **51 pass, 0 fail** together with the new file — the run view's own geometry is untouched.
- `bunx biome check` on both new files: clean (formatting applied with `--write`).
- `bunx tsc -p apps/mobile --noEmit`: clean.
- Not run here, by the orchestrator's rule: the full `bun run check` (the gate script runs it after this
  slice, along with the root project's typecheck).

**No protocol schema change**, so no `protocol.json` regeneration and no `protocol.d/` note: this slice
only reads `WorkflowDraft` values the phone already holds.

**No new changelog fragment, deliberately** — same reason as slices 3b and 4:
`changelog.d/workflow-editor.added.md` already exists on the branch with this task's one
user-visible sentence, and the plan assigns that fragment to 7c. A second fragment for the same
slug+category is the collision the changelog rules forbid, and pure geometry is not user-visible on its
own (nothing renders it until 7a).

**Unverified, one line:** the drawing is proven in the LOGICAL space only — no renderer consumes it
until slice 7a maps it onto `react-native-svg`, so the on-device look (label collisions at a wide dynamic
type, a 64-step scroll) is first observable there, or in the e2e flow of 7c.

*— claude-opus-5-5 (executor, slice 5), 2026-11-24*
## Execution

### Slice 6 — phone editor controller (D7) — DONE

**PARTIAL check re-run FIRST** — `.tentacle/tmp/workflow-editor/lb6.sh` on the branch tip `7d7a0ed8`:

```
== 1. RemoteSession.workflowSave/Source (slice 4) ==
1388:  async workflowSource(name: string): Promise<WorkflowSourceResult | { unsupported: true }> {
1411:  async workflowSave(
== 2. core insertStep + draft ops (slice 2) ==
221:export function insertStep(    254:export function setFailTarget(
289:export function setRetry(     308:export function setGotoMax(
327:export function setNext(      348:export function moveStep(
368:export function duplicateStep( 388:export function renameStep(
441:export function deleteStep(   523:export function patchStep(
608:export function setPrompt(   641:export function draftProblems(
652:export function nextVersion(  667:export class EditHistory
== 3. core templates ==  133:export const WORKFLOW_TEMPLATES
== 4. core index exports == 49/50/51: workflow-yaml, workflow-draft, workflow-templates
== 5. the controller file already exists? ==
ls: apps/mobile/src/workflow-edit-controller.ts: No such file or directory
ls: apps/mobile/test/workflow-edit-controller.test.ts: No such file or directory
== 6. changelog fragment == changelog.d/workflow-editor.added.md
== 7. protocol == 1151 WorkflowSaveParamsSchema … 1210 WorkflowSaveResult
```

The slice's precondition — "`RemoteSession.workflowSave` and `core`'s `insertStep` exist" — holds, and the
module this slice adds is absent as the plan expects. **Not a PARTIAL.**

**What this run built** (two new files; `git status --short` shows only these two, both untracked)

1. `apps/mobile/src/workflow-edit-controller.ts` — D7's state machine as VALUES, injectable session,
   React-free. `loading → editing(reviewing) → saving → saved` plus `broken` / `unreadable` /
   `unsupported` / `unavailable` / `ended` / `failed`. Every `@tentacle/core` edit op is a method
   (`insert`, `rename`, `remove`, `duplicate`, `move`, `setNext`, `setFail`, `setRetry`, `setGotoMax`,
   `patch`, `prompt`) funnelled through ONE `apply()` that records the `EditHistory` state, bumps the
   version on the first edit of a loaded file, and recomputes the bar. `edit(fn)` is the general door
   and returns the `DraftEdit`, so the long-press menu reads `dangling` ("N links point here") without
   computing it twice. Four pure helpers are exported for the screens and their tests:
   `saveOffReason`, `reconnectOutcome`, `discardText`, `savedToast`, `existsNotice`.
2. `apps/mobile/test/workflow-edit-controller.test.ts` — 51 tests over a fake session, with the plan's
   own cases: Save off offline / invalid / clean each with its reason; review then confirm
   (`dryRun:false` + `baseHash`); `changed` keeping the draft; the three reconnect hash outcomes;
   `unsupported` / `unavailable` / `unreadable`; a template create sending `mode:"create"` and its
   prompts; discard.

**One plan contradiction, found by a probe, reconciled (drift 1 below).**

**Drift from the Implementation (2, both reconciled against the code).**

- **An invalid on-disk file gets a `broken` screen, not an editable draft.** D7 lists `unreadable` and
  `unsupported` and `unavailable`, and treats everything else as editable; a file that is structurally a
  workflow but fails the validator would then be offered for edit. It cannot be saved. Probe
  (`.tentacle/tmp/workflow-editor/s6/broken-base.ts`, run on this branch): a `replace` save over an
  invalid file answers `changed` **forever** —
  `{"ok":false,"refusal":"changed","reason":".tentacle/workflows/demo.yaml changed since you opened it: steps[0].run: should not be empty"}`,
  file untouched — because the writer's base check hashes the file on disk through
  `prepareSourceSync`, and an invalid file has no hash (`cli/src/workflow-files.ts:504-517`), so
  `workflowSource` returns no `hash` either (probe `s6/src-invalid.ts`: `draft: true | ok: false |
  errors: ["steps[0].run: should not be empty"] | draft.version: 3`). D3's own comment says `hash` is
  present *iff* the file validated, so a client that ignored this would draw an editor whose Save can
  never land. The controller therefore refuses at `land()` when `baseHash === null`, and the screen says
  the validator's first error plus `EDIT_FIX_ELSEWHERE`. This is the same conclusion the plan reaches for
  hand-written files one line over (`unreadable` → "fix it on the computer or ask the model"); it just
  needed applying to the invalid-but-parsable case, which is not a bug in the plan's design so much as a
  state it did not name. **Slices 7a–7c must draw `broken`.**
- **`create` probes the name to borrow the picker vocabulary, and ignores the rest of the answer.** D7
  has `create(template, name, …)` build the draft from `WORKFLOW_TEMPLATES` and says nothing about where
  `context.{models,agentTypes}` comes from on that path. The controller calls `workflowSource(name)`
  once (the session's own read — no second path) purely to fill `context`, then keeps the template's
  draft whatever came back: a file that already exists is NOT adopted, and the save answers `exists`
  (the plan's own create rule). A `create` also sends **no `baseHash`** (there is no file to pin), which
  is the wire's own reading of the field.

**Red before green (§9).** For a new module a test file can only fail on the import, which proves
nothing, so the plan's own target is a MUTATION and each row below is a real one on the finished code.
Backup in `.tentacle/tmp/workflow-editor/mut-s6/controller.bak`, restored with `cp` after each; the final
md5 of the module matches the pre-mutation file (`123f3317…` → `123f3317…`), and `git status` shows no
other change.

| # | Mutation | Result |
|---|---|---|
| A | a `changed` refusal RESETS the draft to the baseline (**the plan's own target**) | 2 red — "`changed` KEEPS the draft", and its Keep-editing pair |
| B | `saveOffReason` ignores the offline flag | 3 red — the offline test and both gate tests |
| C | `reconnectOutcome` always answers `"saved"` | 3 red — the base-hash, third-hash and rule-table tests |
| D | confirm sends no `baseHash` (the silent-overwrite hole) | 1 red — "confirm sends … with the BASE hash" |
| E | the `broken` screen removed (an invalid file opens as editable) | 1 red — the `broken` test |
| F | every held prompt file is carried, not only the referenced ones | **SURVIVED at first** (see below), 1 red after the fix |
| G | `{unsupported}` answered as an editable file | 1 red — the `unsupported` test |
| H | the version never bumps on the first edit | 1 red — "the version bumps ONCE" |
| I | a lost save is RE-SENT on reconnect | 2 red — "nothing is re-sent" and the landed case |
| J | an ended session is shown as editable | 1 red — the ended test |
| K | a borrowed session is left anyway (detaches another screen) | 1 red — the leave test |
| L | Cancel on Review confirms the write instead | 1 red — the Cancel test |
| M | the base hash is the PREVIEW's instead of the loaded one | 1 red — the confirm test |

**Mutation F survived the first pass, and the fix was a test, not code.** The prompt-carrying test
asserted that the request carries exactly the template's prompt files — which a "carry everything held"
implementation also satisfies, because `plan-build-review-merge` references every file it ships. The
property D7 actually states ("the prompt files the draft carries") only differs from "everything held"
in a draft where a step reads a file another step no longer does, so a second test switches `exec` to an
inline prompt and asserts `prompts/exec.md` is NOT carried while `prompts/plan.md` is. F then went red.
This is §9's non-vacuity check catching a weak test, not a drift in the code.

**Evidence**

- `bun test apps/mobile/test/workflow-edit-controller.test.ts`: **51 pass, 0 fail**.
- Neighbouring workflow files together (`workflow-edit-graph`, `workflow-start-controller`,
  `workflow-runs-controller`, `workflow-run-controller`, `bundle-node-free`): **76 pass, 0 fail** — the
  geometry, start, runs and run controllers this one sits beside are untouched, and
  `bundle-node-free` (the Metro gate) stays green: the module imports `@tentacle/core` values only.
- `bunx biome check` on both new files: clean.
- `bunx tsc -p apps/mobile --noEmit`: clean.
- Not run here, by the orchestrator's rule: the full `bun run check` (the gate script runs it after this
  slice, plus the root project's typecheck).

**No protocol schema change**, so no `protocol.json` regeneration and no `protocol.d/` note: this slice
only consumes `WorkflowSourceResult` / `WorkflowSaveResult` and `WorkflowSaveRequest` as slice 3a/4 left
them (`git diff --stat packages/protocol/` is empty).

**No new changelog fragment, deliberately** — same reason as slices 3b, 4 and 5:
`changelog.d/workflow-editor.added.md` already exists on the branch with this task's one user-visible
sentence, and the plan assigns the fragment to 7c. A second fragment for the same slug+category is the
collision the changelog rules forbid; a controller nothing renders yet is not user-visible on its own.

**Unverified, two lines.** (1) The picker vocabulary is proven against a fake only: no test drives
`workflowSource` through a real RPC round trip, so whether a real daemon's `context.models` reaches the
bar is first observable in 7b's step sheet. (2) The `broken` screen is this slice's reading of the
writer's behaviour; slices 7a–7c must render it, and an e2e flow with an invalid seeded file is where it
is first seen on a device.

*— claude-opus-5-5 (executor, slice 6), 2026-11-24*

### Fix round 1 — review of slices 4–6

Both findings were fixed in `apps/mobile/src/workflow-edit-controller.ts`. Only that file and its test
changed.

**HIGH 1: edits made after a lost save were marked saved. FIXED (option b).** `interrupted` now
records the snapshot the write carried and the change count at send (`:660`). When the write landed,
the baseline becomes that snapshot, not `current` (`:1031`). If the draft still differs from it, the
phase stays `editing`, `changes` counts only the later edits, and the notice says "The save landed —
your later edits are not saved yet". The next save carries `baseHash` = the landed hash.

**MEDIUM 2: Save was offered while a lost save was undecided. FIXED.**
- `saveOffReason` takes `pending`, and it ranks right after offline: `EDIT_SAVE_PENDING`
  "Checking whether the last save landed" (`:77`).
- `beginReview` also refuses while `interrupted !== null` (`:888`).
- The check runs at once when the link is up at the rejection (`:666`).
- Any `setLink(true)` re-checks, not only one after an observed down (`:958`). An ordinary reconnect
  still reads nothing, because `checkInterrupted` returns at once when no save was lost.
- `interrupted` stays set while the read is in flight, so Save stays off until the hash decides. A
  `checking` flag allows one read at a time (`:995`).
- A failed check keeps the decision pending. A Reload clears it, and a check that was in flight then
  is ignored (`interrupted !== lost`).

**Drift (and why).**
- A lost PREVIEW (`dryRun: true`, `:638`) no longer counts as an interrupted save. It wrote nothing
  (D4), and with the new Save gate it would have blocked Save behind a pointless read. It goes back
  to `editing` with "The review did not answer (…)".
- The old test "the preview's hash on disk → saved" now drops the link before the rejection lands,
  as its comment describes. It used to drop it afterwards, and the immediate check now settles the
  save first. It also asserts that nothing is read while the link is down.

**Red before green** (`bun test apps/mobile/test/workflow-edit-controller.test.ts`, before the fix):
```
(fail) … edits made AFTER the lost save stay dirty when it landed (never marked saved)
       Expected: "editing"  Received: "saved"
(fail) … a lost save with the link still up is checked AT ONCE (no down→up needed)
       expect(readNames).toEqual(["demo","demo"]) — one read only
(fail) … Save is OFF while a lost save is undecided; a later link-up re-checks
       saveOff was null (Save offered)
```
After the fix the file passes: 56 pass / 0 fail. Two more tests were added: the `pending` rule
itself, and "a lost PREVIEW wrote nothing: no check, Save stays on". `bunx biome check` on both files
is clean, and `tsc -p apps/mobile` is clean.

**Mutations** (`.tentacle/tmp/workflow-editor/mutate.ts`, each applied alone and then restored; the
file was byte-identical afterwards):
```
== M1 baseline = current (not the sent snapshot)        → 2 fail (edits AFTER…, Save is OFF…)
== M2 saveOff ignores a pending lost save               → 1 fail (Save is OFF…)
== M3 no immediate check when the link is up            → 2 fail (checked AT ONCE…, Save is OFF…)
== M4 re-check only on a down→up edge                   → 1 fail (Save is OFF…)
restored
```
The `interrupted !== null` guard in `beginReview` is a second guard behind `saveOff`. On its own, a
mutation of it stays green, and that is expected.

**Debt (not fixed).**
- After a landed save with later edits, the draft carries the same `version` as the bytes that
  landed. The version bump only happens on the first edit since the last save, so the next save
  writes the same version number. This is cosmetic: the hash, not the version, guards the write.
- There is no manual "check again" control. A check that keeps failing waits for the next
  `setLink(true)`, and slice 7's screen must report link-ups, including a relay reconnect.

*— claude-opus-5-5 (executor, fix round 1 of slices 4–6), 2026-11-24*

### Fix round 2

Review round 2 had one new finding. It was fixed in `apps/mobile/src/workflow-edit-controller.ts`.
Only that file and its test changed.

**MEDIUM: a link-up during an in-flight check was swallowed. FIXED.** The case: the immediate check
starts while the link is already dead, the link-up arrives while that read is still in flight, and
then the read fails. Nothing re-armed the check, so Save stayed on "Checking whether the last save
landed".
- A `recheck` flag now records an up that `checkInterrupted` saw while `checking` (`:357`, `:995`).
- Each new read clears it (`:1004`).
- The read's `catch` checks again at once when `recheck && !offline` (`:1072`). Otherwise it waits
  for the next link-up, as before, so a dead link never causes a retry loop.
- A successful read decides the outcome and needs no recheck.

**Red before green** (`bun test apps/mobile/test/workflow-edit-controller.test.ts`, before the fix):
```
(fail) … a link-up that lands DURING a check that then fails re-checks (Save never stuck)
       expect(h.readNames).toEqual(["demo","demo","demo"])  — Received only 2 reads
 57 pass / 1 fail
```
After the fix: 58 pass / 0 fail. The reviewer's repro (`rev456/stuck.test.ts`, run as a copy)
now ends `saved, reads: 3`. A second test pins the other side of the fix: an up mid-check that is
down again when the read fails re-reads nothing, and the next up does. The test harness gained one
seam: a `reads` entry may be a Promise the test settles itself.
`bunx biome check` on both files is clean, and `tsc -p apps/mobile` is clean.

**Mutations** (`.tentacle/tmp/workflow-editor/fix2/mutate.ts`, each applied alone and then
restored; the file was byte-identical afterwards):
```
== M1 catch ignores the remembered up            → 1 fail (… DURING a check …)
== M2 an up mid-check is not remembered          → 1 fail (… DURING a check …)
== M3 catch re-checks without the offline guard  → 1 fail (… while the link is DOWN …)
== M4 catch always re-checks (retry loop)        → 2 fail (Save is OFF …; … while the link is DOWN …)
restored (byte-identical)
```

**Drift:** none. The fix is the one the review proposed.

*— claude-opus-5-5 (executor, fix round 2 of slices 4–6), 2026-11-24*

## Review

### Slices 4 + 5 + 6 — REQUEST-CHANGES

Scope: `git diff main...HEAD`, slices 4, 5 and 6 only (fresh context).

**Gate (narrow):** the 5 touched test files: 183 pass / 0 fail. `bun run lint`: clean (2392 files).
`bun run typecheck` (root + mobile + relay): clean.

**Findings**

1. **HIGH: edits made after a lost save are marked saved and then dropped without a prompt.**
   `apps/mobile/src/workflow-edit-controller.ts:631-635` sets `phase = "editing"` after a write whose
   answer was lost, so editing continues (offline editing is a planned state). On reconnect,
   `checkInterrupted` (`:982-994`) takes the `saved` outcome and sets `baseline = history.current`
   and `changes = 0`. That `current` includes every edit made AFTER the interrupted write, but the
   disk holds only the previewed bytes. Repro:
   `.tentacle/tmp/workflow-editor/rev456/lost-edits.test.ts`. Load, edit, Review, confirm (the write
   rejects), `setLink(false)`, `setRetry(plan, 3)` (`dirty: true`), `setLink(true)`. The result is
   `kind: saved, dirty: false, discardPrompt: null`, while the draft still shows `retry: 3`. The
   edit is not on disk, and leaving the screen loses it silently. The fix should either (a) freeze
   editing while `interrupted !== null`, or (b) set the baseline to the snapshot that was SENT
   (keep it in `interrupted`), not to `current`. Add a red test for this case.
2. **MEDIUM: Save is offered while a lost save is still undecided, and the only re-check is a
   link down→up edge.** `beginReview` (`:855`) does not check `interrupted`. `checkInterrupted`
   runs only from `setLink(up)` after a recorded `down` (`:919-925`). A rejection without an
   observed link drop leaves `interrupted` pending indefinitely, with the notice "reconnecting will
   check" and nothing to trigger it. Examples: a quick relay reconnect the screen never saw as
   down, or an RPC error. A second Save then writes against the stale `baseHash`. If the first
   write had landed, the user gets "Changed on the computer" for their own write, and Reload
   discards any edits made since. The failure is loud, not an overwrite, but D7's "the hash
   decides" never runs. Gate Save on `interrupted`, and re-check at once when the link is already
   up.

**Mutations (all red, then reverted; `git status` clean afterwards):**
- trust bit removed in `RemoteSession.workflowSave` → `workflows-client` "sends NOTHING" fails;
- `padHit` uses the drawn size → 2 graph tests fail (≥ 44 pt, ＋ over pill);
- `reconnectOutcome` drops the preview→saved branch → 2 controller tests fail.

**Attacks that found nothing:**
- Slice 4: MethodNotFound → `unsupported`, and other errors rethrow.
- Slice 4: `"once"` means no resend.
- Slice 4: `sessionId` cannot be overridden (`Omit` plus the spread order puts the session's id first,
  and the wire carries it twice). No turn is minted.
- Slice 5: the hit priority holds, and the ＋ never targets a side-column pill.
- Slice 5: ghosts are deduplicated.
- Slice 6: a `changed` refusal keeps the draft. Review blocks edits (`apply` requires `editing`).
  Confirm sends the previewed draft with `baseHash`.

**§7:** the slice-4 trust bit refuses locally, sends nothing, and is pinned. The phone carries
model names only. Slices 5 and 6 are pure, React-free modules.

**Executor:** disciplined and honest in Execution. The same model family reviewed it (Opus,
fresh context only), so blind spots they share may survive both passes.

*— claude-opus-5-5, 2026-11-24*

### Round 2 — REQUEST-CHANGES

Scope: `git diff HEAD~1` (d4eb0097). `bun test apps/mobile/test/workflow-edit-controller.test.ts`: 56 pass / 0 fail. `bun run lint` clean; `bun run typecheck` clean.

- **Finding 1 (HIGH): FIXED.** My round-1 repro (`.tentacle/tmp/workflow-editor/rev456/lost-edits.test.ts`, link down before the write rejects) now ends `editing, dirty: true, "Discard 1 change?"`, with the offline edit kept. Mutation: `baseline = history.current` → 2 controller tests red; reverted.
- **Finding 2 (MEDIUM): mostly fixed, and the fix opens a new hole.** Save is now off while a save is undecided (mutation `pending: false` → red), and the check runs at once with the link up (mutation: drop the immediate `checkInterrupted` → 2 red). Both reverted; `git status` clean.
  - **New MEDIUM, `apps/mobile/src/workflow-edit-controller.ts:989` + `:1055-1064`.** The immediate check fires while the link is already dead but not yet reported down. If the link-up arrives while that check is in flight, `checking` swallows it (`:989`). When the check then rejects, nothing re-arms it.
  - Result: Save is stuck on "Checking whether the last save landed" until another link flap, or a Reload that discards the edits.
  - Repro: `.tentacle/tmp/workflow-editor/rev456/stuck.test.ts`, red: `saveOff: Checking whether the last save landed`, `reads: 2`.
  - Fix: remember an up that arrives while `checking` (a `recheck` flag), and re-run `checkInterrupted` from the catch when `!offline`. Pin it with this race as a red test.
- **Regressions checked, none found:**
  - a lost PREVIEW (`dryRun`) no longer arms `interrupted`;
  - `reload` clears it, and an in-flight check is ignored through `interrupted !== lost`;
  - `setLink(up)` with nothing pending only refreshes, as before.

*— claude-opus-5-5, 2026-11-24*

### Round 3 — PASS

Scope: `git diff HEAD~1` (2d1f44f2). `bun test apps/mobile/test/workflow-edit-controller.test.ts`: 58 pass / 0 fail. `bun run lint` clean (2392 files); `bun run typecheck` clean.

- **Round 2's new MEDIUM (Save stuck while the hash check is pending): FIXED.** My round-2 repro now ends `saved`, with `reads: 3`: the link-up that came during the failed check re-checked (`.tentacle/tmp/workflow-editor/rev456/stuck.test.ts`). Mutation: `recheck = false` at `apps/mobile/src/workflow-edit-controller.ts:995` → the new test "a link-up that lands DURING a check that then fails re-checks" goes red. Reverted; `git status` clean.
- **Regressions checked, none found:**
  - No retry loop: `recheck` is set only by an external link-up, and is cleared both when a check starts and before the catch re-runs one.
  - A `recheck` left over after a successful or superseded check is harmless: the next check clears it.
  - The superseded/disposed early return in the catch still comes before the re-check.
  - Round 1's repro still passes (`lost-edits.test.ts`: `editing, dirty: true`).
- Slices 4–6 have no open findings.

*— claude-opus-5-5, 2026-11-24*

## Execution

### Slice 7a — editor screen + route + entries (D8) — DONE

**PARTIAL check re-run first:** `RemoteSession.workflowSave` at `packages/client/src/remote-session.ts:1411`, and `insertStep` at `packages/core/src/workflow-draft.ts:221`. Both are present.

**Resumed from a stopped DeepSeek run** (the watchdog stopped it after 253 tool calls). Its working-tree edits were kept after review: the files matched its own pre-mutation backups, so no mutated file was left behind.
- New `apps/mobile/src/workflow-edit-actions.ts`: a pure module for what each gesture means (`tapIntent`, `portRelease`/`dragIntent`, `editMenuModel`, `menuInputs`, `applyIntent`, `drawnSteps`, `draftCaption`, `barLine`), tested in `apps/mobile/test/workflow-edit-actions.test.ts`.
  **Drift:** the Files table does not list this module. It exists so that `WorkflowEdit.tsx` stays a dumb renderer (AGENTS §7).
- `WorkflowEditRoute` in `routes.ts`, and the `WorkflowEdit` stack screen + `WorkflowEditRoute` in `App.tsx`. The route attaches through `RUNTIMES.controller`→`open` and follows the borrowed/leave rule.
- `screens/WorkflowEdit.tsx`.
- Entries: runs empty state → `onNew`; catalogue rows (valid and broken) → `onEdit`.

**Fixed on top (red first, each new assertion in `workflow-edit-wiring.test.ts` failed on DeepSeek's code):**
1. **Canvas taps.** The ground `Pressable` (absoluteFill) was rendered after the pills/＋/✗/labels. React Native stacks later siblings on top, so the ground swallowed every tap meant for them. It is now drawn first, right after the `Svg`.
2. **✗ drag.** The port used `Pressable.onPressOut`, which fires when the touch leaves the retention box. A drag therefore resolved at the port's edge, never where the finger lifts. It is now a `PanResponder`:
   - lift point = grant location + `(dx, dy)`, passed to the same `portRelease`;
   - `onPanResponderTerminationRequest: () => false`, so the ScrollView cannot steal the drag;
   - one responder per port (`useRef`), with the latest `onDrop` read through a ref.
3. **Catalogue "New workflow".** D8 lists this entry, but it was missing. Added `WorkflowStart` `onNew` → `testID="workflow-start-new"` (shown when ready and on the list view) → `navigate("WorkflowEdit", {computerId, sessionId})`.
4. **Doc-comment fix.** The `WorkflowEditRoute` doc comment contained the word `reopen`, inside the span that `workflow-start-wiring.test.ts` scans for `WorkflowStartRoute`. That test was red. The comment is reworded.
5. **Cosmetic.**
   - `RootStackParams` is back in its original layout (the resumed edit had glued `*/ export type` onto one line).
   - The toast dismiss icon is `xmark` (it was `chevron.left`).

**Red → green:** `bun test apps/mobile/test/workflow-edit-wiring.test.ts` went from 18 pass / 4 fail to 22 pass / 0 fail. The 4 failures were ground order, `onPressOut`, `workflow-start-new`, and the push count < 3.

**Mutations** (each reverted; the file was restored byte-equal from `.tentacle/tmp/workflow-editor/s7a/actions.ts.orig`). Each was killed by a distinct test, 4 fail in total:

| Mutation in `workflow-edit-actions.ts` | Killed by (`workflow-edit-actions.test.ts`) |
|---|---|
| `tapIntent` armed+node → `open` | "a step tapped while a port is armed is the DROP" |
| `portRelease` drops the `port.hit.x` offset | "ONE release handler: a touch inside … is the TAP" and "…a DRAG once the touch leaves that box" |
| `drawnSteps` +1 | "the bar's count is the draft's `steps:`" |

The two screen fixes (ground order, `onPressOut`) are pinned by the wiring tests shown red above on the unfixed code.

**Checks run (narrow only):**
- `bun test apps/mobile/test/`: 5117 pass / 0 fail (325 files);
- `tsc -p apps/mobile`: clean;
- `biome check` on the 8 changed files: clean.

**Not in 7a (by design):**
- Save calls `beginReview()`, but the Review screen is 7c's. Until then the `reviewing` state draws the canvas with "nothing written yet" and offers no confirm. Cancel still leaves.
- `insert`/`open` intents are dropped until 7b's sheets.
- The changelog fragment `changelog.d/workflow-editor.added.md` already exists (commit 26a4aa6b), so no second one was written.

**Unverified:** the `PanResponder` drag inside the `ScrollView` on a device (iOS native scroll vs the JS responder). Verify with e2e E4 in 7c.

*— claude-opus-5-5, 2026-11-24*

#### Slice 7a — RESUME after an offline pause (fix round) — DONE

The slice was already DONE (above). This round is the owner's RESUME: finish what the
paused run left in the working tree. It was kept as-is, re-verified, mutation-checked,
and one real defect found and fixed.

**PARTIAL check re-run first (the slice's load-bearing check, §Slices):**
`RemoteSession.workflowSave` present at `packages/client/src/remote-session.ts:1411`;
`insertStep` present at `packages/core/src/workflow-draft.ts:221`. Both hold, so the
slice is not PARTIAL.

**Working tree kept, not partly re-done.** `git status` showed the paused run's edits:
`M App.tsx, src/routes.ts, screens/{WorkflowRuns,WorkflowStart}.tsx, docs/…`;
`?? screens/WorkflowEdit.tsx, src/workflow-edit-actions.ts, test/workflow-edit-{actions,wiring}.test.ts`.
Reviewed against D8 and against the plan's Files table (one documented drift: the new
`workflow-edit-actions.ts`, not in the table, exists so the screen stays a dumb
renderer — AGENTS §7). Nothing needed rewriting; the two test files were 49/49 green and
`tsc -p apps/mobile` clean on arrival.

**Defect found by probing the code the slice owns (a repro, not a review finding).**
`.tentacle/tmp/workflow-editor/s7a/repro-stale-arm.ts`:

```
after tapping the port, armed = gate
deleteStep on gate -> [ "plan" ]
next tap on plan -> {"kind":"saveFail","id":"gate","target":"plan"}
bar says -> undefined          (the core: refused = no step "gate")
```

The route's menu path was `act({ armed, intent })`, so a menu row passed the arm through
unchanged. `armed` is a STEP ID and "Delete" removes that step: after deleting the armed
step, the next tap on ANY step is read as a drop onto the id that just went. The step
never opens, and the bar shows `no step "gate"` instead of the step. The stale arm also
survived Duplicate / Move / Open.

**The fix, one rule in the pure module:** `menuGesture(intent)` →
`{ armed: null, intent }` (`apps/mobile/src/workflow-edit-actions.ts:253`). The menu is
not the canvas — its rows are commands, none of them a place to drop a `✗` — so the arm
is put down. `App.tsx` calls `act(menuGesture(intent))`, so no intent reaches the
controller without passing through it. The same repro after the fix:
`armed after menu = null | next tap = {"kind":"open","id":"plan"}`.

**Red → green (§9).**
- `workflow-edit-wiring.test.ts` "a menu row DISARMS the port…" — **red** on the pre-fix
  route: 22 pass / 1 fail; **green** after: 23 pass.
- `workflow-edit-actions.test.ts` "a menu row DISARMS the port…" — asserts the rule AND
  its consequence (`tapIntent(menuGesture(…).armed, {kind:"node"})` is `open`, never
  `saveFail`).

**Mutation battery** (`.tentacle/tmp/workflow-editor/s7a/mine/battery.sh`; every case
asserts the mutation actually applied, then restores and asserts byte-identity — all
seven printed `RESTORED`):

| # | Mutation | Killed by |
|---|---|---|
| m1 | `tapIntent`: `armed === null` → `true` (an armed step tap opens) | "a step tapped while a port is armed is the DROP" |
| m2 | `portRelease`: drop `port.hit.x` (the port's own offset) | "ONE release handler: a touch inside … is the TAP" + "… is a DRAG once it leaves" |
| m3 | `drawnSteps` + 1 (a ghost pill counted as a step) | "the bar's count is the draft's `steps:`" |
| m4 | the ground `Pressable` moved AFTER the pills (the real RN stacking bug) | "the canvas ground is UNDER the pills: drawn first" |
| m5 | the port back on `Pressable.onPressOut` | "a ✗ drag resolves where the finger LIFTS" |
| m6 | `onPanResponderTerminationRequest: () => true` (the ScrollView may steal) | same wiring test |
| m7 | `menuGesture` keeps the arm (`armed: "gate"`) — the defect above | "a menu row DISARMS the port…" |

**Repro-script incident, disclosed.** My first `m4.ts` appended a backup to itself, so
the restore produced a doubled `WorkflowEdit.tsx` (1470 lines, two `WorkflowEditScreen`
declarations). `tsc` caught it at once (TS2393/TS2323). Both halves were byte-identical
to each other, so the file was rebuilt from the first half and is byte-equal to the
pre-mutation file; typecheck and the tests then went clean. The battery script that
replaced it never writes a backup file.

**Checks run (narrow only; the orchestrator runs the gate after this run):**
- `bun test` on the affected workflow test files: 130 pass / 0 fail;
- `bun run typecheck` (root + mobile + relay): clean;
- `bunx biome check` on the 8 changed files: clean.

**Changelog:** `changelog.d/workflow-editor.added.md` already exists (commit 26a4aa6b) and
covers the phone editor; this round adds no user-visible capability of its own, so no
second fragment. **No schema change** → `protocol.json` needs no regeneration.

**Not in 7a (unchanged):** Save calls `beginReview()`, but the Review screen is 7c's;
`insert`/`open` intents are 7b's sheets. **Unverified:** the `PanResponder` drag inside
the `ScrollView` on a device (e2e E4, 7c).

*— claude-opus-5-5 (executor, resume/finish of slice 7a), 2026-11-24*

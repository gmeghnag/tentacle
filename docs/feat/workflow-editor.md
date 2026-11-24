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
  Round-trip property: `Bun.YAML.parse(workflowYaml(d))` deep-equals `d`.
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
- **`renameStep(draft, old, new)` rewrites every `next` / `on_fail.goto` reference.** The user
  named the step, so rewriting the references is what they asked for.
- **`deleteStep(draft, id) → {draft, dangling: string[]}` NEVER rewrites references.** Fall-through
  reconnects by array order. `next`/`goto` references that named the deleted step stay as they
  are and become validator errors, drawn as a ghost pill. `dangling` feeds the menu note
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
  (the mockup's 6 steps). Each is `{id, label, sub, draft(name, description, inputs), prompts:
  Record<"prompts/<x>.md", text>}`.
  - The template's prompt files are referenced by its steps, so they are inside its hash (owner
    decision, 22/11 ~23:00).
  - Test: every template, once named, passes `draftProblems` with 0 errors, and every one of its
    prompt paths is referenced by a step.

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
  - **Payload bounds:** `draft` is a bounded JSON value (`z.record(z.unknown())`, refined to ≤ 512 KiB
    serialized). `prompts` ≤ 32 entries, each ≤ 64 KiB.
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
- **`cli/src/workflow-files.ts`:** `writeWorkflowFiles(cwd, plan, currentHash)`.
  - **Synchronous.** No `await` between the base check and the last rename.
  - **Base check:** re-read the current YAML plus its prompts (the `loadWorkflowSource` path,
    `:53-74`). `currentHash(source)` is the driver's sync validate+hash (below). Then:
    - `replace`: a missing file, or `currentHash !== baseHash`, refuses `changed`;
    - `create`: an existing YAML refuses `exists`.
  - **Prompt files.** A prompt the base did not cover, existing on disk with different bytes,
    refuses `exists` naming it: never overwrite a file the user did not load. Identical bytes are
    `unchanged`.
  - **No-links on every path.** Every target goes through `resolveInside(cwd, rel, fs)`, so every
    component is no-links. `prompts/` is created only when absent and under a real directory.
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

  `core/test/workflow-templates.test.ts`: every template validates with 0 errors and references
  every prompt it carries. Mutation: an extra unreferenced prompt → red.
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

## Review

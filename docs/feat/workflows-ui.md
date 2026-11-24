# feat/workflows-ui — see workflows: the client data path, the TUI view, the iPhone screens

Type: feat · Size: L (split into S/M slices) · Blast: cross-module (client + TUI + app; protocol only if the existing wire is insufficient) · Suited: Opus plan, DeepSeek exec (one at a time), Opus review, simulator shots

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

`feat/agent-workflows` merged 23/11 04:45 (`4ceba7b3`, protocol 25) with the engine, approvals, docker steps, notifications and scheduled start — but **no UI**: slice 6 (TUI rail + panel + `/workflow`) STOPPED before any edit (`docs/feat/agent-workflows.md:1364`) and slices 7–8 (iPhone list, graph 2C ⇄ cards 2A, approve buttons, node→detail morph + skeleton) shipped only the pure modules `apps/mobile/src/workflow-{graph,list,morph,skeleton}.ts` (`:1836`), because the client has no data path: `RemoteClient.workflowList()`, a public log read for the detail, and the `workflows` update reaching client state were all missing (the slice 7–8 load-bearing check, `:1836-1860`). Owner 23/11 ~07:45: do it, after the native-sheets plan.

Decisions already taken by the owner (keep them): iPhone main view = vertical graph **2C** with a cards toggle; tapping a workflow task/node navigates INTO it with the **morph** transition + **skeleton** (rows at their final positions, no layout shift; Reduce Motion: static grey bars), every inner part grows with the container; this is the ONE place transitions stay — every other sheet in the app becomes a native 3-detent sheet (`feat/mobile-native-sheets`, planned, not built yet — do not depend on it, do not conflict with its `Sheet` route). Mockups: `.tentacle/mockups/agent-workflows-{view,diagram,transition,spec,report}/`. Approval asks always show verbatim `run` commands (§7). Colour-blind owner: meaning never by hue alone. The workflow EDITOR is a separate later task (`feat/workflow-editor`, variant A) — out of scope; read-only views + run/stop/approve here.

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

### Load-bearing assumption (named first, proved against the source)

**"Everything the views need is already on the wire and answered by the daemon, except one
thing — a step's `prompt`/`report`; what is missing is the client keeping and exposing it."**
If this were false (e.g. the daemon did not publish runs to every client, or `workflow/list`
were not answered), the slices below would need a daemon redesign, not plumbing.

**What the daemon already sends / answers (verified):**

| Fact | Where |
|---|---|
| `workflows` update = FULL state (current + last ended), class `display`, sent to every attached client, idle too | `protocol/src/updates.ts:484-495`, `:599`; emitted `daemon/src/hosted-session.ts:2433-2444` |
| Row shapes: `WorkflowRowSchema` (runId, name, version, hash, state, stopReason, reason, tokens, budget, startedAt, endedAt, steps ≤ 64) and `WorkflowStepRowSchema` (id, kind, model, where, state, attempt, round, maxRound, reason ≤ 2000, live ≤ 200, durationMs) — **no `prompt`, no `report`** | `protocol/src/session.ts:807-849` |
| Snapshot field `workflows` on the open/resync snapshot (first page; absent on a pod) | `protocol/src/session.ts:1196-1201`; filled `hosted-session.ts:2236` |
| `session/workflow` (start / stop / resume / rerun_step; start-like actions carry a client-minted `turnId`; `wake-` refused) | `methods.ts:170-173`, `:320`; schema `session.ts:883-925`; daemon `connection.ts:450-451`, `hosted-session.ts:2458-2489` |
| `workflow/list` (serve; every LIVE session's runs, newest first, with `needsUser`) | `methods.ts:174-175`, `:321`; `session.ts:927-953`; `session-host.ts:909-917`; `hosted-session.ts:2491-2513` |
| A step's ask is an ordinary `permission_request` whose `agent.id` is `"<runId>.<stepId>"` (the hash approval: `"<runId>"`), approve steps raise kind `workflow_approve` | `agent/src/workflow-driver.ts:915-945`, `:762-778` |
| The phone already renders a `workflow_approve` ask allow-once / deny only | `apps/mobile/src/permission-sheet.ts:184` (`sheetOptions`), pinned by `apps/mobile/test/workflow-approve-sheet.test.ts` |
| Step detail is durable ONLY in the `workflow_step` log entry (`prompt` ≤ 16 KiB, `report` ≤ 64 KiB) | `protocol/src/session-log.ts:373-394`, `:83`; written `workflow-driver.ts:835-848`; daemon log `daemon/src/session-log.ts:230-232` |
| The daemon's log keeps only the current + previous segment in memory (older dropped at a replacement) | `daemon/src/session-log.ts:72-78`, `:118-119` |

**What the client lacks (verified; `rg -n "workflow|Workflow"` over `packages/client/src`
hits only `mapping.ts` and `permission-router.ts`; over `packages/tui/src` only
`permission-ui.ts`; over `apps/mobile/src` only the four pure modules + push/permission):**
- `mapping.ts:389-391` returns `null` for `workflows` ("by its own listeners") — correct shape,
  but no such listener exists. Sibling to mirror: `subagents` — listener set
  `remote-client.ts:965`, `onSessionSubagents`/`subagentsOf` `:1549-1557`,
  `subagentsChanged` `:3559-3564`, snapshot fold `:3984-3989`, live branch `:4178-4180`.
- `RemoteSession` has no `workflows`/`onWorkflows`/`workflow()` (sibling: `subagents` getter
  `remote-session.ts:1058`, `onSubagents` `:1104-1116`, a trust-gated method `deleteSchedule`
  `:1250-1261`).
- No public call sends `session/workflow`, `workflow/list`, nor reads a step's detail.
  `readBack` (`remote-client.ts:2843`) is the persistence read: it needs `sha256`, mutates the
  held copy (`entry.log`), and its `LogState` keeps only messages (`session-log-reader.ts:38-44`)
  — not a display source, and a cold read from the phone would page the whole conversation to find
  one entry.
- Pass-throughs missing: `cli/src/local-runtime.ts:369-380`/`:947-966` (sub-agents/schedules
  have them), TUI session type `tui/src/app-types.ts:283-321`, subscriptions
  `tui/src/useSessionLink.ts:469-475`.

**Empirical check (paste-in for the executor; I could not run `bun` in this planning session —
the executor runs it FIRST and pastes the output in Execution):**
`.tentacle/tmp/workflows-ui/lb.ts` — prints, for `RemoteClient.prototype` /
`RemoteSession.prototype`, whether `workflowsOf`, `onSessionWorkflows`, `workflowList`,
`workflow`, `workflowStep`, `onWorkflows`, the `workflows` getter exist (expected today: all
`false`; `subagentsOf`/`onSessionSubagents`/`onSubagents`/`readBack` `true`), `"WorkflowStep" in
Method` (`false`), the `WorkflowStepRowSchema` keys (no `prompt`/`report`), `UPDATE_CLASS.workflows`
(`display`), and that `{type:"workflows",runs:[]}` parses. If any "today" value differs, STOP and
report — the plan's premise moved.

**Consequence → one protocol addition, additive:** a NEW request `session/workflow_step` (the
step detail on demand). Rejected alternatives: (a) put `prompt`/`report` on the step row — the
row rides a full-state update re-sent at every step move, up to 64 steps × 80 KiB per frame;
(b) the client reads `session/log` — persistence-coupled and O(conversation) per tap (above).
**No `PROTOCOL_VERSION` move, no `protocol.d/` note:** a new method is free (AGENTS §7 forward
compat: an older daemon answers `MethodNotFound`, handled as "update tentacle"). Nothing existing
changes shape. The executor regenerates `packages/protocol/schema/protocol.json` with
`bun run schema:export` on the branch (as slice 9 did) so `json-schema.test.ts` stays green;
the orchestrator's `protocol:bump` at merge regenerates it again either way.

### Preconditions (verified invariants relied on)

- **One session path** (§7): every runtime goes through `RemoteClient` ↔ `Connection`; the
  in-process worker AND `serve` have a driver (`cli/src/wiring.ts:835-842`: "the worker and
  `serve` and NEVER tunnelled"), so the same client code serves TUI-local, `connect` and phone.
- **Peer not serialized** (§7): `session/log` is served synchronously from the derived log
  (`connection.ts:425-430`, `hosted-session.ts:2620-2628`); the new method follows the same rule
  (synchronous, no await, no lock).
- **Trust bit**: `daemonWakes` is set exactly by the worker, `connect` and the phone
  (`remote-client.ts:550-557`, `apps/mobile/src/connection.ts:72`, `cli/src/connect.ts:301`) —
  the same set of daemons that can run a workflow. A pod never runs one (`session.ts:1198-1200`).
  So the client drops a `workflows` frame / snapshot field with the bit off, exactly like
  `schedules` (`remote-client.ts:4181-4187`, `:3996-4000`): a pod's runs are a pod-supplied claim
  about laptop-owned state. `RemoteSession.workflow()` answers its own refusal with the bit off
  and sends nothing (pattern `deleteSchedule`).
- **Own-turn attribution**: a run's asks carry its start `turnId` (`workflow-driver.ts:936`);
  auto-accept answers only asks whose turn this session owns (`remote-session.ts:726-754`), and
  ownership comes from `mint()` (`:764-772`). So `workflow{start|resume|rerun_step}` MUST
  `mint` its turnId, or auto-accept silently stops answering the run's tool asks.
- **Pure modules / dumb components** (§7): every branch below lives in a `.ts` module with tests;
  `.tsx` only paints a view-model. The four phone pure modules already exist and are tested
  (`agent-workflows.md:1903-1912`, 47 tests).
- **Ink gotcha** (§6): blank rows are `" "`.

### Design

**D1 — `session/workflow_step` (protocol + daemon).**
- `protocol/src/session.ts`: `WorkflowStepParamsSchema {sessionId, runId: WorkflowRunRefSchema,
  stepId (same regex as rerun_step), attempt?: int ≥ 0, round?: int ≥ 0}` and
  `WorkflowStepResultSchema {detail?: {attempt, round, live: boolean, state?: line(32),
  verdict?: line(32), reason?: ≤ 2000, prompt?: ≤ WORKFLOW_PROMPT_MAX_CHARS, report?: ≤
  SUBAGENT_REPORT_MAX_CHARS, tokens?, durationMs?}}`. Strip schemas. `detail` absent = "not
  available" (never ran; or its entry left the retained log — compaction, a serve reload).
- `methods.ts`: `WorkflowStep: "session/workflow_step"` + its table row.
- `daemon/src/session-log.ts`: `findWorkflowStep(runId, stepId, attempt?, round?)` — scan the
  retained slots newest-first for a `workflow_step` match (latest attempt/round when omitted);
  synchronous.
- `agent/src/workflow-driver.ts`: `Run.current?: {stepId, attempt, round, text}` set when a
  step's action starts, cleared at its end; `liveStep(runId, stepId)` returns it.
- `daemon/src/hosted-session.ts`: `workflowStepDetail(params)` — the driver's live step first
  (`live: true`, prompt, no report), else the log entry (`live: false`); no driver → `{}`.
- `daemon/src/connection.ts`: `case Method.WorkflowStep` via `this.readable(sessionId)`
  (reading needs no open, like `session/log`, `:428-431`).

**D2 — client data path.**
- NEW `packages/client/src/workflows.ts` (pure): `MAX_WORKFLOW_RUNS = 8`, `boundWorkflows(rows)`
  (keeps newest-first order, caps runs; steps are already ≤ 64 by schema), `workflowsFromSnapshot`,
  `askForStep(pending, runId, stepId | null)` (matches `agent.id` `"<runId>.<stepId>"` /
  `"<runId>"`), `WORKFLOW_OLD_DAEMON` / `WORKFLOW_UNTRUSTED_DAEMON` refusal texts.
- `remote-client.ts`: `workflowListeners`, `onSessionWorkflows`, `workflowsOf`,
  private `workflowsChanged(entry, rows)`; live branch beside `subagents` (`:4178`) and snapshot
  fold beside `:3986`, BOTH gated on `daemonWakes`; `workflow(sessionId, params)`,
  `workflowList()` → `WorkflowListResult | {unsupported: true}` (MethodNotFound),
  `workflowStep(sessionId, …)` → `WorkflowStepResult | {unsupported: true}`.
- `remote-session.ts`: `workflows` getter, `onWorkflows` (current list given at once, like
  `onSubagents`), `workflow(action)` (mints the turnId for start/resume/rerun_step; refuses
  locally with no id / bit off), `workflowStep(runId, stepId, attempt?)`.
- `cli/src/local-runtime.ts`: pass-throughs `onWorkflows`, `workflow`, `workflowStep`.
- `tui/src/app-types.ts`: the same three, optional (absent ⇒ "not supported by this session").
- `mapping.ts`: unchanged (its `null` is right once the listener exists); its comment names the
  listener.

**D3 — TUI (spec: mockup `agent-workflows-view` TUI 1 + TUI 2).**
- `tui/src/workflow-view.ts` (pure): `railLines(run, width, now)` — header
  `workflow <name> · <done>/<total> · <tok>/<budget> tok`, one line per step `glyph id model
  [where] dur note` (glyph + WORD always: `✓ ok`, `✗ error`, `▸ running`, `⧗ waiting`,
  `? needs approval`, `‖ stopped`, `○ pending`, `↻ n/m` on a goto round; an unknown state →
  `· <word>` as is, never coerced); width tiers drop `where` then `model` (pattern
  `background-list.ts:36-40`); a long graph windows to `WORKFLOW_RAIL_MAX_STEPS = 7` around the
  active step with `… +k` rows; `live` tail one line under the running step; reason/live flattened
  (`oneLine`). Plus `panelView(run, sel, detail, width, maxBody)` (two columns), `workflowKey`
  (↑↓ / r / o / esc), and `parseWorkflowCommand(args)` (`/workflow` | `run <name> [k=v…]` |
  `stop` | `resume`).
- `tui/src/components/WorkflowRail.tsx` paints `railLines`; mounted in `AppView.tsx` in the
  live area above the queued/slot block (`AppView.tsx:149-157`), ONLY while the current run has
  no `endedAt` (the end is already an ordinary transcript note, `hosted-session.ts:2417`); its
  rows counted in the live-area row budget (`activeRows`, `AppView.tsx:190-192` comment) so
  the input never moves.
- `tui/src/panels/workflow.ts` + one line in `panels/registry.ts:26-31` + the `OpenPanel` union
  in `tui/src/panel.ts` (registry's `PanelKindName` derives from it, `registry.ts:37`).
  `o` fetches `workflowStep` and shows prompt/report in the right column (windowed to
  `maxBody`); `r` sends `rerun_step`; the reply/refusal is a notice.
- `tui/src/commands/workflow.ts` + registry line in `commands/registry.ts` (pattern
  `commands/schedule.ts`: unsupported notice when `sessionRef.current?.onWorkflows` is absent).
- `useSessionLink.ts`: subscribe `onWorkflows` beside `:469-475`, reset on session switch
  (`:456`); state held where the dock holds `schedules` (`useDock`).
- **No `[a]/[d]` in the panel (drift from D6, deliberate):** an approve ask already takes the
  input as the permission dialog (`AppView.tsx:~130-147`), with the verbatim detail; a second
  answer path would be a second UI for one ask. The panel line says `? needs approval — answer
  in the prompt`.

**D4 — iPhone list + graph 2C ⇄ cards 2A + approve.**
- Routes (`apps/mobile/src/routes.ts`): `WorkflowRuns {computerId, name, sessionId?}` and
  `WorkflowRun {computerId, sessionId, runId, title}` — two native-stack PUSH screens in
  `App.tsx` beside `:2714-2820`. Names chosen not to touch `feat/mobile-native-sheets`'s `Sheet`
  route; no `<Modal>` used.
- Hub entry `workflows` in `hub-actions.ts:12-27` (label "Workflows"; badge = `needsUserCount`
  in the current hub idiom: rim arc, no dot); dimmed with `emptyLabel` "No workflow runs" when
  `workflow/list` returned none.
- NEW `apps/mobile/src/workflow-runs-controller.ts` (pure, injected client): loads
  `workflowList()` on focus, on pull, and on any `onSessionWorkflows` notice (debounced 500 ms);
  `unsupported` → "Update tentacle on this computer"; link down → keeps the last list + an offline
  line (no spinner loop). Uses `fromListRow`/`elencoSections` (`workflow-list.ts:115`, `:252`).
- NEW `apps/mobile/src/workflow-run-controller.ts` (pure): attaches through the SAME session
  runtime (`session-runtimes.ts:35`), follows `onWorkflows`, selects the run by `runId`, view mode
  `graph | cards` (persisted per app), pairs each approve/waiting step with its pending ask
  (`askForStep`), answers through the phone's existing sheet path (`permission-sheet.ts:154`,
  `responseFor` `:217`). If the sheet can only answer its HEAD ask, this slice adds a pure
  `answerFor(requestId, optionId)` to `permission-sheet.ts` (red-first) — never a second
  resolve path. Stop / resume / rerun step → `session.workflow(...)`; a refusal is a notice.
- Screens `apps/mobile/src/screens/WorkflowRuns.tsx`, `WorkflowRun.tsx` (graph via
  `graphGeometry` + `react-native-svg` if already a dependency, else Views + absolutely
  positioned pills — the executor checks `apps/mobile/package.json` and uses what is there, never
  adds a native dep in this slice); cards = one card per step (2A). The approve card shows the
  ask's `title` + `detail` VERBATIM (scrollable, never truncated: §7 "verbatim `run` commands")
  and Allow once / Deny.
- **Labels in English.** `workflow-skeleton.ts:241-262` (`detailBlocks`) and the list words carry
  the mockup's Italian ("Stato", "Tipo", …); the app UI is English (`Computers`, `Settings`, push
  "Workflow finished"). This slice switches those strings to English (tests updated with them).

**D5 — iPhone node → detail morph + skeleton (react-native-reanimated: NOT added).**
- **Decision: RN `Animated`.** Already used in the app (`screens/SessionsDrawer.tsx:30`, `:125`)
  and enough for one 380 ms transition: progress `Animated.Value` (JS driver,
  `useNativeDriver: false`, because width/height/borderRadius/fontSize are layout props the native
  driver refuses) interpolated from a TABLE the pure module computes (new pure
  `morphTable(from, to, samples = 11)` in `workflow-morph.ts`: inputRange 0..1 → each property's
  outputs from `morphFrame`), so `workflow-morph.ts` stays the only source of the motion; the
  graph layer's fade/scale and each row's opacity on separate native-driven values started in
  `Animated.parallel` with `rowStartMs(i)` delays. Adding reanimated would mean a native module
  (pods, Babel plugin, worklets package, a new dev-client build, the e2e gate re-baselined) for
  one screen — cost without a measured need. Revisit only if the e2e shows dropped frames.
- The detail is a LAYER inside `WorkflowRun` (not a navigation push: a native-stack transition
  cannot morph from a pill); while it is open, `gestureEnabled: false` and the header back
  reverses the morph.
- Skeleton: on tap the kv block is final at once (from the row); `workflowStep(...)` fills
  prompt/report into the log block, whose skeleton bars are `skeletonBars` (`workflow-skeleton.ts:172`).
  The property pinned: **no box above the log block moves when the detail arrives**; the log block
  only grows downward. Reduce Motion (`useAccessibilityFlags`, `SessionScreen.tsx:949`) →
  `morphLook(true)` crossfade + `skeletonMotion(true)` still bars.

### Slices (dependency order; each S/M; one executor at a time)

| # | Slice | Size · Blast · Suited | Files |
|---|---|---|---|
| 1a | `session/workflow_step` (D1) | S · cross-module (additive method) · standard review | `protocol/src/{session,methods}.ts`, `protocol/schema/protocol.json` (regenerated), `daemon/src/{session-log,hosted-session,connection}.ts`, `agent/src/workflow-driver.ts` |
| 1b | Client data path (D2) | M · cross-module · standard review | `client/src/{workflows (new),remote-client,remote-session,mapping,index}.ts`, `cli/src/local-runtime.ts`, `tui/src/app-types.ts` |
| 2 | TUI rail + panel + `/workflow` (D3) | M · contained · standard review | `tui/src/{workflow-view (new),panel,useSessionLink,useDock,AppView}.ts(x)`, `tui/src/components/WorkflowRail.tsx` (new), `tui/src/panels/{workflow (new),registry}.ts`, `tui/src/commands/{workflow (new),registry}.ts`, `changelog.d/workflows-ui.added.md` |
| 3 | iPhone list + graph ⇄ cards + approve (D4) | M · contained · standard review + e2e | `apps/mobile/src/{routes,hub-actions,workflow-runs-controller (new),workflow-run-controller (new),workflow-list,workflow-skeleton,permission-sheet}.ts`, `apps/mobile/src/screens/{WorkflowRuns,WorkflowRun}.tsx` (new), `apps/mobile/App.tsx`, `apps/mobile/src/screens/SessionScreen.tsx` (hub entry wiring only), e2e flow + seed |
| 4 | iPhone morph + skeleton (D5) | M · contained · standard review + e2e | `apps/mobile/src/workflow-morph.ts` (`morphTable`), `apps/mobile/src/screens/WorkflowStep.tsx` (new, the layer), `WorkflowRun.tsx`, e2e flow |
| 5a | Workflow catalogue + start-by-hash on the wire (D6, below) | M · cross-module (additive method + additive fields) · standard review | `protocol/src/{session,methods}.ts`, `protocol/schema/protocol.json` (regenerated), `cli/src/workflow-files.ts` (`listWorkflowSources`), `cli/src/wiring.ts` (pass `list` dep), `agent/src/workflow-driver.ts` (`catalogue`, `start{hash}`, `refusal`), `daemon/src/{hosted-session,connection}.ts`, `client/src/{workflows,remote-client,remote-session}.ts`, `cli/src/local-runtime.ts`, `tui/src/app-types.ts` |
| 5b | iPhone "Start a workflow": catalogue + inputs form + start (D6) | M · contained · standard review + e2e | `apps/mobile/src/workflow-start.ts` (new, pure), `apps/mobile/src/workflow-start-controller.ts` (new, pure), `apps/mobile/src/screens/WorkflowStart.tsx` (new), `apps/mobile/src/routes.ts`, `apps/mobile/App.tsx`, `WorkflowRuns.tsx` (entry button), e2e flow + seed |

~~Order: 1a → 1b → 2 → 3 → 4 → 5a → 5b.~~ **Superseded by plan v3 (owner 23/11 ~10:30, see D7/D8):**

| # | Slice | Size · Blast · Suited | Files |
|---|---|---|---|
| ~~0~~ | ~~(v3) workflows path constant~~ — **replaced by 0a + 0b (v4, D7 rewritten after the owner's review)** | | |
| ~~0a / 0b (v4)~~ | ~~root walk, hide root file~~ — **replaced by slice 0 (v5, owner review of v4: root = cwd)** | | |
| 0 | `core/src/project-paths.ts` (the `.tentacle/` names + the one no-links check + the bounded display-only `workflowsAbove` hint) + node adapter; **workflows** move to `<cwd>/.tentacle/workflows` (loader, messages, tool texts); **hide** and **tool-output** take their names from the module (strings only); `.gitignore` exception (D7 v5) | M · cross-module (a new core seam, tool texts; no change to the hide set, no approval-key change) · standard review | `core/src/project-paths.ts` (new), `core/src/index.ts`, `cli/src/project-fs.ts` (new, node adapter), `cli/src/workflow-files.ts`, `core/src/workflow-spec.ts` (messages), `agent/src/workflow-driver.ts` (comments), `agent/src/agent.ts:2973`, `cli/src/workspace-mount.ts:252,287` (names only), `tools/src/{workflow,schedule}.ts` (texts), `protocol/src/session.ts:856` (comment), tests in D7 v5, `.gitignore`, `AGENTS.md` §6 one line, a dated note in `docs/feat/agent-workflows.md` |
| 2b | TUI: the project's workflows shown automatically (D8) | M · contained · standard review | `tui/src/workflow-view.ts` (`catalogueLine`, panel section), `tui/src/useSessionLink.ts`, `tui/src/AppView.tsx`, `tui/src/components/WorkflowRail.tsx` (or a sibling `WorkflowsLine.tsx`), `tui/src/panels/workflow.ts`, `tui/src/commands/workflow.ts` |

**Order (v5): 0 → 1a → 1b → 5a → 2 → 2b → 3 → 4 → 5b.** 0 first: every later slice that touches
a workflow file takes the folder from it — 5a (`listWorkflowSources(cwd)`, `workflowsGitIgnored(cwd)`,
the catalogue's `dir` and `elsewhere` hint), 2b/5b (the folder named on screen, the hint), the
e2e seeds of 3/5b (write under `<serveCwd>/${PROJECT_PATHS.workflows}`, never a hand-written
path). 0b is gone: hide keeps its exact behaviour and only takes its names from the module (D7
v5), which is a string change inside slice 0. 1a/1b do not read the path. 5a before the TUI (2b
reads its catalogue); 5b needs 3's routes. One executor at a time; PARTIAL rule as below, plus:
0 — the D7 inventory `rg` still returns exactly the readers listed (a new one → STOP, update D7);
2b — `RemoteSession.workflowCatalogue` exists (5a) and slice 2's rail is mounted.

**PARTIAL rule (every slice):** the executor first re-runs the checks its slice stands on — 1a:
`lb.ts`; 1b: `"WorkflowStep" in Method` true and the daemon answers it; 2: `RemoteSession.onWorkflows`
/ `workflow` / `workflowStep` exist and `local-runtime` passes them; 3–4: `RemoteClient.workflowList`
and `RemoteSession.workflowStep` exist; 5a: `RemoteSession.workflow` exists (1b) and the driver's
`inspect`/`prepare` are as cited in D6; 5b: `RemoteSession.workflowCatalogue` exists and a
`start{hash}` with a stale hash is refused `changed` by the daemon. If any is missing, write
`### Slice N — PARTIAL` in Execution with the failing line and STOP — no screen without its data
path. The chain stops on PARTIAL.

### Failure modes (how each converges)

| Slice | Failure | Converges to |
|---|---|---|
| 1a | step never ran / its entry left the retained log (compaction, serve reload) | `{}` → UI "detail no longer available" (never a throw, never a stale other step's text) |
| 1a | asked mid-step | `live: true` + resolved prompt, no report; re-asked when the row says ended |
| 1a | tunnelled session (no driver) | `{}` |
| 1a/1b | older daemon | `MethodNotFound` → `{unsupported:true}` → "update tentacle" |
| 1b | disconnect mid-run / lost update | full-state update + snapshot field on resync repaint (`workflowsChanged` from the snapshot, then buffered frames in seq order); nothing stale |
| 1b | run started elsewhere (model, another client, a schedule) | every attached client gets the frame (`updates.ts:486`) and shows it; its asks are foreign to this client's auto-accept (correct: not mine) |
| 1b | pod daemon sends `workflows` | dropped (bit off); `workflow()` refused locally, nothing sent |
| 1b | start reply refused (`ok:false`, one run already running, hash changed) | `reason` returned as a value, shown as a notice |
| 1b | client forgets `mint` | caught by the test below (auto-accept would silently stop) |
| 2/3/4 | unknown step kind / state from a newer daemon | shown as its own word with a neutral glyph (`·`), never coerced (pattern `stateLook`, `workflow-list.ts:79`; phone already tested M6) |
| 2/3/4 | very long graph (64 steps) | TUI windows ±3 around the active step with `… +k`; phone scrolls (64-step non-overlap already pinned, `workflow-list-graph.test.ts`) |
| 2/3/4 | multi-line / escape-laden reason from a `run` step | flattened `oneLine` for rows; the detail shows it as lines; never raw SGR |
| 3 | session ended between list and tap | open refused → "This session has ended" + back; never `open{reopen}` (archive rule §7) |
| 3 | `workflow/list` against a worker (not serve) | the phone only reaches `serve`; on `unsupported` the hub entry is dimmed |
| 3 | approve ask answered elsewhere first | `permission_resolved` removes it; the card falls back to the step's state, buttons gone |
| 4 | Reduce Motion | crossfade 200 ms + static bars (the layout still holds) |
| 4 | detail arrives during the flight | the log block fills in place; boxes above unchanged |
| 4 | tap while a morph runs | ignored until settled (one flight at a time) |

### Tests (red first; the property each kills)

- **1a** `daemon/test/workflow-step-detail.test.ts` (fakes as `workflow-hosted.test.ts`):
  ended step → its `prompt` + `report` from the log, `live:false`; running step → `live:true`,
  prompt, no report; latest attempt when `attempt` omitted, the asked one when given; unknown step
  → `{}`; after a `replaced` (compaction) beyond the previous segment → `{}`; tunnelled → `{}`.
  `protocol/test/json-schema.test.ts` green after `schema:export`. Red: method missing →
  `MethodNotFound`.
- **1b** `client/test/workflows-client.test.ts` (fake peer as `client/test/subagents.test.ts`):
  a `workflows` frame reaches `onSessionWorkflows` and `RemoteSession.onWorkflows` in seq order;
  a resync snapshot repaints (failure row "lost update"); bit off → frame and snapshot DROPPED and
  `workflow()` sends nothing; `workflow({action:"start"})` sends a non-`wake-` turnId AND
  `session.ownsTurn(thatId)` is true (mutation: remove `mint` → red); `workflowList`/`workflowStep`
  map `MethodNotFound` to `{unsupported:true}`; `askForStep` matches `wf-1.merge` and not
  `wf-11.merge`. Pass-through: `cli/test/local-runtime*.test.ts` pattern, the three methods reach
  `inner`.
- **2** `tui/test/workflow-view.test.ts` (pure: every state glyph + word, width tiers, window
  `… +k`, unknown state as is, flattening) and `tui/test/workflow-frames.test.tsx`
  (ink-testing-library, pattern `schedule-panel-frames.test.tsx`): rail frame text equals the
  mockup TUI 1 lines for the fixture run; the input row's y does not change when the rail
  appears/disappears (the exact property, not "height constant"); `/workflow` opens the panel,
  ↑↓ moves, `o` paints the fetched report, `r` sends `rerun_step`, unsupported session → notice.
- **3** `apps/mobile/test/workflow-runs-controller.test.ts`, `workflow-run-controller.test.ts`
  (pure, fake client): refresh triggers; offline keeps the list; unsupported; mode toggle;
  ask↔step pairing; answer goes through the sheet's path with that `requestId`; resolved-elsewhere
  removes buttons; hub entry dimmed/badged (`hub-actions.test.ts`); routes (`routes.test.ts`).
  Screens are pinned by source-reading tests only (RN is Flow, unimportable from Bun — see
  `apps/mobile/test/hub-tools-wiring.test.ts` header) plus the e2e shots.
- **4** `apps/mobile/test/workflow-morph-skeleton.test.ts` additions: `morphTable` inputRange
  strictly increasing, every output equals `morphFrame` at that sample, endpoints exact; the
  boxes above the log block are identical before and after the detail lands (mutation: lay the
  log above the kv → red).

### Validation (screenshots — the orchestrator runs them)

- **TUI (slice 2):** frames captured by `workflow-frames.test.tsx` and pasted (SGR-stripped) into
  Execution: (T1) rail with the mockup fixture at 120 cols; (T2) same at 60 cols (tiers);
  (T3) 64-step run windowed; (T4) `/workflow` panel, `review` selected; (T5) panel after `o`.
- **iPhone (slices 3–4):** a new Maestro flow `apps/mobile/e2e/flows/42-workflow-shots.yaml` +
  a seed step (`seed.ts` gains `startWorkflow`, through its own `RemoteClient`, `seed.ts:9-13`)
  that writes `demo.yaml` under `<serveCwd>/${PROJECT_PATHS.workflows}` (v5: the module's name,
  never a hand-written path) (an `agent` step on the mock model, a `run` step
  `echo ok`, an `approve` step) and starts it. Shots on iOS 26 and 18: (P1) hash-approval sheet
  showing the `run` command verbatim; (P2) Workflows list with "needs you" section; (P3) graph 2C
  with the running blink frame; (P4) cards 2A; (P5) approve card with Allow once / Deny; (P6)
  after allow → run `ok`; slice 4 adds (P7) mid-morph frame, (P8) skeleton, (P9) detail loaded,
  (P10) Reduce Motion on (simulator accessibility setting) — skeleton still. Run:
  `bun run e2e:mobile --ios 26 --only 42-workflow-shots` (and `--ios 18`).

### Owner questions (each with a recommendation)

1. **TUI rail placement** — live block above the input only while a run is not ended (the end
   stays as the transcript note), not a block re-painted inside the scrolled transcript?
   *Recommend: yes* — the transcript is static once printed; a live block there would reflow.
2. **Starting a NEW run from the phone** — needs a list of workflow files (no such method today).
   *Recommend: not in this task*; the phone does stop / resume / rerun step / approve; start stays
   TUI `/workflow run` or the model. A `workflow/defs` method can follow with the editor task.
   **→ Owner overruled: IN scope** (see Owner answers) — designed in D6, slices 5a/5b.
3. **Phone labels in English** (the pure modules carry the mockup's Italian). *Recommend: English*,
   as the rest of the app.

### D6 — Start a run from the phone (owner answer 23/11: in scope)

*— claude-opus-5-5 (planner), 2026-11-23*

**Load-bearing assumption for D6:** *the daemon can already validate, hash and approval-check a
workflow without starting or asking anything; only enumerating the files and pinning the hash
at start are missing.* Proved:
- `WorkflowDriver.inspect(name, inputs)` validates the CURRENT file, hashes it and answers
  `approved` with no run and no ask (`agent/src/workflow-driver.ts:391-412`); it rides `prepare`
  (`:668-697`): `deps.load` → `validateWorkflow` with the session's `models`/agent types →
  `workflowHash` over the YAML + the referenced prompts.
- Validation errors are already strings that name their YAML path (`core/src/workflow-spec.ts:566-571`
  "every problem is returned at once"; e.g. `steps[3].on_fail.goto: …`, D1 of agent-workflows);
  `prepare` prefixes the file path (`workflow-driver.ts:684-686`).
- Inputs are strings, `{required, default?}` (`core/src/workflow-spec.ts:69-72`, spec field
  `inputs` `:155`); the daemon is the authority on them (`inputsProblem`, `workflow-driver.ts:234-244`:
  unknown → refused, missing required → refused).
- The loader reads only regular files under `<cwd>/workflows/`, never a symlink
  (`cli/src/workflow-files.ts:1-56`), and the driver exists only on the worker and `serve`, never
  tunnelled (`cli/src/wiring.ts:835-843`) — so every file the catalogue reads is the serve host's
  own repo, never pod-supplied.
- Missing today: nothing lists `workflows/*.yaml` (the loader takes one `name`,
  `workflow-files.ts:37`); `session/workflow{start}` has no hash (`protocol/src/session.ts:884-891`),
  so a start re-reads the file and would run an edit the user never saw; the start result has no
  machine-readable refusal (`session.ts:917-924`: `ok`, `runId?`, `reason?`).

**Design (additive only — no `PROTOCOL_VERSION` move, no `protocol.d/` note).**
- **New method `session/workflow_catalogue`** (session-scoped: the catalogue is validated against
  THAT session's `models`/agent types, and the run starts in that session). Params `{sessionId}`.
  Result `{workflows: WorkflowDefRow[], truncated?: true, unavailable?: string(≤ 200), gitIgnored?: boolean}` (`gitIgnored`: D7)
  (`unavailable` = this session cannot run workflows, e.g. tunnelled — distinct from an empty
  folder), `WorkflowDefRow = {name: line(64),
  path: line(512), ok: boolean, version?, description?: ≤ 500, hash?: sha-256 hex,
  approved?: boolean, inputs?: [{name, required: boolean, default?: ≤ WORKFLOW_INPUTS_MAX_CHARS}]
  ≤ 64, steps?: [{id, kind: line(16), model?, where: line(256), command?: ≤ 4096}] ≤ 64,
  errors?: string(≤ 300)[] ≤ 20}` — `ok:false` rows carry `errors` and nothing else beyond
  name/path. Model-free and deterministic: no LLM, no ask, no write; one directory walk.
  Caps: ≤ 64 YAML files (beyond → `truncated`), the loader's existing per-file/byte caps.
- `cli/src/workflow-files.ts`: `listWorkflowSources(cwd): Promise<WorkflowSource[]>` (v5: the
  session cwd IS the project root; folder from `PROJECT_PATHS.workflows`, checks via
  `resolveInside(…, "no-links")` — never its own path or symlink code). The catalogue result also
  carries `dir: string` (≤ 1024, the ABSOLUTE folder it read — `/workflow` and the phone show it)
  and, only when that folder lists no workflow, `elsewhere?: {dir: string ≤ 1024, count: int}` from
  `workflowsAbove` (D7 v5; display only) — ONE async
  walk (`fs/promises`, so a big folder does not block the serve event loop the concurrent peer
  shares, §7), the same no-symlink / regular-file / size rules, every top-level `<stem>.yaml`; a
  stem that is not a workflow name becomes an `ok:false` row ("not a workflow name"), never a
  silent skip. Missing `.tentacle/workflows/` → `[]` (the folder per D7, slice 0).
- `agent/src/workflow-driver.ts`: dep `list?: () => Promise<WorkflowSource[]>` (wired in
  `cli/src/wiring.ts` beside `load`, `:843`); `catalogue()` = for each source, the existing
  `prepare` path (refactored to take a source instead of a name, no behaviour change) +
  `approvals.has(path, hash)`; the `steps` summary is the spec's steps (the same facts
  `stepsSummary` puts in the hash ask, `:247-255`, but uncapped per row so the phone shows every
  `run` command in full BEFORE the approval).
- **`session/workflow{start}` gains optional `hash`** (`WorkflowHashSchema`). Present and ≠ the
  file's current hash → `{ok:false, refusal:"changed", reason:"workflows/x.yaml changed since you
  opened it"}`, nothing asked, nothing run. Checked in `start` after `prepare`, before the slot
  claim (`workflow-driver.ts:369-381`). Absent → today's behaviour (TUI `/workflow run`, the
  model's tool).
- **`WorkflowResultSchema` gains optional `refusal`** (bounded free word, never an enum):
  `changed` | `running` (with the run id in `runId`) | `invalid` | `inputs` | `unavailable`
  today; the driver's existing refusals get their word (`:362-367` running, `:370-371` invalid,
  `:374-377` inputs, `:380` running). The UI branches on the word; the `reason` stays the text.
- Version skew: a daemon that answers `workflow_catalogue` is by construction one that knows
  `start{hash}` and `refusal` (same slice), so the phone offers Start ONLY after a successful
  catalogue — an older daemon answers `MethodNotFound` → "Update tentacle on this computer",
  and never receives a `hash` it would silently drop.
- Client (`client/src/remote-client.ts`, `remote-session.ts`): `workflowCatalogue()` →
  `WorkflowCatalogueResult | {unsupported:true}`, trust-gated on `daemonWakes` (refused locally
  otherwise, like `workflow()`); `workflow({action:"start", name, inputs, hash})` reuses 1b's
  minting path. Pass-through in `local-runtime.ts` + optional in `tui/src/app-types.ts` (the TUI
  can complete `/workflow run <name>` from it later; not required here).

**Hash approval from the phone — single broker, exactly as on the Mac (§7).** Nothing new on the
approval path: the start is an ordinary `session/workflow{start}`; the driver asks the hash
approval through the session's ONE requester (`workflow-driver.ts:762-778` →
`deps.request` = `permissions.request`, `wiring.ts:848`); the phone receives it as a
`permission_request` kind `workflow_approve` and answers through its existing sheet, which offers
ONLY allow-once / deny (`apps/mobile/src/permission-sheet.ts:184`); auto-accept never answers it
(`core/src/permission.ts:302-308`). On allow, the DAEMON records `{project, path, hash}` in the
serve host's own store (`workflow-driver.ts:780-782`) — the same record a Mac answer writes; the
phone stores nothing. This does not violate "never a lasting approval for pod-supplied input":
the file is the serve host's own repo (the driver never exists on a tunnelled session), and the
record is bound to the exact hash, so any edit asks again. The phone's start screen shows the
full step list with every `run` command verbatim (from `steps[].command`) before the user taps
Start, because the ask's own `detail` is capped at 2000 chars (`workflow-driver.ts:775`, see
Notes).

**Phone flow (5b).** Entry: `WorkflowRuns` gets a "Start a workflow" button when it was opened
from a session (it has that `sessionId`); route `WorkflowStart {computerId, sessionId}`.
- `apps/mobile/src/workflow-start.ts` (pure): `catalogueRows(result)` (valid first by name, then
  invalid rows with their errors; `approved` → "Approved" / "Needs approval" — word + glyph, never
  hue alone); `formFor(def)` (one field per input, prefilled with `default`, marked required);
  `formProblems(def, values)` (required empty, value over `WORKFLOW_INPUTS_MAX_CHARS`, the whole
  list over the 4 KiB JSON bound, control characters) — a hint only, the daemon decides;
  `startParams(def, values)` (only declared names, `hash: def.hash`, empty optional fields left
  out so the file's default applies); `afterRefusal(result)` → `reload` (changed) | `openRun`
  (running, runId) | `showReason`.
- `apps/mobile/src/workflow-start-controller.ts` (pure, injected session): load the catalogue on
  focus/pull; Start disabled while the link is down, while a start is in flight, or when
  `formProblems` is non-empty; on `ok` → navigate to `WorkflowRun {runId}` (the hash ask, if any,
  arrives there as the normal sheet); on `changed` → reload the catalogue and keep the typed values
  for inputs that still exist, banner "This workflow changed — review it again"; on `running` →
  "Workflow X is already running" + Open run.
- `apps/mobile/src/screens/WorkflowStart.tsx`: list → tap a valid row → detail (description, full
  step list with verbatim commands, inputs form, Start); tap an invalid row → its errors verbatim,
  each with its YAML path, no Start.

**Failure modes (D6).**

| Failure | Converges to |
|---|---|
| invalid YAML / unknown `schemaVersion` / bad reference | an `ok:false` row with every error and its YAML path; no Start; listing never throws for one bad file |
| a stem that is not a workflow name, a symlink, an oversize file | an `ok:false` row ("not a workflow name" / "not a regular file") or skipped by the loader's caps with `truncated` — never a silent partial list without the flag |
| file edited after listing (YAML or any prompt) | `start{hash}` refused `changed` before any ask; catalogue reloads; the user reviews the new steps |
| file edited after start | irrelevant: the run holds the snapshot it hashed (agent-workflows D3 "Snapshot at start") |
| a run already active (this or another client, the model, a schedule) | refused `running` with its run id → Open run; two simultaneous starts: the driver claims synchronously, the second gets `running` (`workflow-driver.ts:379-381`) |
| hash approval denied / unanswered past `budget.wait` / run stopped first | the run ends `error: not approved…` / `stopped: timeout` / `stopped: cancelled` (`:784-801`); the run screen shows it |
| offline when tapping Start | Start disabled; the form keeps its values |
| link drops after Start was sent | never re-sent automatically; on resync the `workflows` snapshot shows the run if it started, else Start is enabled again (a duplicate tap is refused `running`, never a second run) |
| `approved` flips meanwhile (approved from the Mac) | display only; the daemon decides at start |
| pod session / older daemon / worker-only feature missing | `unsupported` or local refusal → "Update tentacle on this computer" / "Workflows run only on a laptop or serve session"; no Start button |
| `models` name in the file not in this session | an `ok:false` row with the validator's error (it is checked against the session's list, `workflow-driver.ts:680-683`) |

**Tests (red first; each names the property).**
- 5a `cli/test/workflow-files.test.ts` additions: one walk lists every `*.yaml`; symlinked file
  and symlinked `workflows/` refused; bad stem → error row; missing dir → `[]`; > 64 →
  `truncated`.
- 5a `agent/test/workflow-driver.test.ts` additions (fakes, `SpyBroker` pattern): `catalogue()`
  returns valid rows with hash = `workflowHash` of the same bytes, `approved` from the fake store,
  an invalid file's errors with their YAML path, and **asks nothing and starts nothing** (spy
  broker sees zero requests); `start{hash: stale}` → `refusal:"changed"`, zero asks, no row
  (mutation: drop the hash check → red); `start{hash: current}` on an unapproved hash → exactly ONE
  `workflow_approve` ask through the ONE requester (mutation: a private requester → red);
  `running` / `inputs` / `invalid` words on the existing refusals.
- 5a `daemon/test/workflow-hosted.test.ts`: `session/workflow_catalogue` answered on a session
  with a driver; on a tunnelled one (no driver) an explicit `refusal:"unavailable"`-style empty
  answer, never a list that looks like "no workflows"; `protocol/test/json-schema.test.ts`
  green after `schema:export`.
- 5a `client/test/workflows-client.test.ts`: `workflowCatalogue` maps `MethodNotFound` →
  `unsupported`; bit off → nothing sent; `start` carries `hash` and mints its turn.
- 5b `apps/mobile/test/workflow-start.test.ts` (pure): defaults prefilled; required empty blocks;
  optional empty is OMITTED (not `""`, which would override the file's default — mutation: send
  `""` → red); undeclared names never sent; `changed` → reload with surviving values kept;
  `running` → openRun with the id; Start disabled offline / in flight.
- 5b e2e `apps/mobile/e2e/flows/43-workflow-start.yaml`: seed writes `demo.yaml`
  (input `slug` required, `note` default) and a broken `broken.yaml` in the root's
  `PROJECT_PATHS.workflows` (v4, as slice 3's seed); shots:
  (S1) catalogue with "Needs approval" and the broken row; (S2) broken row's errors with YAML path;
  (S3) form with the default prefilled and Start disabled until `slug` is typed; (S4) hash-approval
  sheet on the phone; (S5) run screen running after Allow once; then the seed edits `demo.yaml` and
  the flow taps Start on the stale screen → (S6) "This workflow changed" banner. iOS 26 and 18:
  `bun run e2e:mobile --ios 26 --only 43-workflow-start`.

### D7 (v5) — ONE project-paths module; the project root IS the cwd (owner review of v4, 23/11 ~11:25)

*— claude-opus-5-5 (planner), 2026-11-23 — supersedes D7 v4 (its root walk and 0b are dropped).*

**Load-bearing assumption:** *with root = cwd, every `.tentacle/` reader keeps exactly the folder
it reads today except workflows, which only change folder name — so the module is names + one
check + a hint, and nothing it adds can steer a run.* Proved:
- The reader inventory of D7 v4 still holds (same `rg`; three readers: hide, tool-output,
  workflows — v4 table "Load-bearing assumption", unchanged).
- hide reads `` `${source}/.tentacle/hide` `` with `source = real(input.cwd)`
  (`cli/src/workspace-mount.ts:287`, `cli/src/engine-select.ts:378-380`): already cwd-rooted.
- tool-output: relative to the confined env, unreached in product (`wiring.ts:592-593`, `:786`,
  `:1025`): no root at all.
- workflows: `loadWorkflowSource(config.cwd, …)` (`wiring.ts:843`, `workflow-files.ts:37-41`),
  approvals keyed `projectKey(config.cwd)` (`wiring.ts:848`, `workflow-approvals.ts:78`): already
  cwd-rooted; only `"workflows"` → `.tentacle/workflows` moves. A child cannot start/stop a run
  (`agent/src/subagent.ts:432-434`) and works in the same session cwd, so the files a run reads
  and the folder its agents work in stay the same directory.
- No `--cwd` flag exists (D7 v4 evidence); a container's root is its mount folder, unchanged.

**Design.**
- NEW `packages/core/src/project-paths.ts` (pure; core has no `node:fs`, I/O injected):
  - `TENTACLE_DIR = ".tentacle"`; `PROJECT_PATHS = { workflows: ".tentacle/workflows",
    hide: ".tentacle/hide", toolOutput: ".tentacle/tool-output" } as const` — the only place these
    are spelled. NO root function: callers pass the cwd they already have.
  - `resolveInside(base, rel, fs, "no-links")` — refuses a symlink at ANY component from `base`
    down (`.tentacle`, `workflows`, the file); today the loader checks only `workflows` and the file
    (`workflow-files.ts:25-26`, `:49`). Returns `{path}` | `{absent}` | `{problem}`.
  - `workflowsAbove(cwd, fs, {home}) → {dir, count} | undefined` — the DISPLAY-ONLY hint (below).
  - `ProjectFs = {lstat(path) → "dir"|"file"|"link"|"other"|undefined, list(dir) → names+kinds | undefined}`.
- NEW `packages/cli/src/project-fs.ts`: the node adapter (ENOENT/ENOTDIR → `undefined`, pattern
  `engine-select.ts:446-458`).
- **workflows:** `workflow-files.ts` reads `<cwd>/${PROJECT_PATHS.workflows}` through
  `resolveInside`; recorded `path` `.tentacle/workflows/<name>.yaml`; messages
  (`workflow-spec.ts:2`, `:106`, `:145`, `:172`, `:337-349`, `:777`) and tool texts
  (`tools/src/workflow.ts:53`, `tools/src/schedule.ts:94`) built from `PROJECT_PATHS.workflows`; the
  not-found error and the `workflow` tool's `validate` name the ABSOLUTE folder read
  (`no workflow x: /Users/…/proj/.tentacle/workflows/x.yaml does not exist`), so a model or a user in
  the wrong folder sees where tentacle looks. Approvals: unchanged (`projectKey(cwd)`).
- **hide: names only.** `HIDE_FILE_LABEL = PROJECT_PATHS.hide` (`workspace-mount.ts:252`) and the
  path built from it (`:287`). Its reader and checks stay where they are — `loadHideFile`'s
  realpath-inside rule (`:292-296`) and the fd-level `O_NOFOLLOW|O_NONBLOCK` re-check
  (`engine-select.ts:458-470`) are a FIFO-safe primitive the pure module cannot express; moving a
  container-secrets reader for no behaviour gain is load-bearing churn (see Notes). Proof of "no
  change": the hide test files are NOT edited and stay green.
- **tool-output: name only.** `agent.ts:2973` builds from `PROJECT_PATHS.toolOutput`.
- **`/workflow` names its folder:** the catalogue (5a) returns `dir` = the absolute folder read;
  the TUI panel header says `reading ~/proj/.tentacle/workflows` and the phone's start screen shows
  it under the list.
- **The "workflows higher up" hint — bounded, read-only, display-only.**
  `workflowsAbove(cwd, fs, {home})`: runs ONLY inside a catalogue call and ONLY when the cwd's
  folder yields zero rows. It looks at the **4 nearest ancestors** of `cwd` (parent … great-great-
  grandparent), stopping earlier at `$HOME` (home itself is NOT looked at) or `/` (never looked
  at). At each, lstat `.tentacle` and `.tentacle/workflows` (both must be real dirs — a symlink
  is skipped, never followed); the FIRST ancestor whose folder lists ≥ 1 regular `<stem>.yaml`
  with a valid workflow name wins, returning `{dir, count}` (count capped at 200). No file is
  opened, no YAML parsed, no hash computed, nothing written. Cost ≤ 8 lstat + 1 listing.
  *Why 4:* the owner's case `~/tentacle/apps/mobile` is depth 2; a source folder
  (`apps/mobile/src/screens`) is depth 4; past that a match is more likely a different project.
  *Why it cannot change behaviour:* (1) structurally — its result has ONE consumer, the
  catalogue's `elsewhere` field; `loadWorkflowSource(cwd, name)`, `listWorkflowSources(cwd)` and
  the driver's `prepare` take no ancestor input, so nothing it finds can be loaded, hashed,
  approved or started; (2) by test — a parent holding `x.yaml` → the child's catalogue has 0 rows
  and `start x` fails "not found" naming `<cwd>/.tentacle/workflows` (mutation: feed the hint's dir
  to the loader → red).

**Every behaviour change (exhaustive).**

| Reader | Before | After |
|---|---|---|
| workflows | `<cwd>/workflows/<n>.yaml`; symlink refused on `workflows` and the file | `<cwd>/.tentacle/workflows/<n>.yaml`; symlink refused on every component incl. `.tentacle`; errors name the absolute folder |
| workflows hint | — | new display-only `dir` / `elsewhere` on the catalogue |
| hide | `<cwd>/.tentacle/hide` | identical (same string, now from the module) |
| tool-output | `.tentacle/tool-output/…` relative to the env | identical (same string, from the module) |
| approvals, mount source, session store, spill store | keyed / rooted on `cwd` | unchanged |

**Failure modes.**

| Failure | Converges to |
|---|---|
| started in a subfolder of a project with workflows | that folder's own (usually none) + the hint `~/tentacle/.tentacle/workflows has 3 (start tentacle in ~/tentacle)`; nothing from above is used |
| the subfolder has its own `.tentacle/workflows` | those are used; no hint (it runs only on zero rows) |
| ancestor folder is a symlink / unreadable / not a dir | skipped; the walk continues to the next ancestor within the bound |
| workflows only at depth 5+, at `$HOME` or `/` | no hint (bounded by design) |
| `.tentacle` or `.tentacle/workflows` in cwd is a symlink | refused with the path (`no-links`) |
| the model wrote a file under a subfolder while the session runs at the root (or vice versa) | not loaded; the tool's answer names the absolute folder it reads |
| old `workflows/x.yaml` at the repo root | not read; not-found names `.tentacle/workflows` |

**Tests (red first).**
- `core/test/project-paths.test.ts` (injected `ProjectFs`): `resolveInside` refuses a link at
  `.tentacle`, at `workflows`, at the file (mutation: check the last component only → red);
  `workflowsAbove`: found at depth 1 and 4, NOT at 5 (mutation: unbounded → red), never at
  `$HOME` or `/`, skips a symlinked `.tentacle`, counts only valid `*.yaml` regular files, first
  match wins, never calls a read (the fake has no read method — a call would not type-check).
- `cli/test/project-fs.test.ts`: the adapter on a temp dir.
- `cli/test/workflow-files.test.ts` + `workflow-wiring.test.ts:68,103-105,217-219`: loads
  `<cwd>/.tentacle/workflows/x.yaml` (red today); the old `workflows/` not read; a parent's
  `x.yaml` is NOT loadable from the child (the "cannot change behaviour" property, mutation above).
- 5a's catalogue tests gain `dir` and `elsewhere` (present only on zero rows).
- Hide: no test edited; the existing hide suites green (the no-change proof). Tool-output: the
  existing spill tests green.
- Path-only fixtures (`agent/test/workflow-driver.test.ts:155,888,915,919,953`,
  `daemon/test/workflow-hosted.test.ts:52,130,185`, `schedule-workflow.test.ts:101`,
  `support/log-fixture.ts:104`) move to `.tentacle/workflows/…`.

**Unchanged from v4 and still part of slice 0:** the `.gitignore` exception and its
`git check-ignore` proof, the `AGENTS.md` §6 fact line, and `workflowsGitIgnored(cwd)` for 5a.

### D7 (v4, superseded by v5 — kept for the trail) — ONE project-paths module: the project root, `.tentacle/` and its children (owner review 23/11 ~11:00)

*— claude-opus-5-5 (planner), 2026-11-23 — v4 rewrite; the v3 "one constant" text is replaced,
and the v3 "approvals re-asked" note is dropped (owner: no approval exists yet).*

**Load-bearing assumption:** *every reader of a `.tentacle/` path in product code is one of
exactly three — `workflows` (to be), `hide`, `tool-output` — so one module can own them all.*
Proved by `rg -n '\.tentacle'` and `rg -n '"\.tentacle"|tool-output|"hide"'` over
`packages/*/src`, `apps/*/src`, `apps/mobile/App.tsx`, `scripts` (run here, 23/11):
- **hide** — `cli/src/workspace-mount.ts:252` (`HIDE_FILE_LABEL`), `:287` (the path:
  `` `${source}/.tentacle/hide` ``, `source` = the MOUNT folder), the realpath-inside check
  `:293-296`; caller `cli/src/engine-select.ts:373-385` (`source = real(input.cwd)`, read only
  for a local, non-kubernetes, mounting engine); readers `:421-470` (`nodeHideFs`,
  `nodeHideFileFs`). Comments `:265`, `:278`, `:487`, `:536-557`.
- **tool-output** — `agent/src/agent.ts:2973`, a path RELATIVE to the confined `env`, used only
  when the agent has no `toolOutput` sink (`:727-730`, `:2954-2957`). Every product agent gets a
  sink: `cli/src/wiring.ts:592-593` (`outputs.forProject(config.cwd)`), passed at `:786`
  (sub-agents) and `:1025` (the main `new Agent`, `:1011` — the only `new Agent(` in
  `cli`/`daemon` src). So in product the literal is never reached; it is the library fallback.
- **workflows** — none yet under `.tentacle/`: today `cli/src/workflow-files.ts:41`
  `join(cwd, "workflows")`, returned paths `:47`, `:50`, `:55`.
- Every other hit is NOT a `.tentacle/` path: `.tentacle-source.json`
  (`config/src/packages.ts:18`), temp names (`exec/src/host-execution.ts:665`,
  `cli/src/update.ts:93`, `cli/src/pod-install-dir.ts:90`, `scripts/install.sh:177-178`),
  `relay.tentacle.so`, `so.tentacle.app`, a MIME type, mockup comments; the cache spill dir is
  `<cache>/tentacle/tool-output` (`agent/src/tool-output.ts:123`, `:147`) — not in the project.
- No `--cwd` flag exists (`rg -- '--cwd|"-C"|chdir' packages/cli/src` → only `git -C` in
  `packages-cmd.ts:317-350`); the project is always the process cwd (`config.cwd`).

**Root resolution — decision, with evidence.**
`findProjectRoot(cwd, fs, {home})` →
1. walk up from `cwd` (inclusive) for a `.git` entry (a directory OR a file — a worktree and a
   submodule have a `.git` FILE); the first one found is the root (`how: "git"`);
2. no `.git` → the nearest ancestor (inclusive) holding a `.tentacle` DIRECTORY (not a symlink)
   (`how: "tentacle"`);
3. neither → `cwd` (`how: "cwd"`).
Both walks stop BEFORE `$HOME` and before `/`: neither is ever discovered as a root (only
`cwd === home` makes home the root, by rule 3).
Why, not "nearest `.tentacle/`" first:
- **Worktrees prove it.** This very checkout, `…/tentacle/.tentacle/worktrees/workflows-ui`, has
  a `.git` file and NO `.tentacle/` (`ls -a` at its root, 23/11). "Nearest `.tentacle/`" would
  climb to `…/tentacle/` and read the MAIN checkout's workflows from a branch — wrong files,
  approved against the wrong tree. The git rule gives the worktree's own root, whose
  `.tentacle/workflows/` is that branch's versioned copy (the `.gitignore` exception below).
- In a repo the git root is what a user calls "the project" (versioning, `.gitignore`, the
  owner's `~/tentacle/apps/mobile` example → `~/tentacle`).
- **Non-git dirs** (`~/assistant`): rule 2 lets `~/assistant/notes` find
  `~/assistant/.tentacle/`; rule 3 keeps a lone folder self-contained. The `$HOME` stop prevents
  a dotfiles `~/.git` or a stray `~/.tentacle` from turning every folder into one project.
- A pure walk (lstat only), not `git rev-parse`: no process spawn, works without git installed,
  same answer as git for work trees, worktrees and submodules.
- **Pods/containers:** none of the three readers resolves inside a pod. Workflows: the driver
  never exists on a tunnelled session (`cli/src/wiring.ts:839`). Hide: read on the HOST before the
  container starts, local engines only (`engine-select.ts:377`). Tool-output fallback: not reached
  in product (above). So the root is always a host path; nothing new is mounted or sent to a pod.

**Design.**
- NEW `packages/core/src/project-paths.ts` — pure (core has no `node:fs`: `rg 'from "node:fs'
  packages/core/src` → none; I/O injected as `HideFs`/`HideFileFs` already are):
  - `TENTACLE_DIR = ".tentacle"`; `PROJECT_PATHS = { workflows: ".tentacle/workflows",
    hide: ".tentacle/hide", toolOutput: ".tentacle/tool-output" } as const` — the ONLY place the
    folder and its children are spelled; labels/messages use them.
  - `findProjectRoot(cwd, fs, {home}) → {root, how}` (above).
  - `resolveInside(base, rel, fs, policy)` — the ONE escape/symlink check:
    `policy: "no-links"` (no component from `base` down may be a symlink; what the workflow loader
    does today, `workflow-files.ts:25-26`, `:49`, now over EVERY component incl. `.tentacle`) or
    `"real-inside"` (links allowed if the realpath stays inside `base`; what hide does today,
    `workspace-mount.ts:293-296`). Returns `{path, real}` | `{absent}` | `{problem}`.
  - `ProjectFs` = `{lstat(path) → "dir"|"file"|"link"|"other"|undefined, realpath(path)}`.
- NEW `packages/cli/src/project-fs.ts` — the node adapter (lstat/realpath, ENOENT/ENOTDIR →
  undefined, as `nodeHideFileFs`, `engine-select.ts:446-458`).
- **workflows (0a):** `wiring.ts` computes `const project = findProjectRoot(config.cwd, …)` ONCE
  per agent build and hands `project.root` to `loadWorkflowSource` (`:843`), 5a's
  `listWorkflowSources`, `workflowsGitIgnored`, and `workflowApprovals(configDir, root)` (`:848`;
  the store's `project` key becomes `projectKey(root)`, `workflow-approvals.ts:78`). The loader
  reads `<root>/${PROJECT_PATHS.workflows}` through `resolveInside(root, …, "no-links")`; recorded
  `path` = `.tentacle/workflows/<name>.yaml` (root-relative). Validator messages
  (`workflow-spec.ts:337-349`, `:777`, comments `:2`, `:106`, `:145`, `:172`) and tool texts
  (`tools/src/workflow.ts:53`, `tools/src/schedule.ts:94`) built from `PROJECT_PATHS.workflows`.
  The model writes files relative to ITS cwd, which may be a subfolder: the `workflow` tool's
  `validate`/not-found answer names the ABSOLUTE folder searched (`<root>/.tentacle/workflows`),
  so a file written in the wrong place is reported with where it must go.
- **tool-output (0a):** `agent.ts:2973` builds its path from `PROJECT_PATHS.toolOutput`. Still
  relative, still through `env.writeFile`, never root-resolved (the agent package has no host fs
  and the env is confined).
- **hide (0b):** `engine-select.ts` resolves `root = findProjectRoot(real(input.cwd))`. Read
  (a) `<root>/.tentacle/hide` with `resolveInside(root, …, "real-inside")` — when `root` ≠ the
  mount folder — and (b) `<mount>/.tentacle/hide` exactly as today (`loadHideFile(source, …)`).
  The resolved sets are UNIONED (add-only, as the file's semantics already are,
  `workspace-mount.ts:238-244`). For (a), `resolveHideFile` gets two roots: patterns ANCHORED at
  `root` (they were written for the project), the walk BOUNDED to the mount folder (paths outside
  it are not in the container; walking a whole monorepo from a small subfolder would hit
  `HIDE_SCAN_CAP`, `:249`). A problem in either file refuses the start, as today (`:536`).
  Labels say which file (`.tentacle/hide (project root)` / `.tentacle/hide`).
- `.gitignore:28` `.tentacle/` → `.tentacle/*` + `!.tentacle/workflows/` (git cannot re-include
  a child of an excluded DIRECTORY, hence `/*`). The executor proves every other child stays
  ignored: `git check-ignore -v .tentacle/tmp/x .tentacle/worktrees/x .tentacle/mockups/x
  .tentacle/tool-output/x .tentacle/hide` (all ignored) and `git check-ignore
  .tentacle/workflows/x.yaml` (exit 1), pasted. `bun run lint` re-run (Biome honours the ignore
  file, `biome.json:3`). `AGENTS.md` §6's "`.tentacle/` is gitignored" → "`.tentacle/*` is
  gitignored except `.tentacle/workflows/`" (fact fix bundled with the code, §10).
- **"Not versioned" notice** (unchanged from v3, now at the root): 5a's catalogue gains
  `gitIgnored?: boolean` from `workflowsGitIgnored(root)` — `git check-ignore -q --
  .tentacle/workflows/` (async spawn, argv only, cwd = root, 2 s timeout): exit 0 → `true`,
  exit 1 → `false`, anything else → ABSENT (unknown, never claimed). Only on a catalogue call.

**Every behaviour change (exhaustive).**

| Reader | Before | After | Direction |
|---|---|---|---|
| workflows | `<cwd>/workflows/<n>.yaml`; approvals keyed `projectKey(cwd)` | `<root>/.tentacle/workflows/<n>.yaml`; keyed `projectKey(root)` (same approval from any subfolder); a symlinked `.tentacle` now refused too | the requested move + root resolution |
| hide, `root` = mount folder (the common case: started at the repo root, or no git and no `.tentacle` above) | `<mount>/.tentacle/hide` | identical (one file, same checks) | none |
| hide, started in a subfolder of a project | only `<mount>/.tentacle/hide` | that file AND `<root>/.tentacle/hide` (patterns anchored at root, walk bounded to the mount) | only MORE is hidden, never less; a broken root file now refuses the start (as a broken mount file does) |
| tool-output | `.tentacle/tool-output/…` relative to the env | identical string, from core | none |
| not touched | mount source (still `cwd`, `workspace-mount.ts:682`), session store `projectKey(cwd)`, spill store `forProject(config.cwd)` (`wiring.ts:593`) | — | — |

**Failure modes.**

| Failure | Converges to |
|---|---|
| started in a subfolder | same root, same workflows, same approvals, hide gains the root file |
| a worktree / submodule | its own root (`.git` file), its own versioned workflows |
| non-git `~/assistant/notes` with `~/assistant/.tentacle/` | root `~/assistant` |
| `~/.git` (dotfiles) or `~/.tentacle` | never chosen (the `$HOME` stop); a non-git folder without its own `.tentacle` stays its own root |
| `.tentacle` or `.tentacle/workflows` is a symlink | workflows: refused with the path; hide: allowed only if its realpath stays inside the root (as today) |
| the model wrote a file under a subfolder's `.tentacle/workflows` | not loaded; the tool says the absolute folder it reads |
| an unreadable ancestor during the walk | the walk stops there and takes the next rule (never throws at startup) |
| root file + mount file both hide a path | union, deduped by realpath |

**Tests (red first; fakes, no real fs except the adapter's own test).**
- `core/test/project-paths.test.ts` (injected `ProjectFs`): git dir → its root; `.git` FILE
  (worktree) → its root even when an ancestor has `.tentacle/` (mutation: prefer `.tentacle` →
  red); no git + ancestor `.tentacle/` → that ancestor; neither → cwd; `~/.git` and `~/.tentacle`
  never chosen (mutation: drop the `$HOME` stop → red); `/` never chosen; `resolveInside`
  `no-links` refuses a link at ANY component (`.tentacle`, `workflows`, the file — mutation: check
  the last only → red), `real-inside` accepts an inside link and refuses an escaping one.
- `cli/test/project-fs.test.ts`: the adapter on a temp dir (ENOENT/ENOTDIR → undefined, a link
  reported as `link`).
- `cli/test/workflow-files.test.ts` + `workflow-wiring.test.ts:68,103-105,217-219`: a run started
  from `<repo>/sub` loads `<repo>/.tentacle/workflows/x.yaml` (red today: it reads
  `<repo>/sub/workflows`); the recorded `path` is root-relative; the old `workflows/` is not read.
  `workflow-approvals.test.ts`: an approval from `<repo>` is found from `<repo>/sub`.
- 0b `cli/test/workspace-mount.test.ts` / `engine-select*.test.ts` pattern: root == mount →
  byte-identical hide set to today (pin with a fixture recorded BEFORE the change); subfolder
  mount → root-file paths inside the mount are hidden, those outside it are not walked (scan
  counter), the mount-folder file still applies (mutation: read only the root file → red — the
  "never less hidden" property); a root file escaping by link → refused.
- The fixtures that only feed a path (`agent/test/workflow-driver.test.ts:155,888,915,919,953`,
  `daemon/test/workflow-hosted.test.ts:52,130,185`, `schedule-workflow.test.ts:101`,
  `support/log-fixture.ts:104`) move to `.tentacle/workflows/…`; they are inputs, not proofs.

### D7 (v3, superseded — kept for the trail)

*— claude-opus-5-5 (planner), 2026-11-23*

- the only path construction: `cli/src/workflow-files.ts:41` (`join(cwd, "workflows")`) and the
  recorded `path` it returns, `:47`, `:50`, `:55`;
- texts/comments: `core/src/workflow-spec.ts:2`, `:106`, `:145`, `:172`, `:337`, `:345`,
  `:349`, `:777`; `agent/src/workflow-driver.ts:86`, `:89`; `tools/src/workflow.ts:53`;
  `tools/src/schedule.ts:94`; `protocol/src/session.ts:856`;
- durable: the approval store keys `{project, path, hash}` with `path` = the loader's
  `workflows/<name>.yaml` (`workflow-driver.ts:86`, `:780-782`); the log's `workflow_start.path`
  (display only, `session-log.ts:362`); a schedule pins name + hash, not path
  (`rg path core/src/schedule.ts` → no hit). No README/ARCHITECTURE/AGENTS mention.
- tests that build or assert the path: `cli/test/workflow-wiring.test.ts:68,103-105,217-219`,
  `cli/test/workflow-approvals.test.ts:18-44`, `agent/test/workflow-driver.test.ts:155,888,915,919,953`,
  `daemon/test/{workflow-hosted.test.ts:52,130,185, schedule-workflow.test.ts:101,
  support/log-fixture.ts:104}`.

**Design.**
- `core/src/workflow-spec.ts`: `export const WORKFLOWS_DIR = ".tentacle/workflows"` — the ONE
  name; every message above is built from it (`should stay inside ${WORKFLOWS_DIR}/`, `no file
  "x" under ${WORKFLOWS_DIR}/`), the comments say it.
- `cli/src/workflow-files.ts`: root = `join(cwd, ...WORKFLOWS_DIR.split("/"))`; the symlink
  guard now refuses a symlinked `.tentacle` AS WELL AS a symlinked `workflows`
  (`:49` checked only the last component; a linked `.tentacle` could point the reader outside the
  repo); recorded `path` = `${WORKFLOWS_DIR}/<name>.yaml`; same for 5a's `listWorkflowSources`.
- Tool descriptions (`workflow`, `schedule_create`) name `.tentacle/workflows/<name>.yaml`, so
  the model writes the file there.
- `.gitignore:28` `.tentacle/` → `.tentacle/*` + `!.tentacle/workflows/` (git cannot re-include
  a path whose parent DIRECTORY is excluded, so the `/*` form is required). Every other
  `.tentacle/` child (tmp, worktrees, mockups, tool-output) stays ignored — the executor proves it
  with `git check-ignore -v .tentacle/tmp/x .tentacle/worktrees/x .tentacle/mockups/x`
  (all ignored) and `git check-ignore .tentacle/workflows/x.yaml` (exit 1, not ignored), pasted.
  Biome reads the ignore file (`biome.json:3` `useIgnoreFile`): it does not lint YAML/Markdown,
  but the executor runs `bun run lint` to prove no new file kind is picked up.
- `AGENTS.md` §6 says "`.tentacle/` is gitignored" (repro dir rule): one-line fact fix
  ("`.tentacle/*` is gitignored except `.tentacle/workflows/`") — bundled with this code (§10).
- **"Not versioned" notice (owner: tentacle never edits a user's `.gitignore`).** 5a's catalogue
  result gains `gitIgnored?: boolean`: `cli/src/workflow-files.ts` `workflowsGitIgnored(cwd)` runs
  `git check-ignore -q -- .tentacle/workflows/` (async spawn, argv only, cwd = the repo, 2 s
  timeout) → exit 0 `true`, exit 1 `false`, anything else (no git, not a repo, timeout) ABSENT
  ("unknown", never claimed). Shown by the TUI (D8) and the phone's start screen as
  "`.tentacle/workflows/` is ignored by git — approvals work, but the files are not versioned".
  It is computed only with a catalogue call, never on a hot path.

**Failure modes.** Old `workflows/x.yaml` left in a repo → not found; the error says
`no workflow x: .tentacle/workflows/x.yaml does not exist` (the user sees where it must be);
symlinked `.tentacle` → refused like a symlinked `workflows`; old logs
keep their old `path` (display only).

**Tests (red first).** `cli/test/workflow-files.test.ts`: a file under `.tentacle/workflows/`
loads with `path` `.tentacle/workflows/x.yaml`; one under the old `workflows/` is NOT found
(mutation: keep the old join → red); symlinked `.tentacle` refused; `workflowsGitIgnored` on a
temp repo with and without an ignore rule, and outside a repo → absent (in `.tentacle/tmp`-free
temp dirs the test env guard already provides, `scripts/test-env-guard.ts`). `core` message tests
assert `WORKFLOWS_DIR` in the text; the listed fixtures move to the new path (they are inputs,
not assertions of the move, except `workflow-wiring.test.ts:68`, which becomes the red one).

### D8 — TUI: the project's workflows, automatically (owner 23/11 ~10:30)

*— claude-opus-5-5 (planner), 2026-11-23*

**Load-bearing assumption:** *the live area already has an always-visible, row-budgeted strip
for "things armed in this session" that a new line can join without moving the input.* Proved:
the dock list is shown iff something is running OR armed (`tui/src/background-list.ts:166-173`
`listVisible`), its rows are reserved in `activeRows` so the input never moves
(`AppView.tsx:188-193`); schedules join it as one glyph kind (`background-list.ts:70`,
`:480-490`) from a pure view module (`schedule-view.ts:1-11`). The data comes from 5a's
`workflowCatalogue()` (D6) — so 2b runs after 5a.

**Design (decided; alternative noted).**
- **ONE summary line, not one dock row per workflow.** A workflow file is not a running or armed
  thing: making each one a focusable dock row would grow the dock with every file and add a new
  focus kind to the `keys/` contract. Instead a single non-focusable line sits as the dock's top
  row (or alone when the dock is empty), painted from pure `catalogueLine(cat, width)` in
  `workflow-view.ts`:
  `◇ workflows  task v3 approved · nightly v1 needs approval · broken invalid · +3   /workflow`
  — state always as a WORD (colour-blind rule); width tiers: words → glyph + word for the first
  only (`task v3 ✓ approved · nightly v1 ? · …`) → `◇ 6 workflows · 1 needs approval · /workflow`.
  Order: needs-approval first, then invalid, then approved, by name inside each (what needs the
  user surfaces even at narrow widths). Many workflows: as many as fit, then `+k`; the full list
  is the `/workflow` panel. Ignored by git (D7) → suffix `· not versioned` on the widest tier only;
  the full sentence is in the panel.
- **When it shows / hides.** Shown when the catalogue has ≥ 1 row AND no run is active. Hidden
  when: a run is active (the rail, D3, takes its place — the owner's "only while a run is active"
  rule is for the rail; the line is the at-rest view); the catalogue is empty (**empty state =
  no line**: an empty project must not carry a permanent hint) — **v5 exception:** empty AND the
  catalogue carries `elsewhere` → ONE dim line `◇ no workflows here — ~/tentacle/.tentacle/workflows
  has 3 (start tentacle in ~/tentacle)` (path `~`-shortened, cut in cells; pure
  `elsewhereLine(cat, width, home)`), never actionable: Enter/`/workflow` cannot start anything from
  it; the session cannot run workflows
  (`unavailable`, `unsupported`, a pod — `onWorkflows`/`workflowCatalogue` absent); the permission
  dialog or a panel owns the live area (as the dock today). Counted in the live-area row budget
  like the dock, so it appearing/vanishing never moves the input row.
- **When it refreshes (no filesystem watcher, no polling):** after the session opens/attaches;
  at every `turn_end` (the model may have written or edited a file); when a run ends (`workflows`
  frame with a new `endedAt`); after a `workflow_approve` ask is resolved (the approval state
  changed); on `/workflow`. A user editing a file in an external editor while idle sees it at the
  next of these — stated in the panel footer ("updated at turn end · /workflow to refresh").
  Requests are coalesced (one in flight per session; a trigger during it schedules one more).
- **`/workflow` to act** (slice 2's panel gains a "Workflows" section above the runs): every
  catalogue row with version, approval word, step count, the invalid ones with their errors and
  YAML paths, and the not-versioned sentence. Enter on a valid workflow → with no required input it
  starts at once (`start{hash}`, 5a; a `changed` refusal refreshes and says so); with required
  inputs it pre-fills the input line with `/workflow run <name> <req1>= <req2>=` and closes the
  panel (pure `startCommandFor(def)`); `/workflow run <name> k=v…` also sends the catalogue's hash
  when it holds one for that name.
- Files: `workflow-view.ts` (pure: `catalogueLine`, `catalogueOrder`, `catalogueSection`,
  `startCommandFor`, `refreshTriggers` reducer), `useSessionLink.ts` (fetch + coalesce),
  `AppView.tsx` (mount + budget), a `WorkflowsLine.tsx` painter, `panels/workflow.ts`,
  `commands/workflow.ts`.

**Failure modes.** Catalogue call fails / link down → keep the last line (stale is better than
flicker) and refresh on the next trigger; `unsupported` → no line, `/workflow` says "update
tentacle"; 200-cell names → cut in cells with `…` (pod-free: the files are the host's, but names
are still `oneLine`d); a workflow deleted while listed → gone at the next refresh; Enter on a
row whose file changed → `changed` refusal, refresh, notice; terminal shorter than the live-area
budget → the line is the first thing dropped (before dock rows), as a decision in the pure budget.

**Tests (red first).** `tui/test/workflow-view.test.ts`: tier at 120/80/50 cols; ordering puts
needs-approval first; `+k` arithmetic exact at the boundary; every state carries a word; empty →
`null`; unavailable → `null`; `startCommandFor` with/without required inputs.
`tui/test/workflow-frames.test.tsx` (ink-testing-library): the line appears after open with a
fake catalogue; the input row's y is identical with and without it (the exact property); it is
replaced by the rail when a `workflows` frame starts a run and comes back at its end; a
`turn_end` triggers exactly one catalogue request (mutation: refresh on every frame → red on the
count). Validation frames (pasted in Execution): (T6) line at 120 cols with 3 workflows, (T7)
at 50 cols with 9, (T8) `/workflow` Workflows section with an invalid file's errors and the
not-versioned sentence.

### Notes / debt (deliberate)

- **(v5) Two symlink checks remain, on purpose.** The module's `resolveInside` serves workflow
  files; `.tentacle/hide` keeps its own FIFO-safe fd reader (`workspace-mount.ts:292-296`,
  `engine-select.ts:458-470`). Folding it into the module would touch the container-secrets path
  (load-bearing) with no behaviour gain; if the owner wants literally one checker, that is its own
  small load-bearing task with fresh-context review. *Recommend: leave it.*
- **The hash ask's `detail` is capped at 2000 chars** (`workflow-driver.ts:775`), so a long
  workflow's approval sheet can cut `run` commands — in tension with "verbatim `run` commands"
  (Context). D6 mitigates on the phone (full list before Start); the TUI and a model-started run
  still see the capped detail. Not fixed here (it is the agent loop's ask, load-bearing); proposed
  as its own `fix/` task: raise the cap or end the detail with an explicit "… N more steps, see
  `/workflow`" line.

- No global key opens the TUI panel (the `keys/` contract tests make a new binding a cross-cutting
  change); `/workflow` and the palette do. A key can follow if asked.
- After a `serve` restart, ended runs from before it are not in the driver's rows (unchanged
  behaviour of agent-workflows); out of scope.
- `needsUser` counts `waiting · slot` as "needs you" (`hosted-session.ts:2507-2508`) — pre-existing;
  noted, not changed here.

## Execution

### Slice 0 — `core/src/project-paths.ts` + node adapter; workflows → `.tentacle/workflows` (D7 v5)

*— claude-sonnet-4-5, 2026-11-23*

**Load-bearing check re-run FIRST (PARTIAL rule): PASSES, unchanged.** `rg`/`grep` inventory
(`.tentacle/tmp/workflows-ui/lb-inventory.sh`, paste-in below) returns exactly the plan's three
readers and nothing else:

| Expectation | Result |
|---|---|
| the only workflow path construction is `cli/src/workflow-files.ts:41` | **yes** — that line only |
| the only `loadWorkflowSource` caller is `wiring.ts:843` (`config.cwd`) | **yes** |
| `.tentacle/` product readers are hide + tool-output only | **yes** — `workspace-mount.ts:252,287`, `agent.ts:2973` (+ their comments) |
| `@tentacle/core` has no `node:fs` (the module must stay pure) | **yes** — no hit |
| no `PROJECT_PATHS`/`project-paths` anywhere yet | **yes** — no hit |

```
--- A. workflow path construction (expect ONLY workflow-files.ts:41) ---
packages/cli/src/workflow-files.ts:41:  const root = join(cwd, "workflows");
--- B. loadWorkflowSource callers (expect ONLY wiring.ts:843) ---
packages/cli/src/wiring.ts:843:        load: async (name) => loadWorkflowSource(config.cwd, name),
--- E. core has no node:fs (the module must stay pure) ---
(none)
--- F. PROJECT_PATHS does not exist yet (expect nothing) ---
(none)
```
No new reader appeared, so D7's inventory still holds and slice 0 proceeded.

**As built, in dependency order.**

1. **`packages/core/src/project-paths.ts` (NEW, pure).** `TENTACLE_DIR`, `PROJECT_PATHS`
   (`workflows` = `.tentacle/workflows`, `hide`, `toolOutput`) — the only place the names are
   spelled; `WORKFLOW_NAME_RE` (the loader's `NAME`, moved here so the folder and the name rule
   have one home); `ProjectFs` (`lstat`/`list`, both `undefined` for "nothing there");
   `resolveInside(base, rel, fs)` (no-links: refuses a link at **any** component, plus
   absolute/`..`/empty escapes, and returns `absent` vs `problem`); `workflowsAbove(cwd, fs,
   {home})` (the display-only hint: 4 ancestors, never `$HOME`/`/`, real dirs only, valid
   `<stem>.yaml` regular files only, count capped at 200, ≤ 8 `lstat` + 1 listing per ancestor).
   Exported from `core/src/index.ts`.
2. **`packages/cli/src/project-fs.ts` (NEW).** `nodeProjectFs()`: `lstatSync`/`readdirSync`,
   ENOENT/ENOTDIR → `undefined`, a symlink reported as `link` (never followed) — same shape as
   `nodeHideFileFs` (`engine-select.ts`).
3. **workflows moved.** `workflow-files.ts` now resolves `${PROJECT_PATHS.workflows}/<name>.yaml`
   through `resolveInside` and records `path` = `.tentacle/workflows/<name>.yaml`; the missing-file
   error names the **absolute** folder (`no workflow x: /…/proj/.tentacle/workflows/x.yaml does not
   exist`), and a symlinked `.tentacle`/`workflows`/file is refused by path. Prompts are still
   keyed relative to the folder, so the validator, hash and approval key are untouched
   (`projectKey(cwd)` unchanged, per D7 v5). `workflowsGitIgnored(cwd)` added here too (it is
   slice 0's "unchanged from v4 and still part of slice 0" item; its consumer is 5a).
4. **Messages/texts from the module.** `workflow-spec.ts` (header, `promptPath`/`readPrompt`
   docs, `promptPathProblem`'s two sentences, the "no file … under" error) and
   `tools/src/{workflow,schedule}.ts` (the `workflow` DESCRIPTION, `schedule_create`'s `workflow`
   field) build `${PROJECT_PATHS.workflows}` instead of a hand-written `workflows/`.
5. **hide: names only** — `HIDE_FILE_LABEL = PROJECT_PATHS.hide`, and `loadHideFile` builds its
   path from that label. The reader, its realpath-inside rule and the fd-level
   `O_NOFOLLOW|O_NONBLOCK` re-check are untouched, exactly as the Notes/debt entry recommends.
6. **tool-output: name only** — `agent.ts` builds `${PROJECT_PATHS.toolOutput}/…`; still relative,
   still through `env.writeFile`, never root-resolved.
7. **`.gitignore`**: `.tentacle/` → `.tentacle/*` + `!.tentacle/workflows/`, with a comment saying
   why (`/*` because git cannot re-include a child of an excluded DIRECTORY).
8. **Docs**: `AGENTS.md` §6's repro fact line now says `.tentacle/*` is gitignored **except
   `.tentacle/workflows/`**; `docs/feat/agent-workflows.md` gained a dated note that D1's
   `workflows/` is now `.tentacle/workflows/` and nothing else about that task changed.

**Every path-only fixture moved** (inputs, not proofs — the plan's list, exactly):
`agent/test/workflow-driver.test.ts` (`:155` + the four approval keys), 
`daemon/test/workflow-hosted.test.ts:52,130,185`, `daemon/test/workflow-load.test.ts:151`,
`daemon/test/schedule-workflow.test.ts:101`, `daemon/test/support/log-fixture.ts:104`, and
`cli/test/workflow-wiring.test.ts` (its two real fixture writes + the not-found assertion, which
now pins the absolute folder). `cli/test/workflow-approvals.test.ts` keeps its literal
`workflows/task.yaml` **on purpose**: the store keys on whatever `path` it is handed, and that
suite is the "path is opaque to the store" contract — editing it would have weakened the test.

**Red before green (each shown failing on the pre-change code).**
- `core/test/project-paths.test.ts` (NEW, 17 tests): written against the module — the red step was
  the export/caller wiring, not an assertion, so the *property* proof is the mutation column below
  (§9's non-vacuity rule is what carries here).
- `cli/test/workflow-files.test.ts` (NEW, 9 tests) — **RED on today's loader, 7 of 8 failing** by
  assertion, not compile error: it read `<cwd>/workflows`, so `.tentacle/workflows` loads failed and
  every symlink case fell through to `no workflow task: workflows/task.yaml does not exist`.
- `core/test/workflow-spec.test.ts` — the two message assertions FAILED after the text moved
  (`.tentacle/workflows/` vs `workflows/`), which is the behaviour change itself surfacing; updated
  with the code, as the plan's "messages" item requires.
- `cli/test/project-fs.test.ts`, `cli/test/workflow-gitignored.test.ts` — new readers; their
  non-vacuity is the mutation/repo-shape evidence (`git init` in a temp dir, both `.gitignore`
  shapes), no old code to fail on.

**Mutation checks (all applied, all reverted; tree clean afterwards).**

| Mutation | Killed |
|---|---|
| `resolveInside` checks only the LAST component for a link (the plan's named mutation) | 3 core tests (link at `.tentacle`, at `workflows`, …) **and** 2 loader tests (symlinked `.tentacle`, symlinked `workflows`) — the property propagates end to end |
| `workflowsAbove`'s walk unbounded (drop `WORKFLOWS_ABOVE_DEPTH`) | "NOT found at depth 5: the walk is bounded" |
| feed the hint's `dir` to the loader (the plan's named mutation, "a parent's `x.yaml` becomes loadable from the child") | "a parent's workflow is NOT loadable from the child (the hint never feeds a run)" — nothing else failed, so the hint is provably confined to display |

**Gate.** This executor did **not** run the full suite / repo-wide typecheck / lint (per the brief
the orchestrator's script does). What was run, foreground and narrow: every affected suite —
`core/test` (65 files, 929 tests), the four new/extended cli suites, `workspace-mount`,
`engine-select`, `tool-output-wiring` + agent `tool-output`, the four workflow driver/daemon suites,
all of `packages/tools/test`, `daemon/test/{mapping,push-hook}`, `core/workflow-ledger`,
`cli/workflow-approvals`, `scripts/test/changelog-guard` — **0 fail**. `bunx biome check` on all 17
changed/new source+test files: **clean** (5 auto-fixed, then no fixes applied). `tsc -p` per
package: `core`, `agent`, `tools`, `daemon` clean; `cli` reports 119 pre-existing errors in
untouched files (`attach-run.ts`, `connect.ts`, …) — **zero** in the files this slice touched.

**Drift from Implementation — two, both recorded here rather than forced:**
1. **`protocol/src/session.ts:856`** — the plan lists a comment edit; done (`.tentacle/workflows/<name>.yaml`).
   **No schema change**, so `packages/protocol/schema/protocol.json` is NOT regenerated and no
   `protocol.d/` note is due: slice 0 adds no wire shape. `json-schema.test.ts` therefore stays green
   as-is (drift: the plan's slice table lists the schema file only for slices 1a and 5a).
2. **The changelog fragment is `changed`, not `added`.** §10 allows ONE fragment per
   slug+category, and slice 2's row already claims `changelog.d/workflows-ui.added.md`. Writing
   `added` here would have created that exact filename collision at merge, so slice 0's fragment is
   `changelog.d/workflows-ui.changed.md` (a move, which is what this is) and slice 2 keeps `added`.

**Not done in this slice (deliberately, and why):** nothing from 1a/1b/5a/2/2b/3/4/5b.
`PROJECT_PATHS` has no root function (cwd is the root, owner 11:25). The `/workflow` header,
the TUI workflows row and the phone start screen name the folder in slices 2/2b/5b — they read
`PROJECT_PATHS`/the catalogue's `dir`. `workflowsAbove` has no production caller yet: its consumer
is 5a's catalogue `elsewhere` field, and slice 0 ships it with its bound, its `$HOME`/`/` rule and
its "cannot change behaviour" property already pinned by tests.

### Slice 1a — `session/workflow_step` (D1)

*— claude-sonnet-4-5, 2026-11-23*

**Load-bearing check re-run FIRST (PARTIAL rule): PASSES, unchanged.**
`.tentacle/tmp/workflows-ui/lb.ts` on this branch returns the same gaps slice 0 recorded —
the missing client seams are all still `false` (`RemoteClient.workflowStep`,
`RemoteSession.onWorkflows`, …), `Method.WorkflowStep` is absent from `Method`, `WorkflowStepRow`
carries no `prompt`/`report`, `UPDATE_CLASS.workflows === "display"`. What the plan's
load-bearing assumption needs — **the daemon already has the detail** — holds: the
`workflow_step` log entry is written whole (`workflow-driver.ts:835-848` →
`daemon/src/session-log.ts:230-232`) with `prompt`, `report`, `state`, `verdict`, `reason`,
`tokens`, `durationMs`, and nothing exposed it. So 1a proceeded.

**Red first (§9).** `packages/daemon/test/workflow-step-detail.test.ts` was written before the
daemon half and run against it stubbed (`workflowStep` → `{}`, the log reader removed):
**5 pass / 4 fail**, and the four failures were at the ASSERTIONS (`toMatchObject` on
`detail` receiving `undefined`), not at an import or compile error. The five passers are the
"not available" cases, which a stub satisfies by construction — they are pinned by mutation
instead (below).

**As built, in dependency order.**

1. `packages/protocol/src/session-log.ts` — `WorkflowStepParamsSchema` /
   `WorkflowStepDetailSchema` / `WorkflowStepResultSchema` (+ their types). **DRIFT 1** (below).
2. `packages/protocol/src/methods.ts` — `Method.WorkflowStep = "session/workflow_step"` and its
   `RequestSchemas` row.
3. `packages/protocol/test/workflow-wire.test.ts` — the method is registered, the params refuse a
   bad run/step id and a negative/fractional `attempt`/`round`, an empty result is valid, a detail
   round-trips and `reason` is bounded at the LOG's 2 KiB (not a second number).
4. `packages/protocol/test/json-schema.test.ts` — three fixtures added (the table asserts every
   method has one; without them the drift test fails).
5. `packages/agent/src/workflow-driver.ts` — `Run.liveStep` (the execution in flight: its
   `prompt`, attempt, round, and the row's live text, updated by `setStep`, cleared by `finish`)
   and the public `liveStep(runId?)` accessor.
6. `packages/daemon/src/session-log.ts` — `workflowStepDetail(request)`: a newest-first scan of
   the RETAINED slots (current segment + previous one), so what compaction dropped is honestly
   `undefined`. Synchronous, no await, no lock (§7).
7. `packages/daemon/src/hosted-session.ts` — `workflowStep(params)`: the durable entry wins
   (`live:false`, prompt + report); with none, the driver's in-flight record answers for the same
   run AND step AND attempt/round (`live:true`, prompt, no report); otherwise `{}`.
8. `packages/daemon/src/connection.ts` — `case Method.WorkflowStep`, through `lookup` (it reads a
   session this connection opened or watches).
9. `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`).
10. `changelog.d/workflows-ui.added.md`.

**Drift from Implementation — one, recorded rather than forced:**

1. **The two schemas live in `session-log.ts`, not `session.ts`.** The plan says `session.ts`. It
   cannot: `WorkflowWordSchema` and the three caps (`WORKFLOW_REASON_MAX_CHARS`,
   `WORKFLOW_PROMPT_MAX_CHARS`, `SUBAGENT_REPORT_MAX_CHARS`) live in `session-log.ts`, which
   already imports `session.ts` — a back-import closes a cycle that breaks module init
   (`ReferenceError: Cannot access 'TurnIdSchema' before initialization`, reproduced in
   `.tentacle/tmp/workflows-ui/cycle.ts`). The alternative was duplicating the bounds and the word
   schema, i.e. a second source of truth for the log's own caps. Placing them beside the entry they
   read keeps ONE source and adds no cycle. `methods.ts` therefore imports them from
   `./session-log.ts`, next to `LogParamsSchema`. Everything else the plan lists landed where it
   says.

**No `protocol.d/` note**, and `PROTOCOL_VERSION` untouched: a NEW method with an optional result
field is additive (§7 "fields and methods are free"); an older daemon answers `MethodNotFound`,
which 1b maps to `{unsupported:true}`. A display-class method needs no bump.

**Mutation checks (each reverted; all on the finished code, test file unchanged):**

| Mutation | Result |
|---|---|
| the scan ignores `attempt`/`round` | RED — "an attempt the step never ran is `{}`" |
| live record answered even when the entry exists | RED — 4 tests (the report/live split) |
| scan oldest-first instead of newest-first | **GREEN first time (vacuous)** → added the `retry: 1` case (two executions of one step), then RED |
| driver records no `liveStep` | RED — "live:true with the prompt and no report" |
| `read`'s window start (wrong site: `read`, not the reader) | GREEN — no-op, discarded as an invalid mutation |
| never drop an old segment (retention) | RED — "an entry two segments back is `{}`" |
| no `case Method.WorkflowStep` in the dispatch | RED — "the method is dispatched" |

The third row is the §9 non-vacuity catch: the first version of the "newest" test passed with the
scan reversed, because every step had exactly one entry. The retry case fixed that.

**Tests.** `packages/daemon/test/workflow-step-detail.test.ts` (11 tests): the ended execution
(prompt + report, measured fields), unknown step/run, a run that never started, the in-flight
answer and its replacement by the entry, a live record not leaking to another run/step, the newest
vs the asked-for execution (incl. the retry), an attempt that never ran, the retention window
(two `clear()` replacements), a session with no driver, and one end-to-end `RpcPeer` call through
`Connection`. Plus 4 in `protocol/test/workflow-wire.test.ts` and 3 fixtures in
`protocol/test/json-schema.test.ts`.

**Gate (my own narrow runs; the orchestrator's full gate follows).** `bun test` on
`packages/protocol/test`, `packages/agent/test`, `packages/daemon/test`, `packages/client/test`,
`packages/cli/test`, `packages/tools/test`, `packages/core/test`, `scripts/test/changelog*`:
**0 fail** (3 skips: the opt-in baseline). Root `tsc --noEmit -p tsconfig.json`: **0 errors**.
`bunx biome check` on every file this slice touched (plus all of `packages/{protocol,daemon,agent}/
{src,test}`): clean.

**Not done in this slice (deliberately, and why):** nothing from 1b/5a/2/2b/3/4/5b — the client
seam (`RemoteClient.workflowStep`, `{unsupported:true}` on `MethodNotFound`), the TUI panel, the
phone screens. `session/workflow_step` is answered by the daemon and reachable over RPC; no client
calls it yet.

### Slice 1b — client data path (D2)

*— claude-sonnet-4-5, 2026-11-23*

**Load-bearing check re-run FIRST (PARTIAL rule): PASSES.** `.tentacle/tmp/workflows-ui/lb.ts`
prints `"WorkflowStep" in Method: true session/workflow_step`, and the daemon answers it:
`protocol/src/methods.ts:184` + its `RequestSchemas` row `:332`, dispatched at
`daemon/src/connection.ts:459` into `hosted-session.workflowStep` (1a's work). So 1b proceeded.

**Red first (§9).** `client/test/workflows-client.test.ts` was written before the client half and
run against it: **7 pass / 10 fail**, and every one of the ten was at an ASSERTION, not an
import/compile error — `session.workflow is not a function`, `session.workflowStep is not a
function`, `client.workflowList is not a function`, and two `until: timed out … waiting for
session.workflows !== undefined`. The seven passers are the pure-module cases (`boundWorkflows`,
`askForStep`), which no stub can fail by construction — their non-vacuity is the mutation column
below, not the red run.

**As built, in dependency order.**

1. `packages/client/src/workflows.ts` (**NEW**, pure — the module's own header states the two
   rules): `MAX_WORKFLOW_RUNS = 8`, the three per-field caps, `sanitizeWorkflowText`, `boundWorkflows`
   / `workflowsFromSnapshot`, `askForStep`, `WORKFLOW_OLD_DAEMON` / `WORKFLOW_UNTRUSTED_DAEMON`,
   and the exported `WorkflowAction` (the user's ask: the wire params MINUS `sessionId`/`turnId`,
   which the session owns — a caller cannot forget the mint).
2. `packages/client/src/remote-client.ts`: `SessionWorkflowsNotice`; `Snap.workflows` / `SessionEntry.workflows`;
   `workflowListeners` + `onSessionWorkflows` / `workflowsOf`; private `workflowsChanged`; the live
   branch beside `schedules` and the snapshot fold beside it, **both** gated on `daemonWakes`;
   `workflow(sessionId, params)` (`"once"`, `MethodNotFound` → `{ok:false, reason: WORKFLOW_OLD_DAEMON}`),
   `workflowList()` (daemon-wide, `{unsupported:true}` on `MethodNotFound`), `workflowStep(sessionId, params)`
   (same mapping).
3. `packages/client/src/remote-session.ts`: `get workflows()`, `onWorkflows` (the current list given
   at once, like `onSubagents`), `workflow(WorkflowAction)` (refuses locally with no id or with the
   bit off, mints through the new `mintTurn()` for the three work-BEGINNING actions, none for `stop`),
   `workflowStep(runId, stepId, attempt?)`.
4. `packages/client/src/index.ts` — exports the new module. `packages/client/src/mapping.ts` — no
   code change: its comment now names `onSessionWorkflows` (the plan's "unchanged, its comment names
   the listener").
5. `packages/cli/src/local-runtime.ts`: the three `SessionController` members + the three forwards in
   `persistingController`.
6. `packages/tui/src/app-types.ts`: the same three, optional, plus the structurally-mirrored
   `WorkflowActionView` (the TUI does not depend on `@tentacle/client`, so a wire type cannot be
   imported — the `ScheduleDockRow` precedent).
7. Tests: `client/test/workflows-client.test.ts` (NEW, 18), one new forward test in
   `cli/test/local-runtime.test.ts`, and the three entries the guard demands in
   `cli/test/subagent-panel-controller.test.ts`.
8. `changelog.d/workflows-ui.added.md` — EXTENDED, not duplicated (**drift 2**, below).

**Drift from Implementation — three, recorded rather than forced:**

1. **The trust gate on `workflow()`, not only on the feed.** D2 says "`workflow()` refused locally
   with no id / bit off"; the plan also says `stop` needs no `turnId`. The two combined left `stop`
   ungated in v5's wording, so this slice gates EVERY action on `daemonWakes`: a pod client has no
   run of the laptop's to stop either, and the plan's own failure row ("pod daemon … `workflow()`
   refused locally, nothing sent") states the behaviour without carving out `stop`. The
   `!daemonWakes` branch is one `if`, before the `stop`/turnId split, so there is one gate and no
   second path to keep in sync.
2. **The changelog fragment is EXTENDED, not added.** §10 allows one fragment per slug+category, and
   on this branch `changelog.d/workflows-ui.added.md` already exists (1a's) while slice 2's row
   claims it too. 1b is what makes 1a's bullet literally true — "readable from any client" — so the
   one existing `added` bullet gained the client seam sentence. A new `changed` fragment would have
   claimed a user-visible behaviour change this slice does not have: it adds no surface (no panel, no
   rail, no command), it wires the data path those slices will paint.
3. **`MAX_WORKFLOW_STEPS` is NOT a new constant; the cap is the schema's own 64.** The plan's D2 lists
   only `MAX_WORKFLOW_RUNS`, and the wire already refuses more than 64 steps
   (`WorkflowRowSchema.steps`, `session.ts:833`). A named constant would have been a second source of
   that number in another package; `boundWorkflows` slices at 64 and its comment cites the schema.

**Mutation checks (each applied, run, reverted; tree clean afterwards; test file unchanged except
where stated):**

| Mutation | Result |
|---|---|
| `mintTurn` returns the id without `mint` (the plan's named mutation, "client forgets `mint`") | **RED** — 2 tests (start; resume/rerun_step) |
| the live `workflows` branch ignores `daemonWakes` | **RED** — "with the bit OFF (a pod…) the frame is DROPPED" |
| the snapshot fold ignores `daemonWakes` | **RED** — "a resync snapshot repaints the list" |
| `boundWorkflows` keeps the OLDEST 8 (`slice(0, 8)`) | **RED** — "at most MAX_WORKFLOW_RUNS, the daemon's order kept" |
| `askForStep` matches by PREFIX (`startsWith(runId)`) | **RED** — 2 tests (`wf-1` pairing, and the `wf-11` trap) |
| `workflowStep`'s `MethodNotFound` rethrown instead of `{unsupported:true}` | **RED** — "workflowStep … or says the daemon is older" |
| a refusal THROWN instead of returned as a value | **RED** — "a refusal is a VALUE with its reason" |
| `boundStep` leaves `where` unsanitized | **GREEN first time (vacuous)** → the fixture's `where` carried no escapes; added one (`docker:box\u001b[2J\u0007`) and extended the label loop to `where`/`model`/`live`, then **RED** |
| `boundRun` drops the 64-step slice | **RED** — "a step list is sliced at the schema's 64" |

The eighth row is the §9 non-vacuity catch of this slice: the sanitizer's test named every field but
fed only `name`/`state`/`reason`/`model`/`live` hostile text, so `where` could have shipped
unsanitized with a green suite.

**Tests.** `client/test/workflows-client.test.ts` (18): the bounding (count, order, the 64-step
slice, every label escape-free, unknown state kept as sent, snapshot-vs-absent); `askForStep`'s three
pairings (a step, the run's own approval, the `wf-11` trap, a main-agent ask); the trust bit on the
live frame AND on the snapshot AND on `workflow()`; the mint (non-`wake-`, `ownsTurn` true, resume /
rerun_step minted, `stop` not); a refusal as a value; `MethodNotFound` on both reads; and `onWorkflows`
giving a late subscriber the state at once. Plus 1 in `cli/test/local-runtime.test.ts` (the three
forwards, and an absent `attempt` staying absent — never an invented `0`, which would ask for the
first execution) and the 3 deliberate entries in `subagent-panel-controller.test.ts`'s guard list.

**Gate (my own narrow runs; the orchestrator's full gate follows).** `bun test` on
`packages/client/test` (897 tests), `packages/tui/test` (3005), `packages/cli/test` (2760, 2 opt-in
skips), `packages/protocol/test/json-schema.test.ts` and `scripts/test/changelog*`: **0 fail**.
`tsc --noEmit` on the root project: **0 errors in the files this slice touched** (the repo's
pre-existing errors elsewhere are the orchestrator's baseline). `bunx biome check` on all 10
changed/new files: clean (4 auto-formatted, then no fixes applied). `bun run schema:export` run:
`packages/protocol/schema/protocol.json` came back **unchanged** — this slice adds no wire shape, so
no `protocol.d/` note and no `PROTOCOL_VERSION` edit (AGENTS §7: fields and methods are free; the
method 1b consumes already existed).

**Not done in this slice (deliberately, and why):** nothing from 5a/2/2b/3/4/5b. `askForStep` takes a
`PendingWorkflowAsk` (id + `agent.id`) rather than a concrete pending-asks container, because the
phone's controller owns that container (`workflow-run-controller`, slice 3); the pure pairing is here
now so both surfaces share one rule, and slice 3 supplies the list. The TUI's `onWorkflows` subscriber
in `useSessionLink` and the rail/panel are slice 2's, as the plan's files column says.

### Slice 5a — Workflow catalogue + start-by-hash on the wire (D6)

*— claude-sonnet-4-5 (executor), 2026-11-24*

**Load-bearing check re-run first (PARTIAL rule):** PASSED. `RemoteSession.workflow` exists
(`packages/client/src/remote-session.ts:1309`) and its `start` path mints a turn as 1b specified;
the driver's `inspect` (`packages/agent/src/workflow-driver.ts:427`) and `prepare`
(`:699`/`:900` after the refactor) are as D6 cites them — `prepare` loads, validates against the
session's `models`/agent types and hashes, answering `{hash, spec}` with no run and no ask.

**What changed, in dependency order.**

1. **Wire (`packages/protocol/src/session.ts`, `methods.ts`).** `session/workflow_catalogue`
   (params `{sessionId}`) and its result `WorkflowCatalogueResultSchema`
   (`{workflows: WorkflowDefRow[], dir, truncated?, unavailable?, gitIgnored?, elsewhere?}`), with
   `WorkflowDefRowSchema` (name/path/`ok`, `version`/`description`/`hash`/`approved`/`inputs`/
   `steps`/`errors`, each capped as D6's table says) and `WorkflowStepSummarySchema`
   (`{id, kind, model?, where, command?}` — `command` uncapped per row so the phone shows every
   `run` command verbatim before an approval). `WorkflowParamsSchema.start` gains optional `hash`
   (`WorkflowHashSchema`, the sha-256 hex already in `session-log.ts`); `WorkflowResultSchema`
   gains optional `refusal` (`WorkflowWordSchema` — a bounded free word, never an enum, so a newer
   daemon's word cannot poison an older client). All additive: **no `protocol.d/` note, no
   `PROTOCOL_VERSION` edit** (§7), and `packages/protocol/schema/protocol.json` regenerated
   (`bun run schema:export`, +192 lines).
2. **Loader (`packages/cli/src/workflow-files.ts`).** `listWorkflowSources(cwd): Promise<
   WorkflowListing>` — ONE async walk (`node:fs/promises`, so a big folder never blocks the `serve`
   event loop, §7) of `<cwd>/${PROJECT_PATHS.workflows}`, through `resolveInside(…, "no-links")`
   so a symlinked `.tentacle`, `workflows` or file is an `invalid` row with its path, never
   followed. Every top-level `<stem>.yaml`; a bad stem / an oversize file is an `invalid` row with
   its reason (never a silent skip); `> WORKFLOW_SOURCES_MAX` (64) sets `truncated`; a missing
   folder is `[]`. Plus `workflowListing(cwd)`: the same walk plus the two display-only facts —
   `elsewhere` (from slice 0's `workflowsAbove`, ONLY when the folder lists no workflow) and
   `gitIgnored` (slice 0's `workflowsGitIgnored`, only asked when there is a source to protect).
3. **Driver (`packages/agent/src/workflow-driver.ts`).** New dep `list?: () => Promise<
   WorkflowListing>`, and `catalogue()`: for each row the SAME `prepare` path `inspect` uses
   (extracted as `prepareSource(name, source)`, `prepare` now a two-line wrapper — no behaviour
   change), plus `approvals.has`, plus the spec's own steps as summaries. Asks nothing, starts
   nothing, writes nothing; a session with no `list` answers `unavailable`. `start` gains
   `hash?`: present and ≠ the current hash → `{ok:false, refusal:"changed"}`, checked after
   `prepare` and BEFORE the slot claim. Every existing refusal gets its word (`running` with the
   run id, `invalid`, `inputs`, `unavailable`).
4. **Daemon (`packages/daemon/src/connection.ts`, `hosted-session.ts`).**
   `Method.WorkflowCatalogue` → `HostedSession.workflowCatalogue()`, which answers the driver's
   catalogue (or the same `unavailable` a driverless session answers) and validates it through
   the wire schema on the way out — each `errors[]` entry flattened to ONE bounded line (the
   validator's text can hold a newline; an over-long one would fail the whole answer and lose
   every other row). `workflow()` passes `params.hash` through to `driver.start`.
5. **Client (`packages/client/src/{workflows,remote-client,remote-session}.ts`).**
   `WorkflowAction.start` gains `hash?`; `RemoteClient.workflowCatalogue` maps `MethodNotFound`
   to `{unsupported:true}` (never a throw); `RemoteSession.workflowCatalogue` is trust-gated on
   `daemonWakes` exactly like `workflow()` — refused locally with `unavailable` and nothing sent
   — and the three answers stay distinct on purpose: rows / `{unsupported:true}` ("update
   tentacle") / `{unavailable}` ("workflows only on a laptop or serve session").
6. **Pass-through (`packages/cli/src/{local-runtime,wiring}.ts`, `packages/tui/src/app-types.ts`).**
   `persistingController` forwards `workflowCatalogue`; the driver is wired
   `list: async () => workflowListing(config.cwd)` beside `load`; `app-types.ts` declares it
   optional on the controller surface (its consumer is slice 2b's panel).

**Mutations (each run against the real code, then reverted from a file copy — never `git
checkout`).**

| Mutation | Result |
|---|---|
| `start`: `if (false)` in place of the `hash` comparison | RED — "a STALE hash is refused `changed`" (`expected +0, received ok:true runId wf-1`) |
| `catalogue()`: one `approvals.has` + a `deps.request` per row added | RED — 3 tests, incl. "it ASKS NOTHING and STARTS NOTHING: zero broker requests" |
| `approveHash`: a private `async () => ({allowed:true})` in place of `stepRequester` | RED — "a CURRENT hash on an unapproved file asks exactly ONE hash approval" and the no-hash case |
| loader: `truncated: false` always | RED — "more than WORKFLOW_SOURCES_MAX files: the first ones are kept, `truncated` says so" |
| loader: `elsewhere` computed unconditionally | RED — "an EMPTY folder gets the hint; a folder WITH a workflow does not" |
| daemon: `params.hash` not passed to `driver.start` | RED — "start{hash} reaches the driver: a stale hash is refused `changed`, nothing runs" |
| client: `MethodNotFound` → an empty catalogue instead of `{unsupported:true}` | RED — "an OLDER daemon is `{unsupported:true}`" |
| `RemoteSession.workflow`: `hash` dropped from the params | RED — "a start carries the hash the user saw, and still mints its turn" |

**Drift from the Implementation (and why).**

- **The loader's name and shape.** The plan says `listWorkflowSources(cwd): Promise<
  WorkflowSource[]>`. The code needs three things that are not a source: the ABSOLUTE folder read
  (the catalogue's `dir`, D7 v5), whether the walk was `truncated` (D6's own failure-mode row),
  and the invalid rows a bad stem / oversize file produce (D6: "an `ok:false` row … never a
  silent skip"). So `listWorkflowSources` answers a `WorkflowListing` (`{dir, rows, truncated}`,
  rows being `source | invalid`) and `workflowListing` adds the two display-only facts. This is
  the same seam, with the shape the design's own requirements force; noted here rather than
  silently.
- **`prepareSource` extraction.** D6 asks for "`prepare` refactored to take a source instead of a
  name, no behaviour change". Taken literally that would have `start`/`rerun`/`inspect` read the
  file too. I added `prepareSource(name, source)` and left `prepare(name)` as a two-line loader
  wrapper, so the shared path is ONE implementation and no existing caller changes.
- **`gitIgnored`/`elsewhere` are on the CLI's `WorkflowListing`, not on `@tentacle/agent`'s
  structural copy.** The driver's `catalogue()` consumes `rows` + `dir` + `truncated` only; the
  extra facts ride the same object at the CLI boundary, where they are produced. Additive and
  structural, so no second type had to grow.
- **`local-runtime`'s controller guard.** `packages/cli/test/subagent-panel-controller.test.ts`
  pins the exact forwarded set; it went red on the new member (which is what it is for), so its
  list gained `workflowCatalogue` beside `workflow`/`workflowStep`.
- **The fragment gained a SECOND bullet — gate-red, now merged into one.** `changelog.d/workflows-ui.added.md`
  held 1a/1b's bullet; this slice APPENDED its own, so the file carried two `- ` bullets and
  `scripts/test/changelog-guard.test.ts` I2 went red (`changelog.d/workflows-ui.added.md: one bullet
  per file; split it into two fragments`). §10 allows one fragment per slug+category, so the two were
  merged back into the single bullet the file must hold (the catalogue/hash/refusal sentence plus the
  `workflow_step` sentence plus the shared client seam), not split into a second file — a second
  `added` file would collide on the slug+category pair.
- **`json-schema.test.ts` fixtures.** Adding a method without its params/result fixtures fails
  "every method … has a fixture" — the new fixtures carry the `hash`/`refusal` params and results
  as well as all four catalogue answers (rows, empty+hint, `unavailable`, `truncated`).

**Tests (all listed failure modes; red before green).**

- `packages/agent/test/workflow-catalogue.test.ts` (new, 13 tests): a valid row's hash IS
  `workflowHash` of the same bytes, `approved` from the store, an invalid file's errors with their
  YAML path; **asks nothing and starts nothing** (zero broker requests, no run, no row); a stale
  `hash` → `refusal:"changed"`, zero asks, no row; a current `hash` on an unapproved file → exactly
  ONE `workflow_approve` through the session's ONE requester; no `hash` → today's behaviour; no
  `list` dep → `unavailable`; `running`/`inputs`/`invalid` words on the existing refusals.
- `packages/cli/test/workflow-files.test.ts` (+8 tests): one walk lists every `*.yaml`; a
  symlinked file and a symlinked `workflows/` are refused; a bad stem → an error row; missing dir
  → `[]`; `> 64` → `truncated`; a folder WITH a workflow never gets the hint, an empty one does;
  a parent's workflow is still not loadable from the child.
- `packages/daemon/test/workflow-hosted.test.ts` (+3 tests): `session/workflow_catalogue` answered
  on a session with a driver (rows, `dir`); a driverless (tunnelled) session answers `unavailable`,
  never a list that looks like "no workflows"; `start{hash: stale}` refused `changed`, nothing run.
- `packages/client/test/workflows-client.test.ts` (+4 tests): the rows and the session-scoped
  request; `MethodNotFound` → `{unsupported:true}`; trust bit off → nothing sent, `unavailable`;
  `start` carries `hash` and `inputs` and still mints its turn.
- `packages/protocol/test/workflow-wire.test.ts` (+6 tests): the method is registered with its own
  schemas; `start{hash}` accepts a sha-256 hex and refuses anything else; `refusal` is a bounded
  word (a newer daemon's word parses); a catalogue row's caps (`errors` ≤ 20, `description` ≤ 500).
- `packages/cli/test/local-runtime.test.ts` (+1): `workflowCatalogue` forwarded to `inner`.
  `packages/protocol/test/json-schema.test.ts`: `zod ⇔ JSON Schema` green with the new fixtures.

**Validation.** `bun test` on every affected file: **744 pass, 0 fail** across `packages/protocol/test`
(whole), the agent's two workflow suites, the cli's 5, the daemon's 3, the client's 2 (66 files).
Wider sweep `packages/{agent,daemon,client}/test` + `packages/cli/test/workflow-*` +
`packages/tui/test/commands`: **3223 pass, 1 skip (opt-in), 0 fail**. `packages/tui/test` +
`packages/cli/test`: 5772 pass, 2 skips, and the one guard failure this slice caused, fixed above.
`bunx tsc --noEmit` (root) + `tsc -p apps/mobile` + `tsc -p apps/relay`: **0 errors**.
`bunx biome check` on all changed files: clean. `bun run schema:export` regenerated
`packages/protocol/schema/protocol.json`.

**Not done in this slice (deliberately, and why):** nothing from 2/2b/3/4/5b. No TUI panel and no
phone screen — 5a is the data path only; `app-types.ts` declares `workflowCatalogue` optional so
2b's panel can call it, and 5b's start screen is where `hash`/`refusal` are consumed. The plan's
"uncapped per row" (vs the 16 000-char approval SUMMARY) is honoured by one
`WorkflowDefStepSchema` per step with its own bounds — `command` ≤ 4096, `where` ≤ 256, `id` ≤ 64,
≤ 64 steps — so a full `run` command travels verbatim while the row still has a wire cap (a
`line`-in-a-loop over 10 000 commands would be a different, unbounded shape).

### Slice 2 — TUI rail + `/workflow` panel + command (D3)

*— claude-opus-5-5 (executor, resuming DeepSeek's partial edits), 2026-11-23*

**Load-bearing check (PARTIAL rule) — holds.** `RemoteSession.onWorkflows`
(`client/src/remote-session.ts:1280`), `workflow` (`:1310`), `workflowStep` (`:1352`) exist;
`cli/src/local-runtime.ts:979-986` passes all three to `inner`; `tui/src/app-types.ts:351-370`
declares them optional.

**As built (DeepSeek's working-tree edits kept where right, then finished):**
- `tui/src/workflow-view.ts` (new, pure): `stateLook` (glyph + word; unknown → `· <word>`),
  `railLines` / `railWindow` (7 rows centred on the active step, `… +k earlier` / `… +k more`),
  `workflowRailLines` (null for no run, an ENDED run, a taken slot, or a terminal too short to keep
  the transcript floor), `workflowPanelView` (two columns), `workflowKey`, `workflowMove`,
  `parseWorkflowCommand`, `workflowTarget`, `workflowReplyNotice`.
- `components/WorkflowRail.tsx` (new, paints the lines); `AppView.tsx` mounts it above the
  queued/slot block; `app-layout.ts` adds `workflowHeight` to `activeRows`, `panelBodyTop`,
  `dockTop` and `statusRowY`.
- `panels/workflow.ts` (new kind, flat-list `sessions` layer) + `panels/registry.ts` line +
  `panels/types.ts` `WorkflowPanel` in `OpenPanel`; `keys/effects.ts` + `keys/execute.ts` two
  effects (`workflowDetail`, `workflowRerun`) carrying runId/stepId/panel generation;
  `usePanels.ts` `fetchWorkflowStep` / `rerunWorkflowStep` / `setWorkflowsData` /
  `setWorkflowState`.
- `useDock.ts` holds `workflowRows`/`workflowsRef`/`setWorkflows`; `useSessionLink.ts` subscribes
  `onWorkflows` and resets on switch; `App.tsx` `followWorkflows` feeds the dock AND an open
  panel (the `followSchedules` pattern), passes `currentRun(workflowRows)` to `frameLayout`.
- `commands/workflow.ts` (new) + `commands/registry.ts` (`/workflow`, alias `/workflows`) +
  `commands/context.ts` `workflowsRef`.

**What I fixed in DeepSeek's partial:** `App.tsx` passed a `followWorkflows` key the host does not
have and lacked the `KeyHost` `workflowDetail`/`workflowRerun` and the usePanels destructuring;
`usePanels.ts` used `oneLine` unimported; `app-layout.ts` passed `PermissionRequest | null` as a
boolean; `workflow-view.ts` pushed onto a readonly array; `frameLayout` was never given the run (the
rail could not appear). The command file and its registry/context lines did not exist. A test
called `toContain` with two arguments and another asserted on an array (vacuous).

**Drift from Implementation (and why):**
- The panel's left column was 20 cells and cut every step id to `p…`; widened to
  `3 + WORD_COLS + 1 + 12` = 30 (found from the T4 frame).
- Rail columns are decided over the WINDOW, not per row: a step with no model (`run`, `approve`)
  keeps an empty cell, else `[docker]` slid under the model column (found from the T1 frame;
  pinned by an alignment assertion, M6).
- `? needs approval — answer in the prompt` added to the detail column (D3 names it; the partial
  lacked it). `WORKFLOW_APPROVE_HINT`.
- Plan file list says `useSessionLink, useDock, AppView, panel` only; the as-built also touches
  `App.tsx`, `app-layout.ts`, `usePanels.ts`, `keys/{effects,execute}.ts`, `panels/types.ts`,
  `commands/context.ts` — the existing seams a panel kind with async keys and a live-area row needs
  (the `/schedule` precedent touches the same files). No new seam.
- Existing enumerating tests updated for the new command / kind: `commands-registry.test.ts`,
  `app-commands.test.tsx`, `panels-registry.test.ts`, `app-panels-structure.test.tsx`.

**Tests.** `tui/test/workflow-view.test.ts` (22: every state's glyph+word, unknown as is,
flattening, tiers + alignment, 64-step window `+37`/`+20`, `workflowRailLines` null cases, panel
columns / detail phases / approve hint, `undefined` vs empty, keys, command parsing, targets,
reply notices, `withWorkflowDetail` stale drop, `withWorkflowsData` clamp/drop).
`tui/test/workflow-frames.test.tsx` (9, real `App`): rail equals `railLines`; **input row y equal
with and without the rail**; a run ending live leaves the input in place; 60-col tier; `/workflow`
opens the panel and hides the rail; ↓ / `o` paints the report / `r` sends `rerun_step` + notice /
esc brings the rail back; `/workflow run task branch=main` → `start` with inputs, `stop` → the live
run, `resume` with nothing stopped refused locally (nothing sent), bad line → usage; a daemon
refusal shows its reason; no feed → notice.

**Mutations (each red, then reverted green):**
| # | Mutation | Red test |
|---|---|---|
| M1 | drop `workflowHeight` from `activeRows` (`app-layout.ts`) | frames: "input sits on the SAME row…", "a run that ends…" |
| M2 | `withWorkflowDetail` ignores `stepId` | "a detail lands only on the step it was asked for" |
| M3 | drop `endedAt` check in `workflowRailLines` | was GREEN at first (App's `currentRun` already filters) → added the pure `workflowRailLines` test → red |
| M4 | `stateLook` unknown → `pending` | "an UNKNOWN state … never coerced" |
| M5 | `o` emits `workflowRerun` | frames: "↓ moves the cursor; `o` paints…" |
| M6 | model column per row | "width tiers … " (alignment assertion) |
| M7 | (a real bug, found writing this section) the view painted `currentRun ?? data[0]` but keys/rules used `currentRun` only, so with no run in flight `o`/`r`/↑↓ acted on nothing | new assertion "No run in flight…" red on the old `workflowPanelRun`; fixed with ONE `shownRun` used by both |

**Post-slice fix (gate, `feat/workflows-ui`).** The rail made `statusRowY` — and with it
`app-layout.test.ts`'s "the status bar's row is the sum of the parts the tree paints above it" and
`app-view-structure.test.ts`'s "onPillRange is still wired" (S10, whose regex pins the expression
verbatim) — stale: both pinned the pre-rail sum, so the gate failed on the app-decomposition half.
Both expectations now name `workflowHeight` in the position the tree paints it (spacer → rail →
queued/slot → dock → input box → bar's own), i.e. they follow this slice's addition instead of
contradicting it. P8's invariance (the attach row moves `viewport` and `inputBoxRows` by one each,
`statusRowY` unchanged) still holds with a rail present, and the M1 mutation above stays red (M1
drops `workflowHeight` from `activeRows`, which moves `statusRowY` too — the pin catches it).

**Validation frames (from `.tentacle/tmp/workflows-ui/frames.ts`, renderAt, SGR stripped):**
```
--- T1 rail (120 cols)
workflow task · 2/6 · 1.2M/3M tok
✓   plan   ok             opus       [local]   2m 4s
✓   exec   ok             deepseek   [local]   14m 10s ↻ 1/1
✗   review error          opus       [local]           REQUEST-CHANGES
▸   fix    running        deepseek   [local]   …
    ↳ edit packages/x.ts
⧗   gate   waiting                   [docker]
?   merge  needs approval
──────────────────────────────────────────────────────────────────────────── m ─
❯  Type a task or /command
--- T2 rail (60 cols)
workflow task · 2/6 · 1.2M/3M tok
✓   plan   ok             2m 4s
✓   exec   ok             14m 10s ↻ 1/1
✗   review error                  REQUEST-CHANGES
▸   fix    running        …
    ↳ edit packages/x.ts
⧗   gate   waiting
?   merge  needs approval
--- T3 64-step rail (120 cols)
workflow task · 40/64 · 1.2M/3M tok
  … +37 earlier
✓   s37  ok             [local]
✓   s38  ok             [local]
✓   s39  ok             [local]
▸   s40  running        [local]   …
○   s41  pending        [local]
○   s42  pending        [local]
○   s43  pending        [local]
  … +20 more
--- T4 /workflow, review selected (120 cols)
╭─ Workflow task · 2/6 ─────────────────────────────────────────────
 ✓ ok             plan         │ ✗ error · opus · [local]
 ✓ ok             exec         │ REQUEST-CHANGES
›✗ error          review       │
 ▸ running        fix          │ [o] prompt and report
 ⧗ waiting        gate         │
 ? needs approval merge        │
 ↑↓ step · r rerun · o prompt/report · esc close
--- T5 after o (120 cols)
╭─ Workflow task · 2/6 ─────────────────────────────────────────────
 ✓ ok             plan         │ ✗ error · opus · [local]
 ✓ ok             exec         │ REQUEST-CHANGES
›✗ error          review       │
 ▸ running        fix          │ prompt:
 ⧗ waiting        gate         │ review the diff of the branch
 ? needs approval merge        │
                               │ report:
                               │ REQUEST-CHANGES: task.ts:380 misses an abort
 ↑↓ step · r rerun · o prompt/report · esc close
```
(Rules shortened here; the rest of each frame is the input rule, input and status bar.)

**Gate (narrow, per the owner's token budget):** `bun test` on the 9 touched/covering TUI files
(`workflow-view`, `workflow-frames`, `app-panels-structure`, `app-commands`, `commands-registry`,
`panels-registry`, `schedule-panel-frames`, `commands`, `app`): 266 pass, 0 fail (before the last
pure fixes; `workflow-view` + `workflow-frames` + `panels-registry` re-run after them: 42 pass). `tsc --noEmit -p packages/tui`:
no error in changed files (one pre-existing `artifact-open.ts:95` under the package config only).
`bunx biome check packages/tui/src packages/tui/test changelog.d`: clean. Full `bun run check` is
the orchestrator's script. No protocol change → no `schema:export`, no `protocol.d/` note.
Changelog: the TUI sentence appended to the existing one-bullet `changelog.d/workflows-ui.added.md`
(same slug+category: one file, one bullet).

**Not done (deliberately):** nothing of 2b (catalogue line, Workflows section), 3, 4, 5b. A
`/workflow` panel with a pinned `runId` other than the live one is supported by the model but no
key selects an older run yet (the panel shows the run in flight, else the newest).

### Slice 2b — TUI: the project's workflows, automatically (D8)

*— claude-sonnet-4-5 (executor), 2026-11-24*

**Load-bearing check re-run first (PARTIAL rule) — PASSES.** `RemoteSession.workflowCatalogue`
exists (`packages/client/src/remote-session.ts:1333`, `packages/tui/src/app-types.ts:378`) and
slice 2's rail is mounted (`packages/tui/src/AppView.tsx:159`, `app-layout.ts:294`).

**What changed, in dependency order.**

1. **Pure module (`packages/tui/src/workflow-view.ts`, +~380 lines).** `catalogueState` (the wire's
   own facts → one of four WORDS: `needs approval` / `invalid` / `unknown` / `approved`; an `ok`
   row whose store said nothing is `unknown`, never a false `approved`), `catalogueOrder` (needs
   approval → invalid → unknown → approved, by name inside each), `catalogueLine` (tiers at 100 and
   60 cols; `assemble` keeps whole names and counts the rest `+k`, never a cut name),
   `elsewhereLine` (`~`-shortened, cut in cells), `workflowsLine`/`catalogueRows` (the frame's
   decision: null behind a panel/dialog/palette, while a run is in flight, or when the terminal
   cannot spare the row), `startCommandFor` (start pinned to the hash / prefill the required inputs
   / refuse an invalid file), `catalogueRowFor`, `catalogueSection` (the panel's section),
   `catalogueRefresh` (the coalescing reducer).
2. **The fetch (`packages/tui/src/useCatalogue.ts`, new).** ONE read at D8's triggers — mount/open,
   a turn SETTLING (`running`'s falling edge, never its rise), a run ending, an approval ANSWERED,
   `/workflow` — no watcher and no polling. `catalogueRefresh` is the rule and this hook only
   executes it: one request in flight, one scheduled, so a burst is never a queue. An answer for a
   session the TUI has left is dropped; a failed read keeps the last answer (stale beats flicker)
   and the next trigger asks again. A session with no seam gets `undefined`, which paints nothing.
3. **Layout (`app-layout.ts`).** `workflowCatalogue` + `home` are frame inputs; `workflowsAtRest`
   and `catalogueHeight` join `activeRows`, `panelBodyTop`, `dockTop` and `statusRowY` in the same
   position the rail occupies (`spacer → rail → at-rest line → queued/slot → dock → input → bar`).
4. **Painting.** `components/WorkflowsLine.tsx` (new, one `<Text>`, tone from the projection) is
   mounted in `AppView.tsx` right after the rail; the two can never both paint.
5. **Panel (`panels/{types,workflow}.ts`, `usePanels.ts`).** `WorkflowPanel.catalogue` and
   `workflowPanel(now, runs, runId, catalogue)`; `workflowPanelView` prepends `catalogueSection`'s
   rows to the two-column view (so the section sits above the runs on every answer, including the
   two with no run) while `start` still indexes the STEP list — the section's rows are `note`s, so
   a click there is a no-op; `withWorkflowsData` carries the catalogue; `setCatalogueData` is the
   one writer both paint sites go through.
6. **`/workflow` (`commands/{workflow,context}.ts`, `App.tsx`).** The panel opens WITH the
   catalogue, every `/workflow` asks for a re-read (coalesced), `run <name>` pins the catalogue
   hash it holds (a file edited since is refused `changed`, 5a), a workflow whose required inputs
   were never given pre-fills the command instead of starting half-specified, and an invalid file
   says its first error. `App` owns the state, the ref the command reads, and the token a re-read
   is asked by (`askCatalogue`, a stable callback over the live binding).

**Drift from the Implementation (and why).**

- **The fetch did not go into `useSessionLink.ts`.** The plan names that file, but its whole
  contract is "this hook declares NO `useEffect`" (`useSessionLink.ts:21`) and `App`'s effect count
  is pinned by `app-tidy-structure.test.ts` (22). D8's triggers are five independent render VALUES,
  not session-link latches, so they live in a leaf hook (`useCatalogue.ts`) — same seam, one file
  the plan did not name, named here rather than smuggled in.
- **`catalogueView` became `CatalogueView`** (`WorkflowCatalogueResult | {unsupported:true} |
  undefined`) and is declared once, in `workflow-view.ts`; `app-types.ts` already exported the
  wire result, so nothing new reached `@tentacle/client`.
- **The panel's section is a PREFIX of `rows`, not a separate block.** A `PanelView` has one
  `start`, and clicks resolve `start + bodyIndex`; a parallel section would have meant a second
  index space in `panels/workflow.ts` for no gain. The section is unselectable (`note`), so the
  click subtracts its length after refusing a non-`head` row.
- **`followCatalogue` writes the panel through a late-bound ref** (`setCataloguePanelRef`), because
  `usePanels` is declared BELOW the frame the catalogue feeds (the catalogue's row is part of the
  layout's budget). That is the same late-binding pattern the file already uses for `pushNoticeRef`,
  `runRef` and `openArtifactRef` — not a second source of truth (the state is the truth; the ref is
  the writer).
- **`/workflow`'s hint gained nothing.** I first added ` · run <name> starts one` to the panel's
  hint when a section was present; slice 2's frames test pins that hint verbatim and the extra
  words earn nothing (`/workflow run <name>` is already in the section's own last line), so the
  hint is unchanged.
- **`askCatalogue` is a separate stable callback** rather than passing `refreshCatalogueRef.current`
  into the command context: the latter tripped `useExhaustiveDependencies` on `handleCommand`
  (a ref read inside a `useCallback` body is a render-scope value to Biome). One `useCallback` over
  the ref keeps the lint gate clean and the identity stable.

**Tests (red first; every listed failure mode).**

`packages/tui/test/workflow-view.test.ts` (+14: the four words from the wire's facts — including
`unknown`, never a guessed `approved` — the ordering, the 120/80/50-col tiers with the width
asserted in CELLS, `+k` arithmetic summing to the row count, `null` for all four "nothing to say"
answers, `not versioned` on the widest tier only, the `elsewhere` hint's `~`/cut/negatives, the
mounted line's three null cases plus its two tones, `startCommandFor`'s three shapes {hash, no
hash, a required input WITH a default, prefill, refused}, `catalogueRowFor`, the panel section's
rows/errors/paths/folder/`truncated`, the section's three empty answers said DIFFERENTLY, and the
coalescing reducer's burst→one-extra→idle).

`packages/tui/test/workflow-frames.test.tsx` (+9, real `App` at a real terminal size): the App
paints the line exactly as `catalogueLine` projects it; **the input row is the SAME with and
without the line** (the exact property); a run in flight replaces it and its end brings it back; a
turn ending re-reads the catalogue exactly once and its START asks for none; a burst of `/workflow`
while a read is held is ONE read plus ONE scheduled, never a queue; a row needing input PRE-FILLS
the command (nothing sent, the blank line in the input, `needs input` said) and the same command
filled in starts with the catalogue's hash; an invalid file is refused with its FIRST error and
nothing sent; an older daemon's `unsupported` paints no line and `/workflow` says "update
tentacle"; the section paints above the run with its errors, path, folder and not-versioned
sentence; a terminal too short drops the line and nothing else.

**Mutations (each run against the real code, then reverted from a file copy — never `git
checkout`; every one went RED).**

| # | Mutation | Red test |
|---|---|---|
| M1 | drop `catalogueHeight` from `activeRows` (`app-layout.ts`) | frames: "the input sits on the SAME row …" (both halves) and "a run in flight replaces it" |
| M2 | re-read on every settle render (`wasRunning \|\| !running`) | "a turn ENDING re-reads the catalogue exactly once (not on its start)" |
| M3 | drop the coalescing in `refreshCatalogue` (read on every trigger) | "a burst of triggers is ONE read plus ONE scheduled" — **was GREEN at first**, so that test was added and re-run against this mutation to prove it kills it |
| M4 | `runFromCatalogue` returns `null` (no hash pinned) | "/workflow run\|stop\|resume send the action …" AND "a workflow needing input PRE-FILLS …" — **the second one was RED for a real reason**: D8's prefill path pinned no hash, so the fix (`return row.hash`, the catalogue's hash whether or not the inputs were typed) came out of this mutation |
| M7 | the prefill path starts anyway (`if (false)`) | "a workflow needing input PRE-FILLS the command instead of starting half-specified" (nothing is sent is the assertion that fails) |
| M5 | drop the `runActive` guard in `workflowsLine` | the pure "mounted line: null while a run is in flight …" and the frames "a run in flight replaces it" |
| M6 | an empty catalogue returns `"◇ workflows  none yet"` | the pure "nothing to say → null" and the frames' mounted-line case |

**Validation frames** (from `.tentacle/tmp/workflows-ui/frames2b.tsx`):
```
--- T6 line, 120 cols, 3 workflows
◇ workflows  nightly v1 ? needs approval · broken ✗ invalid · task v3 ✓ approved  · not versioned   /workflow
--- T7 line, 9 workflows at 120 / 80 / 50 cols
◇ workflows  wf-0 v1 ? needs approval · wf-1 v1 ✓ approved · wf-2 v1 ✓ approved · wf-3 v1 ✓ approved · +5   /workflow
◇ workflows  wf-0 v1 ? needs approval · wf-1 v1 ✓ · wf-2 v1 ✓ · wf-3 v1 ✓ · +5
◇ 9 workflows · 1 needs approval · /workflow
--- T8 /workflow Workflows section (120 cols)
  ? nightly v1               needs approval
  ✗ broken                   invalid
      steps[0].run: missing
      .tentacle/workflows/broken.yaml
  ✓ task v3                  approved       · 2 steps
  not versioned: git ignores this folder
  in /tmp/work/.tentacle/workflows · /workflow run <name> to start one
```

**Gate (narrow, per the owner's token budget).** `bun test` on the 13 touched/covering TUI files
(`workflow-view`, `workflow-frames`, `app-layout`, `app-view-structure`, `app-tidy-structure`,
`commands-registry`, `panels-registry`, `app-panels-structure`, `app-commands`, `app`,
`schedule-panel-frames`, `keys-layers`, `keys-route`): **346 pass, 0 fail**;
`changelog-guard`: 5 pass. `tsc --noEmit -p packages/tui`: no error in any changed file
(the one pre-existing `artifact-open.ts:95` under the package config is slice 2's, untouched here).
`bunx biome check packages/tui/src packages/tui/test`: clean (406 files). The full `bun run check`
is the orchestrator's script. No protocol change → no `schema:export`, no `protocol.d/` note.
Changelog: the at-rest sentence appended to the existing one-bullet
`changelog.d/workflows-ui.added.md` (same slug+category: one file, one bullet — the guard's I2
passes).

**Not done (deliberately):** nothing of 3, 4, 5b. The section has no cursor of its own (D8 was
decided that way: the line summarizes, `/workflow run <name>` acts), so no key selects a catalogue
row yet; starting one from the panel means typing the command, which is exactly what the prefill
hands back.

### Fix round 1 (review round 1: findings #1, #2 — both MEDIUM)

**#1 — one row the wire refuses blanked the catalogue → FIXED.** `hosted-session.ts`
`workflowCatalogue` now maps each driver row through `catalogueRow` (new, module-level beside
`oneLineText`), which runs `WorkflowDefRowSchema.safeParse` PER ROW. A refused row becomes
`{name, path, ok:false, errors}`, each error naming the field by step id
(`step "build" command: String must contain at most 4096 character(s) (the catalogue cannot carry
it)`); name/path are one-lined and capped so that row itself parses. The whole-answer
`unavailable` fallback stays only as a backstop (e.g. `dir` > 1024). Chosen over raising the wire
cap: any other per-row overflow (description > 500, > 64 steps/inputs) is covered by the same path.

**#2 — errors joined and cut silently → FIXED.** `workflow-driver.ts` `prepareSource`'s refusal
now carries `errors: validation.errors` (the `reason` string is unchanged for `start`/`inspect`);
`catalogue()` puts that array in the row. The daemon's `boundedWorkflowErrors` makes each error one
line, cuts an over-long one to 300 ending in `…` (`capWithEllipsis`, never mid-surrogate), and
past 20 keeps 19 + `+k more`. Drift: the row's errors no longer carry the `<path>: ` prefix — the
row has `path` already, and each validator error names its own YAML path (`steps[3].run: …`).

**Tests (red first, on the property).** `packages/daemon/test/workflow-hosted.test.ts`:
- "a VALID workflow the wire cannot carry is ONE ok:false row naming its step — the rest stay"
  — red before: `Received: "the catalogue could not be read: [ { "code": "too_big", "maximum": 4096 …`.
- "every validation error is its own line; over 20 → `+k more`; an over-long one ends in …"
  — red before: `Expected length: 20 / Received length: 1`.
- Two existing assertions updated (`errors[0]` contained `steps` only because it was the joined
  string): daemon "answers every row" → `some(e ⇒ startsWith("steps"))`; agent
  `workflow-catalogue.test.ts` "an INVALID file…" → `errors[0]` starts `version:` + some starts
  `steps` (red on the old joined string too).

**Mutations (each applied by hand, run, reverted; `cmp` against a scratch backup = identical).**

| Mutation | Red test |
|---|---|
| M1 `catalogueRow` returns the row unvalidated (no per-row fallback) | "a VALID workflow the wire cannot carry…" (1 fail) |
| M2 `boundedWorkflowErrors` never caps at 20 | "every validation error is its own line…" (1 fail) |
| M3 `capWithEllipsis` cuts without `…` | same test (`Expected: true / Received: false`) |
| M4 driver back to `errors: [prepared.reason]` | 3 fail: agent "an INVALID file…", daemon "answers every row", "every validation error…" |

**Narrow gate.** `bun test` on daemon `workflow-hosted`, agent `workflow-catalogue` +
`workflow-driver`, protocol `workflow-wire`, client `workflows-client`: **98 pass, 0 fail**.
`bunx biome check` on the 4 touched files: clean. `tsc --noEmit -p packages/daemon`: clean. Full
gate: the orchestrator's script. Notes below the bar (a) `dir: ""` and (b) `resetCatalogue`
were not touched (not HIGH/MEDIUM).

*— claude-opus-5-5, 2026-11-23*

### Slice 3 — iPhone list + graph ⇄ cards + approve (D4) — PARTIAL (code + unit/wiring tests DONE; e2e flow + seed NOT done)

*— claude-opus-5-5, 2026-11-24*

**Resume note.** The brief said DeepSeek's partial edits were in the working tree; `git status`
was clean at start, so nothing was inherited — the slice was done from scratch.

**Load-bearing check (PARTIAL rule) — PASSES.** `RemoteClient.workflowList` exists
(`packages/client/src/remote-client.ts:1646`, `MethodNotFound` → `{unsupported:true}`) and
`RemoteSession.workflowStep` exists (`remote-session.ts:1352`); also used: `onWorkflows` (`:1280`),
`workflow(action)` (mints for start/resume/rerun), `onSessionWorkflows` (`remote-client.ts:1610`).

**As built, in dependency order (red first for every pure module: each test file was run against
a stub/old code and failed on ASSERTIONS before the implementation).**

1. `src/workflow-skeleton.ts` `detailBlocks`: labels English (`State, Kind, Model, Where, Attempts,
   Round "n of m", Duration`). Red: `workflow-morph-skeleton.test.ts` 2 fail on the old Italian.
   `workflow-list.ts` needed NO change — its user-facing words were already English (only comments
   name the mockup's Italian); the plan's "list words carry Italian" was stale.
2. `src/permission-sheet.ts`: the `asking` state carries `agentId` (the asker's `agent.id`, for
   `askForStep`), and NEW `answerFor(requestId, optionId, now?)` — answers only when the ask on
   screen IS that id, same `settle` path and age guard as a tap, never `reply`. Red: 4 fail
   (`answerFor is not a function`, `agentId` missing). The sheet only ever holds ONE presented ask
   (the router serialises; `queue` is a guard), so "answer a non-head ask" is not needed: a card
   whose ask was replaced answers nothing.
3. `src/hub-actions.ts` + `src/hub-session.ts`: entry `workflows` ("Workflows", after Scheduled in
   the canonical order — the idle fan O1 is unchanged), count badge = `workflowsNeedYou` (promoted
   like any badge; the rim arc idiom), dimmed by `workflowsEmpty` (`NO_WORKFLOW_RUNS` /
   older-daemon text), unknown never dimmed; `hubContextOf({workflows?})`; VoiceOver action
   `hub-workflows`. `src/ui/HubFan.tsx`: one icon line (`list.bullet`) — required by the
   `Record<HubActionId, IconName>` (drift: file not in the plan's list; presentation only).
   Red: 4 fail on assertions (after adding only the constant, so the red was not an import error).
4. `src/routes.ts`: `WorkflowRunsRoute {computerId, name, sessionId?}`, `WorkflowRunRoute
   {computerId, sessionId, runId, title}`, two `RootStackParams` entries (type tests in
   `routes.test.ts`).
5. NEW `src/workflow-runs-controller.ts` (pure): reads `workflowList()` on focus / pull / any
   `onSessionWorkflows` notice debounced `RUNS_DEBOUNCE_MS = 500`; one read in flight (a trigger
   during a read = one more read after it); `unsupported` → its own state ("Update tentacle on
   this computer"); a failed read keeps the last list + `WORKFLOWS_OFFLINE` (first read failing →
   `error` with the reason, no spinner loop); `blur`/`dispose` stop listening, nothing lands after
   dispose; `workflowsHub(state)` = the hub figure (undefined while unknown). Red: 11 of 12 fail on
   a stub (the dispose case is green on a no-op stub by construction — its non-vacuity is M8).
6. NEW `src/workflow-run-controller.ts` (pure): `open(sessionId)` — never `reopen`; archived /
   deleted / gone → `ended` + "This session has ended"; other failures → `failed`; a session another
   screen already follows is **borrowed** and never `leave`d (`createSessionController` keeps one
   handle per id with no refcount — leaving would detach the Session screen underneath); the run by
   `runId` from `onWorkflows`; mode via an injected store; ask ↔ step via `askForStep` (exact
   `<runId>.<stepId>`, the run's own `<runId>` is `runAsk`); `answer` → `asks.answerFor(thatRequestId)`
   or the notice `RUN_ASK_GONE`; stop / resume / rerun → `session.workflow(...)`, a refusal is a
   notice. Plus `askSourceFromSheet` (the sheet's `asking` state → a card ask, title/detail verbatim,
   only with a daemon `requestId`). Red: 14 of 15 fail on a stub; `askSourceFromSheet`'s 3 tests were
   written with it (non-vacuity: M2).
7. Screens `src/screens/WorkflowRuns.tsx`, `src/screens/WorkflowRun.tsx` (dumb renderers; graph via
   `graphGeometry` + `react-native-svg`, already a dependency `package.json:39`; approve block =
   title + detail in a `ScrollView`, no `numberOfLines`, Allow once / Deny; in graph mode the step
   asks are drawn above the graph so they stay answerable).
8. `App.tsx`: `SESSION_SCREENS` (the Session screens that are up, by `sessionKey`) so a run screen
   answers through THAT screen's sheet — no second requester on the broker; `useWorkflowRuns`
   (wiring for the runs controller); `SessionRoute` feeds `workflowsHub` + `onOpenWorkflows`;
   `WorkflowRunsRoute` / `WorkflowRunRoute`; two `Stack.Screen`s (plain pushes). `SessionScreen.tsx`:
   two optional props → `hubContextOf({workflows})` and `hubEntries.workflows` only.
9. NEW `test/workflow-screens-wiring.test.ts` (source-reading, the `hub-tools-wiring` pattern): both
   routes exist, no `<Modal>`, the detail is never line-capped and is scrollable, no `allow_always`,
   the run route attaches via `RUNTIMES` without `reopen`, answers only via `screen.sheet().answerFor`,
   borrows a followed session, and the Session screen wires the item.
10. `changelog.d/workflows-ui.added.md`: the one existing `added` bullet EXTENDED with the iPhone
    sentence (one fragment per slug+category, as 1b did).

**Drift from Implementation (recorded, not forced):**
- **No ask for a session whose screen is not up.** The plan says the run controller answers
  "through the phone's existing sheet path". That sheet is the Session screen's (its requester is
  the client's ONE broker requester); a run reached from the list for ANOTHER session has no sheet,
  and building one would be a second requester. So such a card shows "Open the session to answer
  it" (→ that Session, where the native sheet answers it verbatim) and no buttons. From the hub of
  the run's own session (the plan's entry point) the buttons work.
- **Mode memory is per app run (in memory), not persisted to disk.** "persisted per app" would need
  a new storage key and store; the module-level `WORKFLOW_RUN_MODE` keeps it for the app's life.
  Follow-up if the owner wants it across launches.
- **The hub figure comes from `workflow/list` read per mounted Session screen** (`useWorkflowRuns`
  in `SessionRoute`), so the badge refreshes on focus and on any run notice (debounced). The run list
  screen has its own controller instance (two reads at most; no shared cache added).
- `HubFan.tsx` touched (one icon), as above.

**Mutation checks (each applied with `sed` on the file, run, restored from a scratch copy; `cmp`
identical after each):**

| # | Mutation | Result |
|---|---|---|
| M1 | `answerFor` ignores the `requestId` | **RED** — "a card for an ask that is no longer on screen answers NOTHING" |
| M2 | `askSourceFromSheet` drops the agent id | **RED** — "the ask on the sheet, title and detail VERBATIM" |
| M3 | run controller `leave`s a borrowed session | **RED** — "leaving detaches a session this screen opened — never one another screen follows" |
| M4 | archived/gone/deleted reported as `failed` | **RED** — "a session that ended between list and tap…" |
| M5 | run controller opens with `{reopen:true}` | **RED** — "opens the session WITHOUT reopen" |
| M6 | runs controller reads on every notice (no debounce) | **RED** — 2 (debounce; blur) |
| M7 | a failed read drops the kept list | **RED** — "link down: the LAST list stays…" |
| M8 | a read lands after `dispose` | **RED** — "a read that lands after dispose changes nothing" |
| M9 | `workflowsHub` dims a still-loading list | **RED** — "unknown (loading, error) is undefined" |
| M10 | the hub never dims Workflows | **RED** — "no run (or an older daemon) dims it…" |
| M11 | the ask detail gets `numberOfLines={3}` | **RED** — wiring "the ask's detail is never cut to a line count" |
| M12 | `App.tsx` run route opens with `{reopen:true}` | **RED** — wiring "it attaches through RUNTIMES, never with `reopen`" |

**Narrow gate (mine).** `bun test` on the touched files (`hub-actions`, `hub-session`,
`permission-sheet`, `routes`, `workflow-morph-skeleton`, `workflow-runs-controller`,
`workflow-run-controller`, `workflow-screens-wiring`, `workflow-list-graph`): **233 pass, 0 fail**;
plus 22 existing source-reading guard files over `App.tsx`/screens/hub (`hub-*-wiring`,
`native-sheets-wiring`, `session-screen`, `sheet-plan`, `motion-literals`, `e2e-shard`, …): **592 pass,
0 fail**. `tsc -p apps/mobile --noEmit`: clean. `bunx biome check` on the 20 changed/new files: clean.
No protocol change → no `protocol.json` regeneration, no `protocol.d/` note.

**NOT done (PARTIAL) — the e2e flow + seed (P1–P6 shots).** Not started: `e2e/seed.ts`
`startWorkflow` (write `demo.yaml` under `<serveCwd>/${PROJECT_PATHS.workflows}` with an `agent`
step on the mock model, a `run` step `echo ok`, an `approve` step; start it through the seed's own
`RemoteClient`), a flow file, and its registration in `e2e/run.ts` (the flow list at `:1849` and
the env-id map at `:1968`). **Number drift:** the plan's `42-workflow-shots` is taken
(`42-native-sheets-*`, `43-native-sheets-lock`): use `44-workflow-shots`. Exact next step: read
`e2e/run.ts` around `:1840-1980` for how `42-native-sheets-shots` gets its seeded id, add
`startWorkflow` to `seed.ts`, then the flow (hub → Workflows → run → cards → approve card → Allow
once). Also unverified without the simulator: whether the Session screen's native Permission sheet
is pushed over a `WorkflowRun` route on top of it (both answer through the same sheet, so the result
is consistent either way, but the visual must be checked in that run).

**Known limits (below the bar).** A card tap inside the sheet's 400 ms age guard is ignored and
reads "That request is no longer waiting" (the sheet returns one `ignored` for both); the screen
could dim the buttons while `armedInMs > 0`.

### Fix round 3 (orchestrator gate after exec: mockup-kit drift)

The gate's one failure: `scripts/test/mockup-kit.test.ts` → "drift: committed
`tools/mockup-kit/generated/*` === regenerated from source" RED, `kit-data.json:21: committed
«HubFan.tsx 4826433c…» ≠ source «cc651f77…»`. Root cause: Slice 3 added the `workflows:
"list.bullet"` glyph to `apps/mobile/src/ui/HubFan.tsx` (D4), and the kit's `kit-data.json` carries
each source file's sha + the folded `GLYPH` map, so both entries drifted — the generated file was
never regenerated. Fix: `bun run mockup-kit` (= `bun scripts/mockup-kit.ts gen`), which rewrites only
that one file, and only its HubFan sha line and the new `"workflows": "list.bullet"` entry. No
generator source touched. Verified: `bun test scripts/test/mockup-kit.test.ts` 37 pass / 0 fail;
`bunx biome check tools/mockup-kit/generated/kit-data.json` clean.

### Slice 4 — iPhone morph + skeleton (D5) — PARTIAL (code + unit/wiring tests done; the e2e flow + shots NOT done)

*— claude-code 2.1.325 harness, 2026-11-24 (the harness exposes no underlying model id: `AI_AGENT=claude-code_2-1-325_agent`, `CLAUDE_CODE_ENTRYPOINT=cli`; recorded verbatim instead of guessed)*

**Load-bearing check (PARTIAL rule) — PASSES.** `RemoteClient.workflowList` exists
(`packages/client/src/remote-client.ts:1646`, `MethodNotFound` → `{unsupported:true}`) and
`RemoteSession.workflowStep` exists (`packages/client/src/remote-session.ts:1352`), plus the
`onWorkflows` feed (`:1280`) the layer's rows come from. So slice 3's data path is there and the
read the detail needs is reachable — no PARTIAL stop.

**As built, in dependency order (red first for every pure module: each new test file was run against
the un-implemented code and failed on ASSERTIONS, never on an import).**

1. `src/workflow-morph.ts`: **`morphTable(from, to, samples = MORPH_SAMPLES)`** — the `Animated`
   interpolation table the layer drives: `inputRange` 0..1 from `samples` (clamped to ≥ 2, so a
   degenerate count can never build an empty range) and one `outputRange` per animated part, each
   sample being `morphFrame(t).<part>` — so `morphFrame` stays the ONE source of the motion.
   `ROW_FADE_MS` (260) was already there and is reused as the rows' fade length. Red:
   `test/workflow-morph-table.test.ts` 4 fail (`morphTable is not a function`, then the table's own
   assertions).
2. `src/workflow-run-controller.ts`: the **step-detail read**, on the existing pure controller —
   `openStep(stepId, attempt?)` / `closeStep()`, `RunState.openStepId`, `StepCard.detail`, a
   `StepDetail` union (`loading | loaded | missing | unsupported | failed`). One read in flight per
   step, one record per step kept across close/reopen, a re-run of the step drops its stale record,
   a late read lands on ITS step (never the open one), and a handle with no `workflowStep` says
   update tentacle instead of guessing. `RunSessionHandle.workflowStep` is optional (the handle is
   the Session screen's subset too). Red: `test/workflow-run-step-detail.test.ts` 9 fail.
3. NEW `src/workflow-step-detail.ts` (pure, React-free): `canvasMap` (the graph's logical space →
   the screen, never magnified past 1:1), `nodeBoxOnScreen`, `heroBox`, `flight` (the two ends of
   the morph, or null), `heroText`, `stepBlocks` (the controller's `DetailBlocks` from the row's
   own fields — final before the read), `detailLog` (a non-loaded state SAYS so in words, and a
   loaded one is `prompt:` then `report:`/`running now:`), `bodyPending`. Red:
   `test/workflow-step-layer.test.ts` 19 fail on a stub module.
4. NEW `src/screens/WorkflowStep.tsx`: the **layer** inside the run screen — ONE progress value,
   every hero part `interp(table.<part>)` (JS driver: they are layout props), the graph fading over
   the same flight, the rows staggered by `rowStartMs`, the log block skeleton `skeletonBars(...,
   reduceMotion)` until the read lands, `morphLook` picking the crossfade under Reduce Motion, and
   `busy` ignoring a tap mid-flight.
5. `src/screens/WorkflowRun.tsx`: the graph's nodes and the cards became `Pressable`, both calling
   the passed `onOpenStep` (the SCREEN never selects a step), and the layer is mounted as a sibling
   when `state.openStepId` names a step of the run.
6. `App.tsx`: `WorkflowRunRoute` reads `useAccessibilityFlags()` live, measures its width
   (`onLayout`), and forwards `openStep`/`closeStep`/`reduceMotion`/`width`. No new route: the
   detail is a layer, not a push.
7. NEW `test/workflow-step-wiring.test.ts` (source-reading, the `workflow-screens-wiring` pattern):
   the layer is inside the run screen and `App.tsx` adds no `WorkflowStep` route, no `<Modal>`, no
   `navigate(`; every animated part reads `table.<part>`; `useNativeDriver: false`; the crossfade
   branch reads `CROSSFADE_MS`; the run screen's taps go through the callback; the route forwards
   to the controller and never calls `workflowStep` itself; the back reverses the morph.
8. `changelog.d/workflows-ui.added.md`: the existing `added` bullet EXTENDED with slice 4's
   sentence (one fragment per slug+category, as 1b and 3 did).

**Drift from Implementation (recorded, not forced).**
- **The step detail lives in `workflow-run-controller.ts`, not a new file.** D5's list names only
  `workflow-morph.ts`, `WorkflowStep.tsx` and `WorkflowRun.tsx`; the read has to live where the run,
  its feed and the sheet's asks already are, so it is an additive slice of that controller (which
  stays pure and React-free, AGENTS §7). `workflow-step-detail.ts` is the extra pure module the
  component needed for its geometry and text — deliberately separate from the controller so the
  flight is testable without a run.
- **`skeletonBars` is used on the LOG block only**, with the hero/kv rows final at once. That is
  D5's own wording ("the kv block is final at once (from the row); `workflowStep(...)` fills
  prompt/report into the log block"), and the property it pins is the one tested: no box above the
  log block moves.
- **`gestureEnabled: false` while the detail is open is NOT wired.** It is a native-stack option for
  the ROUTE, and this route's `Stack.Screen` sets it per-screen at registration (`App.tsx:3096`); a
  dynamic flip would need the route to own the option. The layer covers the graph and consumes its
  own back, so the visible behaviour holds; the iOS edge-swipe still pops the whole run screen
  instead of closing the detail first. Follow-up, not silently assumed.
- **`width` is measured by the route (`onLayout`), not by the layer.** `Animated` needs it before
  the first frame; a self-measure would fly the first flight from a zero width.
- **The plan's `workflow-morph-skeleton.test.ts` additions are in a NEW file**
  (`test/workflow-morph-table.test.ts`), and the layer's own geometry/text in
  `test/workflow-step-layer.test.ts` / the read in `test/workflow-run-step-detail.test.ts`. Same
  properties, one file per module, as the rest of this task's suites; the existing file is
  untouched and still green.

**Mutation checks (each applied with a `python3` string replace on the file, the narrow test run,
then the file restored from a scratch copy under `.tentacle/tmp/workflows-ui/`, `cmp` identical).**

| # | Mutation | Result |
|---|---|---|
| M1 | `detailLayout` lays the log block ABOVE the kv rows | **RED** — 2 (`every box above the log block is IDENTICAL…`, `the log block only grows DOWNWARD…`) |
| M2 | `morphTable` pins every sample to `morphFrame(0)` | **RED** — 2 (`EVERY output equals morphFrame at that sample`, `the endpoints are EXACT`) |
| M3 | the per-step in-flight guard removed | **RED** — `ONE read in flight per step` |
| M4 | a late read paints on the OPEN step | **RED** — `a LATE read… lands on ITS step, never the open one` |
| M5 | `{}` reported as a loaded empty detail | **RED** — `{} says so — it is not silence` |
| M6 | `rerun` keeps the step's old detail | **RED** — `a re-run of the step drops its stale detail` |
| M7 | a rejected read is swallowed | **RED** — `a rejected read is a failed detail with its reason — never a stuck skeleton` |
| M8 | no `workflowStep` on the handle reads as `missing` | **RED** — `a handle with no workflowStep says update tentacle` |
| M9 | the flight starts at the hero instead of the node | **RED** — `it is the node's screen box and the hero's` |
| M11 | `canvasMap` magnifies the graph past 1:1 | **RED** — `draws it at 1:1, CENTRED (never magnified)` |
| M12 | a non-loaded detail renders as silence | **RED** — `every non-loaded state SAYS so in words` |
| M13 | the back pops the stack instead of reversing the morph | **RED** — wiring `the back reverses the morph (it does not pop the stack)` |
| M14 | the hero's `left` is a literal instead of `interp(table.box.x)` | **RED** — wiring `every animated property is an interpolation of the SAME morphTable` |
| M15 | the run screen ignores the graph node's tap | **RED** — wiring `both the graph node and the card open through the passed callback` |
| M16 | the route stops forwarding `openStep` | **RED** — wiring `the route forwards them to the controller` |

Two mutations first came back GREEN and both were **test** defects, fixed before recording:
M4's test called `closeStep()` first (so the mutation was a no-op — now the second step is opened
instead), and M7's thrown-read test had no steps on its feed (so the read never started — the
fixture now carries one). M10 (the view-model's log-before-kv order) is not reachable in
`workflow-step-detail.ts`: the draw order lives in `detailLayout`, which M1 covers.

**Narrow gate (mine).** `bun test apps/mobile/test` — **4911 pass, 0 fail** (316 files), including
the 5 new/rewritten files (`workflow-morph-table`, `workflow-run-step-detail`, `workflow-step-layer`,
`workflow-step-wiring`, plus the existing `workflow-morph-skeleton` and `workflow-run-controller`).
`bunx tsc -p apps/mobile --noEmit`: clean. `bunx biome check` on the 10 changed/new files: clean.
`bun test scripts/test/mockup-kit.test.ts`: 37 pass (no `HubFan`/glyph drift this slice). No protocol
change → no `protocol.json` regeneration, no `protocol.d/` note. The full `bun test` / repo-wide
typecheck / lint are the orchestrator's gate (owner's token budget), not run here.

**NOT done (PARTIAL) — the e2e flow and the P7–P10 shots.** The plan's slice 4 asks for a flow
"and e2e flow" with (P7) mid-morph frame, (P8) skeleton, (P9) detail loaded, (P10) Reduce Motion on.
That flow is **`44-workflow-shots`, which slice 3 never wrote either** (its Execution says so: the
seed's `startWorkflow`, the flow file and its registration in `e2e/run.ts` — the flow list at
`:1849` and the env-id map at `:1968` — are all missing). Slice 4's shots are frames INSIDE that
same flow, so writing them means writing slice 3's missing half first: a different slice, a
different red-first cycle, and its own acceptance. **Exact next step for whoever picks it up:**
`seed.ts` gains `startWorkflow` (write `demo.yaml` under `<serveCwd>/${PROJECT_PATHS.workflows}`
— an `agent` step on the mock model, a `run` step `echo ok`, an `approve` step — and start it
through the seed's own `RemoteClient`), then `flows/44-workflow-shots.yaml` walks hub → Workflows →
the run → graph node tap → (P7/P8/P9) → Reduce Motion on → tap again (P10), registered in both maps
of `run.ts`. Unverified without a simulator, and stated as such: the mid-flight frame, the
skeleton's own shimmer, and whether the native Permission sheet draws over this layer.

### Slice 5b — iPhone "Start a workflow": catalogue + inputs form + start (D6) — PARTIAL (code + unit/wiring tests DONE; e2e flow + seed NOT done)

*— deepseek-v4-pro (executor), 2026-11-24*

**Load-bearing re-check — already RE-RUN and PASSED by the orchestrator (recorded, not redone).**
`RemoteSession.workflowCatalogue` (`packages/client/src/remote-session.ts:1333`) and
`RemoteClient.workflowCatalogue` (`remote-client.ts:1669`) exist; the driver refuses a stale hash
`changed` (`packages/agent/src/workflow-driver.ts:498-506`); `WorkflowRefusalSchema` /
`workflow.refusal` are on the wire (`packages/protocol/src/session.ts:936-951`, a bounded free word,
never an enum). Wire shapes: `WorkflowDefRow = {name, path, ok, version?, description?, hash?,
approved?, inputs?:[{name,required,default?}], steps?:[{id,kind,model?,where,command?}],
errors?:string[]}` and `WorkflowCatalogueResult = {workflows, truncated?, unavailable?, gitIgnored?,
dir, elsewhere?:{dir,count}}` (`session.ts:1000-1058`). `WORKFLOW_INPUTS_MAX_CHARS = 4*1024`
(`:870`), `WORKFLOW_INPUT_NAME_MAX_CHARS = 64` (`:868`), both re-exported from `@tentacle/protocol`.
The daemon applies a file's `default` itself when an input is OMITTED (`resolveInputs`,
`packages/core/src/workflow-machine.ts:144-152`) and refuses unknown names / missing required ones
(`inputsProblem`, `workflow-driver.ts:323-333`) — **so an empty optional input must be OMITTED,
never sent as `""`** (that would override the default). That sentence is what the whole slice hangs
on; mutation (a) below proves the test binds it.

**As built, in dependency order (red first: each test file was run against a stub and failed on
ASSERTIONS — 19 of 23, then 20 of 22, 11 of 12 — never an import error; the few incidental passes
are listed with the mutation table because they were masked and had to be sharpened).**

1. NEW `apps/mobile/src/workflow-start.ts` (pure, React-free, English labels): `CatalogueView`
   (six `kind`s: loading/unsupported/unavailable/empty/ready, plus `dir`, `valid`, `invalid`,
   `truncated`, `gitIgnored`, `elsewhere`, `reason`), `CatalogueEntry` (its `approval` is
   glyph+word — `✓ Approved` / `? Needs approval`, never hue alone), `catalogueRows` (valid rows
   sorted by name first, then invalid ones with their `errors` verbatim; `{unsupported:true}` →
   `unsupported`; `unavailable` → `unavailable` with its reason; neither → `empty` with `dir` +
   `elsewhere`), `openEntry`, `startHash`, `formFor` (one field per declared input, prefilled with
   `default`, a typed value winning — which is what a `changed` reload keeps), `formProblems`
   (required-and-empty, a value over `WORKFLOW_INPUTS_MAX_CHARS`, control characters, the whole
   JSON over 4 KiB with `field: null` — a HINT only, the daemon decides), `startParams` (declared
   names only, blank optional OMITTED, `inputs` absent when nothing is left, `hash` pinned, `null`
   when the row has none), `afterRefusal` (`changed`→reload, `running`→openRun *only with an id*,
   anything else→showReason). Untrusted file text goes through `oneLine` from `./activity.ts`; a
   `run` step's `command` is deliberately NOT flattened or cut.
2. NEW `apps/mobile/src/workflow-start-controller.ts` (pure, injected session — `workflow-run-controller.ts`'s
   shape: `StartSessionHandle`, `StartState`, `createWorkflowStartController({sessionId, open, leave,
   borrowed, onOpenRun, onChange})`). `start()` opens (never `reopen`) then reads; `pull()` re-reads;
   `openRow` prefills from `formFor`; `setValue` recomputes the problems; `canStart()` = ready && row
   ok && has hash && not starting && no problems; `beginStart()` → `startParams` →
   `workflow({action:"start", …})`; `changed` → `reload()` (banner + `keepSurvivingValues`);
   `running` → notice + `onOpenRun`; else the daemon's reason. One read and one start in flight (a
   trigger during a read = one more read after it); a failed read KEEPS the last catalogue and says
   so (never a spinner loop); nothing lands after `dispose`, which `leave()`s only when not
   borrowed. `SESSION_ENDED` is imported from `workflow-run-controller.ts` (one string, two screens).
3. `apps/mobile/src/routes.ts`: `WorkflowStartRoute {computerId, sessionId}` + its `RootStackParams`
   entry beside `WorkflowRuns`/`WorkflowRun`. `routes.test.ts` needed no change (it does not
   enumerate the map).
4. NEW `apps/mobile/src/screens/WorkflowStart.tsx` (dumb renderer, AGENTS §7): header, the folder
   line (`dir`, "not versioned" when `gitIgnored`, truncation, the `elsewhere` hint), valid rows
   (`workflow-start-row-<name>`), broken rows with every error verbatim (`workflow-start-broken-`,
   `workflow-start-errors-`) and NO Start, the detail (`workflow-start-detail`) with the description,
   the FULL step list (each `run` command verbatim — no `numberOfLines`, no `ellipsizeMode`, pinned
   by the wiring test), the inputs form (`workflow-start-input-<name>`, placeholder = the file's
   default) and Start (`workflow-start-run`). Every id the plan named exists.
5. `apps/mobile/src/screens/WorkflowRuns.tsx`: new optional `sessionId`/`onStart`, and a
   `workflow-runs-start` "Start a workflow" entry rendered ONLY when both are present (and disabled
   while the list is offline — a down link cannot start anything).
6. `apps/mobile/App.tsx` (wiring only): `WorkflowRunsRoute` gains `sessionId?`/`onStart` and passes
   them through only when the launch carried one; NEW `WorkflowStartRoute` mirrors
   `WorkflowRunRoute` (same `LINKS.get` → `RUNTIMES.controller(link.client)` → `runtime.open(id)`,
   `borrowed: runtime.follows(sessionId)`, `session as unknown as StartSessionHandle`,
   `onOpenRun` → `navigation.navigate("WorkflowRun", …)`); NEW `Stack.Screen name="WorkflowStart"`
   beside the other two (`headerShown: false`, plain push, no `<Modal>`).
7. `changelog.d/workflows-ui.added.md`: the ONE existing bullet EXTENDED in place (no second `- `;
   `scripts/test/changelog-guard.test.ts` 5 pass).

**Drift from the plan.** (i) `catalogueRows` also flattens wire text with `oneLine`, which the plan
only implied — a multi-line description or error would otherwise break the one-row-per-file grid.
(ii) `formProblems` reports the 4 KiB *total* with `field: null` (as planned) but each per-field
message names its field, so a person sees which one to shorten. (iii) `startParams` returning `null`
is enforced TWICE (the controller's `canStart()` and again in `beginStart`), because the first
attempt's fixture could not tell the two apart — mutation (e) survived until the no-hash fixture was
given NO inputs. (iv) The runs screen disables the entry while offline; the plan did not say.

**Mutation table (AGENTS §9) — each applied to the real file with a small `python3` replace, the
narrow test run, then the file restored from `.tentacle/tmp/workflows-ui/backup/` and `cmp`-verified
identical.**

| # | Mutation | Narrow run | Result |
|---|---|---|---|
| a | optional blank sent as `""` (the omit branch deleted) | `workflow-start` | **RED** 2 fail — "an empty or whitespace-only OPTIONAL input is OMITTED", "nothing left to send → no `inputs` key at all" |
| b | `changed` → `showReason` (no reload) | `workflow-start` | **RED** 1 fail — "`changed` → reload the catalogue and review again" |
| c | reload drops the typed values (`formFor(def)` instead of `formFor(def, values)`) | `-controller` | **RED** 2 fail — "a start refused `changed` re-reads…", "a `changed` reload DROPS the value of an input the file no longer declares" |
| d | `canStart` ignores `starting` | `-controller` | **RED** 1 fail — "a start in flight disables Start and a second tap sends NOTHING" |
| e | `canStart` ignores the missing hash | `-controller` | first run **GREEN** (survived ⇒ masked by the fixture's required input); after giving the no-hash row `inputs: []`: **RED** 1 fail — "a broken row and a row with no hash can never start" |
| f | a late catalogue read applied after `dispose` | `-controller` | **RED** 1 fail — "nothing lands after dispose: a late catalogue read paints nothing" |
| g | `running` notices but never opens the run | `-controller` | **RED** 1 fail — "a start refused `running` shows the notice AND opens that run" |
| h | a failed read re-enters `loading` (spinner loop) | `-controller` | **RED** 1 fail — "a failed read keeps the last catalogue and says so (never a spinner loop)" |
| i | `dispose` leaves a borrowed session | `-controller` | **RED** 1 fail — "leaving detaches a session this screen opened — never one another screen follows" |
| j | a typed value borrowed across fields | `workflow-start` | **RED** 1 fail — "a value over the wire's bound, and control characters, are caught" |
| k | undeclared names also sent | `workflow-start` | **RED** 3 fail — "only declared names, pinned to the hash that was on screen" + the two omission cases |
| l | a step's command line-capped (`numberOfLines={1}`) | `-wiring` | **RED** 1 fail — "a `run` step's command is drawn verbatim — never line-capped" |
| m | the runs screen offers Start without a session | `-wiring` | **RED** 1 fail — "Start is offered only with a session (the catalogue is that session's)" |

(e) is the one that proved something about the TEST rather than the code, and it is recorded as
such: the sharpening is in `workflow-start-controller.test.ts` (the no-hash row now declares no
inputs, so only the hash can block it). Every other mutation was caught by the test written for it.

**Narrow gate (mine).** `bun test apps/mobile/test/workflow-start.test.ts
apps/mobile/test/workflow-start-controller.test.ts apps/mobile/test/workflow-start-wiring.test.ts
apps/mobile/test/workflow-screens-wiring.test.ts apps/mobile/test/workflow-runs-controller.test.ts
apps/mobile/test/e2e-flows.test.ts` — **137 pass, 0 fail** (6 files). `bunx tsc -p apps/mobile
--noEmit` — clean. `bunx biome check` on the 9 changed/new files — clean (6 reformatted by
`--write`, then re-checked). `bun test scripts/test/changelog-guard.test.ts` — 5 pass. No protocol
change → no `protocol.json` regeneration, no `protocol.d/` note. The full `bun test` / repo-wide
typecheck / lint are the orchestrator's gate (token budget), not run here.

**NOT done (PARTIAL) — the e2e flow and the S1–S6 shots.** The plan asks for
`43-workflow-start.yaml`, but **43 is taken** (`43-native-sheets-lock`, in `FLOWS` and asserted by
`e2e-flows.test.ts`), and slices 3/4 reserved **44** for the workflow shots — so this flow is
**`45-workflow-start`**, and it is not written. It needs a seed hook that does not exist yet (the
harness can read a file but not write one). **Exact next step for whoever picks it up:** (1)
`e2e/seed.ts` gains `workflowFixture(cwd, step)` writing, under
`join(cwd, PROJECT_PATHS.workflows)`, a `demo.yaml` (`schemaVersion: 1`, `name: demo`, `version: 1`,
`inputs: {slug: {required: true}, note: {default: "hello"}}`, one `agent` step on the mock model and
one `run` step `echo ok`) and a `broken.yaml` (an `on_fail.goto` naming a step that does not exist —
the error then names its YAML path), and on `step=edit` rewrites `demo.yaml` with `version: 2` (a new
hash); (2) `e2e/hooks.ts` routes a `workflow-fixture` hook (`?step=write|edit`) to it and `run.ts`
passes it as `deps.actions.workflowFixture: (step) => workflowFixture(runDir, step)`; (3)
`flows/45-workflow-start.yaml` walks `_pair` → computer → the seeded session →
`_hub-fan`/`hub-item-workflows` → Workflows → `workflow-runs-start` → (S1) the catalogue with
`workflow-start-row-demo` ("? Needs approval") and `workflow-start-broken-broken` → (S2) the broken
row's `workflow-start-errors-broken` → (S3) the detail with the default prefilled and
`workflow-start-run` disabled until `slug` is typed → tap Start → (S4) `perm-sheet` / `perm-allow-once`
(the hash ask) → Allow once → (S5) `workflow-run` with the step running → `workflow-fixture?step=edit`
via `runScript` → back to `workflow-start-detail`, tap `workflow-start-run` → (S6)
`workflow-start-banner`; (4) register it in `run.ts`'s `FLOWS` (~:1752-1900) and
`COMPOSE_SESSION_VARS` (~:1932-1975, its own `WORKFLOWSTART_ID`), and end it on a daemon-truth
`runScript` (the `e2e-flows.test.ts` guards: pairs through `_pair`, >1 distinct asserted id, never
ends on a bare container). **Unverified without a simulator, and stated as such:** whether XCUITest
can type into `workflow-start-input-slug` under the keyboard, whether the hash-approval sheet really
presents over this pushed screen, and the S6 banner's timing after the catalogue re-read.

## Review

### Owner answers (2026-11-23)

*— claude-opus-5-5 (orchestrator), recording the owner's words*

- **Q (start a run from the phone): YES, in scope** — owner 23/11 ~08:05: «Devo poter avviare una run dal telefono». The plan needs a way to list the project's workflows (name, version, inputs, approval state) and start one with its inputs from the iPhone, the hash approval going through the single broker as on the Mac.
- **TUI workflow view above the input only while a run is active: YES** (owner «Ok», 23/11 ~08:35).
- **App labels in English** like the rest of the app (not the Italian of the mockup): YES.

**Implementation (v2, incl. start-from-phone) APPROVED** — owner 23/11 ~09:20 («Ok approvo»). Execution order (owner): after `feat/mobile-native-sheets`.
- **Owner 23/11 ~10:30: «da terminale devo poter vedere in automatico i workflows in .tentacle/workflows».** Two requirements: (a) the workflows' home is **`.tentacle/workflows/`** (today the code reads `workflows/` at the repo root: `core/src/workflow-spec.ts:2`, `agent/src/workflow-driver.ts:86-89`, messages at `workflow-spec.ts:337-349,777`) — change it here (one constant, messages, docs, tests); NOTE: the tentacle repo's `.gitignore:28` ignores `.tentacle/`, so a versioned `.tentacle/workflows/` needs `.tentacle/*` + `!.tentacle/workflows/` there (owner to confirm); (b) the TUI shows the project's workflows **automatically** (no command needed) — e.g. a dock/status row like the schedules one, with name · version · approval state, `/workflow` to act. To be planned (plan v3).
- **Owner 23/11 ~10:30: YES** — `.gitignore` becomes `.tentacle/*` + `!.tentacle/workflows/` (tentacle repo, part of this task), so `.tentacle/workflows/` is versioned. Other repos: tentacle never edits a user's `.gitignore` by itself; the `/workflow` view says when `.tentacle/workflows/` is ignored by git (approval still works, but no versioning).

**Implementation v3 APPROVED** — owner 23/11 ~10:45 («ok»). Slice order 0 → 1a → 1b → 5a → 2 → 2b → 3 → 4 → 5b; execution after `feat/mobile-native-sheets`.

### Owner review of v3 (2026-11-23 ~11:00) — slice 0 is REDESIGNED (v3 approval suspended for slice 0)

*— claude-opus-5-5 (orchestrator), recording the owner's objections, verified in the source*

- The owner objected to «the path is built in one place and becomes a constant». Verified: the only reader is `packages/cli/src/workflow-files.ts:41` `join(cwd, "workflows")`, plus hand-written `workflows/…` strings in messages and the approval-store key (`:47-55`, `agent/src/workflow-driver.ts:86-89`, `core/src/workflow-spec.ts:337-349,777`). Two real problems a constant does not fix: (1) it resolves against **`cwd`**, not the **project root** — started in a subfolder (`~/tentacle/apps/mobile`) tentacle would look in `apps/mobile/.tentacle/workflows`; (2) **`.tentacle/` is already used by other features, each with its own hand-written path**: `.tentacle/hide` (`cli/src/workspace-mount.ts:252,287`, `cli/src/engine-select.ts:373,421,446`), `.tentacle/tool-output` (`agent/src/agent.ts:2973`).
- **Owner decision:** slice 0 becomes ONE project-paths module in core: find the project root (git root, or the nearest ancestor with `.tentacle/`, decide and justify; what for a non-git dir like `~/assistant`), define `.tentacle/` and its children (`workflows`, `hide`, `tool-output`, …) with the symlink/escape checks in ONE place, and migrate **workflows, hide and tool-output** to it (no behaviour change for hide/tool-output beyond the root resolution — say exactly what changes, if anything, e.g. a pod/container workspace or `--cwd`).
- «Approvals are not migrated, workflows must be re-approved»: irrelevant (no approved workflow exists yet: the feature landed 23/11 04:45) — drop it from the plan.

**Implementation v4 APPROVED** — owner 23/11 ~10:48 («ok»). Slice 0 = shared project-paths module (project root, not cwd); execution after `feat/mobile-native-sheets`.

### Owner review of v4 (2026-11-23 ~11:25) — project root = cwd, NO upward walk

*— claude-opus-5-5 (orchestrator), recording the owner*

- The owner found v4's root walk (up to any `.git`, else the nearest `.tentacle/`, stopping before `$HOME`) «sporca e fuori controllo»: implicit, depends on folders you don't see, two rules for one thing.
- **Decision: the project root is the directory tentacle runs in (`cwd`), full stop — no upward walk.** (Same as today's project config and the mount folder's `.tentacle/hide`.)
- **Visibility instead of magic:** when started in a subfolder of a project that has workflows higher up, tentacle SAYS so and does not use them (e.g. the TUI workflows row: «no workflows here — ~/tentacle/.tentacle/workflows has 3 (start tentacle in ~/tentacle)»); the `/workflow` view always names the folder it reads. Bounded, read-only, display-only check (say how far it looks and why it cannot change behaviour).
- Verified with the owner (subagents): the driver reads YAML + prompts once at start from the session cwd (`cli/src/workflow-files.ts:37-41`), children cannot start/stop workflows (`agent/src/subagent.ts:432-434`), children share the session cwd — so root = cwd keeps the workflow's files and the agents' working folder the same. In a container, root = the mounted folder (unchanged).
- Keep the single project-paths module (names of `.tentacle/` children, symlink/escape checks once); drop `findProjectRoot`'s walk; re-check what 0b (hide) still needs (likely nothing beyond using the module's names).

**Implementation v5 APPROVED** — owner 23/11 ~11:40 («approva v5»), incl. the recommendation: `hide` keeps its own stricter symlink reader. Slice order 0 → 1a → 1b → 5a → 2 → 2b → 3 → 4 → 5b; execution after `feat/mobile-native-sheets` merges (owner order), after resolving `fix/workflow-approve-detail` (same file).

### Adversarial review — slices 0, 1a, 1b, 5a, 2, 2b (fresh context)

**Verdict: REQUEST-CHANGES** (one MEDIUM convergence bug in 5a; one MEDIUM silent truncation).

**Gate (re-run by the reviewer).** Touched test files (agent workflow-catalogue/driver, cli
local-runtime/project-fs/workflow-files/-gitignored/-wiring/subagent-panel-controller, client
workflows-client, core project-paths/workflow-spec, all of `packages/{daemon,protocol,tui}/test`):
**5350 pass, 1 skip, 0 fail** (387 files). `bun run typecheck`: clean. `bun run lint`: clean (2336
files). The full `bun test` was NOT run here (owner's token budget) — the merge gate runs it.

**Findings.**
1. **MEDIUM — one valid workflow blanks the whole catalogue as "unavailable"**
   (`packages/protocol/src/session.ts` `WorkflowDefStepSchema.command: max(4096)` vs
   `packages/core/src/workflow-spec.ts` `run: z.string()` uncapped, bounded only by the 16 000-char
   approval summary; `packages/daemon/src/hosted-session.ts` `workflowCatalogue` parse fallback).
   Scenario: `.tentacle/workflows/big.yaml` with one `run:` of 5 005 chars — `validateWorkflow` says
   `ok`, so the driver emits an `ok:true` row; `WorkflowCatalogueResultSchema.safeParse` fails
   (repro below), and the daemon answers `{workflows: [], unavailable: "the catalogue could not be
   read: …"}`. Every OTHER valid workflow vanishes: the TUI at-rest line paints nothing, the `/workflow`
   section says this session cannot run workflows, the phone (5b) gets no Start. Exactly the
   "one bad file loses the catalogue" the errors-sanitizer comment says it prevents, and a silent
   wrong state ("unavailable" ≠ "one file is too long"). Fix: cap per row (the row → `ok:false` with
   an error naming the step) or align the wire cap with the spec's, and test it red-first.
2. **MEDIUM — validation errors are joined and cut, not listed** (`packages/agent/src/workflow-driver.ts`
   `catalogue()` `errors: [prepared.reason]`; `hosted-session.ts` `.slice(0, 300)`). `prepareSource`
   joins every validator error with `"; "` behind the path prefix; the catalogue puts that ONE string
   in `errors`, and the daemon cuts it at 300 chars with no `…`. D6's failure-mode row ("an `ok:false`
   row with **every** error and its YAML path") does not hold: a file with several errors shows the
   first ~270 chars and the rest disappear without a marker. Not recorded as drift in 5a's Execution.
   Fix: return `validation.errors` as the array (each one line, ≤ 300, ≤ 20, `+k more` if over).

**Repro (finding 1), `.tentacle/tmp/workflows-ui/rev/cat.ts` against this worktree's sources:**
```
validate ok? true                                   # 5005-char run command is a VALID workflow
catalogue with one 5005-char command parses: false  # → daemon answers `unavailable`
no-driver answer (dir:'') parses: false             # see note (a)
```

**Mutations (each red, reverted from a scratch copy; `git diff --stat` empty after each).**

| Mutation | Red test |
|---|---|
| `remote-client.ts` live `workflows` frame ungated (`if (true)`) | workflows-client "with the bit OFF … the frame is DROPPED" |
| `remote-session.ts` `workflow()` uses `randomUUID()` without `mint` | 3 tests (start / resume+rerun / start{hash} own their turn) |
| `workflow-driver.ts` stale-hash check → `false` | workflow-catalogue "a STALE hash is refused `changed`, zero asks, no row" |
| `session-log.ts` `workflowStepDetail` ignores `attempt` | workflow-step-detail "omitted is the LAST attempt…", "an attempt never ran is `{}`" |

**§7 attacks tried.**
- *Pod trust:* live frame and snapshot field both gated on `daemonWakes` (`remote-client.ts`
  workflowsChanged call sites); `workflow()` and `workflowCatalogue()` refuse locally with the bit
  off and send nothing. Holds. (`workflowStep` is ungated, but a pod has no driver and the panel only
  lists runs from the gated feed — no pod text reaches it in practice.)
- *Single broker / hash approval:* the hash check sits after `prepare`, before the inputs check and the
  slot claim, so a stale start asks nothing; catalogue asks nothing (spy-tested). Holds.
- *Peer not serialized:* `workflow_step` is synchronous over retained slots; `workflow_catalogue` is
  async I/O with no lock/await on a shared mutex. Holds.
- *Protocol:* two new methods + optional fields on strip schemas, no update kind added → no
  `protocol.d/` note needed. Holds.
- *Pure modules:* coalescing rule is the pure `catalogueRefresh`; `useCatalogue` only executes edges.
  Acceptable.

**Notes below the bar (not blocking).** (a) The no-driver answer `dir: ""` violates the schema's
`dir: min(1)` — a client would reject it as a parse error; unreachable today (no trusted client meets a
driverless session), but the test pins a value the wire refuses. (b) `useCatalogue.resetCatalogue`
is never called: after a session switch the previous session's catalogue stays painted until the new
read lands (forever if it fails); a pinned stale hash is refused `changed`, so it is safe, only stale.
(c) Plan drift accepted as recorded: `workflow_step` uses `lookup` (needs open) not `readable`; Enter
on a catalogue row does not start (2b "Not done").

**Executor behaviour.** Thorough, honest Execution sections with recorded drift and real mutation
tables (2b's M3/M4 caught genuine gaps). Missed: the wire-vs-spec cap mismatch on `command`, and the
errors-array collapse, both in 5a. Reviewer is the same model family (Opus) as the planner, not as the
executors; shared planner blind spots may survive.

*— claude-opus-5-5, 2026-11-23*

### Round 2

**Verdict: APPROVE** (scope: `git diff HEAD~1`, commit `cfdaa323`, fixing round 1's two findings).

- **#1 (one valid file blanked the catalogue) — FIXED.** `hosted-session.ts` `catalogueRow` judges
  each row against `WorkflowDefRowSchema` on its own; a row the wire refuses becomes `ok:false` with
  errors naming the step (`step "build" command: …`), the other rows stay, `unavailable` is not set.
  Mutation: return the unchecked row → RED ("a VALID workflow the wire cannot carry is ONE ok:false
  row…").
- **#2 (errors joined and cut silently) — FIXED.** `prepareSource` returns `validation.errors` as an
  array, `catalogue()` passes it through; `boundedWorkflowErrors` keeps each one on one line, ≤ 300
  chars ending in `…` when cut, and past 20 puts `+k more` in the last slot. Mutations: `errors:
  [prepared.reason]` → 3 RED (agent catalogue + 2 hosted); drop `+k more` (plain slice to 20) → RED.
  Every mutation reverted from a scratch copy; `git status` clean after each.
- **Regressions looked for in the diff:** the replacement row's `name`/`path` are one line and capped,
  so it always parses; `capWithEllipsis` does not split a surrogate pair; `reason` (the start refusal
  text) is unchanged. None found. Left as before (not part of round 1): a top-level `dir`/`elsewhere`
  over 1024 chars still fails the whole answer, and the no-driver `dir: ""` (note (a)).
- **Gate:** `bun test packages/daemon/test packages/agent/test` 2271 pass, 1 skip, 0 fail;
  `bun run typecheck` clean; `bun run lint` clean (2336 files). Full `bun test` not re-run (merge gate).

*— claude-opus-5-5, 2026-11-23*

### Adversarial review — slices 3, 4, 5b (fresh context)

**Verdict: REQUEST-CHANGES** (two MEDIUM; no HIGH). Same model family as the slice-3 executor
(fresh context only) — shared blind spots possible.

**Gate (mine):** touched mobile suites (`workflow-*`, `hub-actions`, `hub-session`,
`permission-sheet`, `routes`, `e2e-flows`) 405 pass / 0 fail; `bun test apps/mobile/test` 4971 pass /
0 fail; `bun run typecheck` clean; `bun run lint` clean (2371 files). Full `bun test` not re-run.

1. **MEDIUM — a `live` step detail is cached forever (stale "running now:").**
   `apps/mobile/src/workflow-run-controller.ts:243` returns early when the step's record is `loaded`,
   regardless of `detail.live`; only a rerun from THIS screen drops it (`:342`). Repro
   (`.tentacle/tmp/workflows-ui/live-stale.ts`): open step `a` while running → `{live:true,
   report:"partial"}`; the feed then says `a` = `ok`; reopen → still `{live:true,
   report:"partial"}`, reads: 1. Same for a rerun started elsewhere (TUI, model: new attempt, old
   detail kept). Contradicts the plan's own failure row (1a: "re-asked when the row says ended") —
   a silent wrong state. Fix: don't treat a `live:true` record as final (or key the record on
   step state/attempt), plus a red-first test.
2. **MEDIUM — the step↔ask pairing on ANSWER is untested (vacuous for the security property).**
   Mutation `workflow-run-controller.ts:329` `askForStep(pending(), runId, stepId)` →
   `pending()[0]` (a card answers WHATEVER ask is on the sheet): `bun test apps/mobile/test` stays
   4971 pass / 0 fail. In the field: the card's buttons were rendered for step X's ask, the sheet
   meanwhile moved to another ask (another step, the run's hash, or a plain shell-command ask);
   the tap would `allow_once` that unrelated ask. The code is correct today; nothing pins it (M1
   pins only the sheet's `answerFor`, not which id the controller passes). Needs a test: sheet
   holds a non-matching ask → `answer("x")` sends nothing + `RUN_ASK_GONE`. Reverted; `cmp`
   identical, `git status` clean.
3. **MEDIUM (merge gate) — the missing e2e flows 44/45 block merge as-is.** Screens are only
   source-read from Bun; the property the approve card AND 5b's Start both depend on — the
   Session screen's native Permission sheet presents over a pushed `WorkflowRun`/`WorkflowStart`
   route — is unverified by anyone (slices 3/4/5b Execution say so). If it does not present, a
   phone Start waits on a hash approval nobody can see. Minimum before merge: the orchestrator's
   P1/P5/S4 shots (or a recorded manual simulator run of those three); the rest of 44/45 may be a
   follow-up TODO.

**Attacks tried, nothing found:** `open` never with `reopen` (run + start routes, App wiring);
borrowed-session `leave` (dispose before/after open); late reads after `dispose`; `answerFor`
requestId/age guard/`reply` excluded; no `allow_always` on cards; blank optional input omitted
(not `""`), `changed` reload keeps only still-declared values; `running` refusal opens the run only
with an id. Not a finding, noted: `openRow` carries a previous row's typed value into a
same-named input of another workflow (visible, prefilled).

*— claude-opus-5-5, 2026-11-24*

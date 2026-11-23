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
| 0a | `core/src/project-paths.ts` (root resolution + `.tentacle/` children + the one inside/symlink check) + node adapter; migrate **workflows** (loader, messages, approvals key, tool texts) and the **tool-output** literal; `.gitignore` exception | M · cross-module (approval-store key, tool texts, a new core seam) · standard review | `core/src/project-paths.ts` (new), `core/src/index.ts`, `cli/src/project-fs.ts` (new, node adapter), `cli/src/workflow-files.ts`, `cli/src/workflow-approvals.ts`, `cli/src/wiring.ts` (root once, `:843-848`), `core/src/workflow-spec.ts` (messages), `agent/src/workflow-driver.ts` (comments), `agent/src/agent.ts:2973` (literal from core), `tools/src/{workflow,schedule}.ts` (texts), `protocol/src/session.ts:856` (comment), tests in D7, `.gitignore`, `AGENTS.md` §6 one line, a dated note in `docs/feat/agent-workflows.md` |
| 0b | Migrate **`.tentacle/hide`** to `project-paths` (root file added, mount-folder file kept) | S · **load-bearing** (the container hide set — what a container must not read) · strong executor + mandatory fresh-context review | `cli/src/workspace-mount.ts` (`loadHideFile`, `resolveHideFile` anchor/walk split, `HIDE_FILE_LABEL`), `cli/src/engine-select.ts:373-385` (root + both files), their tests |
| 2b | TUI: the project's workflows shown automatically (D8) | M · contained · standard review | `tui/src/workflow-view.ts` (`catalogueLine`, panel section), `tui/src/useSessionLink.ts`, `tui/src/AppView.tsx`, `tui/src/components/WorkflowRail.tsx` (or a sibling `WorkflowsLine.tsx`), `tui/src/panels/workflow.ts`, `tui/src/commands/workflow.ts` |

**Order (v4): 0a → 0b → 1a → 1b → 5a → 2 → 2b → 3 → 4 → 5b.** 0a first: every later slice that
touches a workflow file reads the root and the folder from it — 5a (`listWorkflowSources(root)`,
`workflowsGitIgnored(root)`), 2b/5b (messages naming the folder), the e2e seeds of 3/5b (write
under `findProjectRoot(serveCwd)` + `PROJECT_PATHS.workflows`, never a hand-written path). 0b
depends only on 0a and nothing later depends on it; it goes second so the load-bearing change is
reviewed alone, early. 1a/1b do not read the path. 5a before the TUI (2b reads its catalogue);
5b needs 3's routes. One executor at a time; PARTIAL rule as below, plus: 0a — the D7 inventory
`rg` still returns exactly the readers listed (a new one → STOP, update D7); 0b — 0a's
`resolveInside` and `findProjectRoot` exist; 2b — `RemoteSession.workflowCatalogue` exists (5a)
and slice 2's rail is mounted.

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
  that writes `demo.yaml` under `findProjectRoot(serveCwd)` + `PROJECT_PATHS.workflows` (v4: the
  same functions the daemon uses, never a hand-written path) (an `agent` step on the mock model, a `run` step
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
- `cli/src/workflow-files.ts`: `listWorkflowSources(root): Promise<WorkflowSource[]>` (v4: `root`
  from 0a's `findProjectRoot`, folder from `PROJECT_PATHS.workflows`, checks via `resolveInside(…,
  "no-links")` — never its own path or symlink code) — ONE async
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

### D7 (v4) — ONE project-paths module: the project root, `.tentacle/` and its children (owner review 23/11 ~11:00)

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
  no line**: an empty project must not carry a permanent hint); the session cannot run workflows
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

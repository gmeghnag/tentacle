# fix/mobile-ask-surfaces — one standard «ask» on the phone: truncated command, small buttons below, origin icon, never blocking

> **Status:** context
> **Branch:** `fix/mobile-ask-surfaces`
> **Size:** M–L (split into S/M slices) · **Blast:** cross-module (mobile ask UI + ask payload on the wire: origin, step N of M) · **Suited:** Opus plan; DeepSeek/Sonnet exec per slice (owner: S/M → deepseek/sonnet); Opus review per group
> **Changelog:** `changelog.d/mobile-ask-surfaces.fixed.md`

## Context

Owner 24/11, two iPhone screenshots (`.tentacle/tmp/mobile-ask-surfaces/owner-1345-ask.png`, `owner-1346-permsheet.png`):
1. Workflow RUN screen: the step ask («Run a shell command» + a long python command hard-clipped through a line + huge Allow once / Deny above the graph) — «bruttissimo»; unclear which step it belongs to.
2. Session PermissionSheet (native sheet): the whole command fills the sheet, Allow/Deny off-screen; unclear whether the ask comes from the agent, a sub-agent or a workflow; the sheet BLOCKS switching session until answered — «non va bene».

### Owner decisions (binding; mockup `.tentacle/mockups/mobile-ask-surfaces/index.inline.html`, variant **A** with changes)
- **ONE standard ask component** in both places (session sheet + workflow run screen).
- **Origin row top-left** with icon + words: main agent = **Polpetto 9×9 silhouette** (filled, eyes as holes, monochrome template from `apps/mobile/src/mascot-scenes.ts:31` rows; see `.tentacle/mockups/mobile-ask-surfaces/polpetto-icon.html`); sub-agent = SF `arrow.triangle.branch` + its name; workflow step = SF `point.topleft.down.to.point.bottomright.curvepath` + «<workflow> · step <id> · N of M».
- **Command truncated** to ~4 lines with an ellipsis + «+N lines · Show all» (expandable; buttons stay reachable when expanded).
- **Deny · Allow once BELOW the command, smaller** (~34 pt capsules), Deny grey not red (colour-blind: words carry it); rare options in a `…` menu.
- **A = native sheet** with detents (thin row / full ask / full screen); from the thin detent the screen behind stays usable (`sheetLargestUndimmedDetentIndex: 0`), swipe-to-dismiss on (`gestureEnabled: true`).
- **Dismissing the sheet (pull down) moves the pending ask into a SLIM BANNER under the header** (tap → sheet again). **No hand badge on the hub** for it.
- **Drawer session list («peek»)**: a session with a pending ask shows ONLY `hand.raised` (no «needs you» text). A session shows the workflow symbol only while a run is **live or waiting on the user**, and `clock` only while it has a **future scheduled wake**.
- On the workflow run screen the ask points at its step (the node shows `hand.raised`, needs-approval marker per fix/workflows-ux).
- «nuovo dato»: the ask needs a structured `origin` (kind main/subagent/workflow-step, name, run id, step id, N of M) instead of parsing `agent.description`; the drawer needs per-session flags (pending ask, live workflow run, next wake) if not already in `session/list`.

### Constraints
- Native sheets: `docs/feat/mobile-native-sheets.md` (detents, lock drain). The «never blocks session switching» rule must hold: the user can always reach the drawer/back with an ask pending.
- Overlaps: `fix/workflows-ux` (WorkflowRun.tsx, workflow markers, protocol run fields, hub), `feat/workflow-editor` (phone screens, protocol). List every shared file and recommend an order.
- `kit.js` `K.permissionSheet` is behind `PermissionSheet.tsx:144-154` — update the kit too (mockups must match the app).
- Pure modules for logic (ask view-model, truncation, origin label, drawer flags); components render only (AGENTS §7). Single-broker invariant untouched; a pod's ask origin is pod-supplied (label, never trust: §7 «a pod is not trusted»).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

> **Status: APPROVED** — owner 2026-11-24 «ok»: Q1 only the slim row for a foreign ask on the run screen; Q2 yes, TUI shows the same origin (S3). Order as in ### Slices (S1b/S7a/S9 after feat/workflow-editor merges; S8 after fix/workflows-ux). Executors: DeepSeek/Sonnet (owner: S/M); Opus review per group.

### Load-bearing assumption (two facts, proved against the source)

The change stands or falls on: **(a)** what reaches the phone's requester is enough to say *who* asked
(main / sub-agent / workflow step) and *where* in the run (N of M), and **(b)** the ask sheet can be
put aside **without answering or withdrawing it**, leaving the drawer and back reachable.

**(a) Today the wire does NOT carry the origin; it carries a string pair.**
- `permission_request` (`protocol/src/permission.ts:62-104`): `tool, title, explanation, suggestion,
  options, agent{type, description, id?}, turnId, reply, askedOn`. No run id, step id, workflow name
  or step position as fields.
- A workflow step's ask gets its `agent` from `stepRequester` (`agent/src/workflow-driver.ts:1189-1196`):
  `agent: options?.agent ?? {type:"workflow", description:"<wf>/<step>", id:"<runId>.<stepId>"}`.
  - A `run` step (`:1423`) and an `approve` step (`:1492`) get the fallback.
  - An `agent` step's ask comes from its child. `subagentRequester` has already set `agent` to
    `{type: step.type ?? "general", description:"<wf>/<step>", id}` (`subagent.ts:229-234`, runner
    built at `workflow-driver.ts:1276-1286`). So `??` keeps the child's. On the wire that ask looks
    exactly like a background sub-agent's: only the `wf-N.` prefix of `id` tells them apart.
  - The run's hash approval: `id = runId` (`:1168`). A schedule's approval: `id = "approval:<name>"`,
    with no run (`:707, :724-727`).
- **N of M is nowhere in the ask.** The step's index exists only in the run's spec, on the daemon.
- The phone pairs ask → step by splitting that id (`permission-sheet.ts:89-95` `agentId`,
  `workflow-run-controller.ts:227,230` `askForStep`). The TUI prints the raw tuple
  (`tui/src/permission-ui.ts:117-123`: `wf-1.generate · general · "wf/generate" · background`).
- **"Sub-agent of a workflow step" does not exist as a third level.** The spawn tool is always
  removed from a child (depth-1 guard, `subagent.ts:10`), so the step's agent IS the only
  sub-agent there.
- ⇒ A structured field is needed (the Context's «nuovo dato»). Only the driver knows the position
  (`run.spec.steps`), so it must be the one to send it.

**(b) Today the sheet blocks. Making it non-blocking takes three code changes; one native fact is checked on the simulator.**
- **Stacking.** The sheet is a `formSheet` route above `Session` in the same native stack
  (`App.tsx:3283-3341`). The drawer is drawn by `SessionDrawerHost` around the Session route
  (`App.tsx:3117-3173`). ⇒ any presented sheet covers the drawer.
- **The block itself.** While asking, the route has `gestureEnabled: false`
  (`sheet-plan.ts:124-126,171`; `App.tsx:3299-3303`) and is dimmed at every detent
  (`SHEET_SPEC.permission.dimmed = -1`, `sheet-plan.ts:68`). That is the owner's «blocca».
- **A swipe already reaches the screen.** It arrives as `dismissedNatively` → `sheet.dismiss()`
  (`SessionScreen.tsx:1402-1406`). `dismiss` WITHDRAWS the shown ask and every queued one:
  `DISMISSED`, nothing sent (`permission-sheet.ts:541-545`). The daemon keeps it pending, but the
  phone forgets it.
- **The reconcile re-pushes whatever is wanted.** `permission: state.sheet.kind !== "idle"`
  (`SessionScreen.tsx:1233-1240`). A plain "allow the swipe" would therefore bounce the sheet back.
- ⇒ The three changes:
  - a `parked` state in the sheet controller: kept, never sent, not withdrawn;
  - `desiredStack` stops wanting `permission` while it is parked (or while the drawer is open);
  - the swipe parks the ask instead of dismissing it.
- **Drain pops stay harmless.** The lock/background drain's pops are *planned*
  (`drainPops`, `plannedPop`, `SessionScreen.tsx:1376-1386,1443-1449`), so `dismissedNatively`
  never reports them and they never park.
- **The one native fact, checked on the simulator in S6 step 1.** At the undimmed detent the screen
  behind takes touches: UIKit `largestUndimmedDetentIdentifier`, plumbed by RNS as
  `sheetLargestUndimmedDetentIndex` (`sheet-plan.ts:145,168`).
  - The rule «never blocks» does NOT depend on it: a swipe parks the ask into the in-screen banner,
    and the drawer is reachable from there.
  - If passthrough fails on the device, the only loss is «☰ straight from the peek row». It
    becomes swipe-then-☰.

### Preconditions (verified)
- **P1 — fields are free.** Strip schemas, and «display: free to add» (AGENTS §7).
  - An optional field on `permission_request` needs no `PROTOCOL_VERSION` note: an older client
    drops it and shows today's ask.
  - The update is **blocking** (`updates.ts:576`), so the new field must NEVER be able to make it
    unparseable: no `.max()`, no `.int()`. Same rule as `agent` (`permission.ts:73-81`). The client
    bounds and validates it.
- **P2 — replay keeps the field.** The pending ask is registered with its whole update
  (`hosted-session.ts:1536`), so a replay on attach carries the new field. The sidecar persists
  only `PendingPermission{toolCallId, tool, resumable, requestedAt, groupStart}`
  (`persisted-session.ts:26-37`), and a reload re-asks. ⇒ **no on-disk format change.**
- **P3 — one router for both surfaces.** The client's router builds the requester options for the
  TUI and the phone in one place (`client/src/permission-router.ts:368-390`, `agent` bounded with
  `progressText`). One mapping serves both.
- **P4 — the drawer is fresh on open.** It re-reads `session/list` every time it opens
  (`App.tsx:1557-1563`). `session/list` already has `schedules` (armed wakes, `session.ts:1983`),
  but nothing for pending asks or live runs (`session.ts:1965-1987`). The daemon has both:
  `asks` map (`hosted-session.ts:909`) and `workflows.rows()` (`:2497`). Its summary is built at
  `hosted-session.ts:2134-2152` → `daemon/src/session-list.ts:92-107`.
- **P5 — detent memory.** It is keyed by the ask's id (`sheet-plan.ts:689-695`, `recordDetent`
  `:501`), fed by the route's `sheetDetentChange` (`App.tsx:3310-3316`). The same identity keys
  the new parked memory.
- **P6 — single broker untouched.** The phone sheet is a requester behind the client router.
  Nothing here creates a second broker or answers anything. The origin is display only: it never
  feeds `autoApproves`/`ownRequest` (`permission-sheet.ts:38`) or the options.

### Design

**D1 — Wire: `permission_request.workflow` (additive, display only).**
- **Schema.** `workflow?: { name: string; runId?: string; stepId?: string; index?: number; count?: number }`
  - no bounds in the schema (P1);
  - `index` is 0-based in file order, `count = spec.steps.length`.
- **Core.** `PermissionRequestOptions.workflow` (same shape) joins `agent` in `core/src/permission.ts:176`.
- **Driver.**
  - `stepRequester(run, stepId)` ALWAYS sets
    `workflow: {name: run.spec.name, runId, stepId?, index?, count}`, OVER whatever `options` carried.
    The step's child cannot forge another workflow: it sets no such field.
  - `requestApproval` (`:724`) sets `{name}` only (a schedule's approval has no run).
  - `agent` stays as is: the TUI's background attribution and `askForStep` keep working during
    the transition.
- **Daemon.** `toPermissionRequestUpdate(…, agent, workflow)` (`permission-map.ts:44`), passed at
  both call sites (`hosted-session.ts:1367, :1532`).
- Then `bun run schema:export`.

**D2 — Shared origin (pure, `packages/client/src/ask-origin.ts`, new; used by the TUI and the phone).**
- `askOrigin(options)` →
  - `{kind:"workflow", name, runId|null, stepId|null, position:{n,m}|null}` when `workflow` is
    present (it wins over `agent`);
  - else `{kind:"subagent", type, task}` when `agent` is present;
  - else `{kind:"main"}`.
- `position` only when `index`/`count` are integers with `0 ≤ index < count ≤ 64`
  (`WorkflowRowSchema.steps.max(64)`, `session.ts:847`). Else null: the label omits «N of M».
- Strings are already bounded by the router (`progressText`). `ask-origin` cuts them again for one
  line (name ≤ 64, step ≤ 64, task ≤ 120). Nothing is ever parsed out of `description`/`id`.
- `originWords(origin)` → `{lead, rest}`:
  - main = `Main agent`;
  - sub = `Sub-agent <type>` · `<task>`;
  - step = `<name>` · `step <id> · N of M`;
  - run approval = `<name>` · `approval`.
- **Trust.** Every label is pod-supplied text (§7 «a pod is not trusted»). The icon comes from
  `kind`, never from the text: a workflow named «Main agent» still draws the workflow glyph.
- The router maps `update.workflow` → `options.workflow` (bounded) at `permission-router.ts:371`.

**D3 — Phone pure modules (`apps/mobile/src/`, React-free, unit-tested).**
- **`command-preview.ts`** — `commandPreview(text, {cols, rows: 4, cap: 400})`:
  - strip ANSI/control (`stripAnsi`); tabs → 2 spaces;
  - soft-wrap at `cols`. Mono advance is fixed, so `cols = floor(width / (fontSize × MONO_ADVANCE))`:
    deterministic, no `onTextLayout`;
  - → `{shown: string[], more: number, expandedRows: string[], expandedCut: number}`;
  - collapsed: 4 visual rows + `+N lines · Show all`. Expanded: at most `cap` rows, then
    `… N more lines not shown`, so a 5000-line command never builds 5000 `Text` nodes.
- **`polpetto-glyph.ts`** — `polpettoMask()`: a 9×9 boolean mask from `MASCOT_BITMAP`
  (`mascot-scenes.ts:30-41`).
  - filled = any cell except `.` and `E` (the eyes are holes); the empty 10th row is dropped;
  - monochrome template, drawn in the origin row's ink.
- **`ask-card.ts`** — `askCard(sheetState, ctx)` → the view-model of THE component:
  - `origin`: `{glyph: "polpetto" | "arrow.triangle.branch" | "point.topleft.down.to.point.bottomright.curvepath", lead, rest, age}`;
  - `title`; `preview`; `armed`;
  - `actions`: `[Deny(reject_once), Allow once(allow_once)]`;
  - `menu`, the rare options: Always allow `<prefix>` (only if offered) · Deny with a reply… (only
    if `reply`) · Auto-accept (only with a link). An ask with no rare option (a
    `workflow_approve`) has `menu: null`, so no `…`;
  - `alsoAsked` line; `returned` state as today.
  - `askAge(ms)` → `12s` / `3m` / `1h`.
- **`ask-park.ts`** — the parked memory: `ASK_PARKS`, keyed `computerId/sessionId/requestId`
  like `holdKey`.
  - Lets a re-delivered ask (a detach and re-attach, a session switch, the lock drain's
    `idle → asking`) come back **parked** if the person had parked it;
  - `forget` on settle.
  - `askBanner(state, parked, queued)` → `null | {title, originShort, more}`; `more` = queued asks
    behind it ("+1").
  - `askPresented({asking, parked, drawerOpen, presentable})` → bool. This is what `desiredStack`
    gets as `permission`.
  - `askSurface(detentIndex)` → `"slim" | "card"`. The peek detent draws the one-row form,
    **never buttons** (mockup: «non si risponde senza vedere il comando»).
- **`permission-sheet.ts`**:
  - `park()` / `unpark()` (state `asking` + `parked: true`, nothing resolved);
  - `dismiss()` stays only for `returned` and unmount;
  - the queue is unchanged: FIFO, one shown.
- **`sheet-plan.ts`** (permission row only):
  - detents `[PEEK, 0.5, 1.0]` with `PEEK = 0.12`. It must hold the slim row (≈ 76 pt) on a
    667-pt screen: a unit test pins `PEEK × 667 ≥ 76`;
  - initial = 1;
  - `dimmed: 0`, so behind the peek row the screen is live;
  - `sheetGestureEnabled` becomes `true` for every kind.
  - `SHEET_HOLDS`/`holdKey` note + `perm-hold` + `gestureCancel` die: there is no blocked
    gesture left to report. `holdKey`'s shape moves to `ask-park.ts`.

**D4 — Phone render (dumb).**
- **New components:**
  - `ui/AskCard.tsx`: origin row top-left · title · command box (4 rows, the footer link) · a
    bottom row `…  Deny  Allow once`, 34-pt capsules, Deny on `fill` / `label` (grey, never red),
    Allow on `accentFill`. The command scrolls inside the card when expanded; the actions are
    OUTSIDE the scroll, so they stay reachable at any detent.
  - `ui/AskSlim.tsx`: `hand.raised` · title · origin short · `Review ⌃` / `Open`.
  - `ui/PolpettoGlyph.tsx`: a 9×9 grid of `View`s from the mask.
- **`PermissionSheet.tsx`** renders `AskSlim` or `AskCard` by `askSurface(detent)`. The detent
  index reaches the content through the existing `sheetDetentChange` listener → the screen's
  host. «Show all» does NOT change the detent (RNS cannot do that imperatively): it grows the
  command area, and the person drags up for more.
- **`SessionScreen.tsx`**:
  - the banner `AskSlim` sits under the header while `askBanner ≠ null`; a tap → `unpark()`;
  - `gone.includes("permission")` while asking → `park()`; while `returned` → `dismiss()` as today;
  - `drawerOpen` turning true while presented → `park()`, so on return the banner shows, not the
    sheet (frame A5).
- **Push tap.** Opening an ask from its push un-parks it: the tap is the intent.
- **No hub badge.**

**D5 — Drawer flags.**
- **Wire.** `SessionListEntry` gains `asks?: int ≥ 0` (pending asks, `this.asks.size`) and
  `workflows?: int ≥ 0` (runs whose state is not `ok/error/stopped`, i.e. live or waiting on the
  user). Additive optional; `session/list` is a response, not blocking, so it is bounded normally.
- **Phone.** `drawer-list.ts` `rowMarks(entry, local)` → `{ask, workflow, wake}`:
  - `ask` = `asks > 0`, OR the current session's own sheet holds one (fresher than the list);
  - `workflow` = `workflows > 0`;
  - `wake` = `schedules > 0`.
- **Render.** `SessionsDrawer.tsx` draws only the glyphs: `hand.raised`, the curvepath, `clock`.
  No «needs you» words. Absent fields (an older daemon) → no glyph.

**D6 — Run screen.**
- **Presenting over the run.** The Session screen under a run of its own may present the ask:
  `sessionInFront` (`sheet-plan.ts:813`) gains `ownRunOnTop(routes, owner)`. The sheet then sits
  over `WorkflowRun` (frame A6).
- **What is presented there** is Q1's answer. The pure `askPresentable(askOrigin, topRunId)` decides.
- **`WorkflowRun.tsx`**:
  - `AskBlock` (`:52-95`, used `:142, :290, :301`) goes;
  - `AskSlim` is pinned at the foot when the ask is parked, not presentable, or `!canAnswer`
    (then `Open the session` → `onOpenSession`).
- **Step node.** It shows `hand.raised` from fix/workflows-ux's marker (the step's
  `needs-approval/waiting` state), not from here.
- **Pairing.** `askForStep` moves to `origin.runId/stepId`. The `agentId` split stays as a fallback
  only while an older daemon has no `workflow`.

**D7 — Kit.**
- `tools/mockup-kit/kit.js` gets `askCard`, `askSlim`, `askSheet`, promoted from the mockup's
  `K.extend`s (`index.html:286-310`).
- `K.permissionSheet` draws `askCard` inside the sheet frame. The mockups then match
  `PermissionSheet.tsx` again (Context constraint).

### Files (dependency order)

| Slice | Files |
|---|---|
| S1a wire types | `protocol/src/permission.ts` (`workflow?`), `core/src/permission.ts` (`PermissionRequestOptions.workflow`), `protocol/schema/protocol.json` (`bun run schema:export`); `protocol/test/permission*.test.ts` |
| S1b driver + daemon | `agent/src/workflow-driver.ts` (`stepRequester` `:1166-1214`, `requestApproval` `:724-727` only), `daemon/src/permission-map.ts`, `daemon/src/hosted-session.ts` (`:1367`, `:1532` only); tests `agent/test/workflow-driver.test.ts`, the daemon's permission-map/hosted ask test (nearest existing) |
| S2 client origin | `client/src/ask-origin.ts` (new), `client/src/permission-router.ts` (`:368-390`), `client/src/index.ts`; `client/test/ask-origin.test.ts` (new), `client/test/permission-router.test.ts` |
| S3 TUI parity (Q2) | `tui/src/permission-ui.ts` (`permissionAgentLine` → `permissionOriginLine`, `:117-123`, `:607`), `tui/src/components/PermissionPrompt.tsx`; `tui/test/` permission frames |
| S4 phone pure | `apps/mobile/src/{command-preview,polpetto-glyph,ask-card}.ts` (new); `apps/mobile/test/{command-preview,polpetto-glyph,ask-card}.test.ts` (new) |
| S5 phone park | `apps/mobile/src/ask-park.ts` (new), `permission-sheet.ts` (`park/unpark`), `sheet-plan.ts` (permission spec, `sheetGestureEnabled`, drop `SHEET_HOLDS`); tests `permission-sheet.test.ts`, `sheet-plan.test.ts`, `ask-park.test.ts` (new) |
| S6 phone render | `apps/mobile/src/ui/{AskCard,AskSlim,PolpettoGlyph}.tsx` (new), `ui/Icon.tsx` (+`arrow.triangle.branch`; +curvepath if workflows-ux S2 is not on `main` yet), `screens/PermissionSheet.tsx` (rewrite), `screens/SessionScreen.tsx` (banner, park on swipe/drawer), `App.tsx` (Sheet route: drop `gestureCancel`, detent → host), `test/native-sheets-wiring.test.ts`, `e2e/flows/08-permission.yaml` (no `perm-later`/`perm-hold`), `e2e/flows/46-ask-park.yaml` (new), `changelog.d/mobile-ask-surfaces.fixed.md` |
| S7a drawer wire | `protocol/src/session.ts` (`SessionListEntrySchema` `:1965-1987` only), `daemon/src/session-list.ts`, `daemon/src/hosted-session.ts` (`summary` `:2134-2152` only), schema export; `daemon/test/session-list.test.ts` |
| S7b drawer phone | `apps/mobile/src/drawer-list.ts` (`rowMarks`), `screens/SessionsDrawer.tsx`; `apps/mobile/test/drawer-items.test.ts` |
| S8 run screen | `apps/mobile/src/sheet-plan.ts` (`ownRunOnTop`, `askPresentable`), `screens/SessionScreen.tsx` (`inFront`), `screens/WorkflowRun.tsx` (AskBlock → AskSlim), `workflow-run-controller.ts` (pairing by origin); tests `sheet-plan.test.ts`, `workflow-run-controller.test.ts`, `workflow-screens-wiring.test.ts`, e2e `46-ask-park.yaml` (run leg) |
| S9 kit | `tools/mockup-kit/{kit.js,kit.d.ts,kit.css}`, `scripts/test/mockup-kit-components.test.ts` |

### Failure modes (how each converges)

| Failure | Converges to |
|---|---|
| **Two asks pending at once** | The sheet's FIFO is unchanged (`permission-sheet.ts:9-11`): one is shown, the next waits. The banner/peek reads `+1`. Parking parks the shown one; a new ask arriving while parked queues behind it, and the banner count rises. The drawer shows one glyph per session. |
| **Ask resolved elsewhere while the banner shows** | `permission_resolved` aborts the requester's signal → that entry resolves `DISMISSED`, nothing is sent (`permission-sheet.ts:23-26`). The state goes to the next one or `idle` → `askBanner` null → the banner goes; `ASK_PARKS.forget`. A tap racing it → `answerFor` on a gone id = `ignored` (today's contract). |
| **Sheet dismissed, then the session switched** | Parked + `ASK_PARKS` noted. If leaving the session detaches, the signal ends the local entry and the daemon keeps it pending. The drawer shows `hand.raised` (`asks > 0`, read on open, P4). Coming back, the replay re-delivers the same `requestId` → it opens **parked** (banner, frame A5), never a surprise sheet. |
| **App locked / backgrounded with an ask** | The drain pops are planned → no park (`SessionScreen.tsx:1443-1449`). On unlock the reconcile re-pushes it unless parked. Detent memory (P5) re-opens it where it was left. A parked ask stays a banner. |
| **Pod-supplied origin text** | Bounded twice (router `progressText`, `ask-origin` cut). The glyph comes from the structured kind. N of M is dropped unless `0 ≤ n < m ≤ 64`. A non-integer from a pod never breaks the blocking parse (P1) and is simply dropped client-side. The origin feeds no decision (P6). A pod can still *omit* its origin and look like the main agent: accepted, it is the agent (§7), and nothing is approved on that basis. |
| **Older daemon without `workflow`** | `askOrigin` falls back to `agent` → «Sub-agent general · wf/generate» for a step: honest, no string parsing (owner rule). Pairing on the run screen falls back to the `agentId` split until the daemon updates. No `asks`/`workflows` in `session/list` → no glyphs. |
| **Older app, newer daemon** | Strips both fields (P1) and shows today's sheet. |
| **A 5000-line (or one 50 KB line) command** | `commandPreview` wraps once and caps the expanded rows at 400 + `… N more lines not shown`. Collapsed it is 4 rows. The buttons sit outside the scroll at every detent. |
| **Sub-agent of a workflow step** | Impossible by the depth-1 guard (`subagent.ts:10`). The step's own agent asks as `workflow` (D1 wins over `agent`), so the label says the step, not «Sub-agent general». |
| **Passthrough at the peek detent fails on device** | «☰ from the peek row» does not reach the drawer. The swipe → banner path still keeps the drawer reachable (assumption b). Reported in Execution, nothing else changes. |
| **The run screen opened with no Session underneath** | `canAnswer=false` (`workflow-run-controller.ts:233`). The slim row says «Open the session to answer it» and goes there. No second host is invented. |

### Tests (red first; the property each kills)
- **S1a/S1b**:
  - the driver's ask for an `agent` / `run` / `approve` step carries
    `workflow{name, runId, stepId, index, count}` even when the child set `agent` (red today: absent);
  - the hash approval carries no `stepId`; the schedule approval carries no `runId`;
  - `PermissionRequestUpdateSchema` parses `index: 1.5` / a 10 KB name (blocking, never unparseable);
  - the daemon update carries it on both call sites.
- **S2**:
  - `askOrigin` table: main / sub / step / run-approval / schedule-approval;
  - `workflow` beats `agent`;
  - N of M dropped on `index ≥ count`, `count > 64`, NaN, negative;
  - the glyph kind ignores text («Main agent» as a workflow name);
  - the router passes `workflow` bounded.
- **S3**: a TUI frame shows `rassegna-stampa · step generate · 2 of 5`, not `wf-1.generate · general`.
- **S4**:
  - `commandPreview`: 3 lines → no footer; 23 lines → 4 + `+19 lines`; one 50 KB line → wraps, 4
    rows; 5000 lines expanded → 400 + cut count; ANSI stripped;
  - `polpettoMask`: 9×9, eyes empty, matches the bitmap (parity with `MASCOT_BITMAP`);
  - `askCard`: a `workflow_approve` has `menu: null`; Deny is never the primary look; the
    Always-allow item only with a suggestion/scope.
- **S5**:
  - `park()` resolves nothing and sends nothing (spy requester still pending);
  - a re-delivered parked id opens parked; `forget` on settle;
  - `askPresented` false while parked or `drawerOpen`;
  - `sheetOptions("permission", {asking:true}).gestureEnabled === true` (red: false today);
  - `dimmed === 0`; `PEEK × 667 ≥ 76`;
  - a planned drain pop does not park.
- **S6**:
  - wiring: a swipe calls `park` (not `dismiss`) while asking;
  - the banner renders from `askBanner`;
  - e2e `46-ask-park`: ask → swipe down → banner → ☰ → drawer opens → back → banner → tap → sheet
    → Allow once;
  - flow 08 still passes without `perm-later`.
  - Mutation check: wire `dismiss` back on the swipe → `46` fails.
- **S7**: `toSessionList` carries `asks`/`workflows`; `rowMarks` table (absent → no mark; the
  current session's local ask wins over a stale `asks: 0`).
- **S8**:
  - `ownRunOnTop([Session s, WorkflowRun s])` true, `[Session s, WorkflowRun t]` false;
  - `askPresentable` per Q1;
  - the run screen with `canAnswer=false` shows «Open the session».
- **S9**: the kit component test renders `askCard` for the three origins.

### Mac / TUI parity
- **Today the TUI does not show the same origin.** It prints
  `wf-1.generate · general · "rassegna/generate" · background` (`permission-ui.ts:117-123`).
- With S2+S3 both surfaces read ONE `askOrigin`/`originWords`. The TUI prints
  `rassegna-stampa · step generate · 2 of 5` (or `Sub-agent explore · <task>`; nothing for the
  main agent, as today).
- The rest is phone-only presentation (truncation, detents, banner, drawer glyphs). The TUI dialog
  already caps its detail rows (`MAX_DETAIL_ROWS`, `:126`) and never blocks session switching (one
  session per TUI).
- `serve` (phone) and the laptop share the daemon code, so D1/D5 hold on both hosts.

### Overlaps and recommended order
- **`feat/workflow-editor`** (in review; `git diff --stat main...feat/workflow-editor`):
  - `agent/src/workflow-driver.ts` (+415, save/source — not `stepRequester`);
  - `daemon/src/hosted-session.ts` (+230, save — not `:1367/:1532/:2134`);
  - `protocol/src/session.ts` (+149, save schemas — not `:1965`);
  - `protocol/schema/protocol.json` (`-merge`: always regenerated);
  - `tools/mockup-kit/{kit.js,kit.css,kit.d.ts}` (its D9 changes `K.permissionSheet({options})`
    — **same function as S9**);
  - `scripts/test/mockup-kit-components.test.ts` (new there; S9 extends it);
  - later slices 7a: `App.tsx`, `routes.ts`.
- **`fix/workflows-ux`** (S1–S2 executed, not merged; S4+ wait for the editor):
  - S2: `screens/SessionScreen.tsx`, `ui/Icon.tsx` (adds the curvepath), `App.tsx`,
    `workflow-runs-controller.ts`;
  - S4: `protocol/src/session.ts:808-848`, `workflow-driver.ts` (`pendingRow`/`drive`);
  - S6a: `ui/Icon.tsx`, `theme.ts`;
  - **S6b: `screens/WorkflowRun.tsx` + `workflow-run-controller.ts` — its D3 «approve bar pinned at
    the bottom (today's AskBlock, moved)» collides head-on with S8.** The owner's decision here
    («ONE standard ask component… workflow run screen») supersedes that bullet. **Amend
    workflows-ux D3/S6b: drop the AskBlock move, leave the ask to S8.**
- **Order:**
  1. **Now, in parallel with workflows-ux** (mobile files disjoint from its pending slices except
     small hunks): S1a → S2 → S3 → S4 → S5 → S6 → S7b.
     - S6 touches `SessionScreen.tsx`/`Icon.tsx`/`App.tsx`, which workflows-ux S2 also touched.
       Rebase on `main` after workflows-ux merges, or merge ours first; the hunks are far apart.
  2. **After the editor merges:** S1b, S7a (driver / hosted-session) and S9 (kit).
  3. **After workflows-ux S6b+S7 merge:** S8 (the run screen).
  - S2–S6 do not need S1b: their tests feed `workflow` directly. Until S1b lands, the live app
    shows the `agent` fallback.

### Slices (each S or M; one executor at a time)

| # | What | Size · Blast | Needs | When |
|---|---|---|---|---|
| S1a | `workflow` field: protocol schema + core option type | S · cross-module (additive wire, display only) | — | now (`protocol.json` is `-merge`: regenerated at merge) |
| S1b | Driver fills it, daemon forwards it | S · cross-module | S1a | after the editor merges |
| S2 | `ask-origin` + router mapping (shared truth) | S · contained | S1a | now |
| S3 | TUI origin line (Q2) | S · contained | S2 | now (real data once S1b lands) |
| S4 | Phone pure: preview, Polpetto mask, card VM | M · contained | S2 | now |
| S5 | Phone park state + sheet plan (detents, gesture) | M · contained (mobile) | S4 | now |
| S6 | Phone render: AskCard/AskSlim, sheet, banner, e2e, changelog | M · cross-module (mobile UI) | S5 | now |
| S7a | `session/list` `asks`/`workflows` | S · cross-module (additive wire) | — | after the editor merges |
| S7b | Drawer glyphs | S · contained | S7a for real data (tests use fixtures) | now |
| S8 | Run screen: sheet over own run, AskSlim foot, pairing by origin | M · contained | S6, workflows-ux S6b/S7 | after workflows-ux |
| S9 | Kit `askCard`/`askSlim`/`askSheet`, `permissionSheet` realigned | S · contained | S6 | after the editor merges |

Review: one Opus round per group (S1a–S3 · S4–S6 · S1b+S7 · S8–S9), per `fewer-reviews`. Simulator QA of
frames A1–A7 before the iOS build.

### Owner questions (only what the Context did not decide)
- **Q1 — On the run screen, an ask that is NOT this run's** (the main agent, another run): present
  it as the sheet over the run, or only the slim row at the foot?
  **Recommendation: only the slim row.** The person is reading this run; the sheet for it alone
  (frame A6). Tapping the row presents it.
- **Q2 — TUI parity:** should the laptop's permission dialog also say
  `rassegna-stampa · step generate · 2 of 5` / `Sub-agent explore · <task>` instead of today's
  `wf-1.generate · general · "…" · background`?
  **Recommendation: yes (S3)**, one `askOrigin` for both, per phone/Mac parity.

*— planner (claude-opus-5-5), 2026-11-24*

## Execution

### S1a — `workflow` field on the wire (executor claude-sonnet-5-5, 2026-11-24)

- **Load-bearing check re-run:** `PermissionRequestUpdateSchema` had no `workflow` (and `PermissionRequestOptions` none) — holds.
- **Red first:** the new `permission_request workflow origin` tests failed on the unchanged schema (strip dropped `workflow`: `r.data.workflow` undefined) — 2 fail / 11 pass.
- **Changed:** `protocol/src/permission.ts` (`workflow?: {name, runId?, stepId?, index?, count?}`, no `.max()`/`.int()`, P1); `core/src/permission.ts` (`PermissionRequestOptions.workflow`, same shape); `protocol/schema/protocol.json` regenerated (`bun run schema:export`); tests in `protocol/test/permission.test.ts` (carry-through, name-only, hostile values stay parseable, absent stays absent); `changelog.d/mobile-ask-surfaces.fixed.md`.
- **Green:** `permission.test.ts` + `json-schema.test.ts` 35 pass; biome clean on the 4 files.
- **Mutations (both reverted):** `index: z.number().int()` → hostile-value test fails (12 pass / 1 fail); `name: z.string().max(100)` → same test fails (12 / 1).
- **Drift:** none. No `protocol.d/` note (additive display field, P1).

### S2 — `ask-origin` + router mapping (executor claude-sonnet-5-5, 2026-11-24)

- **Load-bearing check re-run:** the router's `prompt` action had no `workflow`, and `client/src/ask-origin.ts` did not exist — holds. S1a's wire field is present.
- **Red first:** `ask-origin.test.ts` fails on the missing module. The new router tests fail on the assertions (`workflow` not on the prompt): 4 fail / 1 error before.
- **Changed:** `client/src/ask-origin.ts` (new: `askOrigin`, `originWords`; position only for integer `0 ≤ index < count ≤ 64`; strings cut name/step 64, task 120; `workflow` beats `agent`; kind never read from text); `client/src/permission-router.ts` (`prompt.workflow` typed + mapped, `progressText` on strings, non-finite `index`/`count` dropped); `client/src/index.ts` (export); tests `client/test/ask-origin.test.ts` (new), `client/test/permission-router.test.ts` (+3).
- **Green:** both files 39 pass / 0 fail; biome clean on the 5 files; `tsc --noEmit -p packages/client` clean.
- **Mutations (all reverted, files restored):** `askOrigin` ignoring `workflow` → 7 fail; `index >= count` → `index > count` → 1 fail; router `name` without `progressText` → 1 fail.
- **Drift:** none. Changelog: the S1a fragment `changelog.d/mobile-ask-surfaces.fixed.md` already covers the feature; no second fragment.

### S3 — TUI origin line (executor claude-sonnet-5-5, 2026-11-24) — STOPPED, plan contradicts the code

- **Load-bearing check FAILED:** the plan has the TUI read the same `askOrigin`/`originWords` as the phone (D2, Mac/TUI parity), and `ask-origin.ts` lives in `packages/client`. But `packages/tui/package.json` depends only on `agent`, `core`, `tools` — NOT `@tentacle/client` — and `app-types.ts:55` states it on purpose ("the TUI does not depend on `@tentacle/client`"). The TUI cannot import it without a new package edge.
- **Nothing was edited** for S3.
- **Decision needed (recommendation first):** move `ask-origin.ts` (pure, no deps) to `@tentacle/core` and re-export it from `client/src/index.ts` (the TUI already depends on core; S2's tests move with it). Alternative: add `@tentacle/client` to the TUI (breaks the stated invariant; not recommended). The TUI part is then: `permissionOriginLine(origin, agentId, columns)` replacing `permissionAgentLine` (`permission-ui.ts:117`), a `pendingWorkflow` beside `pendingAgent` (`:427,:607,:635`), `AppView.tsx:149`, and the row count in `app-layout.ts:450` (row present when agent OR workflow).

### Fix round 1 (executor claude-opus-5-5, 2026-11-24)

- **Finding 1 (MEDIUM, `workflow` never reaches a requester) — FIXED.** `packages/client/src/remote-client.ts:4880` now forwards `action.workflow` into the requester's `PermissionRequestOptions` (conditional spread, like `agent`/`requestId`). This corrects P3: the router builds the `RouterAction`, and `RemoteClient` builds the options.
- **Red first:** new test `foreign-turns.test.ts` › "a workflow step's request reaches the requester with its workflow origin". It drives a fake daemon → real `RemoteClient` → ONE `PermissionBroker` → requester spy. On the unfixed code it failed on the assertion: `expect(seen[0]?.workflow).toEqual({...})`, received `undefined`. A companion test, "a request without a workflow hands the requester no workflow", asserts that the `workflow` key is absent.
- **Green:** `foreign-turns.test.ts` + `permission-router.test.ts`: 65 pass / 0 fail. `tsc --noEmit -p packages/client`: clean. Biome is clean on both files.
- **Mutations (reverted; diff shows only the fix + tests):** (a) no forward (the original code): the carry-through test fails. (b) Unconditional `workflow: action.workflow` (the key is present even when undefined): the absent-case test fails (1 pass / 1 fail).
- **Drift:** none beyond the one-line forward. S3 remains STOPPED and waits for the owner's OK to move `ask-origin.ts` to `@tentacle/core` (Review (f)).

### S1b — the driver fills the origin, the daemon forwards it (executor claude-opus-5-5, 2026-11-24)

- **Load-bearing check re-run (passed).** On the pre-edit tree: `rg -n "workflow:" packages/agent/src/workflow-driver.ts` → **no hits** (the driver set no origin), and `packages/daemon/src/permission-map.ts` had no `workflow` parameter (its only hit was the doc comment on `permissionOptions`). S1a's `workflow?` was present on both `PermissionRequestUpdateSchema` (`protocol/src/permission.ts:89`) and `PermissionRequestOptions` (`core/src/permission.ts:181`), and the client forwards it (`remote-client.ts:4932`) — so the plan's premise (the gap is exactly these three files) held.
- **Red first (whole slice):** with all three source files reverted to their pre-edit state, the three touched test files gave **42 pass / 11 fail**; after the change, **53 pass / 0 fail**. The 11 failures are on the assertion of the property (a missing or wrong `workflow`), not on an import or a type error.
- **Changed:**
  1. `packages/agent/src/workflow-driver.ts`
     - `stepRequester` (`:1583-1600`) builds `workflow` from the RUN, not from the options: `{name: run.spec.name, runId: run.runId}` for the hash approval (`stepId === null`), plus `stepId` and `{index: findIndex, count: spec.steps.length}` for a step. `index` is 0-based in file order, `count` is `spec.steps.length` (the schema already caps a run at 64 steps, so no bound is added here — P1).
     - it is passed **after** `agent` in the requester's options (`:1624-1628`), so it OVERRIDES any `workflow` a child put there: `??` stays what `agent` gets (the transition's fallback), never what the origin gets.
     - `requestApproval` (`:1127-1129`) sets `{name: spec.name}` only — a schedule's approval has no run and no step.
  2. `packages/daemon/src/permission-map.ts` — `toPermissionRequestUpdate(requestId, toolCallId, req, agent?, workflow?)`: a 5th field, **built field by field** (never spread), gated on `typeof workflow.name === "string"` so a pod-supplied payload the blocking schema would refuse is DROPPED rather than making the update unparseable (AGENTS §7). No `.max()`/`.int()` added (P1: the client bounds it).
  3. `packages/daemon/src/hosted-session.ts` — the two call sites the plan names: `awaitDecision` (`:1440`, a turn's own ask) and `awaitBackgroundDecision` (`:1611`, the path every workflow STEP's ask takes — `stepRequester` always sets `agent.id`).
- **Tests:**
  - `packages/agent/test/workflow-driver.test.ts` — `describe("the ask's structured workflow origin (S1b)")`, 6 tests: an agent step's ask (`{name, runId, stepId, index: 1, count: 2}`) keeps the child's `explore` agent label beside it; the origin OVERRIDES a forged one; two `run` steps report `1 of 2` then `2 of 2`; an `approve` step names its own step and position; the hash approval carries `{name, runId}` with no step and no position; a schedule's approval carries `{name}` only.
  - `packages/daemon/test/permission-map-workflow.test.ts` (new) — 6 tests: the five fields travel; a name alone is whole and the absent keys stay ABSENT (no fabricated `null`); absent stays absent (no key at all); field-by-field (a forged extra key never reaches the wire); a non-string `name` is dropped and the update still parses; hostile numbers / a 10 KB name still parse.
  - `packages/daemon/test/permission-workflow-origin.test.ts` (new) — 3 tests on a REAL `HostedSession`: a turn's own ask (`awaitDecision`) carries it, a background child's ask (`awaitBackgroundDecision`, with `agent.id` + a child signal) carries it beside its `agent` label, and an ask with none emits no `workflow` key at all. This is the "both call sites" property driven end to end, not read off the code.
- **Green:** the touched + covering files — `workflow-driver`, `permission-map-workflow`, `permission-workflow-origin`, `workflow-hosted`, `workflow-permission-map`, `permission-events`, `subagent-background` — **113 pass / 0 fail**. `tsc --noEmit -p packages/agent` and `-p packages/daemon`: clean. Biome clean on the 6 files.
- **Mutations (all reverted; `git diff` afterwards shows only the fix + tests):**

  | Mutation | Result |
  |---|---|
  | `stepRequester` passes no `workflow` (the original code) | 5 fail / 39 pass (`workflow-driver`) |
  | `workflow: options?.workflow ?? workflow` (a child's origin wins) | 1 fail — "the origin OVERRIDES a workflow the child tried to set" |
  | `index: 0` instead of the step's position | 3 fail |
  | `awaitDecision`'s call site drops `options?.workflow` | 1 fail (`permission-workflow-origin`) |
  | `awaitBackgroundDecision`'s call site drops `options.workflow` | 1 fail (`permission-workflow-origin`) |
  | the map spreads `{...workflow}` | 1 fail — the forged extra key reaches the wire |
  | the map drops the `typeof name === "string"` guard | 1 fail — a non-string name reaches a blocking update |
  | the map emits `workflow: undefined` instead of omitting the key | 2 fail |

- **`protocol.json`:** regenerated with `bun run schema:export` — **no diff** (S1b adds no schema; S1a already exported the field). No `protocol.d/` note: nothing breaks the wire.
- **Changelog:** `changelog.d/mobile-ask-surfaces.fixed.md` (S1a's ONE fragment) extended with the daemon side — still one bullet, no second file.
- **Drift from the plan:** none in scope. Two points worth recording:
  - the plan's `### Tests` line ("the driver's ask for an `agent` / `run` / `approve` step") is satisfied, but a `run` step's ask reaches the requester through `deps.commands.authorize` and an `agent` step's through the child's runner — so the tests drive those real paths instead of calling `stepRequester` directly.
  - a workflow ask ALWAYS has `agent.id`, so it always takes `awaitBackgroundDecision`; the `awaitDecision` leg is covered with an ask that has no sub-agent label. Both legs were mutated separately, so neither assertion is vacuous.
- **Not in this slice (unchanged, as the plan orders them):** S3 is still STOPPED; S7a (`session/list` `asks`/`workflows`) and S8/S9 remain open.

*— claude-opus-5-5, 2026-11-24*

## Review

### Group S1a–S3 — Verdict: REQUEST-CHANGES

**Findings**
1. **MEDIUM — `workflow` never reaches a requester.** `packages/client/src/remote-client.ts:4876-4881` builds the requester's `PermissionRequestOptions` from the router's `prompt` action field by field (`signal, turnId, agent, requestId`). It does not forward `action.workflow`. So S2's mapping (`permission-router.ts:395-414`) is a dead end: the TUI and the phone (both go through `RemoteClient`, §7) get `options.workflow === undefined` even once S1b sends it. They keep showing «Sub-agent general · wf/generate». The broker passes options through unchanged (`core/permission.ts:254,275`), so this is the only drop. Premise **P3 is FALSE as stated**: the router builds a `RouterAction`, and `RemoteClient` builds the options. Fix: forward `workflow` there, plus a RemoteClient-level test showing a requester spy receiving `options.workflow`. Make it red first. This is the property S4–S6 rely on; their tests feed `options.workflow` directly and would stay green over the gap.

**Gate (touched files):** `ask-origin`, `permission-router`, `protocol/permission`, `json-schema`: 74 pass / 0 fail. `bun run lint`: clean (2386 files). `bun run typecheck`: clean. The full `bun test` was not run (scope: the touched files only).

**Mutations (reverted; `git status` clean afterwards):**
- Router `Number.isFinite(index)` → `!== undefined`: the non-finite test fails.
- `askOrigin` without `index < 0`: the bad-position test fails.
- The executor's own mutations (S1a: `.int()`/`.max()`; S2: three) are consistent with these.

**Attacks tried**
- (a) Hostile numbers or a 10 KB name on the blocking update: still parses. Holds.
- (b) Control chars and length in the strings: `progressText` strips them and caps at 200, and `ask-origin` cuts again to 64/120. Holds.
- (c) A workflow named «Main agent»: `kind` still comes from the structure. Holds.
- (d) End-to-end path update → router → RemoteClient → broker → requester: **breaks at RemoteClient (finding 1)**.
- (e) Single broker and options feeding a decision: untouched, display only. Holds.
- (f) S3: the executor stopped correctly. The TUI has no `@tentacle/client` edge (`tui/package.json`, `app-types.ts:55`). Moving `ask-origin.ts` to `@tentacle/core` is the right call, but it needs the owner's OK before S3 resumes.

**Executor behaviour:** red-first and mutations are recorded honestly. S3 was halted on a contradicted plan instead of forcing it (good). S2 inherited the plan's wrong P3 and did not trace past the router.

*Reviewed by claude-opus-5-5 in a fresh context. The planner is the same model, so shared blind spots are possible; the executor was a different model.*

*— claude-opus-5-5, 2026-11-24*

### Group S1a–S3, round 2 (after fix round 1) — Verdict: APPROVE

**Scope:** `git diff main...HEAD`, slices S1a, S2 and S3. S3 is still STOPPED. Nothing was edited for it, so there is nothing to review there; it waits for the owner's OK on moving `ask-origin.ts` to `@tentacle/core`.

**Findings (HIGH/MEDIUM):** none.

**Round-1 finding 1 is closed.** `remote-client.ts:4880` forwards `action.workflow`. It is the only site that turns a router `prompt` into requester options: a grep for `action.agent` / `kind === "prompt"` finds no other. `next()` in `permission-router.ts` is the one builder for both the current and the queued prompts, so a queued ask keeps its `workflow`.

**Gate:**
- Touched tests (`ask-origin`, `permission-router`, `foreign-turns`, `protocol/permission`, `json-schema`): 109 pass / 0 fail.
- `bun run lint`: clean (2386 files).
- `bun run typecheck`: clean, including mobile and relay.
- The full `bun test` was not run (scope).

**Mutations (each reverted; `git status` clean afterwards):**
- The `workflow` forward removed from RemoteClient → `foreign-turns` › "a workflow step's request reaches the requester…" fails (1 pass / 1 fail).
- `askOrigin` without `count > MAX_STEPS` → "N of M is dropped on a bad position" fails.

**Attacks tried:**
- (a) Another requester-options builder dropping `workflow` (TUI, mobile, relay): none client-side. The other `permission_request` builders are daemon-side, in S1b scope.
- (b) A queued (second) ask losing `workflow`: no, the prompt is built in `next()` from `entry.update`.
- (c) `workflow: {}` / `name: 5` from a hostile pod makes the blocking update unparseable. Same exposure as `agent`'s required strings, and a pod can already corrupt any required field. Not widened.
- (d) Bidi/format characters in `name`: `progressText` strips only C0/C1 controls, the same as `agent` today. This is a display-only spoof (P6) with prior art. A nit, not a finding.

**Executor behaviour (fix round 1):** red-first is recorded, two mutations are given, and the diff is minimal. P3 is corrected in Execution, but the Implementation's P3 text still states it the old way (a doc nit).

*Reviewed by claude-opus-5-5 in a fresh context. The planner and the fix-round executor are the same model, so shared blind spots are possible.*

*— claude-opus-5-5, 2026-11-24*

### S4 — phone pure modules (executor claude-sonnet-5-5, 2026-11-24)

- **Load-bearing check re-run:** `apps/mobile/src/{command-preview,polpetto-glyph,ask-card}.ts` did not exist; `askOrigin`/`originWords` are exported from `@tentacle/client` (`index.ts:31`) and the mobile app already imports that package — holds.
- **Red first:** the tests and modules were written in one step, so the red was the missing module (not an assertion). Non-vacuity is shown by the mutations below instead.
- **Added:** `command-preview.ts` (wrap by `cols`, rows counted arithmetically, only `cap` rows built), `polpetto-glyph.ts` (`polpettoMask`), `ask-card.ts` (`askCard`, `askAge`, `glyphFor`); tests `command-preview`, `polpetto-glyph`, `ask-card` (16 pass / 0 fail). Biome clean on the 6 files; `tsc -p apps/mobile` clean.
- **Drift (small, by design):** `askCard(state, ctx)` takes the `AskOrigin` in `ctx` (`{origin, cols, ageMs, hasAutoAccept}`), because `SheetState` carries only `agent`, not `workflow`. S5/S6 supply the origin. Menu items derive from the options the sheet offers (`allow_always` only when offered, so none for a `workflow_approve`), not from re-reading the suggestion. No existing file edited; no second changelog fragment (the S1a one covers it).
- **Mutations (each reverted):** eyes filled (`ch !== "."`) → 2 fail; (the `more` off-by-one mutation was not run); `cap` removed from the row loop → 2 fail (1250 / 5000 rows built); `allow_always` item unconditional → the `workflow_approve` menu-null test fails.

### S5 — phone park state + sheet plan (executor claude-sonnet-5-5, 2026-11-24)

- **Load-bearing check re-run:** `ask-park.ts` did not exist; `permission-sheet.ts` had only `dismiss()`; `sheetGestureEnabled("permission", true)` was `false` — holds.
- **Red first:** modules and tests were written in one step, so red is shown by mutation (below), not by a pre-fix run.
- **Added/changed:** `src/ask-park.ts` (new: `ASK_PARKS`, `parkKey`, `askBanner`, `askPresented`, `askSurface`); `permission-sheet.ts` (`park()`/`unpark()`, `parked` on the asking state, dep `wasParked(requestId)` so a re-delivered parked id opens parked); `sheet-plan.ts` (permission detents `[PEEK=0.12, 0.5, 1.0]`, `dimmed: 0`, `sheetGestureEnabled` always true). Tests: `ask-park.test.ts` (new, 9), `sheet-plan.test.ts` (gesture/dimmed/PEEK×667≥76 updated). 129 pass / 0 fail across `ask-park`, `sheet-plan`, `permission-sheet`; biome clean on the 5 files; `tsc -p apps/mobile` clean.
- **Drift:** (1) `SHEET_HOLDS`/`holdKey` are NOT removed here: `App.tsx:215,3326` still imports/uses them and `App.tsx` is S6 (removing now breaks typecheck). S6 deletes them with `perm-hold`/`gestureCancel`; `ask-park.ts` has its own `parkKey` of the same shape. (2) `askBanner(state, queued, origin)`: no `parked` arg, since `parked` lives on the asking state; `origin` is passed for `originShort` (same reason as S4). (3) `wasParked` is an injected dep, so the sheet stays decoupled from the global `ASK_PARKS`; S6 wires `ASK_PARKS.has(parkKey(...))` and calls `note`/`forget`. (4) The "planned drain pop does not park" test only pins that nothing in the sheet parks by itself; the pop-not-park rule at `SessionScreen.tsx:1443-1449` is exercised in S6 wiring.
- **Mutations (each reverted):** `sheetGestureEnabled` blocks permission+asking → 2 fail; `park()` calls `dismiss()` → 3 fail; `wasParked` inverted → 3 fail.
- **Changelog:** none added; the S1a fragment `changelog.d/mobile-ask-surfaces.fixed.md` covers it.

### S6 — phone render (executor claude-sonnet-5-5, 2026-11-24) — PARTIAL

- **Load-bearing check re-run:** S5's `park()`/`askSurface`/`askPresented` exist and the route's `gestureEnabled` is true — holds.
- **Added:** `ui/{AskCard,AskSlim,PolpettoGlyph}.tsx`; `ask-park.ts` `ASK_DETENT` feed (detent → content); `permission-sheet.ts` `origin` on the asking state + `queued`; `Icon.tsx` (+`arrow.triangle.branch`, curvepath, `chevron.up`).
- **Rewritten/wired:** `screens/PermissionSheet.tsx` (slim at peek, card above, no `perm-later`/`perm-hold`); `SessionScreen.tsx` (banner `ask-banner`, swipe → `park()` while asking / `dismiss()` while returned, drawer open parks, `askPresented` into `desiredStack`, `ASK_PARKS` forget on settle); `session-screen-controller.ts` (`wasParked`); `App.tsx` (`gestureCancel` removed, `sheetDetentChange` → `ASK_DETENT`); `sheet-plan.ts` (`SHEET_HOLDS`/`holdKey` deleted, as S5 deferred).
- **Tests/flows:** `native-sheets-wiring` and `sheet-plan` rewritten, `e2e-flows` updated; flow 08 now drives swipe → `ask-banner` → tap → Allow once; 08c reaches the reply through `perm-menu`. 311 pass / 0 fail over 7 touched/covering files; `tsc -p apps/mobile` and biome clean on changed files.
- **Mutations (reverted):** swipe → `dismiss()` instead of `park()` → wiring test red; `ASK_DETENT.set` removed from App.tsx → wiring test red.
- **NOT done (PARTIAL):** `e2e/flows/46-ask-park.yaml` (drawer leg) not written (a new flow needs run.ts/shard registration; 08 covers swipe → banner → tap). Simulator unverified: peek-row passthrough, flows 08/08c with `perm-menu`. `AskSlim` at the peek has a no-op `onPress` (the person drags up). The origin age is passed as null. Kit/S9 untouched.
- **Changelog:** `changelog.d/mobile-ask-surfaces.changed.md` (the S1a `.fixed` fragment remains).

*— claude-sonnet-5-5, 2026-11-24*

### S7b — drawer phone (executor claude-sonnet-5-5, 2026-11-24)

- **Load-bearing check re-run:** `rowMarks` did not exist; `SessionListEntry` has `schedules` but not `asks`/`workflows` (S7a not on this branch) — as the plan says, tests use fixtures. Holds.
- **Added:** `drawer-list.ts` `rowMarks(row, localAsk)` → `{ask, workflow, wake}`, `DrawerRow.marks`, option `currentAsking` (applies to the current row only); `session-list.ts` `SessionRow.asks/workflows` (0 when absent; read through a local optional `WithFlags` cast, since the schema fields land with S7a); `SessionsDrawer.tsx` draws `hand.raised`, curvepath, `clock` (glyphs only). Tests in `drawer-list.test.ts` (5 new) + fixtures updated (`drawer-items`, `session-groups`). 60 pass / 0 fail; `tsc -p apps/mobile` and biome clean on the 6 files.
- **Red first:** modules and tests written together; red is shown by mutation.
- **Mutations (each reverted):** drop `|| localAsk` → 2 fail; local ask applied to every row (not only current) → 1 fail; `wake` reads `workflows` → 1 fail.
- **NOT done (PARTIAL):** `App.tsx:1698` does not yet pass `currentAsking` to `drawerList` (the open session's sheet state is not read there; one line once the host exposes it). Until S7a lands the real list carries no `asks`/`workflows`, so only the wake glyph is live. Simulator unverified.
- **Changelog:** `changelog.d/mobile-ask-surfaces.added.md`.

*— claude-sonnet-5-5, 2026-11-24*

### Fix round 1 — group S4–S6 + S7b (executor claude-opus-5-5, 2026-11-24)

Fixes the three MEDIUM findings of Review "Group S4–S6 + S7b".

- **Finding 1 (park note erased on detach): FIXED.** The decision moved out of the component and into the pure sheet. `permission-sheet.ts` has a new dep, `onSettled(requestId)`. `settle()` calls it, and `settle()` is the only path for `answer`, `answerFor` and `sendReply`. The abort path (`onAbort`) and `dismiss()` never call it. `session-screen-controller.ts` wires `onSettled` → `ASK_PARKS.forget(parkKey(...))`, next to `wasParked`. The `SessionScreen.tsx` forget effect (`lastParkedKey`) is deleted. The only other forget left in the screen is the banner tap.
  - **Drift from failure-mode row 274:** an ask resolved ELSEWHERE is a withdrawal to this phone. The router's `abort` carries no reason (`permission-router.ts:171-182`; `remote-client.ts:4900`). So its note is no longer forgotten. It is inert, because a settled id is never re-delivered. To keep such leftovers from growing for ever, `createAskParks(cap = ASK_PARKS_CAP = 256)` evicts the oldest note first. Telling "resolved elsewhere" apart from a detach would need a reason on the client's abort, which is outside this plan's files.
- **Finding 2 (settle/re-delivery wiring untested): FIXED.** New tests:
  - `session-screen.test.ts`, which uses the real controller, the real sheet and the real `ASK_PARKS` through the app's broker:
    - a parked ask withdrawn by abort keeps its note and opens **parked** on the replay of the same id;
    - an answered ask spends its note.
  - `ask-park.test.ts`:
    - `onSettled` fires for answer, `answerFor` and a sent reply;
    - it does not fire for an abort or a dismiss;
    - the cap evicts the oldest note.
  - `native-sheets-wiring.test.ts`: the screen has exactly one `ASK_PARKS.forget(`, the banner tap's; the controller's `onSettled` forgets.
  - Flow `46-ask-park.yaml` (the drawer leg on the simulator) is still not written. Pixels and the simulator are unverified.
- **Finding 3 (peek «Review» no-op): FIXED.** `AskSlim.onPress` is now optional. Without it the row is a plain `View`: no button role, and the action word and chevron are drawn in `palette.sec`, so they read as a hint. The peek passes no `onPress` and shows `actionLabel="Drag up"`, because the native sheet cannot be raised from code (only `sheetDetentChange` is read). It also passes `more={sheet.queued}`. Before this, `queued` changed without an `onChange`, so the «+1» (banner and peek) would have gone stale. `permission-sheet.ts` now `commit`s when an ask queues behind the shown one, and when a queued ask is withdrawn.
- **Red first** (before any production edit): 7 fail across the 3 files, each on an assertion:
  - cap;
  - `onSettled` reported;
  - queue-push emit;
  - queued-abort emit;
  - answered spends the note (controller);
  - one-forget pin;
  - peek pin.

  The controller-level "withdrawal → replay parked" test was green on the old code, because the bug lived in the `.tsx` effect, which Bun cannot import. That leg is pinned red by the wiring test (M3) and by the pure-module mutation (M4).
- **Mutations (each reverted, `grep` confirmed the restore):**

  | # | Mutation | Result | Failing test(s) |
  |---|---|---|---|
  | M1 | `settle` never calls `onSettled` | 2 fail | "answer, answerFor and a sent reply each report"; "an answered ask spends its note" |
  | M2 | controller `onSettled` key renamed (wiring dropped) | 2 fail | "an answered ask spends its note"; the one-forget wiring pin |
  | M3 | the reviewer's original `lastParkedKey` forget effect re-inserted in `SessionScreen.tsx` | 1 fail | the one-forget wiring pin |
  | M4 | `onAbort` calls `onSettled` (a withdrawal spends the note) | 2 fail | "a withdrawal … report nothing"; "a parked ask withdrawn by a detach opens PARKED on its replay" |
  | M5+M6 | both queue `commit`s removed | 2 fail | the two «+1» announce tests |
  | M7 | cap disabled | 1 fail | the bounded test |
  | M8 | peek `more={0}` | 1 fail | the peek pin |

- **Narrow gate:**
  - `ask-park` + `session-screen` + `native-sheets-wiring` + `permission-sheet`: 149 pass / 0 fail.
  - With `e2e-flows` + `ask-card` added: 217 pass / 0 fail.
  - `bunx biome check` on the 9 changed files: clean.
  - `tsc -p apps/mobile`: clean.
  - The full gate is the orchestrator's script.
- The reviewer's scratch repro (`repro-detach.test.ts`) imitates the deleted effect line for line, so it no longer describes the code. Its replacement is the controller-level replay test above.

*— claude-opus-5-5, 2026-11-24*

## Review

### Group S4–S6 + S7b — Verdict: REQUEST-CHANGES

Gate: 324 pass / 0 fail across the 12 touched mobile test files; `bun run lint` clean (2397 files); `bun run typecheck` clean. Only `git diff main...HEAD` for S4, S5, S6 and S7b was reviewed.

1. **MEDIUM: a parked ask loses its park memory on every detach, so the replay shows it as a surprise sheet.** The forget effect at `apps/mobile/src/screens/SessionScreen.tsx:1344-1349` calls `ASK_PARKS.forget` whenever `parkedKey` moves from a key to anything else, including `null`. But the key also goes `null` when the ask is withdrawn rather than settled. On `connectionClosed`, `retainOnly` or `sessionClosed`, the router aborts the signal (`permission-router.ts:325-365`), the entry resolves `DISMISSED` and the sheet goes `idle`. The note is then erased before the re-attach replays the same `requestId`, so `wasParked` is false and the sheet opens presented. That breaks failure-mode row 3 and D3's stated purpose for `ASK_PARKS`. On a phone, backgrounding drops the socket all the time, so this is the common case.
   - Repro (`.tentacle/tmp/mobile-ask-surfaces/repro-detach.test.ts`): real `createPermissionSheet` + `createAskParks`, the effect emulated line for line. Swipe → note + park; abort → `after abort: idle`; replay `r1` → `replayed parked = false` (expected true).
   - Fix: forget only on a real settle (answered, or `permission_resolved`), not on a withdrawal, plus a test that is red today.
2. **MEDIUM: the settle and re-delivery wiring has no test.** Deleting `ASK_PARKS.forget(lastParkedKey.current)` (mutation, reverted, tree byte-identical) leaves `native-sheets-wiring` and `ask-park` all green (68/68). The drawer→park→banner leg (flow `46-ask-park`) was never written. So the two §9 properties S6 hinges on (a re-delivered parked ask opens parked; the note is spent on settle) are pinned by nothing. Finding 1 slipped through because of this.
3. **MEDIUM: the peek row's «Review» button does nothing.** `apps/mobile/src/screens/PermissionSheet.tsx:86` has `onPress={() => {}}`. A tap on the labelled action at the peek gives no feedback. That goes against the UI empty-action standard (dimmed + light haptic + inline label, never a silent no-op). Make it inert-looking (no capsule) or give it the haptic and a hint. `more={0}` there also hides the «+1» that the failure-mode table promises on the peek.

Mutation: removing forget-on-settle → **survives** (finding 2). The executor's S4/S5/S6/S7b mutations were not re-run; their tests ran green.

Attacks tried:
- Planned drain pop treated as a park: no. `dismissedNatively` cuts at `plannedPop`, and `park()` is idempotent anyway.
- `wasParked` key mismatch, `compose.computerId` vs `owner.computerId`: both come from the same `computerId` in `App.tsx:1922`. Holds.
- `askCard` always offering `allow_once`/`reject_once`: `SheetOptionId` is a closed set. Holds.
- Reply field now gated on `replyOpen` and reached via `perm-menu`: intended; 08c updated.
- Origin glyph from text: it comes from `kind`. Holds.
- Drawer local ask on non-current rows: no. Holds.

Acknowledged partials, not counted as findings: `currentAsking` not wired in `App.tsx`; the S7a wire is absent; age passed as null; simulator unverified.

*Reviewed by claude-opus-5-5 in a fresh context. The executor was claude-sonnet-5-5: same family, so blind spots may be shared.*

*— claude-opus-5-5, 2026-11-24*

### Round 2

**Verdict: PASS.** All three round-1 findings are fixed. Reviewed `git diff 93bd7b14..HEAD`, which is fix commit `7a01af4d` plus the generated-kit gate commit `ffbc9a64`.

Gate: `bun test apps/mobile/test/` 5043 pass / 0 fail (327 files); `bun run lint` clean (2397 files); `bun run typecheck` clean.

1. **Finding 1 (a detach erased the park memory): fixed.** The screen-side forget effect is gone. The note is now spent only through the sheet's `onSettled` (`permission-sheet.ts:389-392`, called from `settle`), which only fires when the ask is answered here. A withdrawal (the abort path) and `dismiss()` never call it. A `computerId/sessionId/requestId` key left behind by an ask answered on another device is inert, and `ASK_PARKS_CAP` (256, oldest evicted first) bounds them.
2. **Finding 2 (no test): fixed, and every new test fails under mutation.** Each mutation below was reverted, and the tree is byte-identical afterwards (`git status` clean).
   - Drop the `onSettled` call → 2 fail (`ask-park` settle test; `session-screen` "an answered ask spends its note").
   - Call `onSettled` on the abort → 2 fail (`ask-park` withdrawal test; `session-screen` "withdrawn by a detach opens PARKED on its replay", which runs through the controller's real sheet and broker).
   - Put a screen-side `ASK_PARKS.forget` back in `SessionScreen.tsx` → 1 fail (wiring: exactly one `forget` call in the screen).
3. **Finding 3 (dead button on the peek row): fixed.** `AskSlim` with no `onPress` now draws a plain `View` with a dimmed «Drag up» hint, so there is no dead tap. `more={sheet.queued}` makes the «+1» live. A queue push or a withdrawal behind the shown ask now calls `commit(state)` so the count re-renders; covered by 2 tests.

Regressions looked for, none found:
- The extra `commit(state)` passes the same `state.sheet` reference, so the drawer-park effect, which depends on `state.sheet`, does not fire again.
- `onSettled` runs only when the ask has a `requestId`.
- An answer that is sent but lost (`returnReply`) spends the note. That is acceptable: the person had already brought the ask back to answer it.

Still open from round 1 (acknowledged partials, not findings): `currentAsking` is not wired in `App.tsx`; the `46-ask-park` e2e flow; simulator QA.

*Reviewed by claude-opus-5-5 in a fresh context. The executor was DeepSeek, a different model family.*

*— claude-opus-5-5, 2026-11-24*

## Execution

### S7a — `session/list` `asks`/`workflows` (executor claude-opus-5-5, 2026-11-25) — DONE

**Load-bearing check re-run first (the plan's preconditions):** holds.
- `SessionListEntrySchema` (`protocol/src/session.ts:2114-2136`) had `jobs`/`schedules` but neither
  `asks` nor `workflows`; `SessionSummary` (`daemon/src/session-list.ts:26-54`) likewise, and
  `toSessionList` (`:105-140`) passed neither through.
- The daemon does hold both: `asks` map (`hosted-session.ts:982`) and the driver's live rows
  (`agent/src/workflow-driver.ts:619` `rows()`, `done` filtering at `:621`; the host keeps the last
  emitted list in `lastWorkflows`, `hosted-session.ts:1113`). `summary()` is the single place
  `session/list` reads a live session (`session-host.ts:939`).

**Changed**
- `protocol/src/session.ts:2134-2137` — `asks?: int ≥ 0`, `workflows?: int ≥ 0` (optional, additive,
  strip schema; `session/list` is a response, not blocking, so bounded normally — D5).
- `daemon/src/session-list.ts` — `SessionSummary.asks?/workflows?` (`:44-54`), `liveRunCount` exported
  (`:80-90`: a run is over iff its state is `ok`/`error`/`stopped`; an unknown state counts as live,
  so a run this build cannot judge never looks finished), and both fields passed through
  (`:131-132`) only when present — absence is not the same claim as 0.
- `daemon/src/hosted-session.ts:2235-2239` — `summary()` emits `asks: this.asks.size` always on a
  live session (0 is a fact the drawer reads) and `workflows: liveRunCount(this.lastWorkflows)` ONLY
  where a driver is bound (`this.workflows`), so a pod/tunnelled session makes no claim.
- Archived entries (`session-host.ts:940-951`) are untouched: no ask is loaded on one, and no run is
  live — the plan implies exactly that, and the two existing archived-entry assertions stayed green.
- `packages/protocol/schema/protocol.json` regenerated (`bun run schema:export`): +8 lines, the two
  new optional integers. No `PROTOCOL_VERSION` note — fields are free, display data, additive (§7).
- Changelog: `changelog.d/mobile-ask-surfaces.added.md` extended (S7b's ONE fragment, same bullet) —
  the drawer's glyphs now read the counts from the list itself. No second fragment.

**Drift from the plan:** none in shape. Two clarifications found while implementing:
- the plan says `workflows` = "runs whose state is not ok/error/stopped"; implemented as an exported
  pure `liveRunCount` over the host's `lastWorkflows` (not `driver.rows()`), because `summary()` is a
  pure read with no I/O and `lastWorkflows` is the daemon's own judged copy (schema-validated at
  `:2584/:2599`).
- `asks` is emitted as a live `0` while `workflows` is absent without a driver. Both follow D5's
  "absent → no glyph" but differ in kind: every live session holds an ask map, not every session
  runs workflows.

**Tests (red first; the property each kills)** — `daemon/test/session-list.test.ts`:
- `L-asks`: pass-through, absent stays absent, a `0` stays a `0`, paging untouched, and a
  `SessionListResultSchema.parse` round-trip (a STRIP schema drops an unknown field, so this is what
  kills a missing protocol field). RED first: `Expected -2 / Received +2` on the pass-through, then
  `error: expect(received).toBe(expected) Expected: 0 Received: undefined` on the host path.
- `L-live`: `liveRunCount` over the six documented states → 3, `[]` → 0, an unknown state → 1.
  RED first: `Expected: 3 / Received: 6` against a row-counting skeleton.
- `H-asks`: a real pending ask raised through the session's broker during a live turn reaches
  `summary()` and `session/list` as `1`, and `workflows` is absent without a driver.
- `H-runs`: with a fake driver attached (`attachWorkflows`, the existing seam), 4 rows → `2`, and
  the count reaches the wire.
- Three pre-existing whole-entry `toEqual` tests (H1, H3, and the archived-entry one) gained
  `asks: 0` — the intended additive field, not a behaviour change.

**Mutations (each applied, run, reverted by restoring the file from `.tentacle/tmp/mobile-ask-surfaces/`):**
| Mutation | Result |
|---|---|
| `asks: 0` hard-coded in `summary()` | 1 fail (H-asks) |
| drop the `this.workflows ?` guard (always emit) | 4 fail (H-asks, H-runs, H1, H3) |
| `liveRunCount` counts every row | 2 fail (L-live, H-runs) |
| neither field passed into the entry | 5 fail (L-asks + the four host tests) |
| absent becomes `0` (`: { asks: 0 }`) | 5 fail (L2, L-asks, H-asks, H1, H3) |
| drop `asks` from `SessionListEntrySchema` | 4 fail (L-asks, H-asks, H1, H3) |

**Verification (touched files only, per the executor budget):** `bun test
packages/daemon/test/session-list.test.ts` 27 pass / 0 fail; the neighbouring `session/list`
consumers (`session-pin`, `persistence`, `watch-hosted`, `connect-sessions-view`,
`client/session-list`, `protocol/session-pin`, `session-titles`, `watch-connection`,
`ws-device-route`, `relay-link`, `client/pairing`, `connect-resume`, `protocol/json-schema`,
`apps/mobile/session-list`, `apps/mobile/drawer-items`) 329 pass / 0 fail combined; `bunx tsc -p
packages/daemon --noEmit` and `-p apps/mobile --noEmit` clean; `bunx biome check` on the four
changed files clean. The full gate is the orchestrator's.

**Not in this slice:** S7b's `App.tsx` `currentAsking` wiring (still open) and the rest of the plan's
slices. `apps/mobile/src/session-list.ts:183`'s local `WithFlags` cast is now redundant but harmless —
left alone, since S7b owns that file.

*— claude-opus-5-5, 2026-11-25*

### S9 — kit `askCard`/`askSlim`/`askSheet`, `permissionSheet` realigned (executor claude-code, 2026-11-25) — DONE

**Load-bearing check re-run first (D7 + the Context constraint):** holds, with one correction.
- `tools/mockup-kit/kit.js:329` `K.permissionSheet` still drew the OLD stack — a head row
  (`k-perm-tile` + title/tool), one `k-perm-detail` dump of `detail` and a vertical column of
  `k-perm-pill`s — while `apps/mobile/src/screens/PermissionSheet.tsx:76-101` now draws `AskSlim`
  (peek) or `AskCard` (every other detent). The constraint «mockups must match the app» was therefore
  broken exactly as the plan says.
- The mockup's `K.extend`s (`.tentacle/mockups/mobile-ask-surfaces/index.html:286-310`) are the
  promotion source: `askCard`, `askSlim`, `askSheet`, all three built on plain HTML there.
- Polpetto's 9×9 mask exists in the app as a pure function (`apps/mobile/src/polpetto-glyph.ts`), so
  the kit folds it rather than re-deriving it from the sprite rects — a second derivation would be a
  second truth for the owner's drawing.
- One plan detail does NOT match the app: `PermissionSheet.tsx` keeps a plain `ScrollView`, not a
  detented frame; the detents live in the route (`App.tsx`). So `askSheet` is a frame the CATALOGUE
  composes, and `permissionSheet` keeps returning the `k-scrim`/`k-sheet` frame it always did (now
  holding `askCard`), rather than nesting a second sheet chrome.

**Changed**
- `tools/mockup-kit/kit.js` — `askCard` (`:412`, the origin row, title, the 4-row command with
  `+N lines · Show all` / `Show less`, the `… Deny Allow once` action row outside the scroll, the
  optional menu / also-asked / arming lines), `askSlim` (`:447`), `askSheet` (`:461`, throws on an
  unknown detent), with the private `askOriginRow`/`askGlyph`/`polpettoGlyph`/`askCommand`
  (`:350-410`). `permissionSheet` (`:476`) now draws `askCard` inside the sheet frame: `options`
  (validated, unchanged throw) become the card's own action capsules, `origin`/`title`/`detail`/
  `diff` are passed through, `tool` survives only as the frame's accessible name (the card has no
  tool row). The default origin is the main agent. The answer capsules are now `k-ask-b` (the card's
  own class), so `k-perm-pill`/`k-perm-head`/`k-perm-detail`/`k-perm-options` are gone.
- `tools/mockup-kit/kit.css` — the `.k-ask*` block (`:605-830`): card, origin row (the Polpetto mask
  as runs, the SF glyph otherwise), command box with a separate `.bd` scroller (so the actions are
  siblings, never inside the scroll), capsules, menu, the slim row, and the sheet frame (dim only
  above `peek`). Every metric is a `var()`. The `.k-perm-*` rules were deleted with their markup.
- `tools/mockup-kit/kit.d.ts` — `AskOriginProps`, the new `askCard`/`askSlim`/`askSheet` signatures,
  `origin?` on `permissionSheet`.
- `scripts/mockup-kit/manifest.ts:37-38` — `ask-card` and `ask-slim` join the style manifest, so
  every card/slim metric is EXTRACTED from `AskCard.tsx`/`AskSlim.tsx` (`--m-ask-card-*`,
  `--m-ask-slim-*`) instead of hand-copied: `generated/tokens.css` +28 lines of those, no
  `APPROXIMATIONS` entry needed.
- `scripts/mockup-kit/sources.ts:32,251` — `viewModels.polpettoMask` folds the app's own
  `polpettoMask()`; `generated/kit-data.json` +91 lines.
- `tools/mockup-kit/index.html` — two catalogue entries (`ask: the card, for each origin (D4)`,
  `ask: the sheet detents (peek never dims) + the slim row (D4)`) next to the realigned
  `permission sheet`; `tools/mockup-kit/README.md` — the builders' row names the three new ones.
- `scripts/test/mockup-kit-components.test.ts` — four new describes (17 tests, see below) and the
  three pre-existing `permissionSheet` assertions moved to the card's classes.
- `changelog.d/mobile-ask-surfaces-s9.added.md` — ONE fragment. `added`, because the kit gains three
  builders; the realignment of `K.permissionSheet` is the same bullet (one task, one fragment).

**Drift from the Implementation**
- **The plan's `SHEET_HOLDS`/`gestureCancel`/`perm-hold` cleanup is not here** — it is S5/S6's, and
  the kit never had those names.
- **`askSheet`'s detent names are the app's three** (`peek`/`ask`/`large`), not the mockup's
  `ask`/`peek` pair: the app's `sheet-plan.ts` detents are `[PEEK, 0.5, 1.0]`, and the large detent
  is the one frame the plan's A1/A6 need.
- **`permissionSheet` keeps the scrim/sheet frame** (see the load-bearing note): the plan's "the kit's
  `permissionSheet` draws `askCard` inside the sheet frame" is implemented literally — the card goes
  inside the sheet it already had, and the `k-sheet[data-permission]` padding rule is no longer used
  by it (the card carries its own padding, as `AskCard.tsx` does).
- **Polpetto is drawn as horizontal runs** (~15 `<i>`s, 17 pt) rather than 81 cells — same mask, one
  HTML file that stays readable; the mask itself is folded from app source, so the shape cannot drift.

**Tests (red first; the property each kills)** — `scripts/test/mockup-kit-components.test.ts`:
- `askCard` (`:131`): the glyph comes from the origin KIND, never the words (a workflow named «Main
  agent» still draws the curve path, and only `main` draws `k-ask-p`) — this is the §7 «a pod is not
  trusted» property; the three origins each draw their own row and an unknown kind falls back to the
  main agent (never a blank row); the origin words are escaped and the age is its own column; the
  command is 4 rows + `+N lines · Show all` collapsed, every row + `Show less` expanded, no footer
  when short, and a blank line still draws; Deny is never `data-primary` and comes first; `…` exists
  only with a rare option (a `workflow_approve` has a spacer instead); the actions are a SIBLING of
  the command box (`</div>` between them, `.k-ask-a { flex: none }`, `.k-ask-c[data-x] .bd` is the
  scroller).
- `askSlim` (`:242`): the hand, the title, the origin short and the caller's action word; never
  `Allow once`/`Deny`; `go` is the caller's word and escaped.
- `askSheet` (`:271`): the peek detent carries no `data-dim` while `ask`/`large` do (the screen behind
  stays usable at the peek); the grabber plus the caller's content and nothing else; an unknown detent
  throws.
- `permissionSheet` (`:297`): it draws the ask card, not the old head/detail/pill stack; `options`
  stays a parameter on the card's own action row (two answers, no 「Always allow」, a malformed list
  still throws); the origin reaches it by kind.
- RED first: 17 of the 30 tests in the file failed before the kit change (`Expected to contain: "…"`
  against the old `k-perm-*` markup), including the three pre-existing `permissionSheet` ones.

**Mutations (each applied to the real kit file, run, then restored from
`.tentacle/tmp/mobile-ask-surfaces/bak/`):**
| Mutation | Result |
|---|---|
| glyph from the words (`origin.lead === "Main agent"`), not the kind | 2 fail (kind test, three-origins test) |
| Deny takes `data-primary`, Allow once loses it | 1 fail (Deny-never-primary) |
| `permissionSheet` actions back to the default pair (drops `options`) | 3 fail (options ×2, card-actions) |
| every command line drawn, no `+N` footer | 1 fail (4-rows test) |
| the peek detent dims too | 1 fail (peek-never-dims) |
| CSS: `.k-ask-c[data-x]` scrolls the box itself (actions no longer siblings) | 1 fail (actions-outside-scroll) |

**Verification (touched files only, per the executor budget):** `bun test
scripts/test/mockup-kit-components.test.ts scripts/test/mockup-kit.test.ts
scripts/test/mockup-kit-png.test.ts scripts/test/changelog.test.ts` → 90 pass / 0 fail (the two
`calibrate` stderr lines are its documented Chrome / no-e2e exits). `bunx tsc --noEmit` and `bunx tsc
-p apps/mobile --noEmit` clean; `bunx biome check` clean on every file this slice touched.
`bun run mockup-kit` regenerated `generated/{tokens.css,kit-data.json}` deterministically (re-running
it after the mutations produced no further diff). The full gate is the orchestrator's.

**Not in this slice:** S7b's `App.tsx` `currentAsking` wiring and S8 (the run screen) remain open, as
the plan orders them; the kit's `askCard` is what S8 will compose for the run screen's slim foot.

*— claude-code (AI_AGENT=claude-code_2-1-325_agent — the only model id this session exposes), 2026-11-25*


## Execution — S8 (run screen)

- **Load-bearing check (re-run): holds.** `AskOrigin` carries `runId`/`stepId` (`packages/client/src/ask-origin.ts:21-31`); the `WorkflowRun` route carries `computerId`/`sessionId`/`runId` (`routes.ts:126`); the Session screen already reads the root routes (`SessionScreen.tsx` `rootRoutes`).
- **`sheet-plan.ts`:** `ownRunTopId`/`ownRunOnTop` (top non-`Sheet` route is this session's `WorkflowRun`; a `Sheet` above it is ignored; any other screen above → not on top), `askPresentable(origin, topRunId)` (over a run only an ask whose `origin.runId` is that run; Q1), `sessionInFront(…, ownRun)`.
- **`SessionScreen.tsx`:** `topRunId` feeds `inFront` and `askPresented`'s `presentable`.
- **`workflow-run-controller.ts`:** `CardAsk.origin`; `askForRunStep` pairs by `origin.runId/stepId` first (another run's origin never pairs, whatever the agent id says), falling back to the `agentId` split only for an origin with no run id; `AskBar` gains `foreign` (an ask that is not this run's); `AskSource.unpark` + `controller.reviewAsk()`; `askSourceFromSheet` passes `origin`/`unpark`.
- **`WorkflowRun.tsx`:** `AskBlock` removed; `AskPanel` draws one `AskSlim` (`Review` → unpark; `Open the session` for foreign / `!canAnswer`). Prop `onAnswer` → `onReviewAsk` (`App.tsx` wires it and `unpark`). `controller.answer` stays (tested), unused by the screen.
- **e2e `44`:** the run's hash approval is now answered on `perm-sheet`. `46-ask-park.yaml` run leg NOT written (no new flow registered), unverified on a simulator.
- **Drift:** the plan's `askForStep` move is `askForRunStep` in the mobile controller (client `askForStep` untouched, the TUI uses it). `ASK_PARKS.forget` is not called from the run screen's `Review` (only `sheet.unpark()`); the Session screen underneath owns that memory.
- **Tests:** `sheet-plan`, `workflow-run-controller`, `workflow-screens-wiring` (rewritten for the slim row): 129 pass / 0 fail; `tsc -p apps/mobile` clean; biome clean. Red: before the code, import/assertion failures (4 assertion reds in the controller file).
- **Mutations:** `askPresentable`→`true`: 1 fail; `sessionInFront` without `ownRun`: 1 fail (+ askPresentable still mutated at that moment); `askForRunStep` structured branch disabled: 2 fail. All reverted, 129 green again.
- Changelog: `changelog.d/mobile-ask-surfaces-s8.changed.md` (the `mobile-ask-surfaces.*` names were already taken by earlier slices).

*— claude-sonnet-5-5, 2026-11-25*

### S8 gate fix (e2e 44)

- **Symptom:** `44-workflow-editor` red 2/2 at `extendedWaitUntil perm-sheet` after Run: the run screen showed only the slim row (`Review ⌃`), no sheet. Main passed because the hash approval was inline there; the flow change to `perm-sheet` is the intended S8 behaviour (D6/Q1: the run's OWN ask is a sheet over the run).
- **Root cause (app bug, not a stale flow):** `SessionScreen`'s `rootRoutes` was memoized on `stackKey`, which is `stackSignature` = the *Sheet* routes only. Pushing WorkflowRuns/WorkflowRun over Session never changed it, so the memo kept `Computers>Sessions>Session`, `ownRunTopId` returned null, `inFront` stayed false and the sheet was never pushed. Evidence: a temporary on-screen dump (reverted) read `topRunId:null, origin.runId:"wf-1", f=false, rr=Computers>Sessions>Session`. S8's unit tests fed `ownRunTopId` hand-made routes, so they could not see it.
- **Fix:** `SessionScreen.tsx` reads `navigation.getState()` fresh each render and memoizes on all route keys (`freshKey`). Red→green: wiring test `native-sheets-wiring.test.ts` "root routes are re-read FRESH…" fails on the old source (1 fail), passes now; `apps/mobile/test` 5433 pass; biome + `tsc -p apps/mobile` clean.
- **e2e (sim 0B43D716):** 44 PASS twice (94 s, 95 s); 08-permission, 08b-permission-deny, 10-background-ask PASS. Note: two earlier red runs (21–28 s, at pairing) were another session's `e2e:mobile` using the same simulator (uninstalling the app) — unrelated to this fix.

*— claude-sonnet-5-5, 2026-11-25*

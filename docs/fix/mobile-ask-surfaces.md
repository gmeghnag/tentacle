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

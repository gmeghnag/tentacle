# fix/workflows-ux — Workflow runs readable on the phone, reachable from the hub, quiet in the TUI

> **Status:** context
> **Branch:** `fix/workflows-ux`
> **Size:** M–L (split into S/M slices) · **Blast:** cross-module (mobile screens + hub, TUI, workflow run data on the wire) · **Suited:** Opus plan; DeepSeek exec per slice (owner: S/M → deepseek/sonnet); Opus review per slice group
> **Changelog:** `changelog.d/workflows-ux.fixed.md` (+ `.changed.md` for the hub entry if the plan prefers)

## Context

Owner 24/11, after running a real workflow (`~/assistant/.tentacle/workflows/demo-note.yaml`, collect → draft(retry 1) → review(on_fail goto fix max 2, next confirm) → fix(next review) → confirm(approve) → archive) on the iPhone and in the TUI. Screenshots: `.tentacle/tmp/workflow-run-view/{162fac2b,9bd2be28,d1b5faaa}-image.png`.

### Defects (evidence)
1. **Run graph is unreadable** (d1b5faaa): a linear chain of pills; no taken/untaken path, no failure, no loop; `fix` (never ran: review passed first time) shows `○ fix · waiting` IN the chain between review and confirm, even after the run ended; the fix→review back edge is not drawn; no run outcome/duration.
2. **Never-run step detail** (162fac2b): `fix` says «This step's detail is no longer available» with State `waiting` — must say it did not run and why.
3. **Step detail header overlaps** the status bar and the back chevron (both detail screenshots).
4. **Hub entry unreachable when no run exists**: `hub-actions.ts:270` dims Workflows with `NO_WORKFLOW_RUNS` (`hub-session.ts:136`), and the Start entry lives only inside that screen (`WorkflowRuns.tsx:121`) → the first workflow can't be started from the phone.
5. **TUI before the first message**: the `/workflow` panel says «this session is not open yet» for the catalogue (`remote-session.ts:1336`) and «not supported by this computer's tentacle» for runs (`workflow-view.ts:516`) — false; the session is just not open.
6. **TUI at-rest catalogue line** `◇ workflows  demo-note v1 ✓ approved   /workflow` above Thinking (`workflow-view.ts:757,794`, `app-layout.ts:123`) reads like a lingering finished run. Owner: «va tolto».

### Owner decisions (binding, mockups in `.tentacle/mockups/workflow-run-view/`)
- **Run view = A + B** (`index.inline.html`): A = graph with the side branch (taken edge solid, possible dashed, not-taken faded dotted; chips `✗ 1/2` on goto, `↻ 1/1` on retry; top strip with outcome, total time, tokens) as the main view; B = rounds timeline («Next», «Not run» groups) behind the top-right list button (replacing the cards toggle).
- **Step detail**: nav bar under the safe area (`‹ demo-note · step 4 of 6`), never-run wording «Not run — review passed on its first try…», approve step shows question, outcome, wait.
- **Markers** (`markers-v2.inline.html`): style **(ii) tinta** — soft tinted circle body, the glyph carries the contrast; tokens `--wr-{ok,fail,run,ask,wait}-{soft,ink}` (+ `--wr-skip-ink`) light/dark as drawn; glyphs bigger (~half the circle). Glyphs are REAL SF Symbols via `apps/mobile/src/ui/Icon.tsx` (expo-symbols), not drawn SVG: succeeded `checkmark`, failed **`multiply`** (owner, `error-icon.html`), running/waiting-on-you/not-run per the mockup mapped to SF Symbols (plan proposes names). **Pending/not-yet = plain soft-grey disc with NO glyph** (owner: no ○ / dots). Owner is colour-blind: every state must stay distinguishable without colour (glyph + edge line style + the state word).
- **Hub** (`hub-workflows.inline.html`, variant B): Workflows takes **Attach's** slot in the fan; **Attach is removed from the hub entirely** (the composer `+` already does it); Commands stays. Workflows icon = SF Symbol `point.topleft.down.to.point.bottomright.curvepath`. The item is not dimmed when the project has workflows to start (fix 4).
- **TUI**: remove the at-rest catalogue line (catalogue stays in the `/workflow` panel); fix the wrong notes before the first message (5) — ideally the catalogue reads without an open session, else an honest «send a message first».
- «nuovo dato» from the mockups: the run view needs the workflow DEFINITION edges (`next`, `on_fail{goto,max}`, `retry`) with the run, so a loop is drawn before it fires; the plan decides where (protocol field on the run/steps read) and wires both ends.

### Constraints
- `feat/workflow-editor` is executing in parallel (slices 3b → 7c: workflow driver/daemon save path, client, phone editor screens + route + entries). List every file both touch; order or rebase so they don't collide (this task may execute after workflow-editor merges).
- Logic in pure modules (graph layout, state projection, hub ordering), components render only (AGENTS §7). Phone/Mac parity statement.

*— orchestrator (claude-opus-5-5), 2026-11-24, owner decisions in this session*

## Implementation

> **Status: APPROVED** — owner 2026-11-24 (#### Owner answers, after Owner questions). Execution order: S1–S3 now; S4→ after feat/workflow-editor merges.

### Load-bearing assumption (named first, proved against the source)

**The run read carries each step's LAST state only — no definition edge (`next`, `on_fail{goto,max}`,
`retry`), no goto counter, no history — so every loop/branch the phone draws today is guessed. The
daemon HAS all of it in memory for every run (its frozen `run.spec` and `run.state.counters`), so the
fix is to put it on the wire from the driver, not to re-derive it on the client.**

Proof (static; the executor re-runs it empirically first — see PARTIAL rule):
- Wire step row = `id, kind, model?, where, state, attempt, round, maxRound?, reason?, live?,
  durationMs?` (`packages/protocol/src/session.ts:808-826`); run row has no history
  (`:830-848`). Both are strip schemas (§7): a `next`/`onFail` a daemon sent would be DROPPED on
  parse. The catalogue's step has no edges either (`:990-1000`) — and the catalogue is the file
  NOW, not the run's snapshot, so it is the wrong source anyway.
- The phone therefore guesses: `isLoopTarget = maxRound !== undefined` (`apps/mobile/src/workflow-graph.ts:124-126`),
  and `maxRound` is set only once a goto FIRED (`packages/agent/src/workflow-driver.ts:1054-1061`);
  the graph is the file order with an edge between neighbours (`workflow-graph.ts:170-197`). Run ①
  (review passes first time) ⇒ `fix` sits in the chain between review and confirm, no back edge —
  exactly d1b5faaa.
- `fix · waiting`: the never-run step stays `pending` after the end (`finish` only maps
  running/waiting/needs-approval → stopped, `workflow-driver.ts:1146-1150`) and the phone words
  `pending` as "waiting" (`apps/mobile/src/workflow-list.ts:42,59`); its detail read finds no entry →
  `missing` → "no longer available" (`workflow-step-detail.ts:29,146-148`) — defect 2.
- The data exists daemon-side: rows are built from the run's own spec at start
  (`workflow-driver.ts:772`, `pendingRow(step: WorkflowStep)` `:931-941`), a resume reuses `run.spec`
  (`:838-853`); `WorkflowStep` has `retry`, `onFail{kind,id,max}`, `next?` (`core/src/workflow-spec.ts:98-110`);
  the pass target is `step.next ?? steps[i+1]` (`core/src/workflow-spec.ts:483-487`, `passTarget`
  in `core/src/workflow-machine.ts:358`); goto counters are `state.counters[edgeKey(from,to)]`
  (`workflow-machine.ts:111-115,382-397`); every execution passes through `drive` (`workflow-driver.ts:1043-1110`),
  where `setStep` overwrites the row (`:947-968`) — the history is lost there, so it is recorded there.
- Rows are in-memory only (`rows()` `workflow-driver.ts:410-415`; no ledger rebuild): no persisted
  format changes.
- Repro script (run it first): `.tentacle/tmp/workflows-ux/lb.ts` parses a row carrying
  `next`/`onFail`/`retry` through `WorkflowRowSchema` and a catalogue row through
  `WorkflowCatalogueResultSchema`; expected today: the keys are absent after parse. (Not run by the
  planner: `bun` needed approval in this session.)

### Preconditions (verified)

- P1 Strip schemas, a new required field = breaking ⇒ `protocol.d/<slug>.md`, never an edit of
  `PROTOCOL_VERSION` (AGENTS §7). App unpublished ⇒ clean break preferred over optional-field
  fallbacks (owner memory 20/11): an older daemon fails at `initialize` with `VersionMismatch`, so no
  "edges absent" rendering path is written.
- P2 One run's definition is frozen for its life (`workflow-driver.ts:772,838-842`) ⇒ "the file changed
  since the run started" cannot skew the graph: the edges come from that run's snapshot.
- P3 Phone imports `@tentacle/client` and `@tentacle/core` (`apps/mobile/package.json:10-11`); the TUI
  imports `@tentacle/client` ⇒ one shared projection lives in `client`.
- P4 SF Symbols (sf-symbols-typescript 2.2.0, `IconName` checked against it, `Icon.tsx:1-6`;
  deployment target iOS 18, `apps/mobile/app.json:36`): `checkmark` (1.0), `multiply` (1.0),
  `play.fill` (1.0), `questionmark` (1.0), `stop.fill` (1.0), `arrow.clockwise` (1.0),
  `list.bullet` (1.0), `chevron.left` (1.0), `chevron.forward.2` (2.0, index.d.ts:2001),
  `point.topleft.down.to.point.bottomright.curvepath` (5.0, index.d.ts:6002) — all present, all ≤ iOS 18.
- P5 Sessionless reads have a precedent: `session/skills`/`session/tools` with no `sessionId` = "what a
  session created now would have" (`daemon/src/connection.ts:694-712`, `session-host.ts:626-653`).
- P6 Hub order is already a pure module (`hub-actions.ts:164-176,284-301`); the dim reason is
  `dimmedBecause` (`:260-274`) fed by `workflowsHub` (`workflow-runs-controller.ts:175-188`).

### Design

**D1 — Wire (protocol + driver).** `WorkflowStepRowSchema` gains, all REQUIRED (P1):
- `next: line(64) | null` — the RESOLVED pass target (`passTarget`), `null` = the run ends after it.
- `onFail: { goto: line(64), max: int 1..10, taken: int ≥ 0 } | null` — `null` = stop;
  `taken` = `state.counters[edgeKey(id, goto)]`.
- `retry: int 0..5`.

`WorkflowRowSchema` gains `history: { step, attempt, round, state, durationMs? }[] ≤ 64` (finished
executions in order, the LATEST 64) + `historyDropped: int ≥ 0`. ~5 KB worst case per published row.
Driver: `pendingRow` fills `next/onFail(taken 0)/retry` from the run's spec; after each `nextAction`
(`:1106`) the source step's `onFail.taken` is refreshed from `run.state.counters`, and the finished
execution is appended to `history` (cap + dropped count). Nothing else in the driver changes.
`protocol.d/workflows-ux.md`: required fields added to the `workflows` row (+ D7's `sessionId`
relaxation if Q1 = A).

**D2 — Shared projection (pure, `packages/client/src/workflow-run-graph.ts`, new).** `runProjection(row)` →
- per step a **phase**: `ok | error | running | ask | later | skipped | stopped | unknown`.
  - wire `ok/error/running/stopped` as is; `needs-approval`/`waiting` → `ask` (the word keeps them
    apart: "needs approval" / "waiting on you").
  - `pending` → **not yet** (`later`) iff the run is live AND the step is reachable from the current
    step. Reachable = BFS over `next`, over `onFail.goto` while `taken < max`, and over the retry
    self-loop.
  - `pending` → **not run** (`skipped`) otherwise (ended run, or unreachable).
  - an unknown wire word → `unknown`, printed verbatim.
- per edge (`next`, `fail`, `retry`) a **trace**: `taken` (in `history` as consecutive A→B, or
  `taken > 0` / `attempt > 0`), `go` (taken, and its target is the current running/ask step), `later`
  (live and still possible), `never`. Chips: `✗ taken/max` on the goto edge, `↻ attempt/retry` on retry.
- `notRunWhy(stepId)` → `{ text, small? }`, e.g. "Not run — review passed on its first try, so its
  on-fail route never fired." + "It runs only when review fails (up to 2 times).". Cases, in order:
  - only entered by a goto whose source never failed;
  - the run stopped/failed before it (`the run ended at <step>`);
  - the path went elsewhere (fallback).
- `timeline(row)` (view B):
  - `history` rows, then the current step;
  - then `next[]` (reachable, live only, with "round N" for a re-entry);
  - then `notRun[]` (with the why);
  - plus an "N earlier steps not shown" line when `historyDropped > 0`.
- `summary(row, now)` (the top strip):
  - outcome word + phase: `Done | Failed | Stopped · <stopReason> | Running | Needs approval | Waiting on you`;
  - total time (`endedAt ?? now` − `startedAt`);
  - `tokens of budget`;
  - `N of M steps ran`, `· K loops`, or for a live run `so far · step i of M`.

Used by the phone (D3–D5) AND the TUI (D7): one truth for "not yet / not run" on both.

**D3 — Phone graph A (pure layout + dumb render).** New `apps/mobile/src/workflow-run-layout.ts`:
- **Placement from the definition**, never from rounds:
  - spine = the `next` walk from `steps[0]` (cycle-guarded);
  - every off-spine step goes in the side column;
  - its row is ≥ its first entering source's row + 1, strictly increasing within the column.
  - Result: two pills can never overlap in either column, for any 64-step file.
- **Edges:**
  - spine `next` = vertical;
  - goto = from the source's right edge into the side pill's top;
  - side `next` back into its target's right edge;
  - retry = self-arc on the right edge;
  - a goto/`next` to an earlier spine step = a back arc on a side lane, one lane per arc so arcs do
    not coincide.
- **Chips** sit at the arc midpoints and are pushed out of pill boxes.
- Authored in the mockup's 402-pt space (spine x16 w200, side x244 w142, pitch 72, pill 44), scaled
  by the existing `canvasMap` (`workflow-step-detail.ts:45-51`, never upscaled).
- `nodeAt` hit test moves here.
- **Shared with the editor:** if `feat/workflow-editor` slice 5 has landed, the spine/side placement
  is ONE function both `workflow-edit-graph.ts` and this module call (its D6 rule "reached only by
  goto/next from below ⇒ side column" is the same rule). `workflow-graph.ts`'s constants that it
  imports keep their names.

`WorkflowRun.tsx` draws it:
- pills with the D4 markers;
- edge strokes per trace (taken = solid `label`, later = dashed dim, never = dotted dim `--wr-dot`,
  go = dashed accent animated unless Reduce Motion; a fail edge is always dashed by kind);
- the summary strip under the header;
- the approve bar pinned at the bottom (today's `AskBlock`, moved; "Open the session to answer it"
  when `!canAnswer`).

**D4 — Markers (pure mapping + tokens).** New `apps/mobile/src/workflow-marker.ts`:
`phase → { symbol: IconName | null, soft, ink, ring?: "dotted", word }`. Style (ii) tinta: a soft
disc with the glyph in ink, the glyph at ~½ of the disc.

| phase | SF Symbol | body | word |
|---|---|---|---|
| ok | `checkmark` | `wr-ok-soft` / ink | done · approved (approve step) · passed (when a verdict passed) |
| error | `multiply` | `wr-fail-soft` / ink | failed · denied (approve step) |
| running | `play.fill` (blinks; static under Reduce Motion) | `wr-run-soft` / ink | running |
| ask | `questionmark` | `wr-ask-soft` / ink | needs approval / waiting on you |
| later | — (**no glyph**, owner) | `wr-wait-soft` disc | not yet |
| skipped | `chevron.forward.2` | no body, dotted ring `wr-skip-ink` | not run |
| stopped | `stop.fill` (Q5) | `wr-wait-soft` / ink | stopped |
| unknown | — | `wr-wait-soft` | the wire word, verbatim |

- Colour-blind check: every row differs by glyph or by body/ring shape, plus the word and the pill
  border (later = dashed pill, skipped = dotted pill).
- Tokens `wr{Ok,Fail,Run,Ask,Wait}{Soft,Ink}` + `wrSkipInk` join `Palette` (`theme.ts:13`) for
  light/dark/petrol, with the values in `markers-v2.html:159-174` (petrol = dark).
- Then `bun run mockup-kit` regenerates the kit tokens.
- The summary strip and the B rail use the same marker: 26 pt in a pill, 18 pt in the rail, 32 pt
  in the detail hero.

**D5 — Phone list B + step detail.**
- The header's right button toggles graph ⇄ list (`list.bullet` / `square.grid.2x2`, as today,
  `WorkflowRun.tsx:251-265`). `RunMode` `"cards"` becomes `"list"`.
- The list = `timeline()` rendered on the chat step-rail look, with «Next» / «Not run» sections.
  The cards and their inline actions go.
- Step detail (`WorkflowStep.tsx`):
  - a real nav bar UNDER the safe area: `‹ <run name>` back, `step N of M` (file order);
  - `heroBox(top, inset, width)` with `top = insets.top + NAV_H + gap` (today `y = inset`,
    `workflow-step-detail.ts:76-83`), so the morph lands below the bar;
  - hero = the pill (A), Q3.
- Never-run step:
  - no `session/workflow_step` read is sent;
  - the body is `notRunWhy` + bands State/Kind/Where.
- Approve step: bands «Asked» (detail `prompt` = the question, `session-log.ts:451`), «Answer»
  (Outcome Allowed/Denied from state + reason, Waited = `durationMs`).
  - No who/when: not decided, not drawn as required.
- Re-run step → the failed step's detail (Q4).
- Stop/Resume stay at the run screen's foot.

**D6 — Hub.**
- `CANONICAL` = `workflows, activity, artifacts, tools, commands, sessions, info, scheduled,
  dictate, new` (`hub-actions.ts:164-176`).
- `attach` is deleted from the hub: `HubEntryId`, `LABELS`, `holds`, `ENTRY_IDS`
  (`hub-session.ts:246-259`), `GLYPH` (`HubFan.tsx:36`), the entry (`SessionScreen.tsx:1199`) and
  e2e `34-hub-attach.yaml`. The composer `+` is untouched.
- Workflows glyph = `point.topleft.down.to.point.bottomright.curvepath` (added to `IconName`).
- Dim rule, `workflowsHub(runs, catalogue)`:
  - not dimmed when a run exists OR the catalogue lists ≥ 1 workflow;
  - dimmed "No workflows in this project" when there are no runs AND the catalogue is known with
    no workflow;
  - dimmed with the catalogue's text when `unavailable`;
  - unknown (not read, failed, offline) → never dimmed (the Tools D3 rule).
- The catalogue is read ONCE when the session attaches — beside the session-info read that feeds
  Tools (`SessionScreen.tsx:1186`) — never on render.
- `catalogueFigure(answer)` is pure, in `workflow-runs-controller.ts`.

**D7 — TUI.**
- Remove the at-rest line: `workflowsLine`/`catalogueLine`/`elsewhereLine`/`catalogueRows`
  (`workflow-view.ts:793-930`), its slot in `app-layout.ts:326-340` and `AppView.tsx:167`,
  `components/WorkflowsLine.tsx`. The `/workflow` panel's catalogue section stays (`:988-1003`).
- Before the first message (`session.opened()` false):
  - the runs note becomes "No workflow run in this session yet." instead of "not supported…"
    (`workflow-view.ts:516-529`);
  - the catalogue: Q1.
- Parity: the rail/panel words come from D2 (`not yet` dim `○`, `not run` dim `–`). The panel's
  detail column lists `next → X`, `on fail → Y (taken/max)`, `retry n` from D1.

### Files (dependency order)

| Slice | Files |
|---|---|
| S1 TUI quiet | `packages/tui/src/{workflow-view.ts,app-layout.ts,AppView.tsx}`, delete `components/WorkflowsLine.tsx`, `packages/tui/test/{workflow-view.test.ts,workflow-frames.test.tsx}` |
| S2 hub | `apps/mobile/src/{hub-actions.ts,hub-session.ts,workflow-runs-controller.ts,ui/HubFan.tsx,ui/Icon.tsx,screens/SessionScreen.tsx}`, `apps/mobile/test/{hub-actions,hub-session,workflow-runs-controller}.test.ts`, `apps/mobile/e2e/flows/34-hub-attach.yaml` → `34-hub-workflows.yaml`, `changelog.d/workflows-ux.changed.md` |
| S3 detail header | `apps/mobile/src/{workflow-step-detail.ts,screens/WorkflowStep.tsx}`, `apps/mobile/test/workflow-run-step-detail.test.ts` |
| S4 wire | `packages/protocol/src/session.ts` (`:808-848` only), `protocol/schema/protocol.json` (regen), `protocol.d/workflows-ux.md`, `packages/agent/src/workflow-driver.ts` (`pendingRow`, `drive`), `packages/core/src/workflow-machine.ts` (export `passTarget`/`edgeKey` if not), `packages/protocol/test/workflow-wire.test.ts`, `packages/agent/test/workflow-driver.test.ts`, fixtures that build rows (`rg "attempt: 0, round: 0"`) |
| S5 projection | `packages/client/src/workflow-run-graph.ts` (new), `client/src/index.ts`, `packages/client/test/workflow-run-graph.test.ts` (new) |
| S6a layout + markers | `apps/mobile/src/{workflow-run-layout.ts,workflow-marker.ts}` (new), `theme.ts`, `ui/Icon.tsx`, `tools/mockup-kit/generated/*` (regen), tests `workflow-run-layout.test.ts`, `workflow-marker.test.ts` (new) |
| S6b graph render | `apps/mobile/src/screens/WorkflowRun.tsx`, `workflow-run-controller.ts` (`RunMode`), `workflow-step-detail.ts` (`nodeBoxOnScreen` → new layout), retire `workflow-graph.ts`'s guess (keep exported constants the editor imports), `apps/mobile/test/{workflow-list-graph,workflow-screens-wiring}.test.ts` |
| S7 list B + detail | `apps/mobile/src/screens/{WorkflowRun.tsx,WorkflowStep.tsx}`, `workflow-step-detail.ts`, `workflow-run-controller.ts` (no read for a not-run step), `workflow-list.ts` (`pending` word), tests + e2e `45-workflow-run-view.yaml` (new) + `e2e/seed.ts` (seeded runs ① ②), `changelog.d/workflows-ux.fixed.md` |
| S8a TUI parity | `packages/tui/src/workflow-view.ts` (`STEP_LOOK`, panel detail), `packages/tui/test/workflow-view.test.ts` |
| S8b catalogue pre-open (if Q1 = A) | `protocol/src/session.ts` (`WorkflowCatalogueParams.sessionId` optional), `daemon/src/{connection.ts,session-host.ts}` (`newSessionWorkflowCatalogue`, throwaway like `newSessionTools`), `client/src/remote-session.ts` (`workflowCatalogue` pre-open asks without id; `workflow({start})` pre-open goes through `createOrAttach()`), tests in `daemon/test/workflow-hosted.test.ts`, `client/test/workflows-client.test.ts`, `tui/test/workflow-frames.test.tsx` |

### Failure modes (how each converges)

| Failure | Converges to |
|---|---|
| **Run still live** | Every `workflows` update re-projects (pure, O(steps+edges)). `later` vs `skipped` comes from reachability at each update, so a step flips `not yet` → `not run` the moment its last entry closes (review passes). The `go` edge is animated; static under Reduce Motion. |
| **Definition changed since the run started** | Edges come from the run's own snapshot (P2). The graph is the run as it RAN, never the file now. The resume refusal `changed` is unchanged. |
| **Older daemon / older app** | `PROTOCOL_VERSION` bump (P1) → `VersionMismatch` at `initialize`, the existing "update tentacle" path on both ends. No half-drawn graph. |
| **A goto taken max times** | Chip `✗ 2/2`, the fail edge `taken`, the source `failed`, the run `Failed` with the driver's reason ("…already ran 2/2 times", `workflow-machine.ts:385-388`) in the strip. The target keeps its last state. |
| **Retry exhausted** | `↻ 1/1`, the step `failed`, then its `on_fail` (goto edge `taken`) or the run `Failed`. Each try is its own B row (`history`). |
| **Cancelled / timeout / budget / interrupted** | Run `Stopped · <reason>`. The cut step is `stopped` (`stop.fill`). Unvisited steps are `not run` ("the run was stopped before it got here"). Resume stays as today. |
| **Huge workflow** (64 steps, many gotos) | Placement is strictly increasing per column (test with 64 steps and nested gotos: no pill overlap). Back arcs get distinct lanes. The canvas scrolls. `history` is capped at 64 with "N earlier steps not shown". Rows stay ~5 KB. |
| **A step with no file order neighbour** (a `next` cycle with a counter) | The spine walk is cycle-guarded; the revisit is an arc, not a second pill. |
| **Hub: catalogue read fails / offline / pod session** | Unknown → not dimmed; `unavailable` → dimmed with its text. The runs list keeps its own rules. |
| **TUI pre-open** | Runs: "no run yet" (never "not supported"). Catalogue: Q1. A `/workflow run` before the open: Q1 = A makes it open the session through the ONE `createOrAttach()`; Q1 = B keeps today's honest refusal. |

### Tests (red first; the property each kills)

- **S1**
  - `workflow-frames.test.tsx`: an idle frame with a 2-workflow catalogue has NO `◇ workflows` row
    and the input row index is unchanged. Red today: the row is painted, `app-layout.ts:333`.
  - `workflowPanelView` with `opened:false` says "no run yet". Red: "not supported".
- **S2** `hub-actions.test.ts`
  - The idle fan is `[workflows, activity, artifacts, tools, commands, more]`, and `attach` is in no
    list. Red today, `:111`.
  - `workflowsHub(runs: [], catalogue: 1 ok)` → not dimmed. Red today: `NO_WORKFLOW_RUNS`.
  - Catalogue known-empty → dimmed "No workflows in this project".
  - Unknown → not dimmed.
  - Mutation: drop the catalogue term → red.
- **S3**: hero `y ≥ insets.top + NAV_H` for `insets.top` 59. Red: `y = inset`. Mutation: back to
  `inset` → red.
- **S4**
  - Wire: a row without `next/onFail/retry/history` fails to parse; with them it round-trips, keys
    kept.
  - Driver (`workflow-driver.test.ts` fakes), the demo-note shape:
    - review passes first → `review.onFail = {goto:"fix",max:2,taken:0}`, `fix.next = "review"`,
      `history` = 5 entries, and `fix` is never in it;
    - review fails once → `taken: 1`, `history` holds review(error) → fix(ok) → review(ok);
    - draft retried → two draft entries with attempt 0/1;
    - more than 64 executions → length 64 + `historyDropped`.
  - Mutation: append history before `nextAction` → the order test is red.
- **S5** `workflow-run-graph.test.ts`
  - The four mockup scenarios as fixtures: phases, traces, chips and `notRunWhy` text exactly as
    drawn (① fix `skipped` + the sentence; ③ archive `later`, fix `skipped`; ④ review→fix `go`,
    confirm `later`).
  - Ended-run `pending` → `skipped`, never `later` (kills the d1b5faaa bug at its root).
  - Unknown word kept verbatim.
  - Exhausted goto; cancelled run; a 64-step chain.
  - Mutation: drop the `taken < max` term in reachability → ② after 2/2 shows `fix` "not yet" → red.
- **S6a**
  - Layout: no pill overlap for random + 64-step definitions. `fix` lands in the side column for
    demo-note.
  - Every edge starts and ends on its nodes' boxes.
  - Chips are outside the pills.
  - Mutation: place by file index → `fix` on the spine → red.
  - Markers: every phase pair differs in (symbol, ring) or the word. `later` has `symbol: null`. All
    names typecheck as `IconName`.
- **S6b / S7**
  - Source-reading wiring tests (the `workflow-screens-wiring.test.ts` pattern): screens import the
    projection/layout/marker and hold no branching beyond mapping.
  - A not-run step sends no `workflowStep` read (controller test with a fake handle). Red today:
    the read is sent.
  - e2e `45-workflow-run-view.yaml` on iOS 18 + 26: ① graph, "Not run — review passed…", the
    header below the status bar, the list toggle.
- **S8a**: an ended run's pending step reads `– not run` in the panel. Red: `○ pending`.
- **S8b**
  - Pre-open `workflowCatalogue()` sends ONE frame with no `sessionId` and returns rows. Red: the
    local `unavailable`.
  - A daemon test with a fake host.
  - A pre-open start opens once, then starts. The fake peer sees `session/open` before
    `session/workflow`.

### Slices (each S or M; one executor at a time)

| # | Slice | Size · Blast | Depends on | When |
|---|---|---|---|---|
| S1 | TUI at-rest line removed + pre-open runs note | S · contained | — | now (disjoint from the editor) |
| S2 | Hub: Workflows in Attach's slot, Attach gone, dim by catalogue | M · cross-module (mobile only) | — | now |
| S3 | Step detail nav bar under the safe area | S · contained | — | now |
| S4 | Wire edges + counters + history (protocol.d note) | M · **load-bearing** (wire): stronger executor per §10 (owner's call), fresh-context review | — | after the editor merges |
| S5 | Shared run projection in `client` | M · contained (new pure module) | S4 | after S4 |
| S6a | Phone layout + markers + tokens | M · contained | S5 | after the editor's slice 5 is on `main` |
| S6b | Phone graph A render + summary strip + ask bar | M · contained | S6a | — |
| S7 | Phone list B + never-run/approve detail + e2e + changelog | M · contained | S6b, S3 | — |
| S8a | TUI not-yet/not-run + edge lines | S · contained | S5 | — |
| S8b | Catalogue before the first message (Q1 = A) | M · cross-module | S4 (same protocol.d note) | — |

Review: one Opus review for S1–S3, a mandatory fresh-context one for S4, then one for S5–S8.

**PARTIAL rule:** before each slice, re-run its checks:
- S4: `lb.ts` still shows the keys stripped, and `passTarget`/`edgeKey` exist;
- S5+: `WorkflowStepRow` has `onFail`;
- S6a: `workflow-edit-graph.ts` exists on `main` (else STOP and ask: build the layout alone, with an
  unify-later note).

If one fails, write `### Slice N — PARTIAL` with the failing line and STOP.

### Overlap with `feat/workflow-editor` (verified: `git diff main...feat/workflow-editor --stat` + its Files table)

| File | Editor slice | This task | Risk |
|---|---|---|---|
| `protocol/src/session.ts` | 3a (done: appends after `:1060`) | S4 (`:808-848`), S8b (`:1060`) | Separate hunks for S4. S8b touches the very line the editor appends after → run S8b after the merge. |
| `protocol/schema/protocol.json` | 3a | S4, S8b | Always regenerated (`protocol:bump`, `-merge`). |
| `agent/src/workflow-driver.ts` | 3b (`source`/`save`, in exec now) | S4 (`pendingRow`, `drive`) | Separate methods, same file → after the merge. |
| `daemon/src/{connection,hosted-session}.ts` | 3b | S8b (`connection.ts`, `session-host.ts`) | After the merge. |
| `client/src/remote-session.ts` | 4 | S8b | After the merge. |
| `apps/mobile/src/workflow-graph.ts` | 5 imports `MAIN`, `LOOP_*`, `PITCH`, `curve` (`:33-63`) | S6b retires its guess | **Contract**: keep the constants; share the placement (D3). After editor 5. |
| `apps/mobile/src/ui/Icon.tsx` | 7a–c likely add names | S2, S6a | Union lines. Trivial rebase. |
| `apps/mobile/e2e/seed.ts` | 7c | S7 | Append-only seeds. After the merge. |
| `apps/mobile/src/screens/WorkflowRuns.tsx`, `App.tsx`, `routes.ts` | 7a | none (S2 reads the catalogue in `SessionScreen`) | — |
| `core/src/workflow-spec.ts` | 1 (split, done) | read-only import | Import path may move: use the barrel. |

**Recommended order:**
1. S1, S2, S3 now, on this branch (file sets disjoint from every remaining editor slice; owner
   memory allows 2 code tasks with disjoint files).
2. Pause.
3. After `feat/workflow-editor` merges: rebase, then S4 → S5 → S6a → S6b → S7 → S8a → S8b.

Alternative: hold the whole task until the editor merges. That gives one rebase and no pause, but
defects 3–6 ship later.

### Mac / TUI parity

- The Mac is the TUI today. The data (D1) and the projection (D2) are one implementation for both.
- The phone draws the graph. The TUI shows the same facts as words: the rail and panel read `not
  yet`/`not run` from D2, and the panel detail lists next / on fail (taken/max) / retry.
- The phone's `Not run — …` sentence and the TUI's are the same string.
- Pre-open, both ends read the same catalogue (Q1). A phone session is open at the tap, so only the
  TUI needed the fix.
- Glyphs differ by medium: SF Symbols on the phone; text glyphs (`✓ ✗ ▸ ? ○ –`) in the TUI, where
  `○` stays because a terminal needs a character. The phone's no-glyph `not yet` disc is phone-only.

### Owner questions (each with a recommendation)

1. **Q1 — Catalogue before the first message (TUI).**
   - A: read it without a session (the `session/skills`/`tools` precedent); a start from the panel
     opens the session first (+S8b, M).
   - B: an honest "Send a message first to list this project's workflows" (inside S1, no protocol).
   - **Rec. A.**
2. **Q2 — The `elsewhere` hint** (`◇ no workflows here — ~/x has 3 (start tentacle in ~/x)`) is
   the same at-rest slot.
   - **Rec.: remove it with the line.** The `/workflow` panel keeps it (`workflow-view.ts:1001-1003`).
3. **Q3 — Step-detail hero: A (pill, the graph's morph lands on it) or B (flat title)** — the
   mockup drew both.
   - **Rec. A** (the morph exists: `workflow-morph.ts`).
4. **Q4 — "Re-run step"** lived on the cards that view B replaces.
   - **Rec.: in the failed step's detail**, under the bands (same condition: state `error`).
5. **Q5 — `stopped` step marker** (not drawn).
   - **Rec.: `stop.fill` on the grey tint, word "stopped"** (the hub's Stop uses the same glyph).

*— claude-opus-5-5, 2026-11-24*

#### Owner answers (2026-11-24, binding)

1. **Q1 = A** — the catalogue reads without a session; a start from the panel opens the session first (S8b).
2. **Q2 — remove the "elsewhere" search ENTIRELY** (owner: «togliamo proprio sta cosa della ricerca in cartelle vicine»): no `~/x has N` hint anywhere (not at rest, not in the `/workflow` panel), and delete the neighbouring-folder lookup code end to end (daemon/protocol/client/TUI/phone, whatever carries it; a protocol field removal goes in the S4 `protocol.d` note or its own).
3. **Q3 = A** — pill hero on the step detail (the graph morph lands on it).
4. **Q4** — «Re-run step» moves to the failed step's detail (state `error`).
5. **Q5** — stopped = `stop.fill` on the grey tint, word «stopped».

Marker glyph change (owner, after Q5): **needs approval = SF `hand.raised` (outline, not fill)** — replaces `questionmark` everywhere a workflow step/run waits on the person (graph, list B, detail, TUI parity where it has a glyph). Pending/not-yet = grey disc with `circle.dashed`; failed `multiply`; running `play.fill`; done `checkmark`. Visual base for S6/S7: `.tentacle/mockups/workflow-run-view/final-v3.inline.html` (v2 look; its metrics table is what the app changes to). Owner (2026-11-24, later): **prev/next in the step detail = (c) a bottom bar with the neighbour's marker + name** (execution order = the B timeline's visits; at the ends the bar says «Start / End of run»; not-run / not-yet steps are reached at the tail, as in B — see final-v3 «Passo precedente / successivo»); add it to S7. **Taken edges are SOLID, goto and retry included** (dashed = possible later, faded dotted = not taken) — overrides the mockup's dashed taken goto/retry.

Executors: DeepSeek for S/M slices (owner rule); S4 (load-bearing wire) DeepSeek too + mandatory fresh-context Opus review.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Execution

### Slice S1 — TUI at-rest line removed + pre-open runs note

**Load-bearing check re-run first** (`.tentacle/tmp/workflows-ux/lb.ts`, unchanged from the plan):

```
review keys after parse: id,kind,where,state,attempt,round
fix state: pending · endedAt: 2
catalogue step keys: id,kind,where
```

The wire row still drops `next`/`onFail`/`retry` and the catalogue step drops its edges — S4's
premise holds. S1 does not depend on it; it only had to not be contradicted by it.

**As built, in order**

1. `packages/tui/src/workflow-view.ts` — deleted `catalogueLine`, `elsewhereLine`, `workflowsLine`,
   `catalogueRows`, `CatalogueGrant`, the `TIER_CATALOGUE_*` tiers, `assemble`, `tilde` and the
   `CATALOGUE_HEAD/GAP/HINT/SEP` constants (all of them existed only for the at-rest line), plus the
   now-unused `cellWidth`/`PROJECT_PATHS` imports. `catalogueName` stays (the panel names rows with
   it). `workflowPanelView` gained a trailing `opened?: boolean` and two exported notes:
   `WORKFLOW_NO_FEED` (the existing "not supported by this computer's tentacle", now reachable only
   for a session that IS open) and `WORKFLOW_PRE_OPEN` ("No workflow run in this session yet — send
   a message to start it."). `undefined` = taken as open, so a host-less mount keeps today's words.
2. `packages/tui/src/app-layout.ts` — dropped the `workflowsLine`/`catalogueRows` call, the
   `catalogueHeight` term from `activeRows`, `panelBodyTop`, `dockTop` and `statusRowY`, the
   `workflowCatalogue` and `home` inputs (nothing else read them), and added `sessionOpened`, passed
   to `panelView`.
3. `packages/tui/src/panels/registry.ts` + `panel.ts` — `PanelAt.opened?: boolean` (absent = open) and
   the matching `panelView(…, opened?)` parameter; `panels/workflow.ts` forwards `at.opened`.
4. `packages/tui/src/AppView.tsx` — the `WorkflowsLine` paint site and its destructure are gone;
   `packages/tui/src/components/WorkflowsLine.tsx` deleted (it had no other caller).
5. `packages/tui/src/App.tsx` — `frameLayout` gets `sessionOpened: sessionRef.current?.opened?.() ??
   true` instead of `workflowCatalogue`/`home`; `useCatalogue` is still called for `refreshCatalogueRef`
   (its read is still what the panel's section paints) but its `catalogue` value is no longer
   destructured, since the line was its only other paint site.

**Drift from the Implementation (and why)**

- **The `elsewhere` hint is NOT removed here.** Q1/Q2's answer makes removing the neighbouring-folder
  lookup end to end (daemon → protocol → client → TUI → phone) a cross-cutting change, and the plan
  itself puts it in S8b / a `protocol.d` note, not in S1. S1 removed only the at-rest *line*
  (`elsewhereLine`), which was S1's own defect 6. The `/workflow` panel's empty-catalogue hint keeps
  its `elsewhere` sentence (`workflow-view.ts` `catalogueSection`) — that survives until the
  end-to-end removal lands. Noted as debt in the plan's own S8b line; nothing was half-deleted.
- **`home` left `FrameInput` entirely.** It was threaded into the layout only for `elsewhereLine`'s
  `~`-shortening. `App` still uses `home` for the header and the attach layer, so the prop stays;
  the layout no longer takes it.
- **One extra guard test touched.** `packages/tui/test/app-view-structure.test.ts:331` pins
  `statusRowY`'s exact arithmetic as source text, so it had to lose the `catalogueHeight` term — the
  same edit the layout got (it is the test that catches a silent re-derivation).

**Tests (red first — shown failing on the buggy code, §9)**

- `packages/tui/test/workflow-frames.test.tsx`, `docs/fix/workflows-ux.md S1: the TUI is quiet at rest`:
  - *no at-rest catalogue line*: an idle frame with the 2-workflow `CATALOGUE` contains no
    `◇ workflows` (and no `nightly`), and **every row of that frame equals the frame's with no
    catalogue seam at all** — the exact property (no cell painted AND no row reserved). Red before
    the fix:
    `expect(received).not.toContain("◇ workflows") … Received: "…◇ workflows  nightly v1 ? needs
    approval · task v3 ✓ approved   /workflow\n──…"`.
  - *the catalogue is still in the `/workflow` panel*: `nightly` and `task v3` paint there, and no
    `◇ workflows` row exists behind it (the line, not the catalogue, was what went).
  - *before the first message*: with a lazy session (`opened()` false, a feed that reported nothing)
    the panel says `No workflow run in this session yet` and never `not supported by this computer's
    tentacle`. Red before the fix: the panel's last row was `  not supported by this computer's
    tentacle`.
- `packages/tui/test/workflow-view.test.ts`, `the /workflow panel > before the first message: no run
  YET, never not supported (S1)`: the pure projection's three cases — `opened:false` →
  `WORKFLOW_PRE_OPEN`, `opened:true` → `WORKFLOW_NO_FEED`, absent → `WORKFLOW_NO_FEED`. Red before
  the fix: `Expected to contain: "No workflow run in this session yet" / Received: "  not supported
  by this computer's tentacle"`.
- Removed with the code they pinned: the at-rest assertions in both files (`catalogueLine` tiers,
  `+k`, `not versioned`, the `elsewhere` line, the mounted-line grant, the input-row-with/without
  cases). `catalogueState`/`catalogueOrder` keep their tests — the panel still uses them.

Verification run, `bun test` on the three touched/covering files:

```
bun test packages/tui/test/workflow-view.test.ts packages/tui/test/workflow-frames.test.tsx
 45 pass, 0 fail, 211 expect() calls
bun test packages/tui/test/app-layout.test.ts
 22 pass, 0 fail
bun test packages/tui/test/app-view-structure.test.ts
 10 pass, 0 fail
```

**Mutation checks (non-vacuity, §9)**

| Mutation | Test that caught it |
|---|---|
| `workflowPanelView`'s note hard-coded back to `WORKFLOW_NO_FEED` (ignore `opened`) | `before the first message: no run YET…` — 1 fail |
| `workflowHeight` given `+ 1` (a phantom row back in the budget) | **nothing** — the old row-equality check passed, because the buggy build reserved the line inside `activeRows` too. That is why the frame test now compares **every row** of the two frames; with the `◇` assertion removed, the buggy source fails it on the whole-frame diff. |
| `opened` ignored, on the frame level (source diff reverted) | 2 fail in `workflow-frames.test.tsx` — the exact frames above |

**Changelog:** `changelog.d/workflows-ux.changed.md` (one bullet). No protocol change, so no
`protocol.d/` note; `packages/protocol/schema/protocol.json` untouched.

**Unverified here (one line):** the gate (`bun run check`: typecheck → lint → test) is run by the
orchestrator's script, not by this executor; `bunx tsc --noEmit` (repo root, whole monorepo) and
`bunx biome check packages/tui` were run here and are clean.

*— claude-opus-5-5 (tentacle executor), 2026-11-24*

### Slice S2 — Hub: Workflows in Attach's slot, Attach gone, dim by catalogue

Started by DeepSeek (stopped by the watchdog at 252 tool calls, edits left in the tree); checked,
corrected and finished by claude-opus-5-5. Everything below is the final tree.

**Load-bearing check re-run first** (`lb.ts`, unchanged): `review keys after parse:
id,kind,where,state,attempt,round` · `catalogue step keys: id,kind,where` — S4's premise still holds;
S2 does not depend on it. S2's own premise (P6, defect 4) re-checked on the HEAD source
(`.tentacle/tmp/workflows-ux/s2-lb.ts`): `workflowsHub` took only the runs (arity 1) and dimmed
`No workflow runs` with 0 runs whatever the project held; the idle fan started with `attach`.

**As built, in order**

1. `apps/mobile/src/hub-actions.ts` — `attach` removed from `HubEntryId`, `LABELS`, `holds`, and
   `HubContext.editable` (its only reader); `CANONICAL` starts with `workflows`;
   `NO_WORKFLOW_RUNS` → `NO_WORKFLOWS_HERE = "No workflows in this project"`.
2. `hub-session.ts` — `attach` out of `ENTRY_IDS`, `editable` out of `hubContextOf`.
3. `workflow-runs-controller.ts` — pure `catalogueFigure(answer)` → `{known, count, unavailable}`
   (`null`/`{unsupported}` = unknown; count = every listed row) and `workflowsHub(runs, catalogue)`
   with the D6 rule: a run → open; `unavailable` → dimmed with its text; known-empty → dimmed
   `No workflows in this project`; unknown → never dimmed. `unsupported` runs keep `Update tentacle`.
4. `ui/Icon.tsx` + `ui/HubFan.tsx` — `point.topleft.down.to.point.bottomright.curvepath` added and
   used as the Workflows glyph; `attach`'s glyph gone.
5. `session-screen-controller.ts` — `SendableHandle.workflowCatalogue?()` and
   `SessionScreenState.catalogue` (raw answer, `null` = unknown); `readCatalogue()` single-flight,
   called once per attach beside `refreshArtifacts()`; a failed read leaves `null`.
6. `screens/SessionScreen.tsx` — folds `workflowsHub(workflowsRuns, catalogueFigure(state.catalogue))`
   into `hubContextOf`; the hub's `attach: openAttach` entry is gone (the composer's `onPhoto` keeps
   `openAttach`).
7. `App.tsx` — passes `workflowsRuns={workflowRuns.state}` instead of the folded figure.
8. e2e: `34-hub-attach.yaml` deleted → `34-hub-workflows.yaml` (fan has Workflows, no Attach; tap →
   run list with its empty state → Start → `workflow-start`); `33-hub.yaml`'s Attach step now checks
   Workflows is in the fan and closes on the scrim; `run.ts` seeds
   `<runDir>/.tentacle/workflows/demo-note.yaml` (the serve cwd = the session cwd, `run.ts:561-588`)
   from the new fixture `e2e/fixtures/demo-note.yaml` (validated: `validateWorkflow` → `ok:true`).

**Drift from the Implementation (and why)**

- **The catalogue read lives in `session-screen-controller.ts`, not in `SessionScreen.tsx`.** D6 says
  "beside the session-info read (`SessionScreen.tsx:1186`)"; that read is the controller's
  (`controller.refreshInfo()`), and §7 keeps I/O and branching out of components. The screen only
  folds two facts through the pure functions. Hence two files not in S2's list: the controller and
  a new test, `apps/mobile/test/session-screen-catalogue.test.ts`.
- **`App.tsx` and `e2e/run.ts` + `e2e/fixtures/demo-note.yaml` touched** (not in the Files row).
  App: the fold needs runs AND catalogue in one place, and the catalogue is the screen's, so the runs
  go down as a prop. run.ts/fixture: without a workflow file in the e2e project, the new flow's
  item would be dimmed and its tap a no-op.
- **`HubContext.editable` removed** — Attach was its only reader (dead field otherwise).
- **Corrected from DeepSeek's draft:** (a) `catalogueFigure` counted only `ok` rows; the plan says
  "lists ≥ 1 workflow", and a project holding only a broken YAML would be dimmed "No workflows in
  this project" — false, the start screen is where its errors show. Now every row counts (test
  updated, mutation below). (b) `34-hub-workflows.yaml` asserted `workflow-runs-empty` NOT visible
  — wrong: with no run the list shows exactly that empty state (`WorkflowRuns.tsx:156-158`); now
  asserted visible.
- **Changelog is `changelog.d/workflows-ux.fixed.md`, not `.changed.md`**: S1 already holds
  `.changed.md`, and a fragment is one file = one bullet (`docs/feat/changelog-fragments.md:139`).
  S2 fixes defect 4, so `fixed` fits. **S7 plans `.fixed.md` too** — it must fold its bullet into
  this one (one bullet), not add a second.

**Tests (red first)**

The HEAD source cannot run the new test files at all (their imports `NO_WORKFLOWS_HERE`,
`catalogueFigure` do not exist there — a link error, not an assertion), so red-on-the-property is
shown by putting HEAD's exact logic back into the new code (M1 = HEAD's order, M2 = HEAD's dim rule):

| Mutation | Red |
|---|---|
| M1 `workflows` back after `scheduled` in `CANONICAL` (HEAD's order) | `hub-actions.test.ts`: *with every entry the idle fan is Workflows · Activity · Artifacts · Tools · Commands · More* (added here — the plan's exact S2 test) and *it holds the fan's first slot* — 2 fail |
| M2 `workflowsHub` dims every 0-run case (HEAD's rule, the plan's "drop the catalogue term") | 4 fail: *no run but a workflow FILE → NOT dimmed*, *an UNKNOWN catalogue never dims*, and in `session-screen-catalogue.test.ts` *the hub's item is then NOT dimmed…*, *a FAILED read stays UNKNOWN* |
| M3 dim on `count === 0` without `known` | 2 fail (the two UNKNOWN tests) |
| M4 `readCatalogue()` not called at attach | 2 fail in `session-screen-catalogue.test.ts` (*the attach reads it ONCE…*, *a project with no workflow file IS dimmed*) |
| M5 count only `ok` rows (DeepSeek's draft) | 1 fail: *every listed file counts — a broken one too* |

All reverted (`rg MUTATION apps/mobile/src` empty). Attach's absence: `hub-actions.test.ts`
*Attach is gone from the hub* passes an `attach` entry in and asserts it is never offered; the
wiring test asserts `attach: openAttach` is gone from `SessionScreen` and `onPhoto={openAttach}` stays.

Verification (narrow, foreground):

```
bun test (apps/mobile) hub-actions hub-session hub-opacity workflow-runs-controller
  workflow-screens-wiring session-screen-catalogue   → 190 pass, 0 fail
bun test (apps/mobile) e2e-flows e2e-gate e2e-shard e2e-preflight e2e-escape-probes
  session-info-reveal drawer-new-session              → 222 pass, 0 fail
bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts → 21 pass
bunx biome check <15 changed files>                   → No fixes applied
bunx tsc -p apps/mobile                               → clean
```

No protocol change (no `protocol.d/` note, `protocol.json` untouched).

**Unverified here (one line):** the Maestro flows `33-hub` / `34-hub-workflows` were not run (they need
the simulator) — verify with the mobile e2e gate on iOS 18 + 26 before merge.

*— claude-opus-5-5 (executor), 2026-11-24*

### Slice S3 — Step detail nav bar under the safe area

**Load-bearing check re-run first** (`.tentacle/tmp/workflows-ux/s3-lb.ts`, written for this slice):
`heroBox(DETAIL.inset = 16, 390)` → `{x:16, y:16, w:358, h:68}`, and the layer drew the back row
in FLOW at `y = 0`. On the owner's iPhone (`insets.top = 59`) that puts the hero's top at 16 — 43 pt
above the safe area, and 16 pt into the back row's own 50 pt band. Defect 3 (screenshots 162fac2b /
d1b5faaa) reproduces as described; the plan's premise holds.

**As built, in order**

1. `apps/mobile/src/workflow-step-detail.ts` — the pure metrics. New `STEP_NAV = {height:
   size.headerChat (50), gap: DETAIL.inset (16)}`; `safeInset(n)` (a NaN/negative/Infinity inset is
   0, never a NaN box); `navBox(insetTop, width)` = the bar pinned at `y = 0` with height
   `inset + STEP_NAV.height`; `heroTop(insetTop)` = `inset + STEP_NAV.height + STEP_NAV.gap`; and
   `navText(steps, stepId, runName)` → `{back, position}` (`step i+1 of M` in FILE order, `back`
   flattened through `oneLine`, `"Run"` when the run has no name). `heroBox` and `flight` take
   `top` as their first argument instead of `inset` — the shape the plan pins in D5.
2. `apps/mobile/src/screens/WorkflowStep.tsx` — the layer reads `useSafeAreaInsets()`, computes
   `top = heroTop(insets.top)`, and draws a real nav bar (`styles.nav`, `paddingTop: insets.top`)
   holding the back pressable (`‹ <run name>`, 50 pt tall) and the `workflow-step-position` label.
   The un-inset back row that used to sit at `y = 0` is gone; the hero/spacer use `top`/`hero.height`
   plus `STEP_NAV.gap`, so the body still cannot slide under the landed pill.
3. `apps/mobile/src/screens/WorkflowRun.tsx` — passes `runName={run.name}` (the bar's back label).

**Drift from the Implementation (and why)**

- **The pure-module test lives in `apps/mobile/test/workflow-step-layer.test.ts`, not in
  `workflow-run-step-detail.test.ts` as S3's Files row says.** That file is the *controller's* test
  (reads, one-in-flight, four answers); `heroBox`/`flight`/`heroText` have always been pinned in
  `workflow-step-layer.test.ts`, and the plan's own S3 test ("hero `y ≥ insets.top + NAV_H`") is a
  property of those functions. Putting it in the controller test would have split one module's
  tests across two files. The controller test is untouched.
- **`navBox` was added though the plan only names `heroBox`.** The mutation pass showed why: with
  the hero assertion alone, a nav bar that only claimed the *inset* (no 50 pt content row) stayed
  green — the weak-inequality trap §2 warns about. `navBox` makes the bar's box an assertion
  (`nav.height - inset === STEP_NAV.height`, and `hero.y - (nav.y + nav.height) === STEP_NAV.gap`),
  and the wiring test pins that the layer draws it that way.
- **`navText` is new, not in the plan.** The plan asks for `‹ demo-note · step 4 of 6`; the words
  are a computation (file order, flattening, the no-name and stale-tap cases) so they belong in the
  pure module (§7), not in the component. `step N of M` counts FILE order per the plan; the
  mockup's `final-v3` later switches to visit order, which is S7's prev/next bar, not this one.
- **The wiring test was extended** (`workflow-step-wiring.test.ts`, +43 lines): the layer is a
  `.tsx` Bun cannot import, so the drawn facts (safe-area read, `heroTop` feeding the flight, the
  bar's `paddingTop`, the position label, the spacer) are pinned from source — the established
  pattern. Not in S3's Files row either; without it nothing would catch a component that reverts
  to `DETAIL.inset`.
- **The changelog bullet was folded into the existing `changelog.d/workflows-ux.fixed.md`** (S2's),
  as S2's own note requires: one fragment = one bullet. Its headline now covers both fixes.
- Kept `HERO_METRICS.height` off the spacer deliberately: it is `DETAIL.heroHeight` (68) either way,
  so the only new term is `STEP_NAV.gap`.

**Tests (red first)**

Red-on-the-property was shown by mutation, from green (the new API does not exist at HEAD, so a
literal "run it on HEAD" is a link error, not an assertion — the S2 precedent):

| Mutation | Red |
|---|---|
| M1 `heroTop` back to HEAD's `y = inset` (`return safeInset(insetTop)`) | 4 fail: *the hero starts at or below insets.top + the nav bar's height*, *the flight LANDS there too*, *the nav bar clears the status bar and sits above the hero*, *a garbage inset … is 0* |
| M2 `navBox` height = the inset alone (no `STEP_NAV.height` row) | 1 fail: *the nav bar clears the status bar and sits above the hero*. **First run of this mutation was GREEN** — the assertion was the weak `nav.height >= inset`; it was tightened to `nav.height - inset === STEP_NAV.height` and `hero.y - (nav.y + nav.height) === STEP_NAV.gap`, then M2 went red (§2/§9 non-vacuity) |
| M3 `navText` position `step ${steps.length} of ${index+1}` (numbers swapped) | 1 fail: *the nav bar's text: the run's name, and the step's place in FILE order* |
| M4 the layer's flight back on `DETAIL.inset` (HEAD's argument) | 1 fail (wiring): *the layer reads the safe-area top, and the hero's top comes from the pure module* |
| M5 `workflow-step-position` label/testID removed from the bar | 1 fail (wiring): *the bar says the run's name and `step N of M` — both from `navText`* |

All reverted (`rg MUTATION apps/mobile/src/screens/WorkflowStep.tsx apps/mobile/src/workflow-step-detail.ts`
empty; the tree's other `MUTATION` hits are pre-existing test comments).

Coverage of the enumerated failure modes that land in this slice: a garbage inset (NaN/negative/
Infinity) yields a finite box; a stale step id gets no position; a nameless run still reads as a
button; a multi-line name is flattened; the body cannot slide under the pill (spacer accounts for
bar gap + hero).

Verification (narrow, foreground):

```
bun test apps/mobile/test/workflow-step-layer.test.ts workflow-step-wiring.test.ts → 42 pass, 0 fail
bun test apps/mobile/test/workflow-*.test.ts (13 files)                          → 221 pass, 0 fail
bun test apps/mobile/test/{workflow-screens-wiring,session-screen-catalogue,hub-actions}.test.ts → 90 pass
bun test scripts/test/mockup-kit.test.ts                                        → 37 pass, 0 fail
bun test scripts/test/changelog-guard.test.ts scripts/test/changelog.test.ts     → 21 pass, 0 fail
bunx biome check <5 changed files>                                              → No fixes applied
bunx tsc -p apps/mobile                                                        → clean
```

No protocol change (`protocol.json` untouched, no `protocol.d/` note): S3 is presentation only. The
mockup kit fingerprints neither `WorkflowStep.tsx` nor `workflow-step-detail.ts`, so no regen was
needed — confirmed by its test staying green.

**Unverified here (one line):** no simulator run — the visual result (`‹ demo-note` and `step N of
M` under a 59 pt status bar, the pill landing below them) is verified by the pure-metrics and
source-wiring tests only; confirm on device with the mobile e2e gate (or the S7 flow
`45-workflow-run-view.yaml` once it exists).

*— claude-opus-5-5 (tentacle executor), 2026-11-24*

### Gate fix — mockup-kit drift (post-exec)

The orchestrator's gate on `feat/workflows-ux` failed exactly one test:
`scripts/test/mockup-kit.test.ts` → `drift: committed tools/mockup-kit/generated/* ===
regenerated from source > no drift` (`expect(received).toBeNull()`).

Cause, not a test bug: S2 edited two sources the kit's generated data fingerprints —
`apps/mobile/src/ui/HubFan.tsx` (its sha, and the `workflows` glyph entry in the GLYPH
picklist) and `apps/mobile/src/ui/Icon.tsx` (the new `IconName`). The generated
`tools/mockup-kit/generated/kit-data.json` still held `list.bullet` and the old sha,
so the kit's docs disagreed with the app.

Fix: `bun run mockup-kit` (the test's own prescribed remedy), which rewrote only that
file — `HubFan.tsx` sha `cc651f7` → `f92e7f6`, GLYPH loses `attach` (the hub item is
gone) and `workflows` becomes `point.topleft.down.to.point.bottomright.curvepath`.
`tokens.css` / `tui-tokens.css` unchanged; a second run is a no-op (idempotent).

```
bun test scripts/test/mockup-kit.test.ts  → 37 pass, 0 fail
bunx biome check tools/mockup-kit/generated/kit-data.json → No fixes applied
bun test apps/mobile/test/{hub-actions,hub-opacity,hub-session,session-screen-catalogue,
  workflow-runs-controller,workflow-screens-wiring}.test.ts → 209 pass, 0 fail
```

No production source changed by this fix; no protocol change.

*— claude-opus-5-5 (tentacle executor), 2026-11-24*

## Review

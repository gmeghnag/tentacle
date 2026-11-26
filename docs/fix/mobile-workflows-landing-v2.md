# fix/mobile-workflows-landing-v2 — the landing's actions become real buttons, with air, and its ask lives in the banner under the navbar

> **Status:** implementation (APPROVED — the owner chose mockup A; the remaining details are orchestrator decisions below)
> **Branch:** `fix/mobile-workflows-landing-v2`
> **Size:** S–M · **Blast:** contained (mobile only; no protocol, no daemon, no persisted format) · **Suited:** Sonnet exec + standard Review (the ask rule touches the phone's ONE sheet: the Review red-teams §7 "single broker" on the phone)
> **Changelog:** `changelog.d/mobile-workflows-landing-v2.changed.md`

Type: fix · Size: S–M · Blast: contained · Suited: Sonnet

## Context

*— claude-opus-5-5, 2026-11-26*

**Owner (2026-11-26 ~01:20, on the merged `feat/mobile-workflows-landing` ee1f6a20, not yet on the phone):**
«le scritte colorate Start Approve Delete con quelle icone sbattono, preferisco i bottoni; tutto così ammassato non mi piace; in alto il permesso attaccato alla navbar (AskSlim, mobile-ask-surfaces)».

New mockups (three variants, light + dark, ask-pending states) in `.tentacle/mockups/mobile-workflows-landing-v2/` (`index.src.html`, self-contained `index.inline.html`). **The owner chose A (2026-11-26 ~01:35)** — six screens:

1. **Landing** — three sections with air: the live runs, `Recent runs  6 ›` as a row, the `WORKFLOWS` band. Each workflow: name `›` (= editor); below, state and description on ONE grey line; below, capsule buttons: **Start** (the only filled one) · **Approve** (grey, only with «? Needs approval») · … · **Delete** (grey, grey word, alone on the right). A broken file has Delete only.
2. **Approve just tapped** — the ask does NOT enter the list and does not pop up: it is the `AskSlim` banner attached under the navbar (the session's banner), `Review ⌃`; on the row Approve reads «Asking…», dimmed.
3. **A run waits for you (+ the earlier Approve)** — same banner, one row, the first ask and «+1»; the top section reads «Needs you» with the run. The banner is the only place where one answers.
4. **Tap on the banner** — the standard sheet of today (origin «Workflow deploy-preview», every step, only **Deny / Allow once**). Dragged down it is the banner again; once answered the banner goes and the row says «✓ Approved».
5. **Delete** — the confirm replaces the buttons: the sentence, then **Cancel** left and **Delete** right (same place as before). Only here is the word Delete red.
6. **Offline** — the usual banner says why; the buttons stay where they are, dimmed (tap = light haptic, no empty sheet).

**What is on `main` today (verified, 340ad571):**

- The action row is three words with SF symbols, Delete in red, 24 pt apart (`apps/mobile/src/screens/WorkflowStart.tsx:249-271`, `styles.actions`/`action` `:594-595`); the view-model carries the icon and the red flag (`apps/mobile/src/workflow-landing.ts:41-48`, `LOOK` `:80-84`). That is «le scritte colorate … con quelle icone».
- Name and state share line 1, the description is a full `subhead` paragraph, a broken file adds its path in mono, and every dimmed item repeats its own reason line — offline prints «Offline — reconnecting…» under EVERY item (`WorkflowStart.tsx:216-230`, `:273-280`; `workflow-landing.ts:130-132`, `:158-163`). That is «tutto così ammassato».
- Decision D8 of `docs/feat/mobile-workflows-landing.md:111` presents the approval ask as a SHEET over the list as soon as it is raised: `askPresentable` over the landing returns true for a run-less workflow ask (`apps/mobile/src/sheet-plan.ts:853-855`), so `askPresented` puts `permission` in the stack (`SessionScreen.tsx:1430-1439`); the e2e gate waits for `perm-sheet` right after Approve (`apps/mobile/e2e/flows/46-workflow-landing.yaml:47-52`). The owner wants the banner under the navbar instead — the session's `AskSlim` in `styles.askBanner` (`SessionScreen.tsx:1949-1968`, `:2544`; `docs/fix/mobile-ask-surfaces.md`, «banner under the header, tap → sheet»).

**Repro (2026-11-26, this worktree @ 340ad571, from `apps/mobile`):**

```
$ grep -n 'workflowsTop) {' -A2 src/sheet-plan.ts
853:  if (workflowsTop) {
854-    return origin.kind === "workflow" && origin.runId === null;
855-  }
$ grep -n '<Icon name={action.icon}\|action.destructive ? palette.red\|styles.askBanner\|<AskSlim' src/screens/WorkflowStart.tsx src/screens/SessionScreen.tsx
src/screens/WorkflowStart.tsx:251:            const color = action.destructive ? palette.red : palette.label;
src/screens/WorkflowStart.tsx:266:                <Icon name={action.icon} color={color} size={15} />
src/screens/SessionScreen.tsx:1952:          <View style={styles.askBanner}>
src/screens/SessionScreen.tsx:1953:            <AskSlim
$ grep -n 'id: "perm-sheet"' e2e/flows/46-workflow-landing.yaml
52:      id: "perm-sheet"
```

Red words + icons on the landing, the approval presented as a sheet over the list (D8) and asserted so by the gate; the `AskSlim` banner exists only on the Session screen.

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** — owner decision (mockup A, 2026-11-26 ~01:35) + orchestrator decisions below. No owner question open.

### Load-bearing assumption

**The landing can show the session's pending ask as a banner and open the SAME sheet on a tap, with no second answer path: the banner only reads the Session screen's sheet and calls its own `unpark()`; the answer is still given on that sheet, through the session's ONE broker.** Proved:

1. The landing already reaches the Session screen's sheet for this session through `SESSION_SCREENS` (`apps/mobile/App.tsx:425`, set `:1916-1925`) and wraps it with `askSourceFromSheet` (`App.tsx:2271-2283`; `apps/mobile/src/workflow-run-controller.ts:130-154`) — today WATCH-only (no `unpark`), to see the approval's falling edge (`apps/mobile/src/workflow-start-controller.ts:261-278`).
2. The run screen already does the very thing proposed here: its `AskSlim` bar (`apps/mobile/src/screens/WorkflowRun.tsx:84-138`) calls the source's `unpark` (`workflow-run-controller.ts:93-94`, `:560`; wired `App.tsx:2156-2161`), and that brings the standard sheet up over the run; nothing on that screen answers (`workflow-run-controller.ts:13-17` rule, cited in `docs/feat/mobile-workflows-landing.md:111`).
3. `unpark()` only flips the sheet's own state; it sends nothing (`apps/mobile/src/permission-sheet.ts:635-638`). Answers go only through the sheet's `answer`/`answerFor` (`permission-sheet.ts:196-205`), whose requester is the one the session's ONE broker gets (`permission-sheet.ts:192`; the phone's broker `apps/mobile/src/connection.ts:234-241`).
4. Whether the sheet is pushed is decided in ONE place, `desiredStack({ permission: askPresented({... presentable: askPresentable(origin, topRunId, workflowsTop) }) })` (`SessionScreen.tsx:1424-1440`), from pure functions (`ask-park.ts:98-100`, `sheet-plan.ts:848-860`). Changing the landing's rule there changes only WHEN the sheet appears, never who answers.

Conclusion: the fix is presentation + one pure presentation rule; §7 "single broker" is untouched (no new resolve call, no new requester).

### Preconditions

- **The sheet's park model** (`docs/fix/mobile-ask-surfaces.md` D3/D4): an ask is `asking` with `parked` (`permission-sheet.ts:113-117`); a swipe parks (`park()`, `:630-634`), the banner's tap unparks (`:635-638`); a re-delivered parked id opens parked (`wasParked`, `:170-175`, `:402-404`; wired `session-screen-controller.ts:825-830`). `present()` builds each new current ask's state (`permission-sheet.ts:362-405`) — the only place an `asking` state is born.
- **The Session screen keeps computing presentation while the landing is on top**: it reads the root routes fresh each render and `ownWorkflowsTop` keeps it "in front" (`SessionScreen.tsx:482-486`, `sheet-plan.ts:819-838`); merged D8 already relies on this to present over the landing.
- **The landing's banner data exists**: `askBanner(state, queued, origin)` → `{title, originShort, more}` (`apps/mobile/src/ask-park.ts:62-87`), `queued` from the sheet (`permission-sheet.ts:224`, `:541`; read at `SessionScreen.tsx:1484-1488`). `AskSlim` is render-only and already takes `title/originShort/more/actionLabel/onPress` (`apps/mobile/src/ui/AskSlim.tsx:12-26`).
- **Capsule metrics**: the compact capsule of the app is AskCard's (`apps/mobile/src/ui/AskCard.tsx:186-193`: `minHeight 34`, `borderRadius 17`, `paddingHorizontal 18`, dimmed `opacity 0.4`; actions gap 10, `:177`). `PillButton` is the 50 pt capsule (`apps/mobile/src/ui/PillButton.tsx:1-5`, `height = SIZE.bigButton` `:36`, `theme.ts:434`), kinds `primary|secondary|destructive|neutral` (`:12`), and it does NOT pass `disabled` to `Pressable` (`:57-62`) — so a dimmed tap still reaches `onPress` (the landing's light haptic, `App.tsx:2357`). `typography.subheadStrong` exists (`theme.ts:369`).
- **Header**: `ScreenHeader variant="compact"` with `left`/`right` slots (`WorkflowStart.tsx:474-503`).
- **The landing's view-model and gate are one module**: `blockedWhy` is both what the screen dims and what the controller checks before sending (`workflow-landing.ts:124-150`; `workflow-start-controller.ts:244-259`).
- **Flow 46 is the landing's e2e gate** (seeded `landing-demo.yaml`, `apps/mobile/e2e/run.ts:529-530`, session id `:2019`); screenshots via `_shot.yaml`, theme flips via `appearance.js` (`e2e/flows/appearance.js`, used by `40-mascot-shots.yaml:69-72`, `:107-110`; hook `e2e/hooks.ts:268`).

### Design

**D1 — Over the landing, an ask arrives as the banner; a tap opens the standard sheet (REPLACES D8 of `docs/feat/mobile-workflows-landing.md`).**

- `permission-sheet.ts`: the `asking` state gains `reviewed: boolean` — «the person brought this ask up from a banner». `present()` sets it `false` (`:375-405`); `unpark()` (`:635-638`) sets `parked: false, reviewed: true` and now also acts on an ask that is not parked but not yet reviewed (it is still a no-op on idle/returned, and on an ask already `reviewed && !parked`). Nothing else reads or writes it; the Session screen's own banner keeps showing only for `parked` (`askBanner`, unchanged).
- `sheet-plan.ts` `askPresentable(origin, topRunId, workflowsTop = false, reviewed = false)`: over the landing → `reviewed`, for ANY origin (an approval, a run's step, the main agent). Off the landing: unchanged (over a run only its own ask; elsewhere always). So nothing ever pops up over the landing by itself; a tap is the person's intent, and the sheet names who asks (origin row).
- `SessionScreen.tsx:1438` passes `state.sheet.reviewed` as the fourth argument. A swipe down over the landing parks it as today → `askPresented` false → banner again; a second tap unparks it.
- `ask-park.ts` new pure `landingAskBanner(state, queued, origin)`: the banner the LANDING shows = an `asking` ask that is NOT presented there (`parked || !reviewed`) → `{title, originShort, more}`; else null (idle, returned, or the sheet is up).
- `workflow-run-controller.ts`: `AskSource` gains optional `banner?(): AskBannerView | null`; `askSourceFromSheet` takes an optional `queued?: () => number` and, when given, offers `banner()` = `landingAskBanner(view, queued(), view.origin ?? {kind:"main"})`. The run screen does not pass `queued`, so it is unchanged.
- `workflow-start-controller.ts`: `deps.asks` widens to `Pick<AskSource, "current" | "subscribe" | "unpark" | "banner">`; `StartState` gains `ask: AskBannerView | null`, refreshed in `sheetChanged()` (`:262-278`, which already runs on every sheet change); new `reviewAsk()` → `asks.unpark?.()` (sends nothing to the session). The falling-edge rule (approval leaves the sheet → «Asking…» ends + ONE re-read) is unchanged.
- `App.tsx:2276-2283`: the landing's source adds `unpark: () => screen.sheet().unpark()` and `queued: () => screen.sheet().queued`; the screen gets `onReviewAsk={() => controller.reviewAsk()}`.
- New render-only `apps/mobile/src/ui/AskBanner.tsx`: the `styles.askBanner` container (`paddingHorizontal 12, paddingTop 6`, moved from `SessionScreen.tsx:2544`) + `AskSlim` with `actionLabel="Review"`. Used by `SessionScreen.tsx:1949-1968` (testID `ask-banner` kept) and by the landing, fixed under `ScreenHeader` and OUTSIDE the `ScrollView` (testID `workflow-landing-ask`).

**D2 — Real buttons: the compact capsule.** `PillButton` gains `size?: "regular" | "compact"` and kind `quiet` (`fill` + `sec`). `compact` = AskCard's capsule: `minHeight size.capsule` (new token `34` in `theme.ts`, which `AskCard.tsx:186-192` then reads instead of its literal — one capsule, one number), radius 17, `paddingHorizontal 18`, `typography.subheadStrong`, no icon; dimmed = the whole capsule at `opacity 0.4` keeping its kind's colours (AskCard's dimmed, `:193`; mockup A·offline / «Asking…»). `regular` keeps today's disabled look (visual review P1, `PillButton.tsx:73-74`) — no other screen changes.

**D3 — The item, with air (mockup A).** In the `WORKFLOWS` band (square, hairlines, no card — unchanged):
- line 1: name (`headline`) + `›`; the whole body opens the editor, as today (`WorkflowStart.tsx:208-215`);
- line 2: ONE grey `footnote` line, `numberOfLines={1}`: `<glyph> <word>` + ` · <description>` when there is one (broken: `✗ Cannot run`);
- a broken file: its errors in mono (as today); its path line goes (the folder line at the bottom + the name say it; the confirm names the file);
- the button row (gap 10): **Start** `primary` · **Approve** `neutral` (only `approved === false`; «Asking…» `quiet`, dimmed, while its ask is open) · flex spacer · **Delete** `quiet` on the right;
- one `why` line under the buttons only when it adds something (old daemon, no Session screen, not ready, bad name, Starting…/Deleting…) — never «Offline» (one banner says it) and never «Asking…» (the button says it);
- item padding `space.inset` vertically (was 12, `:587`).

**D4 — The delete confirm** replaces the button row: `Delete \`<file>.yaml\`? Its prompt files stay.` (`subhead`; `<file>` = the basename of the entry's path) then **Cancel** `neutral` on the left, spacer, **Delete** `destructive` (`fill` + `red`, the word Delete) on the right — the only red on the screen. Same testIDs (`workflow-delete-question|cancel|confirm-<name>`).

**D5 — Sections and states.** Order in the `ScrollView`: the offline `Banner` (ONE, `LANDING_OFFLINE`, only when `state.offline`) → `Needs you` / `In progress` run bands (unchanged rows) → `Recent runs  N ›` row → `WORKFLOWS` band → folder line; section gap `space.inset` (as `styles.content`). Header `+` drawn in `palette.accent` (mockup `x-hbtn`). Offline: every capsule dimmed, tap = light haptic (unchanged `onDimmed`), no per-item line.

**D6 — View-model (`workflow-landing.ts`, pure).** `LandingAction` = `{id, label, enabled}` (drop `icon`, `destructive`: the look is the component's, by `id`); approve's `label` is «Asking…» while its ask is open. `LandingItem` gains `summary: string` (D3 line 2) and drops nothing else the controller reads. `blockedWhy` change: a `busy: "asking"` item blocks ONLY its Approve (`Asking…`); its Start and Delete stay usable (mockup A·ask). `starting`/`deleting` keep dimming the whole item. `landingItem`'s `why` skips `LANDING_OFFLINE` and «Asking…». `deleteQuestion` takes the basename.

#### Owner decisions

1. **Mockup A** (2026-11-26 ~01:35): filled/grey capsule buttons — Start filled, Approve grey only when needed, Delete grey alone on the right, red only in its inline confirm; three sections with air; «Recent runs N ›» as a row; the ask = the `AskSlim` banner under the navbar, tap → the standard sheet. **This replaces D8** («sheet over the list as soon as raised») and its `sheet-plan.ts` rule.

#### Orchestrator decisions

1. **«Reviewed» lives on the sheet's own state, set by `unpark()`.** — A tap must make the ask presentable in the SAME commit that re-renders the Session screen; a separate store would need its own subscription, and a park-on-arrival rule would flash the sheet when the landing comes back on top over an unparked foreign ask (popping a run screen).
2. **After a tap, any origin is presented over the landing** (not only the approval). — Mockup A·+1 shows a run's step ask on the same banner with `Review`: the banner is «the only place where one answers»; the sheet's origin row says who asks. Over a RUN screen nothing changes (S8/Q1).
3. **Start and Delete stay usable while Approve is «Asking…»**, as drawn. — A Start then raises the run's own hash ask (queued, «+1»: harmless, pinned to the same hash, once-only — merged Review nit); a Delete leaves an ask for bytes that are gone, which can only store a record for identical bytes at that path.
4. **Compact capsule = AskCard's metrics through one `size.capsule` token; font `subheadStrong`** (the drawn pixels), not AskCard's `headline`. — Three capsules per row at 15 pt are the calmer row the owner chose; the height/radius/padding are shared so the app keeps one capsule.
5. **Offline: one top banner, no per-item reason.** — Repeating it under every item was part of «ammassato»; the gate (`blockedWhy`) still refuses to send.
6. **The broken file's path line goes; the confirm names the basename** (`deploy.yaml`, not `.tentacle/workflows/deploy.yaml`). — As drawn; the folder line at the bottom gives the directory.
7. **Evidence for the two states flow 46 cannot reach in its gate path** (A·+1, A·offline) comes from a shots-only flow `46b-workflow-landing-shots.yaml` with its own seeded file and session: Approve, then Start of the same file → the run is «Needs you» and the banner says `+1`; both asks denied after the shots; offline via a hook that stops/restarts that flow's serve (reuse the flow-37 stop/start hooks, `e2e/hooks.ts:156-158`, if they can target it; else add one beside them). The executor checks how `40-mascot-shots.yaml` is run and runs 46b the same way (not in the gate if 40 is not). A state that cannot be reached is reported «pixels unverified», never faked. **Executor correction (2026-11-26):** the `+1` cannot be reached (see the «Two asks» failure mode); 46b shoots «a run waits, one banner» and does not assert `+1`.

### Files

Dependency order (pure → wiring → render → e2e):

1. `apps/mobile/src/permission-sheet.ts` — `reviewed` on the `asking` state (`:113-117`), set in `present()` (`:375-405`), `unpark()` (`:635-638`).
2. `apps/mobile/src/sheet-plan.ts` — `askPresentable` fourth parameter + doc comment (`:840-860`).
3. `apps/mobile/src/ask-park.ts` — `landingAskBanner` (beside `askBanner`, `:70-87`).
4. `apps/mobile/src/workflow-run-controller.ts` — `AskSource.banner?` (`:89-95`), `askSourceFromSheet` `queued?` (`:130-154`).
5. `apps/mobile/src/workflow-landing.ts` — D6.
6. `apps/mobile/src/workflow-start-controller.ts` — `ask` in `StartState` (`:90-132`, `state()` `:285-302`), `sheetChanged` (`:262-278`), `reviewAsk()`, widened `deps.asks` (`:154`); on every catalogue read drop `busy` entries whose row is gone.
7. `apps/mobile/src/theme.ts` (`size.capsule`, beside `bigButton` `:434`), `apps/mobile/src/ui/PillButton.tsx` (D2), `apps/mobile/src/ui/AskCard.tsx` (`:186-188` read `size.capsule`).
8. `apps/mobile/src/ui/AskBanner.tsx` (NEW, render-only); `apps/mobile/src/screens/SessionScreen.tsx` (`:1438` pass `reviewed`; `:1949-1968` → `AskBanner`; drop `styles.askBanner` `:2544`).
9. `apps/mobile/src/screens/WorkflowStart.tsx` — D3–D5: `AskBanner` under the header, items, confirm, offline banner, `+` colour; props `onReviewAsk`.
10. `apps/mobile/App.tsx` — landing source `unpark` + `queued` (`:2276-2283`), `onReviewAsk` (`:2330-2365`).
11. `apps/mobile/e2e/flows/46-workflow-landing.yaml` (new ask steps + light/dark shots), NEW `apps/mobile/e2e/flows/46b-workflow-landing-shots.yaml`, `apps/mobile/e2e/run.ts` (seed `landing-shots.yaml` + its session, beside `:529-530`, `:2019`), `e2e/hooks.ts` only if offline needs a new hook.
12. `changelog.d/mobile-workflows-landing-v2.changed.md` — one bullet: `- **Workflows landing: real buttons and the ask under the navbar.** …`.
13. `docs/feat/mobile-workflows-landing.md` — one dated line under D8: «Replaced by `docs/fix/mobile-workflows-landing-v2.md` D1 (owner, 2026-11-26)».

### Failure modes

| Case | How it converges |
|---|---|
| Approve tapped; ask arrives | `reviewed: false` → not presentable over the landing → banner `workflow-landing-ask`, Approve «Asking…». No sheet pops up. |
| Banner tapped | `unpark()` → `reviewed: true` → `askPresented` → the standard sheet over the landing; answer on it (ONE broker). |
| Sheet swiped down over the landing | `park()` → banner again; a second tap unparks. |
| Answered / denied / withdrawn (`budget.wait`) | Ask leaves the sheet → falling edge → «Asking…» ends, ONE re-read (unchanged); banner shows the next queued ask, if any, or goes. |
| Two asks (Approve + a run's) | Banner shows the current; after the first is answered the next is born by `present()` with `reviewed: false` → banner, never a surprise sheet. **Executor correction (2026-11-26):** no `+1` for daemon asks — the client's router prompts ONE at a time (`packages/client/src/permission-router.ts:419-427`, one router per `RemoteClient`), so the second never reaches the sheet while the first is open and `sheet.queued` stays 0. `+N` is drawn only when the sheet itself queues. |
| Landing comes back on top (a run screen popped) with an unparked, not-reviewed foreign ask | Not presentable (`reviewed: false`) → banner. No flash. |
| Ask reviewed over the landing, then the person goes back to the Session screen | `askPresentable` off the landing ignores `reviewed` → as today (presented unless parked). |
| A queued ask arrives while the sheet is up over the landing | It queues behind (sheet unchanged); when it becomes current it is born `reviewed: false` → banner. |
| No Session screen for the session (`asks === null`) | No banner (no source); Approve dimmed «Open this session to approve» (unchanged). |
| Offline | One top banner; capsules dimmed; a tap = light haptic, nothing sent (`blockedWhy` gate unchanged). |
| Delete while Approve is «Asking…» | Allowed (Orchestrator decision 3); after the delete the row is gone and its `busy` entry is dropped on the read (no stale «Asking…» if the file is re-created). |
| Start while Approve is «Asking…» | Allowed; the run's own hash ask queues (`+1`); both pinned to the same hash, once-only. |
| A local ask (no `requestId`) | Same rule: the banner reads the sheet state, not the id; `reviewed` is on the state. |
| Long names / descriptions | Line 2 is one line (`numberOfLines={1}`); the name ellipsizes; the buttons never wrap off-screen (three short words). |

### Tests

Red first on the unchanged code for each (§9); the narrow files are `apps/mobile/test/<name>.test.ts`.

- **`permission-sheet.test.ts`** — a new ask is born `reviewed: false`; `unpark()` on an unparked, unreviewed ask sets `reviewed: true` and sends nothing (requester spy: no resolve); `unpark()` on a parked one sets both; the NEXT ask after an answer is `reviewed: false`.
- **`sheet-plan.test.ts`** — REPLACE the D8 case («over the landing ONLY a file's approval», `:604-611`) with: over the landing nothing is presentable unreviewed (approval, run step, main, sub-agent); reviewed → all presentable; off the landing / over a run unchanged whatever `reviewed`. **Mutation:** ignore `reviewed` over the landing (return true) → the «arrives as a banner» case fails.
- **`ask-park.test.ts`** — `landingAskBanner`: unreviewed → banner; parked → banner; reviewed and not parked (sheet up) → null; idle / returned → null; `+N` from `queued`.
- **`workflow-landing.test.ts`** — action order and labels (`Start`, `Approve`, `Delete`; broken = `Delete` only); «Asking…» blocks only Approve and leaves Start/Delete enabled; offline dims all with `why === null`; `summary` = `? Needs approval · <desc>`, no desc → no ` · `, broken → `✗ Cannot run`; the question names the basename. Update the merged cases that assert the old `why` for offline / asking (`:83-89`, `:102-117`).
- **`workflow-start-controller.test.ts`** — `state().ask` follows the fake source's `banner()` on its subscription; `reviewAsk()` calls `unpark` once and calls NO session method (spy); the approval's falling edge still re-reads exactly once; a read that drops a row drops its `busy`.
- **Wiring** (source-slicing pattern of `workflow-start-wiring.test.ts` / `native-sheets-wiring.test.ts`): `SessionScreen` passes `state.sheet.reviewed` to `askPresentable`; the landing's `askSourceFromSheet` in `App.tsx` has `unpark` and `queued`; `WorkflowStart.tsx` renders `AskBanner` outside its `ScrollView`; `AskCard` and `PillButton` both read `size.capsule`. Mutation: drop `reviewed` from the `SessionScreen` call → the wiring test fails.
- **e2e flow 46 (the gate)** — after Approve: `workflow-landing-ask` visible, `perm-sheet` NOT visible, Approve's label «Asking… landing-demo»; tap `workflow-landing-ask` → `perm-sheet` → Allow once → banner gone, «landing-demo, Approved»; Delete → confirm → gone (unchanged). Shots of A·landing, A·ask, A·sheet, A·delete in light AND dark (`appearance.js` around each `_shot`, back to light at the end).
- **e2e 46b (shots only, Orchestrator decision 7)** — A·+1 and A·offline in light and dark.
- **Evidence at execution:** the 12 simulator screenshots (6 states × light/dark) listed in *Execution* beside the mockup's screens; a state not reached is said so. Then `bun test apps/mobile/test/<the six files>`, `bunx tsc -p apps/mobile`, `biome check` on the changed files; the full gate (`bun run check`) and the 2-sim e2e gate are the orchestrator's.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Repro / load-bearing check (before any edit):** the three Context greps printed the same lines (`sheet-plan.ts:853-855`, `WorkflowStart.tsx:251,266`, `SessionScreen.tsx:1952-1953`, flow 46 `:52`). `unpark()` only committed sheet state; the landing's source had no `unpark`; one `askPresentable` call decided the push. Holds.

**As built, in order** (red = on the unchanged code, on assertions):

| Slice | Change | Red |
|---|---|---|
| 1 | `permission-sheet.ts`: `reviewed`, `unpark()` | 4 fail |
| 2 | `sheet-plan.ts`: `askPresentable(…, reviewed)` | 2 fail |
| 3 | `ask-park.ts`: `landingAskBanner` | 4 fail (against a stub returning null) |
| 4 | `workflow-run-controller.ts`: `banner?`, `queued?` | 1 fail |
| 5 | `workflow-landing.ts`: D6 | 6 fail |
| 6 | `workflow-start-controller.ts`: `ask`, `reviewAsk()`, busy | 6 fail |
| 7 | `theme.ts` `size.capsule`, `PillButton` compact/quiet, `AskCard` | no red run first; mutation M10 |
| 8–10 | `ui/AskBanner.tsx`, `SessionScreen`, `WorkflowStart`, `App.tsx` | 6 wiring fail |
| 11 | flow 46, new flow 46b, `run.ts` (seed, list, `LANDINGSHOTS_ID`) | not run on a simulator |
| 12–13 | changelog fragment; dated line under D8 | — |

**Mutations** (each exit 1, source restored; script `.tentacle/tmp/mobile-workflows-landing-v2/mutate.ts`, gitignored):

| # | Mutation | Failed |
|---|---|---|
| M1 | over the landing ignore `reviewed` (`return true`) | sheet-plan 1 («arrives as a banner») |
| M2 | `SessionScreen` drops `state.sheet.reviewed` | wiring 1 |
| M3 | `unpark()` does not set `reviewed` | permission-sheet 3 |
| M4 | `unpark()` keeps the old parked-only guard | permission-sheet 1 |
| M5 | `landingAskBanner` ignores `reviewed` | ask-park 2 |
| M6 | «Asking…» blocks every action | landing 1 |
| M7 | `reviewAsk` does nothing | landing-controller 1 |
| M8 | a read keeps a gone row's action in flight | landing-controller 1 |
| M9 | a Start forgets the open approval | landing-controller 1 |
| M10 | `AskCard` back to `minHeight: 34` | wiring 1 |

**Drift from Implementation**

1. **`+1` is not reachable** (corrected above). The Session screen's banner has the same limit. A possible follow-up, not built: count `RemoteClient.pendingPermissionsOf(sessionId)` (`remote-client.ts:2276`).
2. The controller keeps «Asking…» as its own set beside the start/delete in flight: with one `busy` record, a Start or a refused Delete erased it while the ask was still open (D6, «label «Asking…» while its ask is open»).
3. The confirm's Delete is dimmed when delete is unusable (offline) and a tap gives the light haptic (D5 «every capsule dimmed»).
4. Controller tests are in `workflow-landing-controller.test.ts` (it has the fake sheet), plus one `banner()` case in `workflow-run-controller.test.ts`.
5. The wiring case «never line-capped» now checks the `Detail` block only: D3 caps the item's name and summary.
6. 46b reuses `16-stop-serve.js` / `16-start-serve.js` (main `serve`), so `hooks.ts` is unchanged; it is in `FLOWS` as flow 40 is.
7. `LandingItem` keeps `path`, `status`, `description`; the Recent runs row is unchanged.

**Evidence** (from `apps/mobile`): `bun test test/permission-sheet*.test.ts test/sheet-plan.test.ts test/ask-park.test.ts test/workflow-*.test.ts test/native-sheets-wiring.test.ts test/e2e-*.test.ts test/theme*.test.ts test/session-screen.test.ts` → 1311 pass, **1 fail**; `tsc -p tsconfig.json --noEmit` clean; `biome check` on the changed files clean. No protocol or schema change.

- The 1 fail is `e2e-gate.test.ts` «every quarantined or known-bug flow has a TODO.md line naming it» (`19-lock-unlock-button`). Neither that flow nor `TODO.md` is touched here; `TODO.md` has no such line since `84d8ac64` (base of this branch). It will fail the full gate until that line is restored.

**Unverified**

- **Pixels:** none of the screenshots exist and flows 46 / 46b were never run. The mockup files were outside this session's allowed directories, so layout follows the plan's text only. Verify with the e2e gate (`--only 46-workflow-landing,46b-workflow-landing-shots`) beside mockup A.
- Full `bun run check`: the orchestrator's.

**Left as is (for Review)**

- The landing's `unpark` does not spend the `ASK_PARKS` note (as planned; same as the run screen): a parked ask reviewed here re-delivers parked.
- The 34 pt capsules have no `hitSlop` (the old words had 8 pt).
- The unreleased `changelog.d/mobile-workflows-landing.added.md` still says «permission sheet over the list».

### Fix round 1

*— claude-sonnet-5-5, 2026-11-26*

**Review finding 1 (MEDIUM, no light + dark shots): NOT A DEFECT; no flow changed.** The pair lives in `apps/mobile/e2e/flows/_shot.yaml:8-20` (unchanged by this branch): it shoots `${SHOT}-light`, runs `appearance.js` dark, shoots `${SHOT}-dark`, and flips back to light. Every shot of flows 46 (4 calls) and 46b (2 calls) goes through it, so a run writes the planned 12 frames. The `grep -c appearance` = 0 on the two flows does not see the included flow. The suggested flip around each `_shot` was not applied: it would save a dark frame under the `-light` name. No Drift entry is needed.

**Added:** a pin in `apps/mobile/test/workflow-start-wiring.test.ts` («the landing's evidence comes in light AND dark»). No red on the unchanged code, since there is no defect; non-vacuity by mutation (script `.tentacle/tmp/mobile-workflows-landing-v2/mutate-shots.ts`, gitignored; each file restored):

```
S1 `_shot` loses its dark frame: exit 1
  (fail) … `_shot` shoots light, flips to dark, shoots again and returns to light
S2 `_shot` never flips to dark: exit 1
  (fail) … `_shot` shoots light, flips to dark, shoots again and returns to light
S3 46 shoots one state in one appearance: exit 1
  (fail) … flows 46 / 46b take their six states through `_shot`
  (fail) … neither flow shoots or flips the appearance by itself
S4 46b drops the offline shot: exit 1
  (fail) … flows 46 / 46b take their six states through `_shot`
S5 review's suggested flip around `_shot`: exit 1
  (fail) … neither flow shoots or flips the appearance by itself
```

**Evidence** (from `apps/mobile`): `bun test test/workflow-start-wiring.test.ts test/e2e-gate.test.ts test/e2e-appearance.test.ts` → 71 pass, 0 fail; `biome check` on the changed test clean. Full gate: the orchestrator's.

**Still unverified:** pixels. Flows 46 / 46b have not run on a simulator; run the e2e gate with `--only 46-workflow-landing,46b-workflow-landing-shots` before merge and compare the 12 frames with mockup A.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; same family as the planner, different model from the executor)

**Verdict: REQUEST-CHANGES** (one MEDIUM, evidence only; the code holds).

**Findings**

1. **MEDIUM — the plan's light + dark shots are not built, and Execution does not declare it as drift.** Tests asks flow 46 to shoot A·landing/ask/sheet/delete «in light AND dark (`appearance.js` around each `_shot`)» and 46b to shoot A·two-asks/offline in both. `46-workflow-landing.yaml:44-99` has four `_shot` calls and 46b two, with zero `appearance` steps (`grep -c appearance` = 0; `40-mascot-shots.yaml` = 2). Failure scenario: the owner checks mockup A's dark variant against the simulator, and no dark frame exists — "pixels unverified" for half the states, and Drift does not say so. Fix: add the `appearance.js` dark/light pair around each `_shot` (as `40-mascot-shots.yaml:69-72`), or record the drop in Drift. Neither flow has run on a simulator yet (Execution says so). The 2-sim gate must run `46-workflow-landing,46b-workflow-landing-shots` before merge, because 46 is a gate flow whose assertions changed (`scrollUntilVisible` after the banner, `text: "Asking… landing-demo"`), and 46b is a new gate entry (`run.ts` FLOWS).

**Gate (this worktree)**: touched tests (`ask-park`, `permission-sheet`, `sheet-plan`, `workflow-landing`, `workflow-landing-controller`, `workflow-run-controller`, `workflow-start-wiring`, `e2e-gate`) → **278 pass, 0 fail**. `bun run lint`: clean (2592 files). `bun run typecheck`: clean. The full `bun run check` was not run here.

**Mutations** (script `.tentacle/tmp/mobile-workflows-landing-v2/rev/mut.ts`, each restored; `git status` clean afterwards):

| Mutation | Result |
|---|---|
| `askPresentable` over the landing → `return true` | red (sheet-plan) |
| `blockedWhy`: «asking» blocks every act | red (landing) |
| `landingAskBanner` drops `!state.parked &&` | red (ask-park) |
| `unpark` back to the parked-only guard | red (permission-sheet) |
| `sheetChanged` never redraws | red (landing-controller) |
| landing source in `App.tsx:2284` drops `unpark` | red (wiring) |
| `PillButton` compact dimmed opacity removed | **green**: unpinned, but presentation only, so not a finding |

On the first try the App.tsx mutation hit the run screen's identical line (`App.tsx:2160`) and stayed green. The wiring test slices `WorkflowStartRoute`, so the landing's own line is pinned. The run screen's `unpark` line is not pinned by any test; that was already true on `main`.

**Premises** (TRUE unless noted): `unpark()` sends nothing (`permission-sheet.ts:646-649`) — TRUE. A single `askPresentable` call site (`SessionScreen.tsx:1439`) — TRUE (grep). The sheet's `onChange` reaches the landing's subscription (`session-screen-controller.ts:809` `emit()` → `screen.subscribe`) — TRUE. A serve left down by 46b is restarted before the next flow (`run.ts:1013-1014`) — TRUE, so there is no cascade.

**Attacks tried**

- §7 single broker: the landing's `deps.asks` is `Pick<…"current"|"subscribe"|"unpark"|"banner">`, with no `answerFor`. `reviewAsk` only calls `unpark`, and every answer still goes through the sheet. No new requester or resolve path. **Holds.**
- A surprise sheet over the landing: a new ask is born `reviewed:false` in `present()`. A run popped back onto the landing with an unreviewed ask → banner, no flash. Off the landing, `reviewed` is ignored. **Holds.**
- Other flows that relied on D8: 34/44/45 grep. Flow 44's hash ask is presented over the RUN screen (`topRunId`), not the landing, so it is unaffected. **Holds.**
- «Asking…» plus Start/Delete: a separate `asked` set means a flight no longer erases «Asking…». A read drops the flight of a row that is gone. **Holds.**
- Banner redraw dedup by `title/originShort/more`: two different asks with equal fields produce the same view, so skipping the redraw is harmless. **Holds.**

**Executor**: honest. It reported the unrun flows, the unreachable `+1` (correct: one router prompt at a time), and the open `ASK_PARKS` and hitSlop items. It ran mutations M1–M10. It missed the dark-shots drift.

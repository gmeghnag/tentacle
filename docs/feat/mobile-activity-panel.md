# feat/mobile-activity-panel — Activity as a low-detent bottom sheet

> **Status:** implementation (plan written, awaiting owner approval)
> **Branch:** `feat/mobile-activity-panel`
> **Size:** M · **Blast:** contained · **Suited:** Opus plan, DeepSeek exec + standard in-context Review
> **Changelog:** `changelog.d/mobile-activity-panel.changed.md`

## Context

*— claude-opus-5-5, 2026-11-17*

Owner report (2026-11-17, phone): the Activity view is "a huge sheet",
"resistant to closing", and its task rows are ugly. Mockups:
`.tentacle/mockups/mobile-activity-panel/index.html` (gitignored). Owner PICKED
**B** (README "CHOSEN", 17/11 ~23:45): a low-detent bottom sheet — the first
detent fits the content (1 row ≈ 140 pt), drag up to a tall detent only when
rows overflow, light scrim, swipe-down closes with no resistance
(velocity-based, no rubber-band hold), tap on the scrim closes, header
"Activity · N", no close button needed. Shared across variants: the row
anatomy (glyph per kind, live step, meta, trailing ■ that needs two taps) and
"never opens when empty".

Evidence (source, 2026-11-17, on this branch at `083a1379`):

- The sheet is a full-height native page sheet: `Modal`
  `presentationStyle="pageSheet"`, `animationType="slide"`
  (`apps/mobile/src/screens/ActivitySheet.tsx:126-131`). A page sheet has one
  (large) detent and iOS's own dismiss resistance — the "huge" and "resistant"
  of the report.
- Rows are generic `Row`s with an `ActivityIndicator` as the only glyph and a
  chevron (`ActivitySheet.tsx:69-101`); Stop exists only inside a detail, behind
  an `Alert` (`SessionScreen.tsx` `confirmStop`, ~line 616).
- Empty is already gated on the hub path: `hub-actions.ts:159-160,227-230`
  (`activityEmpty` → `noop` + "Nothing running", from feat/mobile-hub-tap). The
  header pill renders only with `activityVm.badge` (`SessionScreen.tsx:~872`).
  Not gated: the sheet staying open when the last item ends (it then shows the
  `view.empty` row, `ActivitySheet.tsx:143-147`).
- No gesture/animation library is installed: `apps/mobile/package.json`
  dependencies have no `react-native-gesture-handler`, `reanimated` or
  `@gorhom/bottom-sheet`. The app's own drags use RN `PanResponder` + `Animated`
  with the decision in a pure module (`SessionsDrawer.tsx:147` +
  `drawer-nav.ts` `swipeCloses`/`swipeIsHorizontal`; `SwipeTime.tsx` +
  `row-swipe.ts`).

**Repro:** a feat — the capability is missing; the evidence above is the
source itself (`rg -n 'presentationStyle' apps/mobile/src/screens/ActivitySheet.tsx`
→ `129:      presentationStyle="pageSheet"`). No runtime repro: the sheet is a
`.tsx` (React Native sources are Flow, unimportable from Bun — see
`test/hub-tap-wiring.test.ts:1-8`); simulator check is in Tests.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**A JS sheet (transparent `Modal` + `Animated.Value` translateY + `PanResponder`)
can deliver B's "fits content / tall / no-resistance swipe-down" without a new
native dependency.** Grounds: the repo already ships two drags exactly this way
(`SessionsDrawer.tsx:147`, `SwipeTime.tsx`), and RN `Modal` with
`transparent` + `animationType="none"` lets us own the motion. The native
alternative — a react-native-screens `formSheet` route with
`sheetAllowedDetents: "fitToContents"` — would move Activity out of
`SessionScreen` into a stack route, but all its state (`activityOpen`,
`activityFocus`, the 1 s clock, `controller`) lives in `SessionScreen.tsx:558-640`;
that is a larger, cross-module change. See Owner question 1. If the owner
picks native, this section and Design are rewritten before Execution.

### Preconditions

- The view-model is already pure: `activityView` (`activity.ts:194`) yields
  `groups` + `empty`; `sheetDetail` (`subagent-detail.ts`) yields the detail.
  Nothing in the sheet decides data — it only draws them (AGENTS §7).
- Empty is defined once: `groups.length === 0` ⇔ `view.empty !== null`
  (`activity.ts:239`), and the hub reads the same rule (`hub-actions.ts:60`).
- Stops exist only for the OPEN child/job: `stopChild`/`stopJob` read
  `activity.child`/`activity.job` (`session-screen-controller.ts:1556-1597`).
  An inline row ■ therefore needs a by-id entry point (Design 4).
- All openings go through `SessionScreen`: `openActivity` (`:730`), the
  transcript agent card (`:1053-1056`), the hub (`:786`), the pill (`:880`).

### Design

1. **Pure motion module `src/activity-panel.ts`** (React-free, unit-tested):
   - `panelDetents({ contentHeight, screenHeight, topInset, bottomInset })` →
     `{ low, tall }` in pt of visible sheet height. `low = clamp(contentHeight +
     header + bottomInset, MIN_LOW≈140, tall)`; `tall = screenHeight − topInset −
     TOP_GAP (≈ 44)`. When the whole content fits at `low`, there is no tall
     detent to drag to (`tall` collapses to `low`).
   - `panelRelease({ shown, vy, detents })` → `"close" | "low" | "tall"`:
     velocity first (`vy > FLICK` ⇒ close from either detent, `vy < −FLICK` ⇒
     tall), else nearest detent, and below `low × CLOSE_RATIO (0.6)` ⇒ close.
     No hold, no rubber band upward beyond `tall` (clamped) — "no resistance"
     is: any downward flick closes.
   - `panelDrag(shown, dy, detents)` → the clamped height during the drag.
   - `panelOpensFor(view, focus)` → `boolean`: false when `view.empty !== null`
     and `focus === null` (a detail opened from a transcript agent card still
     opens). `panelAutoClose(view, focus)` → true when the panel is on the
     list and the last item ended (Owner question 3).
   - `panelDetentFor(focus)` → `"tall"` when a detail is open (the message
     field + keyboard need room), else `"low"`.
2. **`ActivitySheet.tsx` → presentation swap, same props.** `Modal transparent
   animationType="none" statusBarTranslucent`; a scrim `Pressable` (palette
   `scrim`, light) that closes; an `Animated.View` sheet anchored at the
   bottom whose height is driven by `Animated.Value`; the grabber + header
   ("Activity · N", count from `view.count + view.unread`) carry the
   `PanResponder` (list scroll keeps its own gesture: dragging the LIST does
   not move the sheet — Owner question 2). `onLayout` of the content measures
   `contentHeight` → `panelDetents`. Open = spring 0 → `low` (or `tall` when
   opened on a detail); release → `panelRelease`; `"close"` animates to 0 then
   calls `onClose`. Reduce Motion → no spring, a 150 ms timing.
3. **Row anatomy (`ui/ActivityRow.tsx`, render only).** Per mockup "Shared":
   leading glyph by `row.kind` (sub-agent: spinning arc — reuse `StepNode`'s arc
   if it fits, else `ActivityIndicator`; job: terminal glyph; scheduled: clock;
   finished: doc + accent dot + bold title when `unread`); title (mono when
   `row.mono`); `row.step` mono, one line; `row.meta` secondary; trailing:
   running → thin ■, unread → "Open ›", scheduled → "›". The glyph choice is
   presentation and stays in the component; the view-model gains nothing.
4. **Inline two-tap Stop.** Pure `stopArm` in `activity-panel.ts`:
   `arm(state, id, now)` / `confirm(state, id, now)` → `{ armed, fire }`,
   reverting after `ARM_MS = 3000`; tap 1 turns ■ into a red-outlined "■ Stop"
   pill, tap 2 fires. This REPLACES the `Alert` only for the inline row
   (the detail's Stop keeps `confirmStop`). Controller gains
   `stopRow(kind: "child" | "job", id)` that reuses the existing kill + outcome
   path (`killChildOutcome`/`killJobOutcome`) without opening the detail; the
   notice surfaces on the row's meta until the next activity update. Two-tap
   = the confirmation; no Alert on top (Owner question 4).
5. **Close paths converge on ONE handler** (the existing `onClose` body in
   `SessionScreen.tsx:1436-1441`): scrim tap, swipe/flick, Android back
   (`onRequestClose`), auto-close (3), "Show in chat", Scheduled. `floatShown`
   keeps `activityOpen` in its `covered` list (`:721`) — unchanged.
6. **Out of scope (follow-up `feat/mobile-activity-row-actions`):** swipe-left
   row actions (Message/Stop/Cancel/Mark read) and the long-press context menu
   from the mockup's shared anatomy (Owner question 5).

### Files

1. `apps/mobile/src/activity-panel.ts` — new, pure (detents, release, drag,
   open/auto-close gates, stop arm).
2. `apps/mobile/src/session-screen-controller.ts` — `stopRow(kind, id)` +
   its interface entry (~`:474-480`).
3. `apps/mobile/src/ui/ActivityRow.tsx` — new, render only.
4. `apps/mobile/src/screens/ActivitySheet.tsx` — `pageSheet` → transparent
   Modal + animated sheet + scrim; rows via `ActivityRow`; header count.
5. `apps/mobile/src/screens/SessionScreen.tsx` — `openActivity` honours
   `panelOpensFor`; an effect closes on `panelAutoClose`; pass `onStopRow`.
6. `apps/mobile/test/activity-panel.test.ts`,
   `apps/mobile/test/activity-panel-wiring.test.ts` — new.
7. `changelog.d/mobile-activity-panel.changed.md` — one bullet.

No protocol, daemon, persistence or TUI change.

### Failure modes

- **Content taller than the screen** → `low` clamps to `tall`; the list
  scrolls inside; no detent beyond `tall`.
- **Content changes while open** (a row ends/arrives) → `onLayout` re-measures;
  if the sheet sits at `low` it animates to the new `low`; at `tall` it stays.
  Last item ends on the list → auto-close (or stays with "Nothing running",
  per Q3) — never an empty sheet left open silently.
- **Detail open when its child ends** → `sheetDetail` already flips it to the
  report (F14); the sheet stays at `tall`; no auto-close on a detail.
- **Keyboard in the sub-agent message field** → detail forces `tall`;
  `KeyboardAvoidingView` inside the sheet (`behavior="padding"` on iOS).
- **Inline stop, tap 2 after 3 s** → the arm has reverted; tap 2 is a fresh
  tap 1 (no fire). **Row vanishes between taps** → the arm keyed by id is
  dropped on the next view (`stopArm` prunes ids not in the view).
- **Stop RPC fails / older daemon without `killSubagent`** → the existing
  `killChildOutcome` / `ACTIVITY_UNSUPPORTED` notice, shown on the row.
- **Concurrent opens** (hub + agent card in the same frame) → both set the same
  `activityOpen`/`activityFocus` state; last focus wins, as today.
- **Disconnect while open** → the view goes empty/stale exactly as today;
  auto-close applies only to the list.
- **Drag starts on the list** → the list scrolls, the sheet does not move
  (no gesture fight).

### Tests

- `activity-panel.test.ts` (Bun, pure): detents for 1 / 3 / 9 / 40 rows and
  small vs large screens (`low ≥ MIN_LOW`, `low ≤ tall`, `low ≤ half the
  screen`, no tall detent when content fits, `low` still ≤ `tall` when the
  content outgrows even `tall`); a drag in flight clamps to `[0, tall]` and does
  not move when there is one detent; `panelRelease` table — downward flick
  closes from `low` AND `tall`, upward flick → `tall`, slow drag below
  `0.6·low` → close, nearest otherwise; `panelFollowsContent` — a re-measured
  content moves a sheet resting at `low` only, never one dragged to `tall` and
  never a first measure; `panelOpensFor` false on empty list, true on a focused
  detail; `panelAutoClose` only on the list; `stopArm` arm → confirm fires,
  confirm after 3 s does not, pruned row does not.
- `session-screen-activity-actions.test.ts` (extend): `stopRow("child", id)`
  calls `killSubagent(id)` WITHOUT `openChild`; `stopRow` on an unsupported
  handle yields `ACTIVITY_UNSUPPORTED`; a second Stop while the first is in
  flight sends no second kill; the notice is cleared by the next update and an
  open detail is left alone.
- `activity-panel-wiring.test.ts` (source-pinned, the `hub-tap-wiring.test.ts`
  pattern): `ActivitySheet.tsx` has no `pageSheet`, uses `transparent`; the
  PanResponder release calls `panelRelease`; a re-measured content goes through
  `panelFollowsContent`; the detail's `KeyboardAvoidingView` and detent are the
  module's; `SessionScreen` gates `openActivity` with `panelOpensFor`; every
  close path calls the one handler; the two opens write the same state.
- Red first (§9): each new test is shown failing before its slice lands;
  non-vacuity by mutation (§ Execution's list).
- **Simulator check (not automatable):** open with 1, 3, 9 rows; flick down
  from both detents; tap scrim; open an agent card's detail and type a
  message; light + dark. Screenshots into Execution.

### Owner questions

1. **Sheet engine:** JS sheet (transparent Modal + Animated + PanResponder,
   the drawer's pattern) or native react-native-screens `formSheet` route with
   `fitToContents` detents? *Recommendation: JS sheet* — no new route, state
   stays in `SessionScreen`, detents and "no resistance" are ours to tune and
   testable; native gives the system feel but moves Activity into the
   navigator (cross-module).
2. **Drag surface:** only grabber + header move the sheet, or also dragging
   the list when it is scrolled to the top? *Recommendation: grabber + header
   only* now (no scroll/drag fight); list-at-top drag as a polish follow-up.
3. **Last item ends while the panel is open on the list:** auto-close with a
   light haptic, or stay open showing "Nothing running"? *Recommendation:
   auto-close* (it matches "never open when empty"); a detail never
   auto-closes.
4. **Inline row Stop:** the mockup's two-tap ■ → "■ Stop" (reverts after 3 s)
   replacing the Alert for rows, or keep Stop only in the detail?
   *Recommendation: two-tap inline*, Alert kept for the detail's Stop.
5. **Swipe-left actions + long-press menu** (mockup shared anatomy): in this
   task or a follow-up? *Recommendation: follow-up*
   `feat/mobile-activity-row-actions` — keeps this M and contained.
6. **Detail (sub-agent card / job log) opened from a row:** stays inside the
   sheet, which jumps to the tall detent? *Recommendation: yes*, back returns to
   the list at `low`.

## Execution

*— deepseek-v4-pro (DeepSeek), 2026-11-17*

Built in the Implementation's order (the protocol → daemon → client → cli → tui
order does not apply: this task touches only `apps/mobile`). Every slice was RED
first — the test written and seen failing before its implementation.

1. **`apps/mobile/src/activity-panel.ts` (new, pure, React-free).** The two
   detents (`panelDetents`/`panelDrag`/`panelFollowsContent`/`panelRelease`),
   the open/auto-close gates (`panelOpensFor`/`panelAutoClose`) and the detent a
   sheet opens at (`panelDetentFor`), the inline two-tap Stop's arm
   (`stopTap`/`stopArmed`/`pruneArm`), plus the constants (`PANEL_MIN_LOW` 140,
   `PANEL_TOP_GAP` 44, `PANEL_HEADER` 62, `PANEL_LOW_CAP` 0.5, `PANEL_FLICK`
   0.6, `PANEL_CLOSE_RATIO` 0.6, `STOP_ARM_MS` 3000, `STOP_IDLE`). Nothing in it
   imports React or React Native (AGENTS §7).
2. **`apps/mobile/test/activity-panel.test.ts` (new).** 30 pure tests: the
   detents (1 / 3 / 9 / 40 rows, large and small screen, a content that outgrows
   even `tall`), a drag in flight, the release table, `panelFollowsContent`, the
   open/auto-close gates, the open detent, the two-tap Stop. RED first against a
   stub module (18 assertions failing before the implementation); the
   `panelFollowsContent` block came later and was shown red against the un-wired
   effect (drift list, item 2).
3. **`apps/mobile/src/session-screen-controller.ts`.** `ActivityState` gained
   `stopNotices: Readonly<Record<string, string>>`; the interface gained
   `stopRow(kind, id): Promise<void>`, implemented by REUSING
   `killChildOutcome`/`killJobOutcome` (never `openChild`/`openJob`, so a row
   Stop does not open a detail). A `rowStops` `Set` is the single flight per row;
   both the `onSubagents` and `onJobs` subscriptions reset `stopNotices`, so a
   notice never sticks past the next view.
4. **`apps/mobile/test/session-screen-activity-actions.test.ts` (extended).** A
   `Stop from a ROW…` describe with 8 tests: child and job kills by id with no
   detail opened, a `{killed:false}` notice keyed by the row's id, a thrown kill
   as a notice (never a throw at the UI), an unsupported handle refusing typed,
   the single flight, the notice cleared by the next update, and an open detail
   left alone. RED shown first (`stopRow is not a function`).
5. **`apps/mobile/src/ui/ActivityRow.tsx` (new, render only).** One activity
   row: the kind's glyph (an `ActivityIndicator` arc for a live sub-agent; the
   terminal / clock / `doc.on.doc` icons), the title (mono when the row is mono,
   bold when unread), one line of step, the meta, the notice line, and a trailing
   ■ that becomes the "■ Stop" pill when armed (`onStop` only for a
   subagent/job row) or `Open ›`/`›` for a finished/scheduled one.
6. **`apps/mobile/src/screens/ActivitySheet.tsx` (rewritten).** `pageSheet` → a
   transparent, motionless `Modal` (`animationType="none"`,
   `statusBarTranslucent`) with a scrim `Pressable` (`testID activity-scrim`), an
   `Animated.Value` height driven by a `PanResponder` on the HEADER only, the
   detents from `panelDetents` over the measured content
   (`onContentSizeChange`) and the screen (`onLayout`), a `close()` that animates
   to 0 and only THEN calls `onClose` (guarded, so a double close cannot fire
   twice), Reduce Motion honoured (a 150 ms `timing` instead of the spring),
   opened at `low` (list) or `tall` (detail), the header reading `Activity · N`
   (`view.count + view.unread`), and the detail (`JobDetail`/`SubagentDetail`)
   inside a `KeyboardAvoidingView`. The old `Sheet`/`pageSheet`/close glyph are
   gone.
7. **`apps/mobile/src/screens/SessionScreen.tsx`.** `openActivity` is gated by
   `panelOpensFor(activityVm, null)`; `closeActivity` (a `useCallback`) is the
   ONE close — it clears `activityOpen`, `activityFocus`, the arm and the
   controller's detail, so the four can never disagree (the scrim, the swipe,
   Android's back and the auto-close all pass through it); an effect closes the
   panel on `panelAutoClose(activityVm, activityFocus)`. The row Stop is the
   two-tap arm (`stopTap` + `playHaptic("light"/"firm")` +
   `controller.stopRow`), the arm is pruned by the current row ids (`pruneArm`)
   and reverts on its own through one timer that bumps the panel's clock. The
   sheet is handed `focus`, `now`, `onStopRow`, `arm`, `stopNotices`,
   `onClose`, `reduceMotion`.
8. **`apps/mobile/test/activity-panel-wiring.test.ts` (new).** 17 source-pinned
   tests (the `hub-tap-wiring.test.ts` pattern) for what is `.tsx` and therefore
   unimportable from Bun: no `pageSheet`/`transparent`/`Animated.Value`, Reduce
   Motion, the release asking the pure module, the pan on the header only, every
   close path on one handler, the `panelOpensFor` gate, the auto-close effect,
   the `panelFollowsContent` re-settle, the `KeyboardAvoidingView` and the
   detail's detent, `ActivityRow`, the header count, the two-tap arm, `stopRow`
   killing without opening a detail, and the two opens writing the same state.
   RED was proven by running the same 13 checks against the `HEAD` sources from a
   scratch script (`.tentacle/tmp/mobile-activity-panel/red-wiring.ts`): 0 pass /
   13 fail.
9. **e2e + changelog.** `apps/mobile/e2e/flows/27-activity.yaml` taps the scrim
   (twice) instead of `activity-sheet-close`, `33-hub.yaml` asserts
   `activity-sheet` `notVisible`, `apps/mobile/test/e2e-flows.test.ts` matches; a
   `changelog.d/mobile-activity-panel.changed.md` bullet states the change.

### Drift from the Implementation (all deliberate)

1. **The detent formula (`PANEL_LOW_CAP`).** The plan's
   `low = clamp(content+header+bottomInset, MIN_LOW, tall)` made `tall`
   UNREACHABLE: `low` was always the content's own height, so `tall` collapsed
   onto it and B's "drag up to a taller detent" could never happen. Fixed as
   `low = min(max(fits, PANEL_MIN_LOW), min(tall, max(round(screen·0.5),
   PANEL_MIN_LOW)))`, with the second detent existing (`tall > low`,
   `scrollable`) only when `fits > low`. Verified numbers: iPhone 844/47/34 —
   1 row → low 146 / tall 146; 3 rows → 246 / 246; 9 rows → low 422
   (`round(844/2)`), tall 753, scrollable; small screen 667/20/0 — 9 rows →
   low 334, tall 579.
2. **`panelFollowsContent` (found while covering the failure modes).** The
   plan's failure mode says a changed content re-settles the sheet "if it sits
   at `low`; at `tall` it stays", but the first implementation re-settled on any
   `detents.low` change, including from `tall`. The rule is now a pure function
   and the sheet asks it.
3. **`ActivitySheet`'s props.** Gained `focus`, `now`, `onStopRow`, `arm`,
   `stopNotices`, `reduceMotion`; lost only the close glyph (Design 5 has no
   close button — the scrim, the swipe and Android's back are the doors).
4. **The inline Stop's notice rides `ActivityState.stopNotices`.** The plan said
   "shown on the row's meta"; a dedicated `Record<rowId, string>` keeps a failed
   row Stop out of the row's own metadata, and the next activity update clears
   it, so a notice is never sticky.
5. **The e2e flows and their test** changed from `activity-sheet-close` to
   `activity-scrim` (27) and `activity-sheet` (33): the close button those flows
   tapped does not exist in Design 5.
6. **The empty-list `Row` line and the group bands are unchanged.** The panel
   never OPENS on an empty list (`panelOpensFor`) and auto-closes when the list
   empties (`panelAutoClose`, Owner Q3), so `view.empty` only shows during the
   moment before the sheet animates away; it was not redesigned.

### Mutations run (each caught by a test, then reverted)

| # | Mutation | Red |
|---|----------|-----|
| M1 | `panelRelease`: flip the flick sign | 4 tests |
| M2 | `panelOpensFor`: ignore `focus` | 1 test |
| M3 | remove `PANEL_LOW_CAP` (the plan's original formula) | 5 tests |
| M4 | `stopTap`/`stopArmed`: the window never expires | 1 test |
| M5 | the next activity update no longer clears `stopNotices` | 1 test |
| M6 | drop the `rowStops` single-flight guard | 1 test |
| M7 | `panelFollowsContent`: drop the `shown` check (re-settle from `tall`) | 1 test |
| M8 | `panelFollowsContent` un-wired in the sheet (`false && …`) | 1 wiring test |
| M9 | the hub's open path drops `setActivityOpen(true)` | 1 wiring test |

### Validation

- `bunx tsc --noEmit`, `bunx tsc -p apps/mobile`, `bunx tsc -p apps/relay` —
  clean.
- `bun run lint` — clean (0 errors, 0 warnings).
- `bun test` (full suite, once at the end) — **14929 pass / 5 skip / 0 fail**
  (14934 tests, 1068 files). The 5 skips are the opt-in ones (§6): live docker,
  live k8s, the slow real-socket keepalive, and the CLI's own docker and k8s
  live files — verified one by one, each `1 skip`, nothing else skipping.
- No protocol, daemon, client, persistence or TUI change: **no `protocol.json`
  regeneration and no `protocol.d/` note** (no `PROTOCOL_VERSION` move).
- **Not verified here (not automatable):** the simulator pass — open with 1, 3
  and 9 rows, flick down from both detents, tap the scrim, open an agent card's
  detail and type a message, light and dark. That is the owner's check; nothing
  on this branch was run on a device.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; same family as the planner,
different from the executor)

**Verdict: REQUEST-CHANGES** (one HIGH; the pure module, controller and wiring
otherwise hold).

**Findings**

1. **HIGH — a close interrupted mid-animation leaves the sheet unclosable.**
   `ActivitySheet.tsx:236-246`: `close()` sets `closing.current = true` and
   clears it only in the spring's `done`, which runs only when
   `finished === true` (`:224-228`). Any other `animateTo`/`setValue` on the
   same `Animated.Value` stops the spring with `{finished:false}` (RN
   `SpringAnimation.stop()` → `__notifyAnimationEnd({finished:false})`), so
   `closing` stays `true` and `onClose` never fires. Triggers during the
   ~0.5 s close: the open effect (`:256-262`, deps `detents.low`/`wanted`)
   re-runs when a row arrives/ends (content re-measure) or the person taps a
   row (`focus` → `wanted`), and a re-grab of the header calls
   `height.setValue` (`:286`). Result: the sheet springs back open and the
   scrim, a flick and Android back (`onRequestClose={close}`) all return early
   at `:237` — a modal overlay the person cannot dismiss until something else
   flips `visible`. (Reduce Motion's `timing` path calls `done` regardless, so
   it is not affected.) Fix: reset `closing` on any non-finished end too, or
   make the open/follow effects skip while closing; add a wiring pin.
   Not unit-testable in Bun (RN is Flow); verified from source of the effect
   deps + RN 0.88 `SpringAnimation.js:367-374`.

**Gate:** touched tests (`activity-panel`, `activity-panel-wiring`,
`session-screen-activity-actions`, `e2e-flows`) 112 pass / 0 fail;
`bun run lint` clean; `bun run typecheck` clean. Full `bun test` not re-run.

**Mutations (reverted, tree byte-identical by `git status`):**
`panelAutoClose` ignoring `focus` → 1 fail; `stopTap` window never expiring →
1 fail. Executor's M1–M9 table is consistent with what was spot-checked.

**Attacks tried:** (a) interrupted close → finding 1; (b) open effect vs
`panelFollowsContent` at `tall` — the open effect re-animates on any
`detents.low` change, but with scrollable content `low` is the cap constant,
so a dragged-tall sheet is not pulled down in practice (no finding);
(c) row Stop single-flight / notice lifetime / detail untouched — holds
(`session-screen-controller.ts:1625-1648`); (d) §7 invariants: no protocol,
persistence, broker or transport change; logic in `activity-panel.ts`,
component renders — holds except the close-guard state machine, which lives
in the component and is exactly where the bug is (another argument for §7).

**Executor behaviour:** honest drift list and mutation table; the detent-cap
drift is a real fix of a plan error. It missed the animation-interruption path
of its own "one close door".

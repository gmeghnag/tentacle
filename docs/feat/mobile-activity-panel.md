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

- `activity-panel.test.ts` (Bun, pure): detents for 1 / 3 / 9 rows and small vs
  large screens (`low ≥ MIN_LOW`, `low ≤ tall`, no tall detent when content
  fits); `panelRelease` table — downward flick closes from `low` AND `tall`,
  upward flick → `tall`, slow drag below `0.6·low` → close, nearest otherwise;
  `panelOpensFor` false on empty list, true on a focused detail;
  `panelAutoClose` only on the list; `stopArm` arm → confirm fires, confirm
  after 3 s does not, pruned row does not.
- `session-screen-activity-actions.test.ts` (extend): `stopRow("child", id)`
  calls `killSubagent(id)` WITHOUT `openChild`; `stopRow` on an unsupported
  handle yields `ACTIVITY_UNSUPPORTED`.
- `activity-panel-wiring.test.ts` (source-pinned, the `hub-tap-wiring.test.ts`
  pattern): `ActivitySheet.tsx` has no `pageSheet`, uses `transparent`; the
  PanResponder release calls `panelRelease`; `SessionScreen` gates
  `openActivity` with `panelOpensFor`; every close path calls the one handler.
- Red first (§9): each new test is shown failing before its slice lands;
  non-vacuity by mutation on `panelRelease` (flip `FLICK` sign → test fails).
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

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*

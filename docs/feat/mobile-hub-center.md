# feat/mobile-hub-center — the hub can rest at the centre, and floats

> **Status:** implementation (APPROVED)
> **Branch:** `feat/mobile-hub-center`
> **Size:** M · **Blast:** contained · **Suited:** DeepSeek executes, Opus reviews (TODO: «Opus mockups → DS exec»)
> **Changelog:** `changelog.d/mobile-hub-center.changed.md`

Blast note: the change stays in `apps/mobile` (no protocol, no daemon, no
terminal path). It adds two OPTIONAL fields to the phone-local Activity button
record, inside the same `v: 1` — the precedent `opacity` set
(`apps/mobile/src/activity-settings-store.ts:33-39`). That is the one
persisted-format touch, and it is additive.

Mockup (final, 2 variants: **Oggi** for comparison + **Scelta** in 6 states,
light and dark): `.tentacle/mockups/mobile-hub-center/index.inline.html`
(source `index.html` beside it; gitignored, so it stays on the owner's Mac).

## Context

*— claude-opus-5-5, 2026-11-26*

The floating hub (⁘) rests on the left or right edge of the band between the
header and the composer. The owner wants it to be able to rest at the CENTRE
too, and wants it to float: nothing behind it moves or keeps space free for it.

Today:

- The resting place is `Edge = "left" | "right"`
  (`apps/mobile/src/floating-button.ts:32`). A drop snaps to the nearer half
  (`floating-button.ts:78`). `place` only knows the two edge x values
  (`floating-button.ts:100`).
- The stored record accepts only `"left"` / `"right"`
  (`apps/mobile/src/activity-settings-store.ts:70`). Any other value drops the
  position.
- The pending bubbles reserve the hub's column (`HUB_COLUMN` = 64 pt) at BOTH
  edges through `footClearance` (`floating-button.ts:158-160`, wired at
  `apps/mobile/src/screens/SessionScreen.tsx:2134`, applied as the row's
  `paddingHorizontal` at `apps/mobile/src/screens/compose/PendingBubble.tsx:101`).
- The transcript's end is always lifted above a hub resting in the lower half
  (`listEndPadding`, `floating-button.ts:172-189`, wired at
  `SessionScreen.tsx:2161-2165`). There is no setting for it.
- While the transcript scrolls, the hub stays at full strength and takes taps.

**Owner decisions** (TODO item, 2026-11-23 ~11:15 and ~12:05, from the mockup
https://claude.ai/artifact/LMeMREwnkcGAtxYXKTixnv v2; recorded here as given,
not reopened):

1. **The centre is a third resting place**, alongside left and right.
2. **The hub FLOATS**: in every position, nothing behind it moves or reserves
   space for it.
3. **Dragging looks EXACTLY like today**: no snap-column guides. The v2 mockup's
   dashed columns and highlighted target column are NOT wanted.
4. **2 B, scroll fade**: while the transcript scrolls, the hub fades to 20 % and
   ignores taps. It comes back 600 ms after scrolling stops, with a 150 ms fade.
5. **Remove `footClearance`**: the pending bubbles no longer keep `HUB_COLUMN`
   clear at either edge.
6. **`listEndPadding` becomes a setting**: on = today's «list end above a
   lower-half hub», off = the plain 16 pt. **Default ON** (today's behaviour).

#### Orchestrator decisions

Details the owner's rules leave open. Each is the recommended option, decided
here.

- **O1 — where a drop lands**: the NEAREST of the three resting centres, by the
  button's centre x. This extends today's rule (the midline is the midpoint of
  the two resting centres). On a 402 pt band: left below 119, right above 283,
  centre in between. A drop exactly on a boundary goes to the centre. A
  non-finite x still goes right (today's fallback, `place`'s default). y is
  unchanged. Rejected: plain thirds (134 / 268). Those move the left/right
  boundaries away from "nearest", for no reason the owner gave.
- **O2 — the stored value is `"center"`** (US spelling, like the 272
  `"center"` string literals in `apps/mobile/src`). The type stays named
  `Edge`: renaming it would touch every importer for no behaviour change.
- **O3 — the fan from the centre**: no new geometry. `fanLayout` already aims
  at the band's centre from wherever the anchor is
  (`apps/mobile/src/hub-fan.ts:116-119`), and it searches both ways
  (`hub-fan.ts:136-146`). From the bottom centre, the fan opens straight up and
  symmetric. The label pill (`labelPlacement`, `hub-fan.ts:259`) goes on the
  item's OUTER side: left of an item left of the anchor, otherwise right.
  Today's rule ("inner side") has no meaning at the centre.
- **O4 — what "scrolls" means (2 B)**: only a scroll the FINGER makes. That is
  a drag, plus the momentum it throws (`onScrollBeginDrag` /
  `onMomentumScrollBegin` … `onScrollEndDrag` / `onMomentumScrollEnd`,
  `SessionScreen.tsx:2173-2199`). The follow-scroll of a streaming turn does
  NOT dim the hub: during a turn the hub is where Stop lives, and it would
  otherwise be at 20 % and untappable for the whole turn. The screen already
  tells user scrolls from programmatic ones with exactly these handlers (the
  `dragging` ref, `SessionScreen.tsx:551`, read by `scrolled()` at
  `:727-731`).
- **O5 — 2 B scope**: the dim is the button's OUTER fade (the same layer as
  show/hide, `FloatingActivity.tsx:209`). The running arc and the glow dim
  with it, so nothing stays bright over the text. There is no dim while
  VoiceOver runs: the button must stay reachable and VoiceOver users don't
  scroll with a drag. There is no dim while the button is engaged (a finger on
  it, a drag, the fan open). A press already granted is never undone by a
  scroll elsewhere. When the button is hidden (covered), the scroll state goes
  back to rest. The 150 ms fade is `FADE_MS` (`floating-button.ts:29`) and is
  kept under Reduce Motion, like show/hide (`motion()`,
  `floating-button.ts:127-132`).
- **O6 — the pending row's gutter after `footClearance`**: `space.inset`
  (16 pt, `apps/mobile/src/theme.ts:457`). This is the gutter every
  transcript row has (`apps/mobile/src/screens/transcript/TranscriptRow.tsx:1141`),
  so a queued bubble lines up with a sent one. With clearance 0 it would touch
  the screen edge. Today that already happens in header mode, where
  `footClearance(false)` is 0.
- **O7 — the setting**: one switch row in Settings → Activity button, shown
  only with Floating (the opacity band's rule, `SettingsScreen.tsx:475`).
  Title «Keep the chat's end above the button». Detail «On: when the button
  rests in the lower half, the last message stops above it. Off: the chat runs
  under the button.» Field `listEndAboveHub?: boolean`, absent = ON. The
  section's footnote (`SettingsScreen.tsx:437`) becomes «… a button you can
  drag to either edge or the center.»

**Repro** (2026-11-26, `.tentacle/tmp/mobile-hub-center/repro.ts`, run with
`bun` from the repo root's `.tentacle/tmp/mobile-hub-center/`):

```ts
// mobile-hub-center repro: the hub has no centre resting place today.
import { createActivitySettingsStore } from "../../worktrees/mobile-hub-center/apps/mobile/src/activity-settings-store.ts";
import { footClearance, listEndPadding, place, snap } from "../../worktrees/mobile-hub-center/apps/mobile/src/floating-button.ts";

const bounds = { width: 402, height: 600 };
console.log("drop at x=201 (dead centre) →", snap({ x: 201, y: 300 }, bounds));
console.log("place({edge:'center'}) x →", place({ edge: "center" as never, yFraction: 1 }, bounds)?.x, "(centre would be", (402 - 54) / 2, ")");
const kv = new Map<string, string>();
kv.set("tentacle.activity-button", JSON.stringify({ v: 1, mode: "floating", position: { edge: "center", yFraction: 1 } }));
const store = createActivitySettingsStore({
  kv: { get: async (k: string) => kv.get(k) ?? null, set: async () => {}, delete: async () => {} } as never,
  keychainAccessible: 0,
});
console.log("stored centre reads back as →", (await store.read()).settings.position);
console.log("footClearance(drawn) →", footClearance(true), "pt reserved at BOTH edges");
console.log("listEndPadding (no setting, bottom hub) →", listEndPadding({ mode: "floating", position: undefined, bounds }));
```

```
drop at x=201 (dead centre) → { edge: "right", yFraction: 0.5 }
place({edge:'center'}) x → 338 (centre would be 174 )
stored centre reads back as → undefined
footClearance(drawn) → 64 pt reserved at BOTH edges
listEndPadding (no setting, bottom hub) → 70
```

(The executor adjusts the import paths to its own worktree.)

## Implementation

*— claude-opus-5-5, 2026-11-26* · **APPROVED** (owner design decided
2026-11-23; orchestrator details O1–O7 above).

### Load-bearing assumption

**The hub's resting place is ONE stored `{edge, yFraction}`. Every consumer
turns it into pixels through `place()` / `snap()`. Only four sites read
`edge` directly.** If that holds, adding `"center"` to `Edge` plus teaching
`snap`, `place`, the parser and the label rule moves the button, its fan
anchor and the list's end padding together, and nothing is left behind.

Proof:

- `place` callers: `FloatingActivity.tsx:165` (where it is drawn), `:251`
  (drop target), `:413` (the press's start), `hub-session.ts:150` (the fan's
  anchor), `floating-button.ts:180` (`listEndPadding`).
- `snap` caller: `FloatingActivity.tsx:250` only.
- Direct `edge` reads: `floating-button.ts:96` (`place`'s default),
  `hub-session.ts:156` (passed to `fanLayout`), `activity-settings-store.ts:70`
  (parse), `hub-fan.ts:259` (`labelPlacement`, the only branch on its value).
  `hub-fan.ts:64,101` only carry it through.

A second, smaller assumption, behind O4: a user scroll fires
`onScrollBeginDrag` / `onMomentumScrollBegin`, and the transcript's own
follow-scroll does not. The screen already depends on this to tell the two
apart (`SessionScreen.tsx:2173-2199` set `dragging`, which `scrolled()` reads at
`:727-731`). The executor confirms it on the simulator: during a streaming
turn with no touch, the hub stays at full strength (Execution QA).

### Preconditions

- Geometry is in band coordinates; the band is measured, never guessed
  (`floating-button.ts:6-9`). `fits` already requires width ≥ 2 × 54
  (`floating-button.ts:48`), so a centre always fits where an edge does.
- The record is versioned `v: 1` and additive fields are the house pattern
  (`activity-settings-store.ts:33-39`). A bad field drops only itself
  (`:14-18`, `:101-108`). The holder publishes a pick even when its write
  fails (`:183-191`).
- The button's show/hide is one native-driver timing on the outer `opacity`
  (`FloatingActivity.tsx:204-214`, `hub-button-motion.ts:26-28`). It unmounts
  only when faded OUT with `shown` false (`FloatingActivity.tsx:210`). Touches
  are gated by `pointerEvents` (`FloatingActivity.tsx:526`).
- Engagement is the gesture machine's state (`engaged`,
  `FloatingActivity.tsx:189`) plus `fan` (`:175`).
- §7 "logic in pure modules": every new decision below lives in a pure,
  unit-tested module. The components only wire events and render.

### Design

**D1 — a third resting place** (`floating-button.ts`).
`Edge = "left" | "center" | "right"`. A private `restX(edge, width)` gives each
resting centre: `EDGE_INSET + FLOAT_SIZE/2`, `width/2`,
`width − EDGE_INSET − FLOAT_SIZE/2`.

- `snap` picks the nearest by the drop's centre x (O1). Boundaries are the
  midpoints between resting centres. A boundary goes to `"center"`. A
  non-finite x goes to `"right"`.
- `place` maps `"center"` to `x = (width − FLOAT_SIZE)/2`.
- Nothing else in the file changes shape, except D5 and D6 below.

**D2 — the record** (`activity-settings-store.ts`).
`parsePosition` accepts `"center"`. `ActivitySettings` gains
`listEndAboveHub?: boolean`, parsed as a boolean or dropped. A new exported
`listEndOn(settings): boolean` returns `settings.listEndAboveHub ?? true`.
This is the one place the default lives. `DEFAULT_ACTIVITY_SETTINGS` is
unchanged: absent means ON.

**D3 — the fan's label at the centre** (`hub-fan.ts:259`).
`labelPlacement` gets a `"center"` branch: the label goes on the item's outer
side (`it.x < anchor.x` → left of the item, else right). The existing "above"
fallback and the clamping are unchanged. `fanLayout` and `solveHub` are
unchanged (O3).

**D4 — 2 B, the scroll dim** (new pure module `apps/mobile/src/hub-scroll-dim.ts`):

```ts
export const SCROLL_DIM_LEVEL = 0.2;   // owner 2 B: 20 %
export const SCROLL_REST_MS = 600;     // owner 2 B: back 600 ms after scrolling stops
export type ScrollDim = "rest" | "scrolling" | "settling";
export type ScrollEvent = "begin" | "end" | "elapsed" | "reset";
/** One step; `timer` says what the caller does with its ONE 600 ms timer. */
export function scrollDimStep(state: ScrollDim, event: ScrollEvent):
  { readonly state: ScrollDim; readonly timer: "arm" | "disarm" | "keep" };
/** The button's outer level and whether it takes touches. */
export function hubPresence(input: {
  readonly shown: boolean; readonly scroll: ScrollDim;
  readonly voiceOver: boolean; readonly busy: boolean;
}): { readonly level: number; readonly touchable: boolean };
```

`scrollDimStep` transitions:

| from | event | to | timer |
|---|---|---|---|
| any | `begin` | `scrolling` | `disarm` |
| `scrolling` / `settling` | `end` | `settling` | `arm` |
| `rest` | `end` | `rest` | `keep` (a programmatic scroll's lone momentum-end, O4) |
| `settling` | `elapsed` | `rest` | `keep` |
| `rest` / `scrolling` | `elapsed` | unchanged | `keep` (a stale timer) |
| any | `reset` | `rest` | `disarm` |

`hubPresence` rules:

- `!shown` → `{0, false}`.
- `shown` and `scroll !== "rest"` and `!voiceOver` and `!busy` →
  `{SCROLL_DIM_LEVEL, false}`.
- Otherwise → `{1, true}`.

Wiring:

- `SessionScreen` holds `scrollDim` state and ONE timer ref (cleared on
  unmount). It dispatches `begin` from `onScrollBeginDrag` and
  `onMomentumScrollBegin`, and `end` from `onScrollEndDrag` and
  `onMomentumScrollEnd`. These sit beside the existing `dragging` writes
  (`SessionScreen.tsx:2173-2199`). `onScroll` dispatches nothing.
- It dispatches `reset` when `floatShown` turns false (a sheet or the drawer
  covered it mid-scroll: no stuck dim when it comes back).
- It passes `scroll={scrollDim}` to `FloatingActivity`.
- `FloatingActivity` computes
  `hubPresence({shown, scroll, voiceOver, busy: engaged !== "idle" || fan !== null})`.
  It drives the outer fade with `fadePlan(presence.level, reduceMotion)` and
  sets `pointerEvents={presence.touchable ? "auto" : "none"}`.
- `fadePlan` (`hub-button-motion.ts:26`) takes a target level instead of
  `shown`. Its one other caller, `dropPlan` at `:91`, passes `1`. The unmount
  rule stays `finished && !shown`, so 20 % never unmounts.

**D5 — `footClearance` removed** (owner 5).
Delete `HUB_COLUMN` (`floating-button.ts:19-27`) and `footClearance`
(`:150-160`). Delete the `clearance` prop and its comment from `PendingBubbles`
/ `BubbleView` (`PendingBubble.tsx:41-47, 84, 92, 101, 154, 169`). The row's
padding becomes `space.inset` (O6), and the `rowInner` comment at `:185-186`
is updated. Delete the import and the prop in `SessionScreen.tsx:80, 2131-2134`.

**D6 — `listEndPadding` optional** (owner 6).
Its input gains `readonly enabled: boolean`. When false it returns
`LIST_END_PADDING`, before any geometry. It is required, so a caller cannot
forget it. `SessionScreen.tsx:2161` passes
`enabled: listEndOn(activitySettings)`. With the centre at the bottom, the
existing "lower half" rule applies unchanged (it goes through `place`).

**D7 — the Settings row.**

- `SettingsScreen` gets `activityListEnd?: boolean` and
  `onActivityListEnd?: (on: boolean) => void`.
- It draws a switch row, `testID="activity-list-end"`, after the opacity band.
  The row is drawn only with `activityMode === "floating"` and both props
  present. It is disabled and says why over an unwritable record, like the
  Photos switch (`SettingsScreen.tsx:354-381`).
- `App.tsx` adds `selectActivityListEnd`, the `selectActivityOpacity` pattern
  (`App.tsx:2967-2972`: spread the current settings, reuse the error banner).
  It passes `activityListEnd={listEndOn(activitySettings)}` beside `:3540-3544`.
- The footnote text changes as in O7.

Dragging is untouched (owner 3): no change to `hub-gesture.ts`,
`hub-session.ts` or the `dragTo` path (`FloatingActivity.tsx:320-325`). No
guide is drawn.

### Files

In dependency order, all under `apps/mobile/`:

1. `src/floating-button.ts`: D1, D5 (delete), D6.
2. `src/activity-settings-store.ts`: D2.
3. `src/hub-fan.ts`: D3.
4. `src/hub-scroll-dim.ts` (**new**): D4.
5. `src/hub-button-motion.ts`: `fadePlan(level, reduceMotion)`.
6. `src/ui/FloatingActivity.tsx`: the `scroll` prop, `hubPresence`, the fade
   target, `pointerEvents`.
7. `src/screens/compose/PendingBubble.tsx`: D5.
8. `src/screens/SessionScreen.tsx`: D4 wiring, D5, D6.
9. `src/screens/SettingsScreen.tsx`: D7.
10. `App.tsx`: D7.
11. Tests (below). `e2e/flows/28-floating-activity.yaml` (below).
12. `changelog.d/mobile-hub-center.changed.md`: one bullet, e.g.
    `- **The floating hub can rest at the center, and it floats.** Drag it to the left, the center or the right; nothing behind it keeps space free any more, and while you scroll the chat it fades and lets your taps through. Settings → Activity button → «Keep the chat's end above the button» (on by default) decides whether the last message stops above it.`

The mockup kit (`tools/mockup-kit/`) is NOT changed by this task. Its
`hubFan` sketch cannot fan from the centre (reported in the mockup's "kit da
correggere" section; a follow-up, not this branch).

### Failure modes

- **An older build reads a `"center"` record.** Its `parsePosition` drops the
  position, so the hub shows at its default spot (right, bottom); the mode and
  opacity are kept. That build's next write (mode, opacity, a drop) omits
  `position` and `listEndAboveHub`, because its holder never had them. The
  setting falls back to ON, which is the default anyway. This is the same
  trade as `opacity` (`activity-settings-store.ts:35-37`) and is accepted: the
  app is unpublished, and a `v` bump would make every older build refuse to
  write at all.
- **A bad `listEndAboveHub`** (string, number) drops only that field, so the
  setting reads ON. Pinned.
- **A write fails** (Keychain): the pick holds for this run and the existing
  banner says "didn't save" (`activity-settings-store.ts:187-191`,
  `App.tsx:2967-2972`).
- **Rotation, keyboard, another phone width**: the centre re-projects to
  `width/2` through `place`, like the edges (`FloatingActivity.tsx:191-198`).
- **A scroll starts while a finger is on the hub, or the fan is open**: `busy`,
  so no dim. A granted press is never cut off.
- **A drag begins and its end event never arrives** (the list unmounts, or a
  sheet covers mid-scroll): `reset` when the button hides. Unmount clears the
  timer. A stale `elapsed` is ignored by the reducer. Residual risk: a lost end
  event with the button still shown leaves it dim until the next scroll ends.
  This is stated, not designed out, because RN delivers `onScrollEndDrag` for
  every `onScrollBeginDrag` on iOS. The executor watches for it in QA.
- **Programmatic scroll** (follow, the jump pill, "Show in chat"
  `scrollToIndex`): at most a lone `onMomentumScrollEnd`. In `rest` that is a
  no-op (pinned). The hub never dims during a streaming turn.
- **A tap during the 600 ms tail** is ignored (`pointerEvents` none). That is
  owner 2 B as decided. Pull-to-refresh is a drag, so it dims too.
- **VoiceOver**: no dim (O5), and the button keeps the header-pill path
  (`headerPill`, `floating-button.ts:143-148`).
- **A queued message's Cancel under the hub** is now possible (owner 2: it
  floats, nothing reserves). The way out is the owner's: drag the hub, or
  scroll (2 B makes the hub let taps through only while scrolling). No
  mitigation is added against the owner's rule.
- **Header mode**: no button. `listEndPadding` returns 16 regardless of the
  setting, and the switch row is not drawn.

### Tests

Red before green (§9): write each new or changed test FIRST, run it on the
unmodified code and paste the failures into Execution. Then implement. Run
narrow: `bun test apps/mobile/test/<file>`.

- `test/floating-button.test.ts`
  - **snap**: on 390 pt `BOUNDS` the boundaries are 116 / 274: 115 → left,
    116 → center, 274 → center, 275 → right.
  - **snap, the QA numbers on 402 pt**: 118 → left, 119 → center,
    283 → center, 284 → right.
  - **snap, NaN x**: → right.
  - The old midline tests at `:30-38` are replaced, because owner 1 changes
    that rule.
  - **place**: `"center"` → `x = (width − 54)/2` at 390 and 402 pt; y is as
    for an edge.
  - **listEndPadding**: `enabled: false` → 16 for a bottom-resting hub (the
    mutation: ignore `enabled` → fails). A bottom-centre hub with
    `enabled: true` → the end clears the hub's top.
  - The `footClearance` describe (`:166-205`) is deleted with the function.
- `test/activity-settings-store.test.ts`
  - `"center"` round-trips through write → read. `"middle"` drops the
    position and keeps the mode.
  - `listEndAboveHub` `false` / `true` round-trip; `"no"` is dropped.
  - `listEndOn` of a record without the field → true, and of `false` → false.
- `test/hub-fan.test.ts`
  - **labelPlacement, `"center"`**: an item left of the anchor gets the label
    on its left (`x = it.x − LABEL_GAP − width`); an item right of it gets the
    label on its right.
  - **fanLayout, from a bottom-centre anchor**: the items are mirror-symmetric
    about the anchor's x (±0.5 pt), all inside the band, and the kind is
    `fan`.
- `test/hub-scroll-dim.test.ts` (**new**)
  - Every row of the D4 table.
  - The sequence `begin, end, begin` (drag then fling) → `scrolling`, with
    `disarm` last.
  - `hubPresence`'s four cases: `!shown`, dimmed, VoiceOver, busy.
  - Mutation checks: make `end` in `rest` arm → the programmatic-scroll test
    fails; drop the `voiceOver` guard → the VoiceOver test fails.
- `test/hub-button-motion.test.ts`
  - `fadePlan(0.2, false)` → `{toValue: 0.2, duration: 150, useNativeDriver: true}`.
  - The existing calls are updated to levels.
- `test/session-screen-follow-wiring.test.ts`
  - The QA-bug-1 describe (`:225-245`) is replaced. `PendingBubbles` gets no
    `clearance`, `footClearance` is not imported, and the pending row pads
    with `space.inset`.
  - The four scroll handlers each dispatch `begin` / `end` to the dim; the
    `onScroll` body does not.
  - `listEndPadding({` receives `enabled: listEndOn(`.
- `test/hub-native-driver-wiring.test.ts:42`: still holds
  (`Animated.timing(opacity, fadePlan(`). Keep it green.
- **e2e, `e2e/flows/28-floating-activity.yaml`**:
  - After tapping `activity-button-floating`, add
    `assertVisible: {id: "activity-list-end"}`. The row exists only with
    Floating.
  - In the closing Settings visit, after `activity-button-header`, add
    `assertNotVisible: {id: "activity-list-end"}`.
  - The existing swipe-LEFT / `leftOf` assertions (`:64-73`, `:107-110`) are
    the regression check that a hard drag still reaches the LEFT edge with
    three resting places. Flow 33 (`e2e/flows/33-hub.yaml:60-62`) does the
    same.
  - **Not driven by Maestro** (stated in the flow's header comment):
    - The centre drop. Maestro can swipe from an element only in a direction
      (it ends near a screen edge) or between fixed percentages, and the
      button's y is not known in advance.
    - The 2 B dim. Maestro reads neither opacity nor sub-second timing.
    - Both are pinned by the unit tests above and checked on the simulator in
      Execution (screenshots: centre at rest, the fan from the centre, a frame
      mid-scroll, the switch on and off).

Gate before review: `bun run check` (typecheck, lint, the full parallel
suite) against the clean lint baseline, plus the affected mobile e2e flows (28,
33) on the 2-simulator gate.

## Execution

*— <model-id>, <YYYY-MM-DD>*

## Review

*— <model-id>, <YYYY-MM-DD>*

# feat/mobile-hub-tap — A tap on the hub opens the fan; an empty Activity stays dimmed

> **Status:** implementation (awaiting owner approval)
> **Branch:** `feat/mobile-hub-tap`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek exec + standard review
> **Changelog:** `changelog.d/mobile-hub-tap.changed.md` — `- **A tap on the floating button opens the hub.** On the iPhone, with the Floating Activity button, a single tap now opens the fan of actions (with a haptic) instead of the full-screen Activity sheet; Activity is one of the fan's items, and it stays dimmed and says "Nothing running" when there is nothing to show.`

## Context

*— claude-opus-5-5, 2026-11-17*

Owner request (TODO.md, 2026-11-17): a SINGLE TAP on the floating hub button
opens the hub fan with a haptic. Today a tap opens the full-screen Activity
sheet, even when there is nothing in it. Activity becomes one item of the fan.
LONG-PRESS is reserved for the hands-free voice conversation; until that exists
on mobile, a long-press does what a tap does. Empty entries follow the owner
standard: they stay **dimmed**, a tap gives a **light** haptic and an inline
"Nothing running", and an empty modal never opens.

This depends on `feat/mobile-hub-opacity` (merged, `ec42f0e9`), because both
touch `ui/FloatingActivity.tsx`. `feat/mobile-hub-badges` touches the same file
and the same fan items, so it goes after this one (see Owner question 5).

**Repro** (2026-11-17, branch `feat/mobile-hub-tap` = `main` @ `d96355bd`),
`.tentacle/tmp/mobile-hub-tap/repro.ts`:

```ts
import { hubActions } from "../../worktrees/mobile-hub-tap/apps/mobile/src/hub-actions.ts";
import { IDLE, reduce } from "../../worktrees/mobile-hub-tap/apps/mobile/src/hub-gesture.ts";

const solve = () => {
  throw new Error("solve called");
};
const s1 = reduce(IDLE, { type: "down", p: { x: 0, y: 0 }, t: 0 }, solve);
const s2 = reduce(s1.state, { type: "up", p: { x: 1, y: 1 }, t: 120 }, solve);
console.log("tap →", JSON.stringify(s2));
const ctx = {
  link: "up", turn: null, ended: null, editable: true, dictation: false,
  schedules: 0, nextWakeInMs: null, unseenArtifacts: 0,
} as const;
console.log(
  "activity item (idle, nothing running) →",
  JSON.stringify(hubActions(ctx, { activity: () => {} }).fan),
);
```

```
tap → {"state":{"kind":"idle"},"effects":[{"kind":"tap"}]}
activity item (idle, nothing running) → [{"id":"activity","label":"Activity","badge":null,"danger":false}]
```

So: (1) a tap never builds a fan (`solve` is not called), it emits `tap`, which
the button maps to `onPress` = `openActivity` (the full sheet); (2) the Activity
item already exists in the fan (H3), but it has no "empty" state, so committing
it on an idle session opens an empty sheet.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**The gesture machine already has a "fan opened by a release" path, and a tap
can reuse it.** `pressing` → `up` with `kind === "long"` calls
`open(event.p, solve, "sticky")` (`apps/mobile/src/hub-gesture.ts:189-190`).
`open` plays `firm` and emits `open(layout)`. With no actions it opens nothing
(`:135-137`). A layout that is not a fan becomes the ActionSheet (`:142-144`).
The `fanSticky` state then handles tap-to-commit, tap-elsewhere-to-close and a
new touch on the button that closes it (`:248-260`). So "tap → fan" is a
one-branch change in a pure reducer: `kind === "tap"` → `open(event.p, solve, "sticky")`.
Everything after that (commit, close, opacity, back-swipe guard) already runs
off the state that comes out.

### Preconditions

- The button does nothing on its own. It applies the machine's effects
  (`apps/mobile/src/ui/FloatingActivity.tsx:251-300`). `tap` is the only effect
  that calls `onPress` (`:277-279`). The `open` effect builds the fan from
  `fanItems` by id (`:255-262`).
- The body goes solid when `gesture !== "idle" || fanOpen`
  (`apps/mobile/src/hub-opacity.ts:68`). `setEngaged(driver.state().kind)` runs
  after every effect batch (`FloatingActivity.tsx:300`), so a tap that ends in
  `fanSticky` is engaged, and closing it goes back to the set opacity. This
  needs no change.
- The back-swipe guard follows `isFanOpen`, which includes `fanSticky`
  (`apps/mobile/src/hub-session.ts:246-248`), through `onFanChange`
  (`SessionScreen.tsx:796-804`). This also needs no change.
- Haptics: the machine names a cue and `hubHaptic` plays it as is
  (`apps/mobile/src/haptic-rules.ts:50-52`). `"light"` is already a `HapticKind`
  (`:13`). It is not a `HubCue` yet (`hub-gesture.ts:43`).
- A commit goes through `commitPlan` → `resolveCommit`
  (`hub-session.ts:180-191`, `hub-actions.ts:202-219`). A `noop` with a notice
  is shown in the inline `hub-notice` line (`SessionScreen.tsx:805-815`,
  `:1214-1221`). This is the existing "Already finished" channel, so "Nothing
  running" reuses it.
- Activity is "empty" when `activityView(...).groups` is empty. That is when the
  sheet draws its own dimmed `empty` line (`apps/mobile/src/activity.ts:60-72`).
  The screen already computes `activityVm` (`SessionScreen.tsx:571`).
- The ONE Activity path, `openActivity` (`SessionScreen.tsx:730-733`), stays the
  path for the header pill (`:871-880`). That pill is drawn only while
  something runs or a report is unread, so it never opens an empty sheet.
- No §7 invariant is touched. This is mobile-only, pure modules plus
  rendering, with no protocol, persistence or terminal I/O.

### Design

1. **Tap → fan (pure, `hub-gesture.ts`).** In `pressing`/`up`, `tap` and `long`
   both return `open(event.p, solve, "sticky")`. The timer path (held 400 ms
   while the finger is still down) still opens `fanTracking`, so slide-to-select
   still works after a long-press (Owner question 1). This is the "long-press =
   tap until voice exists" rule: both end with the same fan, and a long-press
   also lets you slide. The `tap` effect kind is removed (nothing emits it any
   more). `classifyPress` stays, because it still separates drag from press.
   The table in the module doc is updated (tap → fan sticky, firm).
2. **Dimmed items (pure, `hub-actions.ts`).** `HubContext` gains
   `activityEmpty: boolean`. `HubItem` gains `dimmed: boolean`, and only
   `activity` is dimmed, when `activityEmpty` (Owner question 3). A dimmed item
   **keeps its slot**. It is not hidden, so the order stays the one in owner
   decision Q-H5. `resolveCommit("activity")` when it is empty →
   `{ kind: "noop", notice: NOTHING_RUNNING }` with
   `NOTHING_RUNNING = "Nothing running"`. The check reads the world at the
   release, like every other re-check (M7/M8), so an Activity that fills up
   while the fan is open opens for real.
3. **The haptic of a dimmed commit (pure, `hub-gesture.ts`).** `HubMenu` gains
   `dimmed: readonly string[]` (the snapshot taken at the open, next to `ids`).
   `commit()` plays `light` instead of `commit` for a dimmed id, and still
   emits `commit` + `close`. That way the screen's `resolveCommit` produces the
   notice, and there is exactly one haptic per release, never two. `HubCue`
   gains `"light"`. `hubHaptic` stays a straight pass-through. `solveHub`
   (`hub-session.ts`) fills `dimmed` from `items`.
   *Edge:* the snapshot says dimmed but the release says full: you get the light
   haptic and the sheet opens. That is a harmless mismatch in a rare race, and it
   is pinned by a test, not designed away (the haptic has already played at
   the release).
4. **Screen wiring (`SessionScreen.tsx`).** `hubContextOf` takes
   `activityEmpty: activityVm.groups.length === 0`. Nothing else changes:
   `onPress` stays a prop for the VoiceOver activate path (Owner question 2).
5. **Rendering (`ui/HubFan.tsx`).** A `dimmed` item is drawn at a fixed low
   opacity. This is presentation only, and the final values will come from
   mobile-hub-badges' solid discs. Its a11y label gets ", nothing running".
6. **VoiceOver.** The fan never opens under VoiceOver (Design 7 of
   mobile-hub). The `activate` route and its hint "Double-tap for Activity" are
   **unchanged in this task unless Owner question 2 says otherwise**.

### Files

In dependency order:

1. `apps/mobile/src/hub-actions.ts`: `activityEmpty`, `dimmed`,
   `NOTHING_RUNNING`, the `resolveCommit` branch.
2. `apps/mobile/src/hub-gesture.ts`: tap → `open(..., "sticky")`, drop the
   `tap` effect, `HubMenu.dimmed`, `light` cue in `commit()`, doc table.
3. `apps/mobile/src/hub-session.ts`: `hubContextOf` input + `solveHub` fills
   `dimmed`. If Owner question 2 = B, `hubA11yRoute("activate")` → `menu`.
4. `apps/mobile/src/ui/FloatingActivity.tsx`: remove the `case "tap"` branch,
   update the header comment (`:2-6`).
5. `apps/mobile/src/ui/HubFan.tsx`: dimmed opacity + a11y suffix.
6. `apps/mobile/src/screens/SessionScreen.tsx`: pass `activityEmpty`.
7. `changelog.d/mobile-hub-tap.changed.md`.
8. Tests (below). `docs/feat/mobile-hub.md` gets no edit (it is a legacy
   record). This doc supersedes its "Tap still opens Activity".

### Failure modes

- **A tap with no actions** (`ids` empty) → `open` returns idle, with no
  haptic (`hub-gesture.ts:135-137`). The button does nothing, as a long-press
  does today. There are no dead taps in practice, because `info` is always
  present.
- **A tap where the fan doesn't fit** → `open(menu)` + firm → the ActionSheet
  with all actions (existing `onMenu` path).
- **A double tap** → the first tap opens the fan (sticky). The second touch on
  the button is `down` in `fanSticky` → `close` (`:255-257`), and its release
  meets idle. This is the existing, tested behaviour; it is re-pinned for the
  tap entry.
- **A late timer after a tap** → after `up` the state is `fanSticky`, and a
  `timer` there does nothing (M13, `:258-259`).
- **The world changes while the fan is open** (sheet arrives, VoiceOver turns
  on, background) → `cancel` → close, silent (M12). Unchanged.
- **Activity goes empty or full between the open and the release** → the
  notice or the sheet follows the release-time world (Design 2). The haptic
  follows the open-time snapshot (Design 3 edge). Both cases get tests.
- **The notice stays on screen.** `hubNotice` clears only at the next commit
  (`SessionScreen.tsx:809`), the same as "Already finished" today. That is
  existing behaviour and is not widened here. It goes under Review notes as
  debt for mobile-activity-panel / hub-badges.
- **A drag that used to begin as a "tap"** → still a drag (≥ SLOP). The tap
  branch is only reached under SLOP and before LONG_MS.

### Tests

These fail first on today's code (red), then pass after the change:

- `test/hub-gesture.test.ts`
  - "9 pt / 390 ms → tap, nothing else" becomes **"a tap opens the fan sticky
    + firm, solve called once"**. Red today: the effect is `tap` and `solve`
    is not called.
  - "a tap then a tap on an item commits; a tap elsewhere closes". Red.
  - "a tap then touching the button again closes; its release is ignored". Red.
  - "a tap with no fit → open(menu) + firm". "a tap with no actions →
    silent idle".
  - "commit of a dimmed id → light + commit + close (no `commit` cue)". Red
    (there is no `dimmed` yet).
  - The existing drag / M4 / M13 / M16 cases stay green, unchanged.
- `test/hub-actions.test.ts`: dimmed only for `activity` and only when
  `activityEmpty`. A dimmed item keeps its slot. `resolveCommit("activity")`
  when empty → notice "Nothing running", and when full → run. Release-time
  re-read in both directions.
- `test/hub-session.test.ts`: the M13 test at `:383-388` ("a tap, never a late
  open") becomes "a tap opens sticky, a later timer does nothing". `solveHub`
  carries `dimmed`.
- `test/hub-opacity-wiring.test.ts`: a tap leaves the body solid, and a
  close after it goes back to the set opacity. This pins that the tap entry
  rides the existing engaged rule.
- Non-vacuity: mutate `tap` back to `{ kind: "tap" }` and `commit()` back to
  always `commit`, and confirm the new tests fail (§9).
- Gate: `bun test apps/mobile` per slice, then the full `bun run check`.

### Owner questions

1. **Long-press until voice exists:** should it open the same fan **with
   slide-to-select** (finger held → slide to an item → let go), or exactly
   tap's sticky fan? — *Recommendation: keep slide-to-select. It is the same
   fan and costs nothing, and it is removed when voice takes over the
   long-press.*
2. **VoiceOver double-tap** ("activate"): A) keep it opening Activity, as
   today, or B) open "Show all actions" (the menu), which is the same as tap
   now opening the hub? — *Recommendation: B, with the hint "Double-tap for
   actions". A sighted tap and a VoiceOver activate should do the same thing,
   and the rotor still reaches Activity directly.*
3. **Which items count as "empty" in this task:** only Activity, or also
   Artifacts when the session has none? (Scheduled is already hidden at 0
   wakes.) — *Recommendation: Activity only, which keeps this S and matches the
   request. Artifacts-empty goes to a follow-up line in TODO.md.*
4. **Haptic of a tap-open:** reuse `firm`, the same lift as today's
   long-press, or a lighter one? — *Recommendation: `firm`. It is one "the hub
   opened" feel whatever opened it, and `light` stays the cue for "dimmed,
   nothing happened".*
5. **Order with `feat/mobile-hub-badges`** (same file, same fan items): this
   task first, then badges restyles the dimmed item as a solid disc. —
   *Recommendation: yes, this task first. The dimmed opacity here is a
   placeholder value that badges will replace.*

## Execution

## Review

# fix/mobile-activity-sheet-reclose — closing the Activity sheet re-opens it once

> **Status:** execution
> **Branch:** `fix/mobile-activity-sheet-reclose`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Opus exec + Opus review
> **Changelog:** `changelog.d/mobile-activity-sheet-reclose.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner, real iPhone, build b39119de (2026-11-18 ~11:30): tap Activity (in the floating
hub's fan, the default) → the low-detent sheet opens. Close it → it closes, **re-opens**
and closes again (one extra open/close cycle). The TODO entry suspected the close
guard that feat/mobile-activity-panel's Review r1 added (`closing.current`). The
evidence below shows that guard is not the cause.

**Repro** (2026-11-18, iPhone Air sim `49F9C1DC…`, iOS 26.5; `bun run
apps/mobile/e2e/run.ts --ios 26 --udid 49F9C1DC-FA61-4105-A5BC-B7131C72FE18 --only
01-shell --hold` for build + serve on ephemeral ports, then a hand-run Maestro flow
from `.tentacle/tmp/activity-reclose/`):

```yaml
# reclose3.yaml (after `_pair.yaml`)
- tapOn: { id: "open-settings" }
- tapOn: { id: "activity-button-floating" }
- tapOn: { id: "settings-back" }
- tapOn: { id: "computer-${output.computerId}" }
- tapOn: { id: "session-${ALPHA_ID}" }
- tapOn: { id: "composer-input" }
- inputText: "AGENTS27"          # the mock launches two background children
- hideKeyboard
- tapOn: { id: "composer-send" }
- extendedWaitUntil: { visible: { id: "floating-activity" }, timeout: 30000 }
# cycle 1: hub → Activity → scrim
- tapOn: { id: "floating-activity" }
- tapOn: { id: "hub-item-activity" }
- extendedWaitUntil: { visible: { id: "activity-sheet" }, timeout: 5000 }
- waitForAnimationToEnd: { timeout: 3000 }
- tapOn: { point: "50%,15%" }    # the scrim
# cycle 2: hub → Activity → swipe down from the header
- tapOn: { id: "floating-activity" }
- tapOn: { id: "hub-item-activity" }
- swipe: { start: "50%, 53%", end: "50%, 97%", duration: 150 }
```

The frames came from `xcrun simctl io … recordVideo`. `analyze.py` reads one pixel column per
frame at 60 fps: the scrim's luma, and the sheet's top edge as a % of the screen. **Before**
(cycle 1, the scrim tap):

```
t=60.38s sheet=47   ← the close starts
t=60.57s sheet=4    ← down (4% = the bottom inset: the sheet is at height 0)
t=60.70s sheet=48   ← RE-OPENED, in ONE frame (not a spring)
t=61.12s sheet=4
t=61.40s -          ← scrim gone
```

The sheet's own `onLayout`, logged with a temporary `console.error` and read with
`simctl spawn … log stream`, plus the phase and every render/step:

```
step 41790 close open->closing
render 41791 visible=true phase=closing value=451
layout 41807 h=437 … layout 41992 h=37   layout 42008 h=34
layout 42141 h=440      ← no render, no step, no second open: the close still in flight
layout 42540 h=34
step 42823 settled closing->closed      ← the spring reports its end ~0.8 s later
closeActivity 42825 … onDismiss 42837
```

Same at 91427 → 91561 (h=440) → 91960 in a second build that drove the height from
React state (no `setNativeProps`). So neither the close's state machine nor
Animated's Fabric sync is the cause. Both were falsified empirically (Execution).

**Root cause:** the close's spring (`ActivitySheet.tsx:224-236`, damping 26 / stiffness
260 / mass 0.8, so ζ ≈ 0.90) undershoots 0. From the low detent (451 pt) it goes to
−0.65 pt and stays negative for about half a period, π/ω₁ ≈ 0.40 s (RN
`SpringAnimation.js:299-306`). The raw value was the `Animated.View`'s `height`
(`ActivitySheet.tsx:339`). Yoga does not treat a negative height as a size: it lays
the view out at its **content** height (440 pt). So the sheet was drawn whole again
until the spring came back above 0.

## Implementation

*— claude-opus-5-5, 2026-11-18*

- **Load-bearing assumption:** the jump is a Yoga layout of a negative `height`, and
  not a state/commit bug. Proven by `onLayout` (34 → 440 → 34 with no render) under
  two different height pipelines (Animated prop / React state). The undershoot is
  computed from RN's own spring formula with the sheet's constants.
- **Preconditions:** `panelDrag` already clamps a drag to `[0, tall]`
  (`activity-panel.ts:81-83`), and Reduce Motion's `timing` cannot overshoot. The
  spring is the only path below 0.
- **Design:** draw `height.interpolate(PANEL_HEIGHT)`, where `PANEL_HEIGHT` is
  `{[0,1]→[0,1], extrapolateLeft: "clamp", extrapolateRight: "extend"}`. The drawn
  height is never below 0, and the open's overshoot above its detent stays as it
  was. The spring constants move into the pure module (`PANEL_SPRING`), so the pure
  test simulates the real spring. The `Animated.Value` itself is untouched: the
  drag, the interrupted-close guard (`closing.current`, any-end continuation) and
  every effect behave exactly as before.
- **Files:** `apps/mobile/src/activity-panel.ts` (+`PANEL_SPRING`, `PANEL_HEIGHT`),
  `apps/mobile/src/screens/ActivitySheet.tsx` (the interpolation, `...PANEL_SPRING`),
  `apps/mobile/test/activity-sheet-close.test.ts` (new),
  `apps/mobile/test/activity-panel-wiring.test.ts` (+1 pin).
- **Failure modes:** an open spring overshoots above the detent (still drawn, which is
  intended: `extrapolateRight: "extend"`). A drag never goes below 0 (`panelDrag`). An
  interrupted close is unchanged: it still ends on any end of its motion. A future
  over-damped spring makes the clamp merely defensive; the mechanism pin says so.
- **Tests:** `activity-sheet-close.test.ts` restates RN 0.88's under-damped
  `SpringAnimation.onUpdate` and `AnimatedInterpolation`'s extrapolation with the
  module's constants: (1) the spring undershoots 0 (the mechanism); (2) no close frame
  draws below 0 from 140/451/780 pt; (3) once at 0, the layout never grows again
  (Yoga as observed: a negative height → the content height); (4) an open is drawn
  as-is, overshoot included. The wiring pin checks that the component draws
  `height.interpolate(PANEL_HEIGHT)` and spreads `PANEL_SPRING`.

## Execution

*— claude-opus-5-5, 2026-11-18*

1. **Simulator.** I first ran on the assigned `0B43D716` (iPhone 17 Pro Max). It turned
   out to be shared with mobile-hub-defaults' agent: the app was swapped under me, and
   the run hit a Keychain leftover, a lock and Maestro driver collisions. I also killed
   two `xcodebuild test-without-building` drivers on that UDID that may have been its
   drivers. After escalating, I got the iPhone Air `49F9C1DC` and did everything there.
2. **Hypothesis 1 (the brief's): the state machine reports the close too early.** I
   extracted the close into a pure `sheetStep` machine (report only after a commit drew
   0). Its test was red on the extracted original ordering (3 fail), then green; 6/6
   mutations caught. **Frames after: the re-open was still there** → falsified. I removed
   the extraction, because it fixed nothing.
3. **Hypothesis 2: Fabric's `setNativeProps`/shadow-tree desync** (RN
   `createAnimatedPropsHook.js:178-199`). I drove the height from React state through
   a listener (`SheetFrame`). `onLayout` still read 34 → 440 → 34 → falsified, and
   removed.
4. **The mechanism, from the logs:** 440 is the content height, and the jump happens
   while the spring is still "in flight" after reaching 0. That matches the undershoot
   computed from RN's formula (−0.65 pt, ~0.40 s negative). Red first:
   `activity-sheet-close.test.ts` with `PANEL_HEIGHT` = identity (the current drawing)
   → **2 fail** (`Received: -0.202…` and `Received: 440`). Fixed → 4/4 green. The wiring
   pin on the HEAD component → 1 fail (`Expected to contain:
   "height.interpolate(PANEL_HEIGHT)"`); fixed → 54/54 across the panel's three test
   files.
5. **Mutations** (each applied, run, restored; `diff` clean afterwards):

   | # | Mutation | Result |
   |---|---|---|
   | M1 | `extrapolateLeft: "extend"` (no clamp) | 2 fail |
   | M2 | `extrapolateRight: "clamp"` (also clamp the open) | 1 fail |
   | M3 | component draws the raw `height` | 1 fail |
   | M4 | spring constants inlined in the component | 1 fail |
   | M5 | damping 40 (over-damped) | 4 fail (the simulator is the under-damped branch: the mechanism pin first) |

6. **Frames after** (same flow, a fresh build with the fix plus a temporary
   `onLayout` log, removed afterwards; `grep -c SHEETDBG` = 0 in the tree):

   ```
   t=64.70s sheet=48   ← the close starts (scrim tap)
   t=64.90s sheet=4    ← down
   t=65.73s -          ← scrim gone; no frame in between above 4%
   layout 49111 h=395 … 49279 h=37, 49296 h=34 → next layout 53123 (the next OPEN)
   ```

   Cycle 1 used to read 34 → 440 → 34. Now there is no layout at all between the
   close reaching 34 and the next open.
7. **Not verified on frames: swipe-down.** Maestro's drag (`swipe` from 54% to 90%,
   400 ms, and from the header id, 200 ms) never moves the sheet: zero `onLayout`
   events, so XCUITest's synthesized drag is not claimed by the header's
   PanResponder. A flick's close goes through the same `close()` → the same spring →
   the same clamp, so it is covered by the pure test, not by frames. To verify: a
   flick down on the header on a device. "Close by the hub" is not a separate path:
   the scrim covers the hub, so a tap there is a scrim tap (cycle 1).
8. **Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
   `bun run lint` clean (2084 files, no fixes) · `bun test` **15262 pass / 5 skip / 0 fail** (15267 tests, 1089 files, 485 s; 5 skips = the same count main's last full run reported in docs/feat/mobile-activity-panel.md).

## Review

*— claude-opus-5-5, 2026-11-18*

**Verdict: APPROVE.** No HIGH/MEDIUM findings. Scope: `git diff main...HEAD` only.

- **Gate (narrow):** `activity-sheet-close.test.ts` + `activity-panel-wiring.test.ts` → 24 pass / 0 fail · `bun run lint` clean (2084 files) · `bun run typecheck` clean (root, mobile, relay). I did not re-run the full `bun test`. Execution reports 15262 pass / 5 skip / 0 fail.
- **Premises:** RN 0.88's `AnimatedInterpolation.js:57-61,127-131` really does support `extrapolateLeft: "clamp"` separately from the right side → TRUE. `height` (`ActivitySheet.tsx:201`) has no other reader that would need the unclamped value: no `addListener`, and the scrim does not interpolate it. The drag writes the raw value through `panelDrag` (`:296`), which is already clamped → TRUE. Only the drawn style changes (`:342`). The state machine and the close guard are untouched → TRUE.
- **Mutation:** `extrapolateLeft` changed to `"extend"` → `activity-sheet-close.test.ts` 2 fail. Restored from a scratch copy, and `git status` was clean afterwards. Execution's M1–M5 are consistent with this.
- **Attacks tried:** (1) Could the clamp hide the open's overshoot? No: `extrapolateRight: "extend"`, pinned by test 4. (2) Does Reduce Motion / `timing` still go through `drawn`? Yes: the same view, and it never goes negative. (3) §7 invariants: none touched. Mobile presentation only, with the constants extracted to a pure module per the "logic in pure modules" rule. (4) Is the pure test vacuous? It restates RN's spring formula, not RN itself, so the source-text wiring pin carries the "real code uses these constants" half. Weak but acceptable for RN, which `bun test` cannot render.
- **Residual (not blocking):** swipe-down close not verified on frames (Execution §7). It shares `close()` → spring → clamp. To verify: a flick on the header on a device. The doc header still reads `Status: execution`.
- **Executor behaviour:** evidence-first, as AGENTS §1 asks. It falsified two hypotheses empirically and removed both failed attempts. It reported a simulator collision honestly. Same model family as the executor (fresh context only), so shared blind spots are possible. The blast is contained, so that is acceptable.

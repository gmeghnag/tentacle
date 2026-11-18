# feat/mobile-hub-native-driver — the hub button on the native driver

> **Status:** execution
> **Branch:** `feat/mobile-hub-native-driver`
> Type: feat · Size: S · Blast: contained · Suited: Opus exec + Opus review
> **Changelog:** `changelog.d/mobile-hub-native-driver.changed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner, 2026-11-18 01:20: the hub fan opens "a rallentatore / a scatti" while the
model is Thinking; "ciò che è bene spostare su driver nativo, che venga
spostato". The audit in `TODO.md`: the only JS-driven animations in
`apps/mobile` are four in `ui/FloatingActivity.tsx` (the show/hide fade, the
rest-opacity level, the drop spring on `xy`, the Reduce-Motion drop fade); the
fan items (`HubFan.tsx`), the running arc and everything else already use the
native driver. A JS-driven animation is stepped on the JS thread, so a JS thread
busy with a streaming turn stutters it.

**Repro / measurement** (2026-11-18, iPhone 17 Pro Max simulator, iOS 26.5, UDID
`0B43D716…`, Release build from the e2e harness, its own `serve` on a free port,
mock model). The mock gained a `THINKHOLD` prompt: a HOLD turn that streams a
reasoning delta every 40 ms for 120 s (the UI shows "Thinking…"). The flow
(`perf-fast.yaml`, a copy of the harness flows in
`.tentacle/tmp/mobile-hub-native-driver/flows/`) opens a session, opens/closes
the fan 3× at rest, sends `THINKHOLD hub`, then opens/closes the fan 5× while it
streams, and finally opens it and taps Stop. Probes:
- **JS thread**: a temporary `requestAnimationFrame` counter imported from
  `index.ts` (fps per 250 ms window, written to `Documents/perf-probe.txt`).
  Removed from the tree after measuring. rAF caps at 60 on the simulator.
- **UI thread**: `simctl io recordVideo` (variable frame rate: a frame per screen
  update). For each fan open (located by the scrim darkening the frame), frames
  per second and the largest frame gap in the 650 ms from the first scrim frame.
  While a turn runs the arc spins on the native driver, so the screen updates
  every vsync and the frame rate is the UI's.

Same flow, same build path, before (HEAD) and after (this branch):

| | before (HEAD) | after |
|---|---|---|
| JS fps at rest, 3 fan cycles (mean / min / p10) | 59.9 / 52.0 / 59.8 | 59.9 / 47.6 / 59.8 |
| JS fps during THINKHOLD (mean / min / p10) | 60.0 / 48.0 / 60.0 | 60.0 / 47.6 / 59.5 |
| JS windows < 55 fps during THINKHOLD | 1 / 357 | 1 / 367 |
| UI fps, fan open during THINKHOLD (5 opens) | 60, 60, 63, 60, 60 | 60, 60, 60, 60, 60 |
| largest UI frame gap in those opens | 23–28 ms | 22–27 ms |
| UI frame gaps > 34 ms in those opens | 0 | 0 |

**What this shows, honestly:** on the simulator (the Mac's CPU) the stutter does
not reproduce, before or after — the JS thread stays at ~60 fps during a
Thinking stream and the fan opens at 60 fps with no dropped frame. The fan's own
open/close was already native, so the change is not expected to move these
numbers here; it removes the JS dependency of the button's fade, rest level and
drop spring, which matters on a device whose JS thread does fall behind. The
owner's symptom must be re-checked on the iPhone (see Review / follow-ups).
Raw logs, videos, contact sheets and shots:
`/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-hub-native-driver/`
(`before4/`, `after4/`, `shot-*-fan-running.png`, `frames-*-busy-open.png`).

Two harness observations, both on HEAD too (not this change):
- `33-hub` fails at its opacity step (`hub-opacity-slider` not visible) on both
  builds.
- After ~30 s of an unbroken Thinking stream, a Maestro `tapOn` waits ~13 s for
  the screen to settle and the tap then does not register — on the hub AND on
  the drawer button (`session-drawer`), on HEAD and on this branch. Taps issued
  with `waitToSettleTimeoutMs: 300` register every time. Whether this is
  Maestro's tap delivery or the app ignoring touches late in a long turn is NOT
  established; it is the first thing to check on the device (a human tap at
  ~40 s of Thinking).

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption
The button's position `xy` is never fed by an `Animated.event` — the press
machine's `dragTo` effect sets it with `xy.setValue` (`FloatingActivity.tsx`
`apply`, `case "dragTo"`), and the PanResponder hands raw points to the driver
(`onPanResponderMove: driver.move(...)`). So `xy` can be native: `setValue` on a
native value is forwarded to the native node. Proven by `grep`: there is no
`Animated.event` in the file (pinned by the wiring test), and on the simulator
the drag/keyboard re-placement and the fan still work on the after build.

### Preconditions
- RN: all the animated values on one view are native or none (a view's props
  node is made native as a whole). The outer view carries `opacity` + `xy`, so
  the fade and the position must move together; the body carries `bodyLevel`
  alone; the arc's `spin` is already native.
- Only opacity and transform are animated — both supported by the native driver.

### Design
A pure module `src/hub-button-motion.ts` returns the config of each animation —
`fadePlan(shown, reduceMotion)`, `levelPlan(body, reduceMotion)` (up instant,
down the fade), `dropPlan(target, reduceMotion)` (a spring, or under Reduce
Motion a placement + a fade from 0) — each typed `useNativeDriver: true`. The
component only starts them. Timings are unchanged (150 ms fade, the RN default
spring).

### Files
- `apps/mobile/src/hub-button-motion.ts` (new) — the plans.
- `apps/mobile/src/ui/FloatingActivity.tsx` — the four calls use the plans.
- `apps/mobile/e2e/mock-model.ts` — the `THINKHOLD` scenario (measurement).
- tests below; `changelog.d/mobile-hub-native-driver.changed.md`.

### Failure modes
- A JS-driven animation started later on a native value → RN throws. None is
  left in the file (pinned).
- `setValue` during a drag on a native value: forwarded to the native node each
  move (it was a JS `setNativeProps` per move before) — same cost class.
- Re-placement when the band changes (keyboard): `xy.setValue` — checked on the
  simulator: keyboard up → the button moves above it; dismissed → back, and a
  tap opens the fan.
- Drop spring completion callback (`moving.current = false`) still fires on the
  JS side when the native animation ends.

### Tests
- `test/hub-button-motion.test.ts` — the plans' values (red: module missing →
  green).
- `test/hub-native-driver-wiring.test.ts` — no `useNativeDriver: false` in the
  button, each of the four calls takes its plan, the arc stays native, no
  `Animated.event`; the fan's spring/fade are native (red on HEAD: 2 of 5 fail
  → green).
- `test/e2e-mock-thinkhold.test.ts` — `THINKHOLD` streams reasoning, then the
  answer; a plain HOLD has none (non-vacuity by mutation: renaming the trigger
  fails it).

## Execution

*— claude-opus-5-5, 2026-11-18*

1. Measured HEAD first (table above). Earlier exploratory runs used a flow whose
   taps waited for the screen to settle; they hit the late-tap observation above
   (and a one-off ~1.4 s rAF stall at a first open that did not reproduce in the
   final runs). The table uses the final, identical `perf-fast` flow on both
   builds (`before4`, `after4`).
2. Wrote the two test files (red), the pure module (green), then switched the
   four calls in `FloatingActivity.tsx` to the plans (wiring test green).
3. Measured the after build with the same flow (table above).
4. Removed the temporary rAF probe (`src/perf-probe-tmp.ts` + its import).

Drift from the brief: nothing had to stay on the JS driver — the "split the
PanResponder value" case does not exist (no `Animated.event`), so the whole
button moved. Neither reanimated nor gesture-handler is a dependency; not added.

Gate (2026-11-18): `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit`
clean · `bun run lint` clean (2072 files) · `bun test`: 15083 pass, 5 skip, 0 fail
(the skips are not in this task's files; AGENTS §6 names three opt-in skips — the
other two are pre-existing on `main`, not checked here).

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context, but the **same model** as the
executor: blind spots they share survive both passes. Blast is `contained`, so
§10 allows it.)

**Verdict: APPROVE.** No HIGH or MEDIUM findings. Scope: `git diff main...HEAD` only.

**Gate (run by the reviewer):** the 3 touched test files pass 13/13 (27
expects) · `bun run lint` clean (2072 files) · `bun run typecheck` clean (root
+ mobile + relay). I did not re-run the full `bun test`; the count in Execution
is the executor's.

**Premises (checked against the code):**
- No `Animated.event` in `FloatingActivity.tsx`: TRUE. `xy` changes only through
  `setValue` (re-placement, `back`, `dragTo`, Reduce-Motion drop) and the drop
  spring.
- One props node per view, all native: TRUE. The outer view animates `opacity`
  plus `xy.getTranslateTransform()`, both native now. The body animates only
  `bodyLevel`. The arc animates only `spin`, which was already native.
- Nothing reads a JS-side animated value: TRUE. The press start comes from
  `place(p.position, p.bounds)` (`onPanResponderGrant`), not from `xy`, so a JS
  value that lags a native spring cannot give a wrong start.
- No other JS-driven animation on these values: TRUE (grep).

**Mutation (non-vacuity), reverted afterwards (tree byte-identical, `git status` clean):**
spring given `useNativeDriver: false`, then `levelPlan` up-duration changed
0→150, then the THINKHOLD trigger renamed. Result: 4 tests fail (the two wiring
tests, `levelPlan` up, THINKHOLD reasoning).

**Attacks tried:**
1. A new grant while the native drop spring runs: the start comes from props,
   and `setValue` stops the running animation. Nothing found.
2. A fade-out completion that unmounts: the `finished` callback still fires on
   the JS side when the native animation ends. Nothing found.
3. A Reduce-Motion toggle now re-runs the fade effect (the dependency changed
   from `fadeMs` to `reduceMotion`). It re-targets the same value, so it is
   harmless.
4. THINKHOLD after Stop: `send` on a cancelled stream behaves like the existing
   HOLD delta loop (an e2e mock, pre-existing pattern). THINKHOLD also runs about
   2× `holdMs` in total (the reasoning loop, then the held answer). This is
   test-harness only and below the reporting bar.

**What is still unverified:** the owner's stutter on a real iPhone. The
simulator did not reproduce it before or after the change (Context table).
The late-turn tap observation is still open.

**How the executor behaved:** measured before changing anything, reported the
negative simulator result honestly, kept the logic in a pure module (§7), and
showed tests going red before green.

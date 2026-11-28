# feat/mobile-ui-fluidity-s7 — sweep the rest of the class (activity clock, mascot, workflow edge)

> **Status:** implementation (APPROVED — orchestrator, delegated by the owner)
> **Branch:** `feat/mobile-ui-fluidity-s7`
> **Size:** M (TODO said S: three components + one hook + one pure helper + pins; still one package) · **Blast:** contained · **Suited:** Opus plan + fresh Opus review (owner night rule), Sonnet exec (simulator for the edge spike and gate 0)
> **Changelog:** `changelog.d/mobile-ui-fluidity-s7.fixed.md` — `- **Smoother Activity sheet, workflow runs and empty-session scene.** On the iPhone the Activity sheet's running times no longer re-render the whole session screen every second, a live workflow run's flowing edge animates off the JavaScript thread, and Polpetto's entrance redraws only when its picture changes.` (drop the workflow clause if the edge falls back, Design 3)

## Context

*— claude-opus-5-5, 2026-11-28*

Slice 7 of `docs/eval/mobile-ui-fluidity.md` (APPROVED by the owner 28/11; Migration
plan row 7, «Sweep the rest of the class»). The eval's root cause: every JS-timed UI
waits behind the session screen's renders, and anything that moves on its own must
take its value from a timestamp on ONE shared clock or a native-driver value, never
from a per-component JS timer or the parent's renders (eval, The pattern, «Clocks» /
«Animation starts»). Slices 0–6 are merged on `main` (`0510b3c3`); s2 built the shared
sampler (`src/clock.ts:61-91`, `src/use-since.ts:10-33`). Row 7's remaining members
(eval «Affected or at risk» table, re-verified on `0510b3c3`):

| Member | Mechanism today | Cost |
|---|---|---|
| Activity sheet clock | `setInterval(() => setActivityNow(Date.now()), ACTIVITY_CLOCK_TICK_MS)` IN `SessionScreen` (`src/screens/SessionScreen.tsx:1007-1015`) | the WHOLE session screen re-renders every second while the sheet is open (and `activityVm`, `activityDetail`, `hubCtx` recompute: deps at `:1034`, `:1053`, `:1488`) |
| Mascot scene | rAF → `setElapsedMs` on EVERY frame (`src/ui/MascotScene.tsx:66-93`) | ~60 renders/s of an `Svg` of rects, although most frames are identical (Repro) |
| Workflow edge flow | `Animated.loop(Animated.timing(flow, { useNativeDriver: false }))` per live edge (`src/screens/WorkflowRun.tsx:217-235`) driving `strokeDashoffset` | a 60 fps JS-driven loop for the whole run, on the screen of `fix/mobile-workflow-run-jank` |
| Activity sheet resize | `Animated.timing/spring(height, { useNativeDriver: false })` (`src/screens/ActivitySheet.tsx:223-240`) | JS-driven during an open/resize (~300 ms) |

Gate: `90-perf-stream` (s0) must improve or hold. None of the four is on that flow's
path (no sheet open, a non-empty session, no workflow), so the expectation is HOLD;
row 7's own AI-free check is «source pins + gate 0».

**Repro** (2026-11-28, `0510b3c3`, no source edited; `.tentacle/tmp/mobile-ui-fluidity-s7/mascot-frames.ts`):

```ts
// How many DISTINCT frames does each scene draw, sampled at 60 Hz (the rAF rate)?
import { MASCOT_SCENES, frameAt } from "../../worktrees/mobile-ui-fluidity-s7/apps/mobile/src/mascot-scenes.ts";
for (const scene of MASCOT_SCENES) {
  for (const run of [0, 1]) {
    let last = ""; let distinct = 0; let samples = 0;
    for (let t = 0; t <= scene.durationMs; t += 1000 / 60) {
      samples++;
      const key = JSON.stringify(frameAt(scene, t, run, { eyeFade: "#fff" }));
      if (key !== last) { distinct++; last = key; }
    }
    const perS = (distinct / (scene.durationMs / 1000)).toFixed(1);
    console.log(`${scene.key} run=${run}: ${samples} rAF frames, ${distinct} distinct (${perS}/s)`);
  }
}
```

```
para run=0: 637 rAF frames, 280 distinct (26.4/s)
skate run=0: 408 rAF frames, 86 distinct (12.6/s)
peek run=0: 348 rAF frames, 27 distinct (4.7/s)
swim run=0: 516 rAF frames, 397 distinct (46.2/s)
rocket run=0: 444 rAF frames, 233 distinct (31.5/s)
ufo run=0: 372 rAF frames, 207 distinct (33.4/s)
camo run=0: 324 rAF frames, 75 distinct (13.9/s)
balloon run=0: 396 rAF frames, 150 distinct (22.7/s)
heli run=0: 576 rAF frames, 310 distinct (32.3/s)
(run=1 identical)  total: 4021 renders today, 1765 distinct frames (−56 %; peek −92 %)
```

Timer sites (`rg -n "setInterval|useNativeDriver: false|requestAnimationFrame" apps/mobile/src`):
`SessionScreen.tsx:418` (voice controller's `every`, out of scope), `SessionScreen.tsx:1013`
(activity clock), `ActivitySheet.tsx:228,234`, `WorkflowRun.tsx:227`, `MascotScene.tsx:87,89`,
`WorkflowStep.tsx:157` (the step flight, a layout animation — not in row 7).

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (orchestrator decisions below; the owner
delegated the details; no choice touches an AGENTS §7 trust rule).

### Load-bearing assumption

**Every screen-side use of the activity view-model is time-free; only the sheet's
DRAWN strings and its Stop arm read `now`.** If true, the screen can stop ticking and
compute its view-model once per data change, and only the sheet subtree needs a clock.

Proof by source: `now` enters `activityView` only through the running rows' elapsed
meta (`src/activity.ts:119`, `:135`) and the Scheduled row's day label
(`:192` → `schedule-view.ts:52-80`); the group's presence is not time-based
(`activity.ts:168-181`). `sheetDetail` uses it only in meta strings
(`subagent-detail.ts:164`, `:384`); `report` is time-free (`:265`). The screen reads
`activityVm` only for `count`/`unread`/`badge*`/`accessibilityLabel`/`groups[].rows[].id`/
`nothingRunning` and `panelAutoClose`/`panelOpensFor` (`SessionScreen.tsx:1094`, `:1133`,
`:1307`, `:1336`, `:1462`, `:1814-1816`, `:1998-2000`) and `activityDetail` only for
`report` (`:1055`). The Stop arm's window is `stopArmed(arm, id, now)`
(`activity-panel.ts:193-194`), called in the sheet (`ActivitySheet.tsx:131`). The one
other screen use, the hub's `schedules: { rows, now: activityNow }` (`:1469` →
`hub-session.ts:113` `wakeContext`), already reads a value frozen while the sheet is
closed — kept as is (Notes).

### Preconditions

- The shared sampler: ONE scheduled callback for all subscribers, wakes aimed at
  `CLOCK_SAMPLE_MS` (250) boundaries of `now()` (`clock.ts:57-91`, `motion.ts:32`);
  `useSince` already wires it through `useSyncExternalStore` (`use-since.ts:10-33`).
  A 1000 ms floor of `now()` changes only at a 250-boundary, so a 1 s label re-renders
  once per second.
- `SheetsPane` is `memo`ized (`screens/session/SheetsPane.tsx:65`) and renders
  `ActivitySheet` with `view`/`detail`/`now` from the screen (`:258-264`).
- `useNativeDriver` for a NON-style prop is not checked JS-side: `AnimatedProps`
  allowlists only `style` (`react-native/Libraries/Animated/nodes/AnimatedProps.js:53-63`,
  `NativeAnimatedAllowlist.js:151-153`); whether the iOS Fabric side applies
  `strokeDashoffset` to react-native-svg's `Path` is **unknown** → Design 3 spike.
- `height` is native-animatable only under `useSharedAnimatedBackend`
  (`NativeAnimatedAllowlist.js:63-66`), so the sheet's height springs cannot simply flip.
- Components are pinned as source (`.tsx` is unimportable from Bun:
  `test/hub-native-driver-wiring.test.ts:1-20`, `test/mascot-wiring.test.ts`).

### Design

1. **Activity clock → the sheet's own leaf, on the shared sampler.**
   - `use-since.ts`: add `useWallClock(active: boolean, periodMs: number): number` —
     `useSyncExternalStore(active ? SAMPLER.subscribe : NEVER, snap, snap)` with
     `snap = Math.floor(SAMPLER.now() / periodMs) * periodMs`. No new timer.
   - `SessionScreen.tsx`: delete the interval effect (`:1008-1015`); `activityNow`
     becomes `activityStamp`, set to `Date.now()` once when the sheet opens (the
     existing `setActivityNow(Date.now())` at `:1012`, kept in an
     `[activityOpen]` effect with no interval). Extract the two inline inputs into
     memos `activityInput` (`ActivityInput`, deps `activity, reports, hubSlice.schedules`)
     and `detailInput` (`SheetDetailInput`, deps `activity, reports`); `activityVm` /
     `activityDetail` stay memos over them with `activityStamp` (all screen decisions,
     unchanged). Pass `activityInput`, `detailInput` to `SheetsPane` instead of
     `activityVm`/`activityDetail`/`activityNow`.
   - `SheetsPane.tsx`: a small `ActivityClockSheet` wrapper (same file) renders
     `ActivitySheet`; it calls `useWallClock(visible, ACTIVITY_CLOCK_TICK_MS)` and
     memoizes `activityView(activityInput, now)` / `sheetDetail(focus, detailInput, now)`.
     So a tick re-renders ONLY the sheet, never the screen or the other panes.
   - **Execution fix (claude-sonnet-5-5, 2026-11-28) — the Stop arm expires by
     STATE, not by the clock.** The screen's arm timer (`SessionScreen.tsx:1101-1108`)
     and `stopRow` bumped `activityNow`, which the sheet no longer receives; a sheet
     clock floored to 1000 ms keeps the pill drawn armed up to ~1 s past
     `STOP_ARM_MS` (measured: `+3020 ms` real armed=false, floored armed=true), while
     `stopTap` would only re-arm. So the timer now calls `setArm(STOP_IDLE)`
     (equivalent for `stopTap`: an expired arm is already a fresh first tap) and
     `stopRow` no longer touches a clock. Pinned.
2. **Mascot → redraw only when the picture changes.**
   - `mascot-scenes.ts`: pure `sameFrame(a: readonly Op[], b: readonly Op[]): boolean`
     (structural: length, kind, x/y/alpha/map/rows for sprites — `rows` by identity is
     NOT enough if a scene builds them per frame: compare contents — rect tuple,
     color, alpha for rects).
   - `MascotScene.tsx`: the rAF loop computes `next = frameAt(scene, elapsed, drawn.run,
     { eyeFade })` and stores it only when `!sameFrame(last, next)` (a functional
     `setFrame(prev => sameFrame(prev, next) ? prev : next)`, so React bails out);
     `eyeFade` read through a ref (a theme flip lands on the next frame). End and
     Reduce Motion unchanged (`[]` once over; `stillFrame()` with no loop).
3. **Workflow edge → native driver, decided by a spike.** `WorkflowRun.tsx:227`
   `useNativeDriver: true`. **Spike first** (Execution step 1, under `sim.lock`): a run
   with a live leg on the simulator (`edgeLook(...).animate`, `workflow-edge.ts:57`),
   two `simctl io screenshot`s ~300 ms apart must differ inside the edge's box, with
   no redbox / warning in the app log; then run the same with Reduce Motion to see it
   still. **If the dash does not move (or the run cannot be produced within one
   attempt): FALLBACK** — keep `false`, drop the edge pin's assertion to an
   "exception" pin with a comment citing the spike, drop the edge clause from the
   changelog, record it in Execution as debt. No look change without the owner.
4. **Activity sheet height springs: stay JS-driven (documented exception).** Native
   height needs the experimental backend (Preconditions); a translateY redesign
   changes the sheet's layout and scroll model (content at the low detent would sit
   below the screen edge) and is not S. They run ~300 ms per open/resize, and the
   drag is a JS `PanResponder` anyway. A pin fixes the exception to exactly those two
   calls, so a new JS-driven animation cannot slip in.

#### Orchestrator decisions

1. **Activity clock: move it to the sheet leaf (recommended) vs carry `since` in the
   view-models and tick each label with `useSince`.** Chosen: the leaf. The label
   variant changes three pure modules' shapes (`detailView` puts the elapsed in the
   MIDDLE of its meta, `subagent-detail.ts:158-166`) and still needs a clock for the
   Stop arm; the leaf variant keeps every pure module and its tests as they are and
   removes the whole-screen tick, which is the cost.
2. **Activity tick period: 1000 ms floor** (`ACTIVITY_CLOCK_TICK_MS`, unchanged) —
   same ≤ 1 s lag as today's `setInterval`, 1 render/s of the sheet only.
3. **Mascot: dedupe (recommended) vs a native value.** A scene is arbitrary pixel ops
   per frame (`mascot-scenes.ts:382-383`); no native value can drive it without a
   rewrite. It shows only on an EMPTY session (`SessionScreen.tsx:2116`), off the
   stream path. Dedupe removes 56 % of its renders (Repro).
4. **Edge: native with a spike, fallback = keep** (Design 3).
5. **Sheet height: keep, pinned** (Design 4). Reopen as its own task only if a device
   `ptrace` shows the sheet open stuttering.
6. **Rename `activityNow` → `activityStamp`** (it no longer ticks); update the pin that
   reads the name (`test/activity-scheduled-wiring.test.ts:20`).

### Files

1. `apps/mobile/src/use-since.ts` — `useWallClock`.
2. `apps/mobile/src/mascot-scenes.ts` — `sameFrame`.
3. `apps/mobile/src/ui/MascotScene.tsx` — deduped frame state.
4. `apps/mobile/src/screens/WorkflowRun.tsx` — `useNativeDriver: true` (or not, per spike).
5. `apps/mobile/src/screens/SessionScreen.tsx` — no interval; `activityStamp`; `activityInput`/`detailInput` memos; new `SheetsPane` props.
6. `apps/mobile/src/screens/session/SheetsPane.tsx` — `ActivityClockSheet`; props `activityInput`, `detailInput` (remove `activityVm`, `activityDetail`, `activityNow`).
7. Tests: `test/fluidity-sweep-wiring.test.ts` (new), `test/mascot-scenes.test.ts` (+`sameFrame`), `test/activity-scheduled-wiring.test.ts` and `test/session-slices-wiring.test.ts:93` (follow the moved memos), `test/mascot-wiring.test.ts` if a pin reads `setElapsedMs`.
8. `changelog.d/mobile-ui-fluidity-s7.fixed.md`.

No protocol, persistence, daemon or client change.

### Failure modes

- **Sheet shows stale times** (clock not subscribed): `useWallClock(visible, …)` —
  `visible` is the same `activityOpen && !yields` the sheet gets; pinned. A closing
  sheet freezes its labels for its ~300 ms close — acceptable.
- **Stop arm never expires / outlives its window**: the screen's timer disarms it
  at `STOP_ARM_MS + 20` (`setArm(STOP_IDLE)`), which re-renders the sheet through
  its `arm` prop; `ActivitySheet.tsx:131` unchanged. A closed sheet already disarms
  (`closeActivity`).
- **Screen decision diverges from what the sheet draws**: impossible by the
  load-bearing assumption (screen fields are time-free); both read the same memoized
  inputs, so a data change reaches both in the same render.
- **Hub's next-wake figure**: still `activityStamp` — same freshness as today (Notes).
- **Mascot freezes on a changed picture** (a `sameFrame` false positive): tested
  against the Repro's JSON-distinct count over every scene × run (must be EQUAL, not
  just ≤), so no real change is ever swallowed.
- **Mascot theme flip mid-scene**: `eyeFade` via ref → next frame; the scene is
  never restarted (owner decision 4 pin stays).
- **Edge silently static on native**: the spike proves motion on device-equivalent
  iOS Fabric before the pin is made green; else fallback (Design 3).
- **Reduce Motion**: edge `setValue(0)` path unchanged; mascot `stillFrame()`
  unchanged; sheet `timing` branch unchanged.
- **Empty/unmount**: `useWallClock` unsubscribes via `useSyncExternalStore`; the
  sampler cancels its single timer at 0 listeners (`clock.ts:81-85`).

### Tests

RED first (show each failing on `0510b3c3`, on the assertion):

- `test/fluidity-sweep-wiring.test.ts` (comment lines stripped, the
  `hub-native-driver-wiring` pattern):
  1. `SessionScreen.tsx` has no `ACTIVITY_CLOCK_TICK_MS` and exactly ONE `setInterval(`
     (the voice controller's, `:418`). RED today (two).
  2. `SheetsPane.tsx` calls `useWallClock(` with the sheet's visibility and
     `ACTIVITY_CLOCK_TICK_MS`, and its `ActivitySheet` gets `now={now}` from it, with
     `activityView(` / `sheetDetail(` computed there. RED today.
  3. `MascotScene.tsx` stores a frame only through `sameFrame(`; no `setElapsedMs`. RED today.
  4. `WorkflowRun.tsx`: every `Animated.timing|spring|loop` config has
     `useNativeDriver: true`. RED today. (Spike fails → replaced by an exception pin.)
  5. Guard (green today): `ActivitySheet.tsx` has exactly two `useNativeDriver: false`,
     both on `height`.
- `test/mascot-scenes.test.ts`: `sameFrame` — equal ops true; a moved sprite, a
  changed alpha, a changed rect tuple, a different length → false; `[]`/`[]` true;
  and, over every scene × run at 60 Hz, the count of `!sameFrame` transitions equals
  the JSON-distinct count (property from the Repro).
- Mutation (§9, each reverted): `sameFrame` → `() => true` (property test fails);
  `useWallClock` subscribe with `NEVER` always (pin 2 must catch the `active ?`);
  put the interval back in the screen (pin 1 fails).
- Gate 0: `bun apps/mobile/e2e/run.ts --udid <sim> --only 90-perf-stream` under
  `sim.lock` (mkdir `/Users/gmeghnag/tentacle/.tentacle/tmp/orchestration/sim.lock`,
  rmdir after), on `main` and on the branch: PERF PASS, 0 jank lines, `starts=1`,
  settle and panes no worse than `main` (s6: settle 707–735 ms, panes 3/1233/118).
  No build is published; `~/bin` and running serves untouched.
- Narrow: `bun test apps/mobile/test/`; `tsc -p apps/mobile`; `biome check` on changed
  files. Full `bun run check` is the orchestrator's.

### Notes / debt

- The hub's `schedules.now` (`SessionScreen.tsx:1469`) is a stamp frozen while the
  sheet is closed — pre-existing, unchanged here; the "next wake in" figure can lag.
  A follow-up could stamp it with `useWallClock` at a coarse period inside the hub leaf.
- `WorkflowStep.tsx:157` (the step flight, a layout animation) stays JS-driven — not
  in row 7.
- Gate 0 does not open the Activity sheet or a workflow run; extending it is out of
  this row's scope.

## Execution

*— claude-sonnet-5-5, 2026-11-28*

**Setup.** The worktree had no workspace links (`@tentacle/core` unresolved):
`bun install --frozen-lockfile` (no tracked file changed).

**Load-bearing check** (`.tentacle/tmp/mobile-ui-fluidity-s7/load-bearing.ts`: every
screen-read field of `activityView`, `panelAutoClose`/`panelOpensFor` and the detail's
`report`, over six `now` values) — HOLDS:

```
view: screen-read variants=1 whole-view variants=5      (×3 inputs: 1/5, 1/1, 1/1)
detail sa-1: report variants=1 whole variants=5         (sa-2: 1/1, bg-1: 1/5)
LOAD-BEARING: HOLDS
arm +3020ms: real-clock armed=false floored armed=true (window 3000)
arm +3500ms: real-clock armed=false floored armed=true (window 3000)
```

The mascot Repro reproduces (e.g. swim 397/516 distinct, heli 310/576).

**Drift from Implementation.**

1. The arm lines above contradict Design 1's «Stop arm … unchanged»: fixed in Design 1
   and Failure modes before coding (the arm timer disarms; `stopRow` bumps no clock),
   with its own pin.
2. Order: all code and tests first, then ONE build for the edge spike and gate 0 (the
   spike still decided before the edge change was accepted).
3. Pins that followed the moved code, beyond Files 7:
   `test/activity-panel-wiring.test.ts` (the pane mounts `ActivityClockSheet`);
   `test/mascot-wiring.test.ts`'s «never a literal run 0» regex now checks the third
   argument (the first picture is `frameAt(scene, 0, drawn.run, …)`).

**As built.** `useWallClock` (`use-since.ts`); `sameFrame` (`mascot-scenes.ts`);
`MascotScene.tsx` holds the frame and sets it through `sameFrame`;
`SessionScreen.tsx` has no activity interval (`activityStamp`, `activityInput`,
`detailInput`); `ActivityClockSheet` (`SheetsPane.tsx`); edge
`useNativeDriver: true` (`WorkflowRun.tsx`); sheet height springs untouched, pinned.
No protocol/schema change.

**RED first** (new/updated tests on the unchanged code, `sameFrame` stubbed to
`() => true`): `90 pass 26 fail`, all on assertions; the sheet-height guard green.
**GREEN:** `bun test apps/mobile/test/` → `6024 pass 0 fail` (364 files);
`tsc -p apps/mobile` clean; `biome check apps/mobile/src apps/mobile/test` clean.

**Mutations** (`mutate.ts`, each restored):

| Mutation | Failing tests |
|---|---|
| `sameFrame` → always true | 16 (incl. the 60 Hz property) |
| `sameFrame` ignores alpha | 3 (incl. the property) |
| `useWallClock` subscribes `NEVER` | 1 |
| interval back in the screen | 2 |
| arm timer bumps a clock again | 1 |
| leaf ticks regardless of visibility | 1 |
| edge back to the JS driver | 1 |

**Edge spike — PASS, native kept** (iPhone 17 Pro, iOS 26 simulator, Release build,
under `sim.lock`). Temporary harness edits (restored; `e2e/` unchanged in git): a third
run `collect → sleep 240 → archive` seeded in `workflowRunsOf`, flow 45 replaced by
one that opens it and takes four screenshots; compared inside the live edge's box
(`png-diff.ts 325,772,375,842`):

```
motion:        a 0 · b 324 · c 534 · d 732 bytes differing from a (dash phase moves)
Reduce Motion: a 0 · b 0   · c 0   · d 0
```

App log (`log show`, animation/unhandled/redbox predicate, motion run): no match.
Reduce Motion restored to off.

**Gate 0** (`--only 90-perf-stream`, branch): `PERF PASS`, jank lines 0, `starts=1`,
fan settle 707/711/713/721 ms, panes `shell=3 tail=1203 cells=118 … sheets=1` — no
worse than s6's recorded 707–735 ms and 3/1233/118. `main` was NOT re-measured (this
executor stays in the worktree): the baseline is s6's figures.

**Not verified.** No pixels of the Activity sheet ticking or of the mascot scene on a
device/simulator (source pins and pure tests only). React may run `MascotSceneLayer`'s
body once more after a change before it bails out (no commit); not measured.

## Review

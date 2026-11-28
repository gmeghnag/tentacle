# feat/mobile-ui-fluidity-s5 — Hub fan without JS timers

> **Status:** implementation — **APPROVED** (owner delegated the details, 2026-11-28; decisions below)
> **Branch:** `feat/mobile-ui-fluidity-s5`
> Type: feat · **Size:** S · **Blast:** contained · **Suited:** Opus plan + fresh Opus review (owner night rule), Sonnet exec
> **Changelog:** `changelog.d/mobile-ui-fluidity-s5.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-28*

This is slice 5 of `docs/eval/mobile-ui-fluidity.md`, which the owner APPROVED on 2026-11-28. The eval's Migration plan row 5 (`:324`) is the scope. **Fan without JS timers:** one native progress value with per-item ranges, and no full-screen work inside the opening window. The AI-free check: the pure ranges are monotone and the last item ends at 1; a source pin forbids `delay:` in `HubFan.tsx`; gate 0 reads `settle` ≤ 1 500 ms while streaming.

**The problem (eval Root cause 4, `:76-83`).** Each fan item has its own spring, started with `delay: i * motion.staggerMs` (`src/ui/HubFan.tsx:96-103`, `staggerMs: 18` at `src/hub-fan.ts:407`). React Native implements `delay` as a **JS `setTimeout`**, even on the native driver (`react-native/Libraries/Animated/animations/SpringAnimation.js:236-237`; the same applies to timing, `TimingAnimation.js:146-147`). Item 0 starts on the UI thread, but items 1…n−1 wait for the JS thread. That is the owner's screenshot: the arc is turning, only Stop has appeared, and the other items are missing. On the device, most opens during a stream never settled (`settle=-1`) or took 2.5–4.0 s (eval Device evidence, `:255`).

**What changed since the eval (drift from earlier slices).** Slices 1–4 removed most of the JS load. After s4, gate 0 passes, with fan settle times of 1068, 1067, 1066 and 1059 ms while streaming, and `panes: shell=3 … hub=1` over a whole flow with 4 fan opens (`docs/feat/mobile-ui-fluidity-s4.md:565-575`). So the opening window already does no screen-shell render. The JS timers are still there, though. Any JS stall, such as a replay burst (slice 6, not built yet), a heavy cell or a slow device, still delays every item after the first. This slice removes that dependency, so the fan cannot depend on JS load at all. The only JS-side work left inside the opening window is `controller.refreshCatalogue()`, an RPC whose answer `emit()`s (`session-screen-controller.ts:1424-1449`) into the `hub` slice (`session-store.ts:64`).

**Repro** (2026-11-28, this worktree = `main` `c5848c0d`, no source edited; `.tentacle/tmp/mobile-ui-fluidity-s5/repro.ts`):

```ts
import { readFileSync } from "node:fs";
const WT = "/Users/gmeghnag/tentacle/.tentacle/worktrees/mobile-ui-fluidity-s5/apps/mobile/src";
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
const fan = strip(readFileSync(`${WT}/ui/HubFan.tsx`, "utf8"));
const screen = strip(readFileSync(`${WT}/screens/SessionScreen.tsx`, "utf8"));
const { fanMotion } = await import(`${WT}/hub-fan.ts`);
const delays = fan.match(/delay:\s*i \* motion\.staggerMs/g)?.length ?? 0;
const perItem = (fan.match(/Animated\.(spring|timing)\(value,/g) ?? []).length;
console.log(`HubFan: per-item animations=${perItem > 0} (one Animated.Value per item), delay: lines=${delays}`);
for (const n of [6, 9, 13]) {
  const m = fanMotion(false);
  console.log(`  n=${n}: ${m.staggerMs > 0 ? n - 1 : 0} items start from a JS setTimeout (SpringAnimation.js:236-237), last at +${(n - 1) * m.staggerMs} ms`);
}
const at = screen.indexOf("const onHubFan = (open: boolean) => {");
const body = screen.slice(at, screen.indexOf("\n  };", at));
console.log(`onHubFan open branch refreshes the catalogue: ${/if \(open\) \{[\s\S]*refreshCatalogue\(\)/.test(body)}`);
console.log(`onHubFan sets navigation options on every change: ${body.includes("navigation.setOptions({ gestureEnabled: !open })")}`);
```

```
HubFan: per-item animations=true (one Animated.Value per item), delay: lines=1
  n=6: 5 items start from a JS setTimeout (SpringAnimation.js:236-237), last at +90 ms
  n=9: 8 items start from a JS setTimeout (SpringAnimation.js:236-237), last at +144 ms
  n=13: 12 items start from a JS setTimeout (SpringAnimation.js:236-237), last at +216 ms
onHubFan open branch refreshes the catalogue: true
onHubFan sets navigation options on every change: true
```

The spring we must reproduce (`spring.ts`, the closed form RN uses at `SpringAnimation.js:291-317`, damping 18, stiffness 260, mass 1):

```
zeta=0.558 rest=933ms overshoot=12.1%
|1-x| <= 0.01 for good after 529 ms
|1-x| <= 0.005 for good after 571 ms
|1-x| <= 0.002 for good after 602 ms
K=8 samples over 600 ms: max |track - spring| = 0.0783
K=12 samples over 600 ms: max |track - spring| = 0.0481
K=16 samples over 600 ms: max |track - spring| = 0.0313
K=24 samples over 600 ms: max |track - spring| = 0.0159
n=6: today the last item rests at 1023 ms
n=9: today the last item rests at 1077 ms
```

Today's settle of about 1 060 ms matches about 8 items, each spring resting after 933 ms (RN's 0.001 rest thresholds, `SpringAnimation.js:114`).

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (owner delegated the details; no §7 trust rule is touched)

### Load-bearing assumption

After `.start()`, a native-driver `Animated.timing` with **no `delay`** needs no JS, and per-item `interpolate` nodes with multi-point ranges, including the chained scale `interpolate`, run in the native graph. If both hold, item *i*'s start no longer depends on the JS thread. Proof from the RN source (the main checkout's `apps/mobile/node_modules/react-native`; this worktree has no `node_modules` until `bun install --frozen-lockfile`):

- `TimingAnimation.js:87-104`: the native config is `type: 'frames'`, with the easing **sampled once in JS at start** (`frames.push(this._easing(frame / numFrames))`, `:96-101`). The only `setTimeout` is the `delay` (`:146-147`).
- `AnimatedInterpolation.js:513-555`: `__getNativeConfig` sends the whole `inputRange`/`outputRange` plus `extrapolateLeft/Right` as `type: 'interpolation'`. Ranges only have to be non-decreasing (`:326-328`).
- `AnimatedInterpolation.js:483-485, 497-504`: an interpolation can be interpolated again, and `__makeNative` makes its parent native first.

The empirical proof is the executor's: gate 0 (`starts=1`, settle) and the before/after video.

### Preconditions

- The fan mounts once per open, and its animation effect starts once per mount. `HubFan` is `memo` (`HubFan.tsx:84`), and `motion` is one frozen object per mode (`hub-fan.ts:397-420`, pinned by `hub-fan.test.ts:458-462`).
- The fan's items are a **snapshot taken at the open**. `FloatingActivity` passes `fan.items` (`FloatingActivity.tsx:525`) from the driver's `solve` (`:364-367`, doc at `:128`). So a catalogue answer that arrives during an open never changes that open's fan, only the next one. The commit uses the world seen at the open too (`SessionScreen.tsx:1765, 1775`).
- `onFanChange(false)` fires on **every** close path, including unmount (`FloatingActivity.tsx:380-396`). It is the only caller of `onHubFan` (`screens/session/HubPane.tsx:50` → `SessionScreen.tsx:1902`).
- A refresh after dispose is harmless. `readCatalogue` returns before assigning or emitting when `disposed` (`session-screen-controller.ts:1436-1438`; `emit()` sits after the try/finally), and it returns at once with no handle (`:1430-1432`).
- `hub-fan.ts` imports nothing from RN. Bun imports it (the repro above), so the new plan is unit-testable.
- The perf probe counts one `fanStart` per start and reports settle on a `finished` callback (`perf-probe.ts:162-171`). The gate rule `settle ≤ 1 500` is unchanged (s0).

### Design

**One value, one native timing, sampled spring tracks (D1).** `HubFan` keeps a single `progress = new Animated.Value(0)` per mount and runs one `Animated.timing(progress, plan.timing)`: `toValue: 1`, linear easing, `useNativeDriver: true`, no `delay`. Each item reads `progress.interpolate(plan.tracks[i])`. Track *i* is today's spring step response, **sampled** and shifted by `i · staggerMs`. Its `inputRange` runs from `(i·staggerMs)/T` to `(i·staggerMs + trackMs)/T`, its `outputRange` holds the samples of `x(t)` (0 at the start, overshoot about 1.12, the last sample exactly 1), and it uses `extrapolate: "clamp"`. The look is therefore today's motion: the same spring and the same 18 ms stagger, within 0.016 of progress (≈ 0.5 pt on a 48 pt disc). The rest of the render is unchanged: `scale = track.interpolate([0,1] → [fromScale, lit ? highlightScale : 1])`, and `opacity = track` or `dimOpacity`.

`hub-fan.ts` (pure) gains:

- `FanMotion.trackMs` (spring 600, Reduce Motion = `fadeMs` 120) and `FanMotion.trackSamples` (spring 24, Reduce Motion 1).
- `springAt(tMs, damping, stiffness)`: the closed form of `SpringAnimation.js:291-317`, from 0 to 1 with v0 = 0 and mass 1, with both the under-damped and the critically/over-damped branches as RN has them.
- `fanOpenPlan(motion, count): FanOpenPlan`, returning `{ timing: { toValue: 1, duration: T, easing: linear, useNativeDriver: true }, tracks: FanTrack[] }`.
  - `T = max(0, count − 1) · staggerMs + trackMs`.
  - `FanTrack = { inputRange, outputRange, extrapolate: "clamp" }`.
  - Reduce Motion: every track is `[0, 1] → [0, 1]` over `fadeMs`.
  - `linear = (t) => t` is exported, because the native config samples it once (`TimingAnimation.js:99`).

`HubFan` memoizes `plan` on `[motion, layout.items.length]` and `tracks` on `[progress, plan]`, and starts `Animated.timing(progress, plan.timing).start(({ finished }) => PERF.fanSettle(finished))` in an effect keyed on `[progress, plan]`. The effect's cleanup stops that run: a fan closed mid-open leaves no orphan animation, and `finished=false` reports nothing, as `fanClose` already does (`perf-probe.ts:173-175`). One `PERF.fanStart()` per start is unchanged.

**Nothing but the gesture lock at the open (D3).** In `onHubFan` (`SessionScreen.tsx:1762-1772`), the open branch keeps only the M7 snapshot `hubOpenAt.current = hubOpen(hubCtx)`, which is pure. `void controller.refreshCatalogue()` moves to the **close** branch. Every open ends in a close (precondition 3), so every open is followed by a refresh. Because of the snapshot (precondition 2), the open that the refresh serves was always the *next* one, so the user sees no difference. `navigation.setOptions({ gestureEnabled: !open })` stays where it is. It is the M2 safety lock against a back-swipe under the scrim, so it must take effect at the open. Gate 0 after s4 shows it does not render the screen shell (`shell=3` over 4 streaming opens).

#### Orchestrator decisions

The owner delegated these. The recommended option is chosen in each case.

- **D1. How to drop the delays.**
  - **(a) Chosen:** one linear native timing, with per-item tracks sampled from today's spring. The motion is the same, and the eval's "one progress + per-item ranges" holds exactly.
  - (b) One `Animated.spring` on `progress`, with per-item sub-ranges. This compresses the late items' bounce, so it feels different.
  - (c) Drop the stagger. This changes the design (Design 4).
  - `Animated.stagger` is not an option: it is implemented with `delay`.
- **D2. Sampling.**
  - **Chosen: 600 ms × 24 samples.** The residual is |1 − x| ≤ 0.002 at 600 ms, so there is no visible pop at the end, and the error is 0.016 (repro).
  - 16 samples (0.031) is visibly coarser at the overshoot.
  - Side effect: the settle shortens from about 933 ms to 600 ms per item, because RN's spring spends about 330 ms below 0.002 just to satisfy its velocity threshold. This is an improvement, invisible to the eye.
- **D3. Where the catalogue re-read goes.**
  - **(a) Chosen: on close.** One file, no new props, no path that misses a refresh.
  - (b) The eval's "settle callback". This needs a new prop through `HubFan` → `FloatingActivity` → `HubPane` → `actions.ts` → the screen (5 files). It also misses the refresh when the fan closes before settling (`finished=false`) unless it is wired into close as well.
  - (c) Leave it at the open. That is RPC + emit + hub render inside the window.
  - This drifts from the eval's wording, not its intent ("no work inside the opening window").
- **D4. Reduce Motion easing.**
  - **Chosen: linear**, a 120 ms fade on the same single value.
  - Today the fade uses RN's default `easeInOut`. At 120 ms, without scale, the difference is imperceptible. Sampling a bezier is extra code for no visible gain.
- **D5. The owner's visual check (eval failure mode `:346-348`).**
  - **Chosen: non-blocking.** The curve is the same by construction and pinned numerically (test A3). The executor records a before/after simulator video of the fan opening (`xcrun simctl io <udid> recordVideo`, flow 33) into `.tentacle/tmp/mobile-ui-fluidity-s5/` for the owner to see in the morning. The merge does not wait on it.

### Files

Dependency order:

1. `apps/mobile/src/hub-fan.ts`: `FanMotion.trackMs`/`trackSamples` in both motions; `springAt`, `linear`, `FanTrack`, `FanOpenPlan`, `fanOpenPlan`. `staggerMs`/`damping`/`stiffness` stay, because they define the tracks.
2. `apps/mobile/src/ui/HubFan.tsx`: one `progress`, `plan`, `tracks`; one `Animated.timing(progress, plan.timing)` with a stop cleanup; items read `tracks[i]` (fallback `progress`); no `grow`, no `delay:`, no `Animated.spring`, no `Animated.parallel`.
3. `apps/mobile/src/screens/SessionScreen.tsx` `onHubFan`: `refreshCatalogue` moves from open to close.
4. Tests:
   - `test/hub-fan.test.ts` (new `fanOpenPlan`/`springAt` describe; the `fanMotion` `toEqual` gains the two fields).
   - `test/fan-jank-wiring.test.ts` (the effect key `[progress, plan]`; no-timer pins).
   - `test/hub-native-driver-wiring.test.ts` (the fan pin `Animated.(timing|spring)(value, …)` × 2 is retargeted to the one plan-driven timing; this file is not in the eval row, but it pins the old shape).
   - `test/hub-workflows-wiring.test.ts` (the open → close pin; also not in the eval row, same reason).
5. `changelog.d/mobile-ui-fluidity-s5.fixed.md`: `- **The hub fan opens whole while a reply streams.** Every item now starts from one native animation, so a busy phone can no longer leave only the first button showing.`

No protocol, persistence, daemon or §7 surface is touched.

### Failure modes

| Case | What happens / how it converges |
|---|---|
| Fan closed or committed before it settles | `HubFan` unmounts, and the cleanup stops the one run. `finished=false` → no settle line; `fanClose` already reports it as today (`perf-probe.ts:173`). The close branch re-reads the catalogue. |
| JS thread busy at the open | The mount and the effect itself still need JS: the tap is a JS `PanResponder` (eval table, out of scope here). Once `.start()` runs, every item proceeds natively, so no item can wait on a timer. The JS-observed `settle` can still be late by the callback's latency, which the gate reads honestly. |
| `count` 0 / 1 | Zero items: `tracks = []`, `T = trackMs` (the settle is still reported). One item: its track spans `[0, 1]`. Both are tested. |
| Highlight during the opening | `scale` is re-derived from `tracks[i]` on render (as it is today from `grow[i]`). `tracks` are memoized per mount, so no new native nodes are made per streamed render beyond today's scale node. |
| `motion` changes mid-open (Reduce Motion toggled) | The new `plan` → the effect cleans up and restarts from the current `progress` to 1. The fan ends settled, same as today's restart. |
| Fan open while the app goes to background | The refresh waits until the close, and the next open is the one it serves anyway (precondition 2). |
| Screen unmounts with the fan open | `onFanChange(false)` → refresh on a leaving controller → the dispose guards (`:1430-1438`) make it a no-op or a dropped answer, never an emit after dispose. |
| A future edit re-adds `delay:`/`Animated.stagger`/a per-item spring | Source pin B1 goes red. |
| A future edit puts work back into the open branch | Pin C1 goes red (the open branch holds only the snapshot). |
| Native interpolation ≠ JS (platform) | It is the same algorithm (`AnimatedInterpolation.js` native config); the video and gate 0 check it on iOS. Android is not in the gate (the app ships iOS), so this is noted, not tested. |

### Tests

Write them red first, against a stub `fanOpenPlan` that returns `{ timing: { toValue: 1, duration: 0, easing: linear, useNativeDriver: true }, tracks: [] }` and a stub `springAt` that returns 1. They must fail on assertions, not on an import. The source pins are red on today's source.

**A. `hub-fan.test.ts` (pure).**

1. The timing is `toValue: 1`, `useNativeDriver: true`, with no `delay` key; `easing(0.37) === 0.37`. Its duration is `(n−1)·18 + 600` (spring) and `120` (Reduce Motion), for n ∈ {0, 1, 8, 13}.
2. There are `tracks.length === n` tracks. Each `inputRange` is strictly increasing and within [0, 1], with `extrapolate: "clamp"`. The first input is `i·18/T`, the first output 0 and the last output exactly 1. **The last item's last input is exactly 1** (eval row 5).
3. **It is the same spring**: over 0…600 ms, each track's piecewise-linear value at `(i·18 + t)/T` is within 0.02 of `springAt(t, 18, 260)`. `springAt` itself matches RN's closed form at three points, and its peak is > 1.1, so a linear `[0,1]` track fails this test.
4. **The stagger is kept**: at `p = (i·18)/T`, item *i* reads 0 and item *i−1* reads more than 0.
5. The end shows no pop: `|1 − springAt(600)| ≤ 0.002`.
6. Reduce Motion: every track is `[0,1] → [0,1]`, and `fanMotion` keeps its one-object-per-mode identity (existing test).

**B. Source pins (comment lines stripped, the existing helper).**

1. `fan-jank-wiring.test.ts`: `HubFan.tsx` contains no `delay:`, `Animated.spring`, `Animated.parallel`, `Animated.stagger` or `setTimeout`. It contains exactly one `Animated.timing(progress, plan.timing)`, whose `.start(({ finished }) => PERF.fanSettle(finished))` effect is keyed `[progress, plan]`. Items read `progress.interpolate(`.
2. `hub-native-driver-wiring.test.ts`: the fan's one animation takes its config from `fanOpenPlan` (native by type, the `hub-button-motion.ts` `TimingPlan` pattern), and there is no `useNativeDriver: false`.

**C. `hub-workflows-wiring.test.ts`.**

1. The open branch of `onHubFan` contains `hubOpenAt.current = hubOpen(hubCtx)` and **no** `refreshCatalogue`.
2. The close branch contains `void controller.refreshCatalogue()`.
3. `navigation.setOptions({ gestureEnabled: !open })` is still unconditional.
4. The commit and flash pins are unchanged.

**Mutations** (apply, run, revert; record the output):

| # | Mutation | Must fail |
|---|---|---|
| m1 | tracks without the `i·staggerMs` offset | A4 |
| m2 | outputs `[0, 1]` instead of the samples | A3 |
| m3 | `delay: i * 18` back on the timing in `HubFan` | B1 |
| m4 | refresh back in the open branch | C1 |
| m5 | `trackSamples: 8` | A3 |

**Gate 0 (AI-free, simulator, under `.tentacle/tmp/orchestration/sim.lock`).** Run `bun run e2e:mobile --udid <sim> --only 90-perf-stream` on `main` first (baseline), then on the branch. The branch must show:

- `PERF PASS`, 0 jank lines;
- `starts=1` on every fan line;
- every streaming settle ≤ the baseline's (expected about 7·18 + 600 ≈ 730–850 ms, against 1 059–1 068 ms);
- `panes` no worse than s4's.

Regression flows: `33-hub`, `34-hub-workflows`, `28-floating-activity`. Record the D5 video. Then run `bun test apps/mobile/test`, `tsc -p apps/mobile` and `biome check` on the changed files. The full `bun run check` is the orchestrator's.

## Execution

*(empty — the executor's)*

## Review

*(empty — fresh-context Opus)*

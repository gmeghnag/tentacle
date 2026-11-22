# feat/mobile-mascot-scenes — Polpetto enters and leaves the empty iPhone session

> Type: feat · Size: M · Blast: contained · Suited: DeepSeek executes, Opus review (one round)
> **Branch:** `feat/mobile-mascot-scenes` · **Changelog:** `changelog.d/mobile-mascot-scenes.added.md`

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22 — owner decisions, verbatim intent*

Today an empty, open session on the iPhone shows `EmptyState` with the `bubble.left` icon,
"Nothing here yet" / "Say something below." (`apps/mobile/src/screens/SessionScreen.tsx:1500-1508`).
The owner wants Polpetto (the owner's 9×9 drawing, `packages/tui/src/mascot.ts:18-28`
`MASCOT_BITMAP`; 9 palettes `packages/tui/src/theme.ts:186-197`) there instead, animated.

**Owner decisions (22/11), all final:**
1. **Variant A** of the empty-session mockup: Polpetto alone, square crisp pixels, **6 pt per
   pixel** (54 pt wide), home position **centred horizontally, just above the composer**. No
   "Nothing here yet" text. One palette at random among the 9 each time.
2. **Nine scenes**, the motion reference is the mockup
   `docs/feat/mobile-mascot-scenes-mockup.html` (open it; its `SCENES` array is the spec —
   timings, sprites, paths). Port it, do not reinvent:
   - **Paracadute:** descends from the top swaying, canopy + strings above; lands with a 1-px
     squash, the canopy falls away fading; blinks, looks to the side, walks off-screen
     (alternating left/right per run; leg frames alternate).
   - **Skateboard:** rides in from the left, brakes at home, looks around, small hop, rides out
     to the right accelerating.
   - **Sbuca dal campo:** rises from BEHIND the composer (clipped by it), looks left, right,
     blinks, waves a tentacle, sinks back.
   - **Nuota:** swims in from bottom-left in tentacle pulses with fading bubbles, hovers at home
     bobbing 1 px, blinks, swims out to the top-right. Starts behind the composer.
   - **Razzo:** a 13×20 rocket stands right of home; Polpetto walks in from the left, looks
     at it, hops into it (hidden behind it); his tiny face shows in the window; the rocket
     shakes with a small flame, then launches up off-screen with a flickering flame, leaving
     fading smoke puffs. No helmet.
   - **UFO:** Polpetto is at home; a UFO flies in near the top from the left (lights
     alternate), Polpetto looks at it and a «!» shows above him; the UFO parks above him, a
     widening light beam extends down, Polpetto dematerialises feet first with sparkles rising
     up the beam, the beam retracts, the UFO leaves to the top-right.
   - **Mimetismo:** at home, blinks; switches palette faster and faster (8 switches over 2 s),
     then fades to transparent; only the eyes stay (light), blink once and vanish.
   - **Palloncino:** walks in from the left holding a 9×11 balloon on a string tied to a
     tentacle; stops, looks up, the balloon lifts him off the top, swaying, legs dangling.
   - **Elicottero:** a ~30×12 utility helicopter (bubble cabin, door with porthole; style B in
     the mockup) descends from the top with Polpetto's face in the windscreen, lands with
     dust puffs, Polpetto hops out to the left, the helicopter takes off up-right, Polpetto
     looks up, blinks and walks off to the left. Rotor alternates two frames.
   (Rejected by the owner, not in scope: angel-flight zipline, teleport, ink cloud, fishing
   hook, dive, soap bubble.)
3. **One scene per empty session, chosen at random, never the same scene twice in a row**
   (remember the last one app-wide, in memory is enough).
4. **It plays once.** After the scene ends the screen stays empty until the next empty
   session. It never comes back by itself.
5. **The first message (or any transcript item) removes Polpetto at once**, mid-scene.
6. **Reduce Motion:** no scene; Polpetto stands still at home, eyes open.
7. Never meaning by hue alone (owner colour-blind): nothing here carries meaning; fine.
8. The `loading` "Opening the session…" state is unchanged.

## Implementation

*— deepseek-v4-pro (executor), 2026-11-22 — source-verified before coding*

**Load-bearing assumption.** The mockup's `SCENES` array is a self-contained, framework-free
spec in *grid units* (1 px = 6 pt, 390×700 reference, `COMPOSER_Y = 610`, `HOME = {x:28, y:80}`,
`docs/feat/mobile-mascot-scenes-mockup.html:52,128-303`), so the nine scenes port as a pure
projection and the only mobile-specific work is *anchoring* the grid to the real screen.
Proved by the load-bearing check (Execution): `HOME.x = 28` grid = 168 pt =
`(390 − 54) / 2`, i.e. **horizontally centred**, and the sprite's bottom at home is
`480 + 54 = 534` pt, i.e. **76 pt above the composer** — owner decision 1 is the mockup's
own home, not a change to it.

**Preconditions (verified).**

1. `apps/mobile` has no mascot code at all (`rg 'mascot|Polpetto' apps/mobile/src` → no hits),
   and does not depend on `@tentacle/tui` (`apps/mobile/package.json`), which it must not: a
   runtime import reaches `packages/tui/src/theme.ts:23` `import chalk from "chalk"`, and
   `packages/tui/node_modules/chalk` is not in the app's bundle (proved:
   `.tentacle/tmp/mobile-mascot-scenes/probe.ts` → `Cannot find package 'chalk'`).
   ⇒ **copy + parity test**, the plan's smaller diff (the alternative — a new shared package —
   touches the TUI, its build and 15 package manifests for two data tables).
2. `react-native-svg@15.16.0` is already a dependency (`apps/mobile/package.json`) and is
   already the app's pixel/vector idiom (`src/ui/chart/ChartThumbnail.tsx:11-29`) ⇒ **no new
   native dependency**; one `<Path>` per (colour, opacity) group, not ≤120 `<View>`s.
3. Reduce Motion is already a live, app-wide hook: `useAccessibilityFlags().reduceMotion`
   (`src/ui/FloatingActivity.tsx:55-82`), used by this very screen
   (`src/screens/SessionScreen.tsx:947`).
4. The empty state is `ListEmptyComponent` of the transcript FlatList
   (`src/screens/SessionScreen.tsx:1500-1513`) whose parent View (`:1310-1315`) already
   measures the **band** = the region between the header and the composer
   (`setBand({width, height})`, `:948`). That band is the layer's box ⇒ no new page geometry.
5. Today's e2e flows only assert the `transcript-empty` **id**
   (`apps/mobile/e2e/flows/07-prompt.yaml:50`, `26-drawer.yaml:94`, `34-hub-new.yaml:37,46`);
   no flow and no test asserts the text (rg → no hits) ⇒ dropping the words breaks nothing.
6. `apps/mobile/test/motion-literals.test.ts` scans `src/ui`+`src/screens` `.tsx` for literal
   `duration:`/`delay:`/`setInterval(…, n)` only, and `motion.ts` is pinned object-equal
   (`test/motion-literals.test.ts:75-93`) ⇒ neither a rAF idiom nor new constants in the mascot
   module trip it; do **not** add to `motion.ts`.

**Design.**

- **D1 — one pure module** `apps/mobile/src/mascot-scenes.ts` (React-free, AGENTS §7): the
  bitmap + the 9 tone tables **copied** from `packages/tui/src/mascot.ts:18-28` /
  `theme.ts:188-197` verbatim, the mockup's `EXTRA` vehicle palette, `PIXEL_PT = 6`,
  `HOME`, the nine `MASCOT_SCENES` (durations from the mockup: 10.6 / 6.8 / 5.8 / 8.6 / 7.4 /
  6.2 / 5.4 / 6.6 / 9.6 s), `frameAt(scene, tMs, run) → Op[]` in **grid units** (so every
  scene body is the mockup's numbers verbatim — "port it, do not reinvent"), `pixels(ops,
  geom, colors) → Pixel[]` (grid → pt, per-row run merge), `homeAt(geom)`, `stillFrame()`,
  `pickScene`/`nextScene`/`pickMascotPalette`.
- **D2 — anchoring.** `homeAt({width, height})`: `x = (width − 54) / 2`,
  `y = height − 76 − 54`. Every op maps `ptX = homeX + (x − 28)·6`, `ptY = homeY + (y − 80)·6`.
  So the vertical travel is the mockup's *relative* motion, re-hung on the composer: an exit
  that leaves the mockup's 700 pt screen leaves the real one too.
- **D3 — z-order without touching the composer.** One absolutely-positioned layer **inside the
  band**, `overflow: "hidden"`, `pointerEvents="none"`. The band's top edge is the header's
  bottom (parachute/helicopter/UFO enter **from behind the header**) and its bottom edge is the
  composer's top (peek/swim are **clipped by the composer**). This reproduces the mockup's
  draw order (`:345-347`) without relying on the composer bar being opaque — in the app it is
  transparent (`Composer.tsx:218,382`: `bar` has no `backgroundColor`).
  *Drift from the mockup worth naming:* its `o.front` split is dead code — no scene sets
  `front` — so one layer suffices.
- **D4 — the clock is the component's, the frames are the module's.** `ui/MascotScene.tsx`
  holds `t0` + a `requestAnimationFrame` loop, stops it at `scene.durationMs` (renders
  nothing after) and on unmount; it picks the scene and palette **once** (mount) via
  `nextScene(appSceneMemory)` / `pickMascotPalette()`, so a re-render, a band resize or a
  theme flip never restarts a scene (owner 4: plays once).
- **D5 — "never the same scene twice in a row", app-wide, in memory**: `SceneMemory`
  (`{ last, plays }`) with one module-level instance, passed in (testable, like
  `activity-memory.ts`). `pickScene(last, rand)` is the pure rule.
- **D6 — Reduce Motion**: no scene and no loop — `stillFrame()` (Polpetto at home, eyes open),
  read live from `useAccessibilityFlags`, so toggling it mid-scene converges (owner 6).
- **D7 — wiring**: the layer renders only on an empty, open session
  (`state.view.rows.length === 0 && state.status.phase === "open"`), so the first message (or
  any row) unmounts it mid-scene (owner 5); `ListEmptyComponent` keeps the `transcript-empty`
  id and the `Opening the session…` `EmptyState` (`:1509-1511`), and drops the
  "Nothing here yet / Say something below." pair (owner 1).
- **D8 — Mimetismo's "eyes only (light)"** needs a colour that reads on *both* appearances
  (the mockup hard-codes `#e8eaed`, invisible on white): the module takes `eyeFade` as an
  input and the component passes `palette.label`. Nothing carries meaning by hue (owner 7).

**Files (dependency order).**

1. `apps/mobile/src/mascot-scenes.ts` — new, pure (D1, D2, D5).
2. `apps/mobile/src/ui/MascotScene.tsx` — new, renderer + clock (D3, D4, D6).
3. `apps/mobile/src/screens/SessionScreen.tsx` — `:1310-1345` insert the layer; `:1500-1513`
   empty state (D7).
4. `apps/mobile/test/mascot-scenes.test.ts`, `mascot-parity.test.ts`, `mascot-wiring.test.ts`.
5. `changelog.d/mobile-mascot-scenes.added.md`.

**Failure modes.**

| Mode | Convergence |
|---|---|
| band not measured yet (`height: 0`) | render nothing (no divide-by-zero, no flash at the top) |
| unmount mid-scene (row arrives, back nav) | `cancelAnimationFrame` in the effect cleanup; no leak |
| Reduce Motion toggled mid-scene | the loop stops, `stillFrame` shows; toggling back does not replay |
| app backgrounded (rAF pauses, `t` jumps) | `t ≥ durationMs` ⇒ finished, nothing drawn; never restarts |
| tiny band (landscape / split) | home is clamped to `y ≥ 0`; the sprite may overhang and is clipped |
| scene ends | nothing is drawn; the screen stays empty until the next empty session (owner 4) |

**Tests (red before green, AGENTS §9).**

- `mascot-scenes.test.ts`: `pickScene` over 10k seeds (never the last, covers all 9) +
  `nextScene` memory; `pickMascotPalette` covers all 9 and clamps `rand()===1`;
  **per scene** `frameAt` at `t=0`, mid and `t = durationMs − 1` — arrivals at home, exits
  off-screen, and `frameAt(scene, durationMs) === []`; `stillFrame` at home with eyes open;
  `homeAt` (centred, 76 pt above the band bottom); `pixels` (run merge, alpha, colour
  resolution, camo's per-op palette + `eyeFade`).
- `mascot-parity.test.ts`: bitmap + the 9 tone tables **parsed out of** `mascot.ts`/`theme.ts`
  source text (a runtime import is impossible: `chalk`) and compared to the copies.
- `mascot-wiring.test.ts`: source pins — layer `testID="mascot"`, `pointerEvents="none"`,
  `overflow: "hidden"`, `react-native-svg` only, liveness condition = empty rows + open phase,
  the "Nothing here yet"/"Say something below." words gone, the `transcript-empty` id kept,
  no `@tentacle/tui` dependency.

**Validation.** `bunx biome check` on the touched files; the three test files; then the
orchestrator's `bun run check`. Screenshots need a Release build of the Expo app on a
simulator — attempted in Execution, reported honestly either way.

**Notes/debt.** Internal UI, no wire and no persistence change ⇒ no `protocol.d/` note.
The nine scenes are the mockup's numbers, not a redesign: a divergence is a bug, not taste.

Hints, as written by the orchestrator (kept for traceability):
- **Pure module** (AGENTS §7 "logic lives in pure modules"): `apps/mobile/src/mascot-scenes.ts`
  — sprites, scenes, `frameAt(scene, tMs, run) → DrawOp[]` (grid units), `pickScene(last, rand)`
  (never repeats), durations. Unit-tested in `apps/mobile/test/`. The component only draws ops.
- **Bitmap + palettes:** the mobile app is React 19 and must not import `@tentacle/tui`. Either
  move `MASCOT_BITMAP` + the 9 tones to a React-free shared place both import, or copy them
  into the mobile module **with a parity test** that fails if they drift from
  `packages/tui/src/mascot.ts` / `theme.ts`. Pick the smaller diff; say which in Implementation.
- **Rendering:** a small absolutely-positioned layer over the transcript area, pixels as Views
  (≤ ~120 rects) or one SVG / Skia canvas if already a dependency — check `apps/mobile/package.json`
  first, add no new native dependency. Drive time with `requestAnimationFrame` or Reanimated if
  already used; stop the loop when the scene ends or on unmount.
- **Behind the composer:** peek and swim must be clipped by the composer (z-order).
- Header stays above everything (parachute enters from behind the header).
- `testID="mascot"` on the layer; the empty-state e2e that looks for `transcript-empty` must
  still pass (update it if it asserted the old text).

## Tests (minimum)

- `pickScene` never returns the previous scene (property over many seeds); covers all 9.
- `frameAt` at t=0 / mid / end for each scene: positions match the mockup's numbers (home at
  the end of arrivals; off-screen at the end of exits); end returns no ops.
- Reduce Motion path returns the static home frame.
- Parity test of bitmap + palettes vs the TUI source.
- Red before green (AGENTS §9).

## Validation (mandatory, report in Execution)

Simulator screenshots in light AND dark theme, mid-scene for each of the 9 scenes, plus the
Reduce Motion still and the state right after sending the first message (Polpetto gone).
Save them under `docs/feat/mobile-mascot-scenes/`. End your report with
`SCREENSHOTS: <paths>` and `READY` or `NOT READY: <why>`.

## Execution

*— deepseek-v4-pro (executor), 2026-11-22*

**Load-bearing check, re-run first (it held).** The mockup's home is the owner's home:
`rg` on the mockup gives `W=390, U=6, HOME={x:28,y:80}, COMPOSER_Y=610`; `(390−54)/2 = 168 = 28·6`,
and the sprite's bottom at home is `480+54 = 534`, i.e. `610−534 = 76` pt above the composer.
So "centred horizontally, just above the composer" (owner decision 1) is the mockup's own
home, and `HOME_INSET_PT = 76` is its derivation, not a new taste. Recorded, with the rest of
the preconditions, in `.tentacle/tmp/mobile-mascot-scenes/repro.txt` (capability absent:
`rg 'mascot|Polpetto' apps/mobile/src` → no hits).

**As built, in the Implementation's order.**

1. `apps/mobile/src/mascot-scenes.ts` (new, ~1030 lines): bitmap + 9 tone tables copied from
   the TUI, `EXTRA_TONES`, `PIXEL_PT = 6`, `HOME_GRID`, `HOME_INSET_PT`, `homeAt`, `body()`,
   the nine sprites and the nine scenes (`frameAt` in grid units), `stillFrame`, `showsScene`,
   `pixels` (grid → pt, row-run + vertical merge), `colorsFor`, `pickMascotPalette`,
   `pickScene`, `nextScene`, `sceneMemory`, `sceneByKey`, `MASCOT_SCENES`. Imports NOTHING.
2. `apps/mobile/src/ui/MascotScene.tsx` (new, 148 lines): the clock
   (`requestAnimationFrame`, origin in a `useRef`, stops at `durationMs`, cancelled on
   unmount), the once-per-mount pick, `Svg`/`Rect` drawing, `testID="mascot"`,
   `pointerEvents="none"`, `overflow: "hidden"`, absolutely positioned in the band.
3. `apps/mobile/src/screens/SessionScreen.tsx`: the layer after the transcript
   (`:1517-1524`), `ListEmptyComponent` reduced to the `opening` `EmptyState` (`:1506-1513`),
   `showsScene` imported (`:124`).
4. Tests: `apps/mobile/test/mascot-scenes.test.ts` (53), `mascot-parity.test.ts` (7),
   `mascot-wiring.test.ts` (10) — 71 total.
5. `changelog.d/mobile-mascot-scenes.added.md`.

**Drift from the Implementation (and why).**

- **Two bugs found by my own tests, fixed in the module, not the test.** (a) Mimetismo's
  palette-switch loop (`while (i < times.length - 1 && t >= times[i+1])`) — my first version
  mutated `i` then read a stale `next`, so it never advanced: the eight switches collapsed to
  two. (b) `mergeDown` dropped `h` on each column's first entry, so every rect came out
  6 pt tall (the vertical merge was a no-op) — caught by the ≤120-rect promise. Both were
  red-then-green.
- **The vertical merge was added, not planned.** The UFO's 60-row beam alone exceeded the
  plan's "≤ ~120 rects" (measured worst frame: 132). Merging vertically contiguous
  same-coloured rects brought the worst frame to 82 (measured, `heli`), so the plan's number
  now holds with margin rather than being relaxed.
- **The layer sits AFTER the transcript, not before.** The plan said "over the transcript
  area"; placing it earlier in the JSX would paint it *under* the (transparent) empty list.
  `mascot-wiring.test.ts` now pins the order, since order is the z-order here.
- **`showsScene` was extracted to the pure module.** I first wrote the condition inline in the
  JSX; AGENTS §7 wants the branching testable, and the inline version survived a mutation
  uncaught — which is exactly why it moved.
- **`sceneByKey` lives in the module, not the component** (one lookup, one place).

**Red before green (AGENTS §9).** The wiring test's assertions and the scenes test were red
first (12 failures on the first run, all from the two real bugs above plus my own wrong
expectations). Mutations, each verified to fail the named test and then reverted:

| Mutation | Caught by |
|---|---|
| old "Nothing here yet / Say something below." restored | wiring › words are gone |
| `pointerEvents="auto"` on the layer | wiring › touch-transparent box |
| `showsScene` ignores `rowCount` | scenes › "one row is enough to remove it" (**initially NOT caught — test added**) |
| `frameAt` never ends | scenes › end is exclusive (2 tests) |
| `pickScene` may return `last` | scenes › 10k seeds; every-excluded (2 tests) |
| one tone hex changed (`#7B3FC0`→`#7B3FC1`) | parity › every tone equals the TUI's |
| `stillFrame` eyes closed | scenes › Reduce Motion still frame |

**Not verified here (stated plainly).** The mandatory **simulator screenshots** are NOT
produced: this worktree has no `node_modules` and no generated `apps/mobile/ios` project, so
there is neither an Expo/`xcrun` build nor an installable `so.tentacle.app`; a Release build
is a minutes-long, environment-dependent step the orchestrator's gate owns. Also
environmental: `bunx tsc -p apps/mobile` cannot run here (2769 `TS1287` errors across
*pre-existing* files — `expo/tsconfig.base` and the RN types are missing), and the RN-mocked
render tests (`notice-row`, `chart-thumbnail-render`) fail on `Cannot find module
'@tentacle/core'` for the same reason. What I did run instead: the pure module typechecks
under `tsc --strict --noUncheckedIndexedAccess` (clean, after fixing two real narrowing bugs
found by it), `bunx biome check` is clean on all six files, and the three task files (71
tests) plus the guards they could trip (`motion-literals`, `node-builtins-guard`,
`bundle-node-free`) are green. **To verify the visual side:** build for a simulator and run a
flow that asserts `testID="mascot"`, once with Reduce Motion on and once with it off.

**Unplanned but noticed, left alone:** the mockup's `o.front` split is dead code (no scene
sets it), so one layer covers both z-orders — noted in Implementation rather than emulated.

### Fix round 1

*— claude-opus-5-5 (executor of the fix round), 2026-11-22*

**Finding 1 (MEDIUM, run plumbing) — FIXED.** `pixels` is not involved; the defect was that
`MascotScene.tsx:108` hard-coded `run = 0`, so `frameAt` never saw a handedness. The decision
moved into the pure module, where it is testable (AGENTS §7): `MascotDraw` +
`drawOnce(memory, rand)` (`mascot-scenes.ts:1164-1176`) return `{scene, palette, run}`, `run`
being `memory.plays` BEFORE the play is recorded — so consecutive mounts are 0, 1, 2. The
component now keeps one `MascotDraw` in state (was `MascotPick`, without a run) and passes
`drawn.run` to `frameAt` (`MascotScene.tsx:58,99`).

**Finding 2 (MEDIUM, paint order) — FIXED.** `mergeDown`'s cross-op grouping was the bug: it
keyed rects by `x|w|color|alpha` across the WHOLE frame and emitted by first-seen key, so a
later op stopped painting over an earlier one. Now `pixels` merges **per op** only
(`mergeDown` on one op's rects) and appends, extending the immediately-preceding rect when it
is the same shape/colour/alpha and STRICTLY contiguous below it (`appendBlock`,
`mascot-scenes.ts:1027-1058`). Nothing is emitted between those two, so the merge cannot cross
a paint. Strict (`rect.y === last.y + last.h`) rather than an overlap test, because the rocket's
smoke is THREE identical `alpha: 0.7` puffs on one cell: folding them kept a third of the blend
(my first attempt used `>=`/`<=` and the reviewer's `order.ts` caught it at rocket 4.8 s). The
per-op pass alone lost the UFO beam's collapse (60 one-row `rect` ops → 121 rects at 2950 ms,
over the 120 bound); the tail merge brings the measured worst frame back to the helicopter at
**82** (the doc's own number), verified by the existing ≤120 test. Both reviewer repros,
re-run: `order.ts` and `detail.ts` in `.tentacle/tmp/mobile-mascot-scenes/` → every scene 0
wrong frames (was heli 3 from 3.0 s, rocket 2 from 4.8 s).

**Tests added (red before green, AGENTS §9).** `mascot-scenes.test.ts`: *a later op still
paints OVER an earlier one* (all nine scenes, every 100 ms, cell-by-cell `paint()` of the
merged output vs. one op at a time; `paint()` STACKS translucent rects, so a dropped blend is
visible), *the op that overlaps an earlier one keeps its own row* (heli 3.0 s, named cells),
*a translucent op stacked on itself stays stacked* (rocket 4.8 s: the three `<#8d969e@0.7`
puffs), and the `drawOnce` block (runs 0/1/2, Paracadute exits right then left, no repeat +
palette in range). `mascot-wiring.test.ts`: *the drawn run reaches the frame*
(`drawOnce(memory)`, `frameAt(scene, elapsedMs, drawn.run,`, and no `frameAt(…, 0, …)`).

**Mutations (§9 non-vacuity), each reverted with the tree clean.**

| Mutation (temporary) | Red on |
|---|---|
| `pixels`: `out.push(...flat)` per op + `mergeDown(out)` at the end = the OLD cross-op merge | scenes › *a later op still paints OVER an earlier one* (19.48 ms), › *the op that overlaps an earlier one keeps its own row* (`#A274DE` expected, `#B387EA` got — the reviewer's exact cell) AND › *a translucent op stacked on itself stays stacked* (57 pass / 3 fail) |
| `appendBlock`: overlap test (`rect.y >= last.y && rect.y <= last.y + last.h`) instead of strict contiguity | scenes › *a later op still paints OVER an earlier one* (20.54 ms) AND › *…stays stacked* (58 pass / 2 fail) |
| `MascotScene.tsx`: `frameAt(scene, elapsedMs, 0, …)` = the OLD literal run | wiring › *the drawn run reaches the frame* (10 pass / 1 fail) |
| `drawOnce`: `const run = 0` | scenes › *consecutive mounts are run 0, 1, 2* AND › *two plays walk off opposite sides* (57 pass / 2 fail) |

**Files:** `apps/mobile/src/mascot-scenes.ts` (+77/−9), `apps/mobile/src/ui/MascotScene.tsx`
(+7/−17), `apps/mobile/test/mascot-scenes.test.ts` (+114/−0), `apps/mobile/test/mascot-wiring.test.ts`
(+9/−1). No production code touched outside the two findings; `pixels`' public shape and the
`Op`/`Pixel` types are unchanged.

**Not fixed (deliberately, out of scope of the round):** the mandatory simulator screenshots —
same environment limit the first Execution recorded (no `node_modules`/iOS project in the
worktree). Unchanged by this round: it is a build/run artefact, not a code property.

**Gate (run by the orchestrator's script, not here).** Local, narrow only: the three mascot
files → 78 pass / 0 fail; the guards (`motion-literals`, `node-builtins-guard`,
`bundle-node-free`) → 13 pass / 0 fail; `bunx biome check` clean on the four changed files; the
pure module under `tsc --strict --noUncheckedIndexedAccess` → clean.

## Review
*— claude-opus-5-5, 2026-11-22 (fresh context; different model family from the executor)*

**Verdict: REQUEST-CHANGES** (2 MEDIUM, no HIGH).

1. **MEDIUM — Paracadute never alternates.** `apps/mobile/src/ui/MascotScene.tsx:108` always
   calls `frameAt(scene, elapsedMs, 0, …)`, so `run` is 0 every time and Polpetto always walks
   off the same side, against owner decision 2 ("alternating left/right per run"). The module
   supports it (`mascot-scenes.ts:395`, and a mutation there is caught by `mascot-scenes.test.ts`),
   but at the integration point that test proves nothing. Camo's palette order (`:729`) is frozen
   too. Fix: take `run` from the memory (e.g. `memory.plays` at pick time) and pin the wiring.
2. **MEDIUM — `mergeDown` breaks paint order.** `mascot-scenes.ts:1011-1063` groups rects by
   `x|w|color|alpha` and emits them in first-seen key order, so a later op no longer paints over
   an earlier one. Repro (`.tentacle/tmp/mobile-mascot-scenes/order.ts`, `detail.ts`: painter over
   `pixels(ops)` vs. over each `pixels([op])` in op order): heli 3 frames wrong from t=3.0 s
   (6 cells, e.g. `234,482` expected `#A274DE` got `#B387EA` — Polpetto's face in the windscreen),
   rocket 2 frames from t=4.8 s (alpha stacking of smoke). No test checks that occlusion survives
   the merge. Fix: merge only vertically adjacent rects with nothing drawn between them in op
   order (or merge per op), plus a test of that property across all scenes.

**Gate:** the 4 touched/guard files: 76 pass / 0 fail; `bun run lint` clean; `bun run typecheck`
clean. (Full `bun test` not re-run here.)
**Mutation:** Paracadute `dir` forced to 1 → 2 fails in `mascot-scenes.test.ts`; reverted, tree clean.
**Attacks tried:** layer box = the measured band (`SessionScreen.tsx:1312-1316`, it is the child of
that View; holds) · paint order under the merge (finding 2) · run plumbing (finding 1) ·
unmount / Reduce Motion / finished scene in the rAF effect (holds; `origin` survives a toggle, so
toggling back resumes in wall time and never replays).
**Executor:** honest about the missing screenshots and the environment; its own mutation table
checks out. Screenshots (mandatory Validation) are still absent → not READY anyway.

### Round 2

*— claude-opus-5-5, 2026-11-22 (fresh context; reviewed 98ba09f3 + f9fe17fe)*

**Verdict: REQUEST-CHANGES** (both round-1 findings fixed; one MEDIUM regression introduced by the fix).

- **R1-1 (run) — FIXED.** `drawOnce` hands out `run = memory.plays` and the layer passes `drawn.run`
  to `frameAt`. Mutation `run = 0` in `drawOnce` → 2 fails (`drawOnce › consecutive mounts…`,
  `› two plays walk off opposite sides`); a wiring pin forbids a literal `0`. Reverted.
- **R1-2 (paint order) — FIXED.** Merging is per op, plus a strict-contiguity `appendBlock`. The
  round-1 repro (`order.ts`) now gives 0 wrong frames in all 9 scenes. Mutation `===` → `<=` in
  `appendBlock` → 2 fails (`› a later op still paints OVER…`, `› translucent op stacked…`). Reverted,
  tree clean.
- **NEW MEDIUM — duplicate React keys.** `apps/mobile/src/ui/MascotScene.tsx` (`<Rect key=…>`) keys
  by `x:y:w:h:color`. Stacked identical translucent ops are now (on purpose) kept as separate rects,
  so they share a key. Repro `.tentacle/tmp/mobile-mascot-scenes/keys.ts`: rocket 10 sampled
  frames from t=3.65 s, heli 2 from t=3.3 s. React warns on every such frame (LogBox in dev), and
  a duplicate-keyed child may be dropped or reused, losing the blend this round set out to keep.
  Fix: key by index (the list is rebuilt every frame) or add the index to the key, plus a pin.
- **Gate:** the 4 mascot/guard files: 83 pass / 0 fail; `bun run lint` clean; `bun run typecheck` OK.
  Worst frame is now 82 rects (heli), so the ≤120 budget holds.

### Fix round 2

*— claude-opus-5-5 (executor of fix round 2), 2026-11-22*

**Scope.** Review round 2 confirmed R1-1 and R1-2 FIXED and raised exactly one new finding
(NEW MEDIUM, duplicate React keys, no HIGHs). Nothing else was touched.

**NEW MEDIUM (duplicate React keys) — FIXED.** Reproduced first: `.tentacle/tmp/mobile-mascot-scenes/keys2.ts`
replays every scene × 5 palettes × runs 0–2 at 10 ms through `pixels` and keys each rect the old
way (`${x}:${y}:${w}:${h}:${color}`) → **135 frames with duplicate keys**, first at rocket (bosco/run0)
t=4800 ms, `270:558:18:12:#8d969e ×3` — the three stacked `alpha: 0.7` puffs that fix round 1
deliberately keeps separate. Root cause: the key encoded the rect's SHAPE, and this round's
correct behaviour is precisely that two rects may share a shape.

The fix keeps the decision out of the component (AGENTS §7): `rectKey(rect, index)`
(`mascot-scenes.ts:931-941`) returns `` `${index}:${x}:${y}:${w}:${h}:${color}` `` — the index,
which the frame's list already has and rebuilds every tick, plus the shape, so a key also changes
when a rect moves (no stale-child reuse). `MascotScene.tsx:113-116` becomes
`rects.map((rect, index) => … key={rectKey(rect, index)}` and the component no longer builds a key
at all. Argument order is `(rect, index)` on purpose so the call site is the idiomatic
`rects.map(rectKey)` — the first attempt used `(index, rect)` and `Array.map` silently fed the
index as the rect.

**Tests added (red before green, AGENTS §9).** `mascot-scenes.test.ts`: *every rect in a frame has
its own key* (all 9 scenes × 9 palettes × runs 0–2 × every 10 ms — the whole 100,500-frame space,
not a sample) and *the rocket's three stacked puffs get three keys* (the named case: three rects
identical in x/y/w/h/color/alpha, three distinct keys). `mascot-wiring.test.ts`: *every rect gets
the pure module's key, and none is made up here* — pins the call shape, the import, and forbids a
component-built template literal (`not.toMatch(/key=\{`/)`).

**Mutations (§9 non-vacuity), each reverted with the tree clean.**

| Mutation (temporary) | Red on |
|---|---|
| `rectKey` → shape-only key (the OLD behaviour) | scenes › *every rect in a frame has its own key* (`rocket/soft/run0 at 3650 ms: 1 duplicate key(s), e.g. 252:504:6:6:#7B3FC0`) AND › *the rocket's three stacked puffs get three keys* (61 pass / 2 fail) — the assertion, not a compile error |
| `MascotScene.tsx`: back to an inline `key={`${…}`}` template | wiring › *every rect gets the pure module's key…* (73 pass / 1 fail) |
| `MascotScene.tsx`: keep the seam but drop the index at the call site (`map((rect) =>`, `rectKey(rect, 0)`) | wiring › *every rect gets the pure module's key…* (11 pass / 1 fail) |

**Evidence after the fix.** `.tentacle/tmp/mobile-mascot-scenes/keys3.ts` (the same 100,500-frame
sweep through the shipped `rectKey`): **0 frames with duplicate keys** (was 135).

**Files:** `apps/mobile/src/mascot-scenes.ts` (+12/−0), `apps/mobile/src/ui/MascotScene.tsx` (+3/−2),
`apps/mobile/test/mascot-scenes.test.ts` (+44/−0), `apps/mobile/test/mascot-wiring.test.ts` (+10/−0).
`Pixel` and `pixels`' public shape are unchanged; `rectKey` is additive.

**Gate (run by the orchestrator's script, not here).** Local, narrow only: the mascot + guard files
(5) → 87 pass / 0 fail; re-run after the formatting fix, the two mascot files → 74 pass / 0 fail;
`bunx biome check` clean on the four changed files; the pure module under
`tsc --strict --noUncheckedIndexedAccess` → 0 errors in the changed file.

**Not fixed (deliberately):** the mandatory simulator screenshots, unchanged from both prior
rounds — no `node_modules`/iOS project in this worktree. It is a build/run artefact, not a code
property.

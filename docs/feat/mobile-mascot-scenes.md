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

*(executor: write it, source-verified per AGENTS §8, before coding)*

Hints, verify them:
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

## Review

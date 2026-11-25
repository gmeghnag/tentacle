# fix/mobile-open-long-session-3 — a ~400-message session opens at a middle turn and visibly scrolls to the end (round 3)

> **Status:** execution
> **Branch:** `fix/mobile-open-long-session-3`
> **Size:** S · **Blast:** contained (mobile transcript list, `follow.ts` + one FlatList prop) · **Suited:** weaker model executes, standard Review
> **Changelog:** `changelog.d/mobile-open-long-session-3.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

Round 2 (`mobile-open-long-session-2.md`) fixed the 114-row case. Post-merge QA (`.tentacle/tmp/qa-2411b/REPORT.md` §1b) found a ~400-message session opening blank ~0.6 s, then showing turn ~123 and scrolling down to the end over ~3.6 s: the contract "the end shows at once, no visible travel, at any length" is not met.

**Repro (main, sim 0B43D716, alpha filled to 400 msgs, last «turn 200 alpha», Maestro open + `simctl recordVideo`, frames at 10 fps):** `.tentacle/tmp/mobile-open-long-session-3/red-sheet-400.png` — blank, then the list at turn 82, then turns 82→200 sliding by over many frames. Reproduced on the first run.

**Characterisation.**
- Trigger: opening from the list. Magnitude: proportional to length (a window of rows not rendered yet), not a fixed px, not the composer inset.
- The transcript is a plain `FlatList` (`SessionScreen.tsx`, no `getItemLayout`, default `maxToRenderPerBatch` = 10). Scrolling to the end of a hidden list renders ~10 more rows per batch, each batch moves the content height, and the landing takes one measurement per move.
- `LANDING_ROUNDS` = 12 (`follow.ts`): ~120 rows. A long opening hits the bound (round 2's `capped` branch, then the quiet timer reveals) while the window is still filling; the rest then arrives with the list SHOWN and is followed by `contentGrew`, ANIMATED. That is the travel. This is inherited from round 1's bound (`df358162`), not from round 2: round 2 only changed the tick of the reveal (inferred from the code; df358162 was not run).
- Blank growth (QA §1a, 3.5 s on 114 rows): **not reproduced**. On this build, unloaded by anything but Maestro + video, the blank is ~0.5 s on 400 rows (5 frames at 10 fps before the first row). Not measured without any driver; the 3.5 s was most likely driver + video load.

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing assumption.** The growth steps are FlatList render batches, so bigger batches while hidden finish the window within `LANDING_ROUNDS`. Falsifiable: 400 rows open with no intermediate frame (done, see Execution).

**Design.** `follow.ts` `landingBatch(settling)` (pure) returns `LANDING_BATCH` (240) while the list is hidden, `undefined` (the FlatList default) once shown. `SessionScreen.tsx` passes it as `maxToRenderPerBatch`. No history-loading change, no bound change, nothing rendered that the window would not render anyway (the default `windowSize` 21 bounds it; 240 rows ≥ the whole window of the shortest rows).

**Files.** `apps/mobile/src/follow.ts`, `apps/mobile/src/screens/SessionScreen.tsx` (1 prop), `apps/mobile/test/follow.test.ts`, `changelog.d/mobile-open-long-session-3.fixed.md`.

**Failure modes.** Very long (1000+) sessions: the window, not the count, bounds rendering; if the growth still outlasts 12 rounds the old capped/tail path applies (unchanged, travel possible again — not measured beyond 400). Growing while opening: unchanged path. Short sessions: never above 10 rows per batch anyway. Re-open/re-attach: `settling` false → default batching. Rotation: after reveal, default. Cost: one hidden render pass of up to ~240 rows on the JS thread during the (already hidden) landing.

**Tests.** `follow.test.ts` "landingBatch": hidden → `LANDING_BATCH`, shown/quiet → `undefined`; the batch covers a whole window.

## Execution

*— claude-sonnet-5-5, 2026-11-25*

**Red → green.** Test red on the unmodified code (the new exports did not exist → the file failed to load, 0 pass); with the fix 71 pass / 0 fail. **Mutation:** `landingBatch` returning `undefined` always → 1 fail (70 pass); restored. Lint on the changed files clean.

**Simulator (iPhone 17 Pro Max, release build of this tree), `.tentacle/tmp/mobile-open-long-session-3/`:**
- before: `red-sheet-400.png` (blank → turn 82 → travel to 200).
- after: `green-sheet-400.png` (10 fps, last 27 frames: blank ~0.5 s, then turns 194–200 directly, no intermediate position), `green-long400.png` (400 msgs at rest), `green-alpha114.png` (114 msgs: turn 57 + answer above the composer), `green-charlie.png` (short session right).

**Unverified:** sessions ≫ 400 rows; blank length with no Maestro/video running; behaviour on a physical device (slower JS may need more than one batch).

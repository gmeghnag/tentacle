# fix/mobile-open-long-session — a long session opens ~1.3 turns above its real end

> **Status:** execution
> **Branch:** `fix/mobile-open-long-session`
> **Size:** S · **Blast:** contained (mobile transcript list) · **Suited:** weaker model executes, standard Review
> **Changelog:** `changelog.d/mobile-open-long-session.fixed.md`

## Context

Pre-build simulator QA (`.tentacle/tmp/qa-2411/REPORT.md` §1, main `7561f84d`): opening a LONG session (alpha, 56 turns ≈ 113 rows) from the session list settled ~570 px above the real end (turn 55 cut by the composer, turn 56 + answer below), 2/2, stable >10 s, app idle; a short session (charlie) opened correctly. The contract from `docs/fix/mobile-open-at-bottom.md` / `mobile-open-at-end.md` still holds: the first visible frame is already the end, no visible scroll travel.

**Not reproduced on the simulator after two attempts** (see Execution). The pre-build QA re-run is the end-to-end check.

*— claude-sonnet-5-5, 2026-11-24*

## Implementation

**Load-bearing assumption.** A landing's last silent scroll reaches the true end. It does not have to: `SessionScreen.tsx` `perform` issues `scrollToOffset(endOffset(size.current))`, and `size` is the last measurement, taken before the tail's cells are laid out. `docs/fix/mobile-qa-1117.md` bug 5 documents exactly this class (a scroll against an end the native view had before the change was mounted lands short while `following` stays true), and its cure is the settle check `armSettle` → `settleStep` (`follow.ts:122`). But `armSettle` is armed only from the NON-landing path of `onContentSize` / `onListLayout` (`SessionScreen.tsx` `if (land()) return;` precedes it). Once an opening landing is over (a repeated height, the bound, or the quiet-timer hand-back) no later size change exists to arm it, so a landing that came to rest short stays short — stable, idle, `following: true`: the QA's symptom.

**Design.** Keep the decision pure (AGENTS §7): `follow.ts` gains `landingEnded(before, after)` (pending → not pending) and `settleStep(state, m, animated = true)` gets an `animated` flag. The screen arms ONE settle check when a landing ends, from both of its exits (the measurement in `land()` and the reveal timer in `armReveal`), performed with `animated: false` — the list is visible by then, and a visible scroll is the complaint. A reader scrolled up is never moved (`settleStep` returns null when not following); an already-at-end list is not moved (slack 2 pt).

**Files.** `apps/mobile/src/follow.ts`, `apps/mobile/src/screens/SessionScreen.tsx`, tests `apps/mobile/test/follow.test.ts`, `apps/mobile/test/session-screen-follow-wiring.test.ts`.

**Failure modes.** Very long sessions: the check runs after `SETTLE_MS` (450 ms) of quiet and issues one silent scroll; a landing that keeps growing re-arms it (any later size change re-arms the ordinary animated settle, which replaces the pending timer). Session that grows while opening: the ordinary follow takes over; a not-following reader is untouched. Short sessions: content ≤ viewport → null. Re-open / re-attach: the same `landingEnded` edge, silent. Rotation: `viewportChanged` path is unchanged. The unit test pins the decision; whether this is the QA's mechanism is a hypothesis, not shown.

**Tests.** `landingEnded` edge cases; `settleStep` silent step for a list parked ~570 pt short; no move when at end / not following; default stays animated; wiring pinned as source (both exits arm it).

*— claude-sonnet-5-5, 2026-11-24*

## Execution

**Reproduction attempts (simulator 0B43D716, app = main-ro cache built from `7561f84d`, `run.ts --only 02-session-list --hold`):**
1. Alpha filled via `laptop-prompt` with 1.2 s pauses to ~70 short turns (140 rows), then +56 QA-style 4-line turns (126 turns total); cold opens from the list ×4, one under CPU stress (2×ncpu busy loops): all settle with the last turn + answer above the composer.
2. QA's exact conditions: fresh hold, 56 QA-style prompts fired WITHOUT pause (busy turns dropped prompts, uneven history), opened from the list right after the fill: correct (`.tentacle/tmp/mobile-open-long-session/qa1.png`).
Not reproduced on the simulator after two attempts; the pre-build QA re-run is the end-to-end check.

**Earlier-planned path (exhausted `LANDING_ROUNDS` revealing with nothing pending) is already fixed in this tree** (`follow.ts` bound branch + test "the bound ending a hidden opening landing enters the silent tail"); not repeated.

**As built:** `follow.ts` `landingEnded` + `settleStep(..., animated)`; `SessionScreen.tsx` `armLandedSettle` ref armed from `land()` and the reveal timer; `armSettle(silent)`.

**Red → green:** on the original `follow.ts` the new tests fail to load (`Export named 'landingEnded' not found`) — red by missing API, a weak red; the behavioural assertion (`settleStep(..., false)` → `animated:false`) is what the code adds. After: `follow.test.ts` + `session-screen-follow-wiring.test.ts` 82 pass / 0 fail; tsc -p apps/mobile clean; biome clean on the 4 files.
**Mutation:** `landingEnded` forced to `false` → 1 fail (the edge test); restored.

**Unverified:** that a landing resting short is the QA's real mechanism (not reproduced); the simulator before/after below shows only that nothing regressed.

*— claude-sonnet-5-5, 2026-11-24*

**Simulator, patched tree (`run.ts --hold`, built from this worktree):** alpha (~60 short rows + 100 QA-style 4-line turns) opens from the list with turn 200 + its answer fully above the composer (`.tentacle/tmp/mobile-open-long-session/after-alpha.png`); charlie (short) still right (`after-charlie.png`). "Before" = `qa1.png` and the earlier `before.png`/`r2.png`/`r3.png`/`load.png` (also correct: the bug did not reproduce, so before/after is a no-regression check, not a fix proof).

*— claude-sonnet-5-5, 2026-11-24*

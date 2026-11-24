# fix/mobile-open-long-session — a long session opens ~1.3 turns above its real end

> **Status:** execution (fix round 1 applied)
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

### Fix round 1

Review round 1 (HIGH ×2, MEDIUM ×1, LOW, NIT):
- **Finding 3 (MEDIUM, contract) + 2 (HIGH, no behavioural test):** the offset check now happens INSIDE the landing, while the list is still hidden. `follow.ts`: `restsShort(m, offset)`; `landingStep` and `landingReveal` take an optional `offset` (null = unknown, behaviour unchanged). A hidden opening landing that came to rest short (>2 pt) does one more silent scroll and stays hidden (the screen re-arms the quiet timer), bounded by `LANDING_ROUNDS`; the revealed list is then at its end. `SessionScreen.tsx` passes `offset.current` to both (the ref moved above `armReveal`). The post-landing silent settle (`armLandedSettle`) stays as a backup for a landing that ends short after the reveal.
- **Red → green:** the 3 behavioural tests (`restsShort`; "a repeated height does not reveal a list that rests short"; "the quiet timer re-scrolls silently and stays hidden while short") FAIL on the pre-round logic (3 fail / 62 pass) and pass after; bound + reader-scrolled-up + unknown-offset tests pin the edges. `follow.test.ts` + wiring: 87 pass / 0 fail; tsc -p apps/mobile clean; biome clean. Wiring regexes updated for the new `offset.current` argument.
- **Mutation:** `restsShort` → false: 3 fail; reveal branch removed: 1 fail; bound removed: 1 fail; `landingStep` ignoring `restsShort`: 1 fail. Restored; 65 pass.
- **Finding 4 (LOW):** the QA gap is 2 turns ≈ 323 pt (968 px at 3×), not 570 pt; fixtures/comments now use 5447 → 5770.
- **Finding 1 (HIGH, mechanism unproven):** NOT resolvable without a repro: mechanisms (b) `following:false` at rest and (c) native metrics already "at end" are not covered and remain open. This fix covers only (a) (landing rests short with following true). The changelog line no longer claims a fix of the QA case. Owner decision stands: the pre-build QA re-run of the 56-turn alpha is the end-to-end check, and a dev log of `{landing, following, offset, size}` at the settle timer there would tell (a)/(b)/(c) apart.
- **Finding 5 (NIT):** wiring window stays 900; status line updated.
- **Simulator (patched tree, lock held and released):** alpha (~100 QA-style turns) opens with turn 190 + answer fully above the composer (`.tentacle/tmp/mobile-open-long-session/fix1-alpha.png`); charlie right (`fix2-charlie.png`). Still a no-regression check; the bug never reproduced.

*— claude-sonnet-5-5, 2026-11-24*

## Review (Round 1)

**Verdict: REQUEST-CHANGES.** The code is safe (silent, following-only, one scroll, logic in `follow.ts`), the gate is green and the tests are non-vacuous. But the bug is not reproduced, and the proposed mechanism has not been shown to produce the QA state. No test exercises the behaviour the fix exists for. Under AGENTS §0/§1/§9, that decision belongs to the owner. It should not be merged on a changelog line that says "A long session opens at its real end".

**Findings**
1. **HIGH: the root cause does not account for the measured gap; it is an untested hypothesis.** The doc admits it ("whether this is the QA's mechanism is a hypothesis, not shown"). The QA state was settled, stable for more than 10 s and idle. That fits at least three mechanisms: (a) a landing that ended short with `following: true` and no later size change, which this fix covers; (b) `following: false` at rest, where `settleStep` returns null and nothing changes (`landingReveal` `follow.ts:413` also returns `landingDone` with no scroll when `!following`); (c) native metrics that already say "at end", e.g. a stale content height or padding, where `settleStep` sees `offset == end` and returns null. Nothing in the branch tells these apart. The cheapest test that would decide it: a dev-only log line of `{landing, following, offset.current, size.current}` when the settle timer fires, captured on the next QA re-run of the 56-turn alpha. After two failed simulator repros, §0 says to escalate with that decision rather than ship a guess.
2. **HIGH: the regression test is not red on the bug.** On `main`, `follow.test.ts` fails only because the module does not load (`landingEnded` is missing). The executor also calls this a weak red. `settleStep` already corrected a short offset on `main`; the only new behaviour is `animated: false`. The wiring test is a source regex. No test drives "a landing ends with the list short of its end → corrected", so the property that would fix the bug is not pinned anywhere.
3. **MEDIUM: if the hypothesis is right, the contract stays broken.** The contract (`mobile-open-at-end`) is that the first visible frame is already the end. The correction runs `SETTLE_MS` (450 ms) after the landing ends, and the list is visible by then because `settling` is false. A long session would show the tail rows and then jump about 2 turns (≈320 pt) with no animation. That beats resting short, but it is still visible. A design that keeps the contract: put the offset check inside the landing, before it hands back (`landingReveal`/`landingStep` take `offset`; if the list is short, do one more silent scroll while it is still hidden). That is still pure and still in `follow.ts`.
4. **LOW: the magnitude was not characterised (§1).** "~570 px" in the QA report is screenshot pixels at 3× (iPhone 17 Pro Max, 1320×2868), not points. Comparing `qa-2411/shots/1-opened-settled.png` (turn 51 at the top) with `1-swipe2.png` (turn 53 at the top, real end) gives a gap of exactly **2 turns**: ≈968 px, or ≈323 pt. The test fixture (`follow.test.ts`, 5200 → 5770) and its comment say "570 pt". That does not change the pure test, but a gap of exactly whole turns is a clue about the mechanism that the doc never used.
5. **NIT:** the wiring regex window was widened from `{0,600}` to `{0,900}` (`session-screen-follow-wiring.test.ts:110`). That is fine, but it weakens that assertion a little. The doc header still says `Status: execution`.

**Gate (run by me on this worktree):** `bun run typecheck` exit 0. `bun run lint` exit 0 ("Checked 2390 files… No fixes applied"). `bun test`: **17871 pass, 5 skip, 0 fail** (17876 tests, 1253 files). The diff adds no `.skip`.

**Mutation (scratch copy in `.tentacle/tmp/mobile-open-long-session-review/`, never `git checkout`; the worktree is byte-identical afterwards, `git status` clean):**

| Mutation | Result |
|---|---|
| M1: `follow.ts` from `main` | RED (load failure, missing export) |
| M2: `settleStep` ignores `animated` | RED (silent test) |
| M3: `SessionScreen.tsx` from `main` | RED (wiring) |
| M4: drop the reveal-timer exit | RED (count 2) |
| M5: `armSettle(false)` | RED |
| M6: `landingEnded` always true | RED |
| M7: pass `silent` instead of `!silent` | RED |

Every mutation is caught. These tests are non-vacuous for the code they pin, but they do not cover the bug itself (finding 2).

**Premise table**

| Premise | Verdict |
|---|---|
| QA symptom: long session rests short, short session OK (`qa-2411/REPORT.md` §1) | TRUE, but the magnitude is 2 turns ≈ 323 pt, not 570 pt |
| `armSettle` is armed only on the non-landing path (`SessionScreen.tsx` `onContentSize`/`onListLayout`, `if (land()) return;`) | TRUE |
| `settleStep` returns null when not following or when content ≤ viewport; slack 2 pt | TRUE (`follow.ts:122`) |
| "Once a landing is over, no later size change exists to arm it" | TRUE only if nothing changes afterwards. Any later size change already armed the (animated) settle on `main` |
| The QA state was mechanism (a) | NOT SHOWN |

**Attacks tried**
- *Very long session:* one silent scroll after 450 ms, and only on the pending→done edge. No loop: `landingEnded` is edge-only (M6 is red). Holds.
- *Content growing while opening:* a later non-landing size change calls `armSettle()`, which clears the silent timer and runs the existing animated settle. Same as `main`, so no new animated travel. Holds.
- *Short session:* content ≤ viewport → null. Holds.
- *Re-open / pull-to-refresh re-attach:* the person has scrolled up or is dragging, so `following` is false or `dragging.current` is set → no move. Holds.
- *Rotation, keyboard or composer inset:* `onListLayout` → `viewportChanged` plus the ordinary `armSettle()` replaces the silent one. Unchanged. Holds.
- *A stale `armLandedSettle` closure:* the ref is reassigned on every render and `armSettle` is stable (`[perform]`). Holds.
- *Does the fix cover mechanisms (b) and (c)?* No (finding 1).

**What holds:** the logic is in a pure module; no new animated scroll; a reader who has scrolled up is never moved; the change is contained and the gate is green.

**How the executor behaved:** honest. It flagged the missing repro, the weak red and the unverified mechanism itself, and it did not overclaim in the doc. But after two failed repro attempts it shipped a speculative fix instead of escalating (§0), and the changelog states the fix as fact.

*— claude-opus-5-5, 2026-11-24 (fresh context; executor was claude-sonnet-5-5, a different model, same family)*

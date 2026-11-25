# fix/mobile-open-long-session-2 — a 114-row session still opens a turn short (round 2)

> **Status:** execution
> **Branch:** `fix/mobile-open-long-session-2`
> **Size:** S · **Blast:** contained (mobile transcript landing, `follow.ts`) · **Suited:** weaker model executes, standard Review
> **Changelog:** `changelog.d/mobile-open-long-session-2.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

Round 1 (`docs/fix/mobile-open-long-session.md`, merged `df358162`) was never reproduced and aimed at a path that is not the one hit. Post-merge QA (`.tentacle/tmp/qa-2411b/REPORT.md` §1) reproduced the bug on a binary built after the merge: alpha at 114 messages opens from the list on turn 56 with its answer cut by the composer; turn 57 + answer are below; stable at rest. Short charlie is right. Contract: `mobile-open-at-bottom.md` / `mobile-open-at-end.md` (first visible frame already the end, no travel).

**Repro (this tree = main, QA harness `fill.sh` + `open.yaml`, sim 0B43D716):** alpha filled to 114 messages (last «turn 57 alpha»), opened from the list: `.tentacle/tmp/mobile-open-long-session-2/red-later.png` (turn 56 + cut answer). Same on 3 runs.

**Characterisation (debug overlay of `{landing, size, offset, following}` per `land()`/scroll/reveal/settle, removed afterwards; `out-dbg3/.../later.png`):**
- the landing takes 11 content growths of ~464 pt (a FlatList batch of 10 rows), then a 12th of 185 pt (5175 → 5360): `land c=5360 o=4455 L=Hpr11` → `scroll c=5360 o=4640 L=SprORs` (rounds=12 = `LANDING_ROUNDS`).
- JS metrics say the list is AT its end (offset 4640 = 5360 − 720; `settle` finds nothing to do, `following` true) while the pixels are those of offset 4455 (the view stops where the previous content ended, 5175). Round 1's path (`settleStep`/`restsShort`) therefore never fires: it trusts these metrics.
- A swipe repaints it right (offset 4670 → 4641, turn 57 visible); a 1 pt nudge 700 ms after the reveal also does (`out-dbg2`, overlay line `nudge`). So the native view had not painted the scroll that was issued in the same tick as the reveal.
- Why only here: the bound branch of `landingStep` scrolls AND ends the hidden landing (`settling:false`) in the same measurement. The normal ending is the quiet timer (`landingReveal`, 120 ms after the last scroll). A session whose last growth is not the 12th measurement (e.g. 260 messages) ends through the tail or the timer and is right. 114 rows put the 12th measurement exactly on the last growth.
- Magnitude: exactly the last growth (185 pt ≈ 2 rows), not a fixed px; tied to the landing round count, not to the composer inset.

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

**Load-bearing assumption.** `follow.ts` `landingStep` bound branch (`state.settling && m.content !== state.last && rounds >= LANDING_ROUNDS`) is reached on the last growth of a ~114-row opening, and revealing in the same tick as the scroll is what leaves the paint stale. Shown by the overlay above (`L=Hpr11` → `L=SprORs` in one step).

**Design.** The bound's first hit scrolls silently but stays hidden (`capped: true`, optional `Landing` field); the screen's existing quiet timer (`landingReveal` → silent tail) then shows the list 120 ms later, like every other landing. A growth while capped takes the old bound path (reveal into the silent tail, fresh rounds), so a content that never repeats is still never left hidden. A reader scrolled up is revealed in place (unchanged early exit). Pure, in `follow.ts`; the screen is untouched.

**Files.** `apps/mobile/src/follow.ts`, `apps/mobile/test/follow.test.ts`, `changelog.d/mobile-open-long-session-2.fixed.md`.

**Failure modes.** Very long sessions: capped once, then the old bound/tail (a 260-message session verified). Session growing while opening: a growth while capped reveals into the silent tail (test). Short sessions: never reach the bound. Re-open / re-attach: `settling` is false there, branch not reached. Rotation: `viewportChanged` path untouched. Stream never quiet: the timer is re-armed only by landing scrolls; the capped growth hits the bound path, so hidden time stays bounded.

**Tests.** `follow.test.ts` "the bound does not show the list in the tick of its own scroll": hit stays hidden with a silent end scroll; the quiet timer shows it into the tail; a growth while capped is not hidden again; a reader scrolled up is never yanked.

## Execution

*— claude-sonnet-5-5, 2026-11-25*

**Red → green.** With the new branch disabled (`&& false`, i.e. the code on main) 2 of the 4 new tests fail (stays hidden; timer shows into tail) — the other two pass on both by design; with the fix 69 pass / 0 fail (`follow.test.ts` + wiring: 91 / 0). **Mutation:** `capped` never set → 2 fail (the new growth-while-capped test and the old "never-repeating height still ends the landing"); restored.

**Simulator (iPhone 17 Pro Max, release build of this tree, `.tentacle/tmp/mobile-open-long-session-2/`):**
- before: `red-later.png` (114 msgs, turn 56 cut), `out-dbg3/.../later.png`.
- after: `out-fix-alpha/*/open/takeScreenshot/settled.png` (114 msgs: turn 57 + answer fully above the composer); `out-fix-long/*/later.png` (260 msgs, last turn 186 + answer); `out-fix-charlie/*/later.png` (short session right).

**Unverified:** visible travel was judged from the settled/later frames only (no video); the underlying native staleness (why the paint misses a scroll issued in the reveal tick) is inferred from the overlay + nudge, not from UIKit.

## Review (Round 1)

*— claude-opus-5-5, 2026-11-25 (fresh context; a different model family from the executor, claude-sonnet-5-5)*

**Verdict: APPROVE-WITH-NITS (PASS).** No HIGH or MEDIUM findings. Two LOW findings below; neither blocks the merge.

**Gate.** `bun run typecheck` passes on all three projects. `bun run lint` reports no issues (2395 files checked). `bun test apps/mobile/test/follow.test.ts` gives 69 pass / 0 fail. `bun test apps/mobile` gives 5020 pass / 0 fail. I did not run the full parallel `bun run test`.

**Red on main (scratch copy, no checkout).** I put `git show main:apps/mobile/src/follow.ts` and the branch's `follow.test.ts` in `.tentacle/tmp/mobile-open-long-session-2-review/`. Result: 67 pass, 2 fail ("…scrolls silently but stays hidden" and "the quiet timer then shows it, into the silent tail"). This matches the Execution section.

**Mutation.** I removed `capped: true` from the new branch (`follow.ts:341`). Result: 2 fail ("a growth while capped is not hidden again" and the older "a never-repeating content height still ends the landing"). So the guard against hiding forever is pinned. The scratch copy was deleted and the worktree is unchanged (`git status` clean before this edit).

**Premise table.**
| Premise | Verdict |
|---|---|
| Symptom: 114 rows open one turn short (`red-later.png`); after the fix the end is visible (`out-fix-alpha/…/settled.png`) | TRUE. I looked at both frames. "turn 56" sits about 557 device px (≈186 pt at @3x) lower before the fix. That is the last growth (185 pt), so it matches the ~570 px gap. The fault is tied to the last growth, not to a fixed inset. The cause explains the measured gap. It is not just a correlated symptom. |
| On main, the bound branch scrolls and ends `settling` on the same measurement (`main:follow.ts` bound branch → `settling:false`) | TRUE |
| The screen re-arms the reveal timer while a landing is pending, so a capped state cannot stay hidden (`SessionScreen.tsx:640-642`, `596-598`) | TRUE. The capped step leaves `settling:true`, so `armReveal()` runs. |
| The timer's reveal of a capped state issues a scroll to `endOffset` again (`follow.ts:497-509`) | TRUE. This also covers an alternative cause I could not rule out: a scroll clamped natively to the old content size. Either way, the list is shown after a second scroll that comes 120 ms later. |
| The "stale native paint" mechanism itself | UNPROVEN, as the doc admits. It is inferred from the debug overlay and the nudge test. The fix holds under both explanations (row above). |

**Attacks tried.**
1. **Very long or still-growing session, with the timer firing between growths** (pure trace script, fix vs main). After capped → timer, the tail inherits `rounds: 12`. It therefore absorbs only one silent growth before handing back to the animated `contentGrew`. Main's bound branch gives the tail fresh rounds, but in the same timing main's timer then ends the revealed tail at once (`landingDone`), so every later growth is animated there too. **Not a regression:** the fix absorbs one more growth than main in that sequence. → LOW-1.
2. **Viewport or inset change (keyboard, composer, safe area) during the 120 ms capped window.** Traced: a measurement with the same content but a new viewport skips both bound branches. It falls into `next` with `rounds 13 ≥ 12`, so `settling:false` and `silent:false`, together with a scroll to the new end. That is a reveal and a scroll in the same tick, the mechanism this fix exists to avoid, and with no silent tail after it. Main had the same path for a layout event on round 12, so this is not a regression, but the fix's own claim ("shown only after its last scroll has landed") does not hold for a non-growth measurement. The window is narrow: round 12 plus 120 ms. → LOW-2.
3. **Short session, re-open/re-attach, scrolled-up reader, rotation.** A short session never reaches round 12. `landingQuiet`/`awaiting` have `settling:false`, so the new branch is unreachable for them. A reader who is not following leaves at the early exit (pinned by the 4th test). Rotation goes through `onListLayout`, which is attack 2 while capped and unchanged otherwise. Found nothing new.
4. **Growth while capped, and capped forever.** A second growth takes the old bound path (reveal into a tail with fresh rounds). This is pinned by the test and confirmed by the mutation. `capped` is dropped by every fresh-literal state (tail, `landingDone`), so it cannot leak into a later landing. Found nothing.
5. **New visible scroll travel.** Every new step is `animated:false`. The capped step is issued while the list is hidden. Found nothing. Video was not checked (it is also unverified in the Execution section).

**Findings.**
- **LOW-1** `follow.ts:497-509` (pre-existing in kind): after a capped landing is revealed by the timer, the tail keeps `rounds: state.rounds` (12), so it has a budget of one silent scroll. The bound branch's comment says "the tail gets fresh rounds". Optional fix: reset `rounds` to 0 when `landingReveal` reveals a `capped` state.
- **LOW-2** `follow.ts:365-379`: a non-growth measurement (a viewport change) while capped reveals with a scroll in the same tick. Optional fix: while `capped`, keep any measurement hidden with its silent scroll, or route it into the tail, as the second bound branch does.
- **Nit** `follow.test.ts` test 3 checks `settling:false` and a non-animated step but not `landingPending(more.state)`, i.e. that the state really is the silent tail rather than `landingDone`.

**What holds.** The logic stays in the pure module (`follow.ts`) and the screen is untouched, as AGENTS §7 requires. The change is small and additive (one optional field and one branch). The test goes red on main and green on the branch, and the mutation shows it is not vacuous. The changelog fragment is correct.

**How the executor behaved.** The executor reproduced the bug before fixing it, using an instrumented overlay and three runs. They measured the magnitude and correctly tied it to the round count, not to the inset. They openly said what was unverified (the native mechanism; video). Their red/green and mutation claims matched what I measured exactly. One gap: they did not consider a non-growth measurement during the capped window (LOW-2).

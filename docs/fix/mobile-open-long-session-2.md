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

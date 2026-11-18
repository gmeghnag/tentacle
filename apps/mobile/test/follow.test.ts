/**
 * Owner B5 (2026-11-15): the transcript must FOLLOW the streaming answer —
 * scroll to the bottom as content arrives — unless the person scrolled up, in
 * which case it stays put and offers a "Jump to latest" pill.
 */
import { describe, expect, test } from "bun:test";
import {
  type Follow,
  LANDING_REVEAL_MS,
  LANDING_ROUNDS,
  type Landing,
  NEAR_BOTTOM_PT,
  contentGrew,
  endOffset,
  initialFollow,
  jumpPill,
  jumped,
  landingAwaiting,
  landingDone,
  landingOwns,
  landingPending,
  landingQuiet,
  landingReveal,
  landingStart,
  landingStep,
  nearBottom,
  reattachLanding,
  scrolled,
  shown,
  viewportChanged,
} from "../src/follow.ts";

const VIEW = 600;
/** Metrics with the viewport `fromBottom` points above the end of 2000 pt of content. */
const at = (fromBottom: number) => ({
  offset: 2000 - VIEW - fromBottom,
  content: 2000,
  viewport: VIEW,
});
/** The list's size as the native side reports it (content INCLUDES the container padding). */
const SIZE = { content: 2000, viewport: VIEW };

describe("follow (B5)", () => {
  test("a fresh screen follows: new content scrolls to the end, no pill", () => {
    const step = contentGrew(initialFollow, SIZE);
    expect(step.scrollTo).toBe(2000 - VIEW);
    expect(jumpPill(step.state)).toBe(false);
  });

  test("the person scrolls UP: new content does not move the list, and the pill shows", () => {
    const up = scrolled(initialFollow, at(300), true);
    expect(up.following).toBe(false);
    expect(jumpPill(up)).toBe(true);
    const step = contentGrew(up, SIZE);
    expect(step.scrollTo).toBeNull();
    expect(step.state.unseen).toBe(true);
    expect(jumpPill(step.state)).toBe(true);
  });

  test("scrolling back to the bottom by hand resumes following and hides the pill", () => {
    const up: Follow = { following: false, unseen: true };
    const back = scrolled(up, at(10), true);
    expect(back).toEqual({ following: true, unseen: false });
    expect(contentGrew(back, SIZE).scrollTo).toBe(2000 - VIEW);
  });

  test("the list's OWN scroll (an animated scroll-to-end overtaken by new content) never stops following", () => {
    // Mid-animation the offset trails the growing end; only a person's drag may
    // turn following off, or a fast stream would drop out of follow by itself.
    expect(scrolled(initialFollow, at(400), false)).toEqual(initialFollow);
  });

  test("a programmatic scroll that lands at the bottom clears the unseen mark", () => {
    expect(scrolled({ following: false, unseen: true }, at(0), false)).toEqual(initialFollow);
  });

  test("the threshold: within NEAR_BOTTOM_PT counts as the bottom, beyond it does not", () => {
    expect(nearBottom(at(NEAR_BOTTOM_PT))).toBe(true);
    expect(nearBottom(at(NEAR_BOTTOM_PT + 1))).toBe(false);
  });

  test("content shorter than the screen is always at the bottom", () => {
    expect(nearBottom({ offset: 0, content: 200, viewport: VIEW })).toBe(true);
    expect(
      scrolled(initialFollow, { offset: 0, content: 200, viewport: VIEW }, true).following,
    ).toBe(true);
  });

  test("Jump to latest: following again, pill gone", () => {
    const state = jumped();
    expect(state).toEqual({ following: true, unseen: false });
    expect(jumpPill(state)).toBe(false);
  });

  test("Show in chat (mobile-chrome S9): held where it scrolled, so new content does not pull it back", () => {
    const state = shown();
    expect(state.following).toBe(false);
    expect(contentGrew(state, { content: 2000, viewport: VIEW }).scrollTo).toBeNull();
    expect(jumpPill(state)).toBe(true);
  });
});

/** A long history: 40 000 pt of content in an 800 pt viewport (the owner's case). */
const LONG = { content: 40000, viewport: 800 };

/** The list has rows to land at (every case except a still-empty screen). */
const ROWS = true;

/** The empty state: nothing to land at, whatever height it reports. */
const NO_ROWS = false;

describe("the initial landing (docs/fix/mobile-open-at-end.md, item 1)", () => {
  test("the first measurement of a long history lands at the end, NOT animated", () => {
    const first = landingStep(landingStart, LONG, true, ROWS);
    expect(first.step).not.toBeNull();
    expect(first.step?.scrollTo).toBe(39200);
    expect(first.step?.animated).toBe(false);
    // A landing is following (the pill is not offered for one frame).
    expect(first.step?.state).toEqual(initialFollow);
  });

  test("it keeps landing silently while the end keeps moving, then stops", () => {
    // A silent scroll renders more cells, so the native content height grows
    // under it: each new measurement lands again, still not animated.
    const a = landingStep(landingStart, LONG, true, ROWS);
    const b = landingStep(a.state, { content: 44000, viewport: 800 }, true, ROWS);
    expect(b.step?.animated).toBe(false);
    expect(b.step?.scrollTo).toBe(43200);
    expect(b.state.settling).toBe(true);
    // The height repeats: this measurement lands (same offset) and the NEXT one
    // is what lets the list be shown — the shown frame is already at the end.
    const c = landingStep(b.state, { content: 44000, viewport: 800 }, true, ROWS);
    expect(c.step).toEqual({ state: initialFollow, scrollTo: 43200, animated: false });
    expect(c.state.settling).toBe(false);
    // Settled: the ordinary follow rules from here on.
    const d = landingStep(c.state, { content: 44100, viewport: 800 }, true, ROWS);
    expect(d.state.settling).toBe(false);
    expect(d.step).toBeNull();
    expect(contentGrew(initialFollow, { content: 44100, viewport: 800 }).animated).toBe(true);
  });

  test("an unknown size lands nowhere (a scroll to 0 would be the bug it fixes)", () => {
    const none = landingStep(landingStart, { content: 0, viewport: 0 }, true, ROWS);
    expect(none.step).toBeNull();
    expect(none.state.rounds).toBe(0);
    expect(landingStep(landingStart, { content: 40000, viewport: 0 }, true, ROWS).step).toBeNull();
  });

  test("a history shorter than the screen lands at 0 (no negative offset, no animation)", () => {
    const short = landingStep(landingStart, { content: 200, viewport: 800 }, true, ROWS);
    expect(short.step?.scrollTo).toBe(0);
    expect(short.step?.animated).toBe(false);
  });

  test("a never-repeating content height still ends the landing (the list is never left hidden)", () => {
    let landing = landingStart;
    let rounds = 0;
    for (; rounds < 100; rounds += 1) {
      const next = landingStep(landing, { content: 1000 + rounds * 7, viewport: 800 }, true, ROWS);
      landing = next.state;
      if (!landing.settling) {
        break;
      }
    }
    expect(landing.settling).toBe(false);
    // Bounded: a stream or a late thumbnail cannot hide the transcript for ever.
    expect(rounds).toBeLessThan(100);
    expect(LANDING_ROUNDS).toBeGreaterThan(1);
  });

  test("a RE-ATTACH (resync, Retry, foreground) lands silently too: no second visible scroll", () => {
    // Its measurements are ABSORBED, not scrolled (bug 4: the replace re-keys
    // every row, so scrolling on each measurement IS the owner's loop). The one
    // silent scroll comes when the sizes go quiet — `landingReveal`.
    const step = landingStep(landingQuiet, LONG, true, ROWS);
    expect(step.step).toBeNull();
    // Nothing was hidden: the rows were already shown before the re-attach.
    expect(step.state.settling).toBe(false);
    expect(landingPending(step.state)).toBe(true); // still owed
    const landed = landingReveal(step.state, LONG, true, ROWS);
    expect(landed.step).toEqual({ state: initialFollow, scrollTo: 39200, animated: false });
    // Still owed — silently — for the growth that scroll causes: the reveal hands
    // the list back only when a height repeats (Review round 1, finding 2).
    expect(landingPending(landed.state)).toBe(true);
    expect(landed.state.settling).toBe(false); // never hidden
    expect(landingReveal(landed.state, LONG, true, ROWS).state).toEqual(landingDone);
  });

  test("a foreground resync while the person reads further up does NOT yank them to the end", () => {
    const step = landingStep(landingQuiet, LONG, false, ROWS);
    expect(step.step).toBeNull();
    expect(step.state.silent).toBe(false);
    // Not even the timer: nothing is owed, so the loop is closed for good.
    expect(landingReveal(step.state, LONG, false, ROWS).step).toBeNull();
  });

  test("with nothing pending the ordinary rules apply (a later append IS animated)", () => {
    const step = landingStep(landingDone, LONG, true, ROWS);
    expect(step.step).toBeNull();
    expect(contentGrew(initialFollow, LONG).animated).toBe(true);
    expect(viewportChanged(initialFollow, LONG).animated).toBe(true);
  });
});

describe("the reveal timer: the list is shown even when no measurement repeats (Review round 1, HIGH 1)", () => {
  test("a SILENT session's real event sequence never repeats a height — the timer is what shows it", () => {
    // The exact sequence the screen receives opening a 2-message session: two
    // measurements of DISTINCT heights, then silence. `onContentSizeChange` and
    // `onLayout` fire only when a size CHANGES, so the repeated measurement
    // `settling` used to wait for never arrives.
    const first = landingStep(landingStart, { content: 300, viewport: 800 }, true, ROWS);
    expect(first.state.settling).toBe(true);
    const second = landingStep(first.state, { content: 420, viewport: 800 }, true, ROWS);
    expect(second.state.settling).toBe(true); // still hidden: 420 ≠ 300
    // Silence. The timer is the only thing left that can show the list.
    const revealed = landingReveal(second.state, { content: 420, viewport: 800 }, true, ROWS);
    expect(revealed.state.settling).toBe(false);
    // It lands at the end it knows NOW, and never animates it: the person must
    // not see the transcript scroll after they thought it had settled.
    expect(revealed.step).toEqual({ state: initialFollow, scrollTo: 0, animated: false });
    // Settled for good: the next content event is ordinary follow, animated.
    expect(landingReveal(revealed.state, LONG, true, ROWS).step).toBeNull();
  });

  test("a long history the timer reaches before it settles still lands at the TRUE end", () => {
    const one = landingStep(landingStart, { content: 40000, viewport: 800 }, true, ROWS);
    const revealed = landingReveal(one.state, { content: 44000, viewport: 800 }, true, ROWS);
    expect(revealed.step).toEqual({ state: initialFollow, scrollTo: 43200, animated: false });
    expect(revealed.state).toEqual(landingDone);
  });

  test("nothing measured: the empty state is still SHOWN, and the rows hide it again for their own landing", () => {
    const revealed = landingReveal(landingStart, { content: 0, viewport: 0 }, true, ROWS);
    expect(revealed.state.settling).toBe(false); // shown: an invisible empty state is the bug
    expect(revealed.state).toEqual(landingAwaiting);
    expect(revealed.step).toBeNull(); // a scroll to 0 is the bug it fixes
    // And the first real measurement lands, not animated.
    const landed = landingStep(revealed.state, LONG, true, ROWS);
    expect(landed.step?.animated).toBe(false);
    expect(landed.step?.scrollTo).toBe(39200);
  });

  test("a person reading further up is shown where they are, never yanked (mutation: drop the guard → a scroll they did not ask for)", () => {
    const revealed = landingReveal(landingStart, LONG, false, ROWS);
    expect(revealed.state).toEqual(landingDone);
    expect(revealed.step).toBeNull();
  });

  test("a reveal is BOUNDED: it is a duration, not a round count", () => {
    expect(LANDING_REVEAL_MS).toBeGreaterThan(0);
    // Short enough to be a settle, long enough to cover a landing scroll's frame.
    expect(LANDING_REVEAL_MS).toBeLessThanOrEqual(500);
  });
});

describe("a RE-ATTACH arms the landing the same way the pull does (Review round 1, MEDIUM 3)", () => {
  test("following → silent landing; reading further up → nothing pending", () => {
    expect(reattachLanding(true)).toEqual(landingQuiet);
    expect(reattachLanding(false)).toEqual(landingDone);
  });

  test("a re-attach never hides the list it just re-read (mutation: arm `landingStart` → the rows flicker out)", () => {
    const step = landingStep(reattachLanding(true), { content: 1300, viewport: 800 }, true, ROWS);
    expect(step.state.settling).toBe(false); // silent, never hidden: the rows are already up
    // One measurement never lands a re-attach: the replace is still re-measuring
    // (bug 4 — a scroll here, then an ANIMATED one per later measurement, is the loop).
    expect(step.step).toBeNull();
    const landed = landingReveal(step.state, { content: 1300, viewport: 800 }, true, ROWS);
    expect(landed.state.settling).toBe(false); // still never hidden
    expect(landed.step).toEqual({ state: initialFollow, scrollTo: 500, animated: false });
  });

  test("but an OPENING landing revealed while it waited for a slow attach hides again for the rows that arrive", () => {
    // A slow attach: the reveal timer fired with nothing measured, so the empty
    // state was seen. The history that finally lands must not be seen at the TOP.
    const shown = landingReveal(landingStart, { content: 0, viewport: 800 }, true, ROWS);
    expect(shown.state).toEqual(landingAwaiting);
    expect(shown.state.settling).toBe(false); // the empty state IS shown
    const first = landingStep(shown.state, { content: 900, viewport: 800 }, true, ROWS);
    expect(first.state.settling).toBe(true); // hidden for the landing, silently
    expect(first.step).toEqual({ state: initialFollow, scrollTo: 100, animated: false });
    // It settles the ordinary way (a repeated height), and is then shown.
    const settled = landingStep(first.state, { content: 900, viewport: 800 }, true, ROWS);
    expect(settled.state.settling).toBe(false);
    expect(settled.state.awaiting).toBe(false);
    // A reveal that fires while still `awaiting` (the rows arrived, the sizes are
    // quiet) behaves like the OPENING landing — one silent scroll, the landing
    // DONE. Never a re-attach's tail (`revealed`), which would silence the next
    // real row a stream appends.
    expect(landingReveal(shown.state, LONG, true, ROWS).state).toEqual(landingDone);
  });

  test("a foreground resync's content change lands silently, not through the animated follow", () => {
    // The bug: the screen re-armed `landingQuiet` only for pull/Retry/Reopen, so
    // a resync's new history went through `contentGrew` — ANIMATED, seen.
    const armed = reattachLanding(true);
    const step = landingStep(armed, LONG, true, ROWS);
    expect(step.step).toBeNull(); // absorbed (bug 4)
    const landed = landingReveal(step.state, LONG, true, ROWS);
    expect(landed.step?.animated).toBe(false);
    expect(landed.step?.scrollTo).toBe(39200);
  });
});

/**
 * Owner, real iPhone 2026-11-18 09:50 (bug 4, HIGHEST): coming back from another
 * app made the transcript scroll "up and down in a loop" trying to reach the old
 * position. Expected: it is simply where it was, with NO scroll at all.
 *
 * The hole `landingQuiet` had: it is a ONE-SHOT. Its `silent` flag cleared on the
 * first measurement, so every later content change of that same re-attach fell
 * through to `contentGrew` — ANIMATED. A re-attach REPLACES the rows (`withHistory`
 * re-keys them all), so a FlatList unmounts its cells and the content height
 * moves for several measurements in a row: the loop the owner saw.
 *
 * Acceptance (the fix brief): a foreground return never issues more than ONE
 * scroll command, and none at all when the person was not at the end.
 */
describe("a RE-ATTACH lands in ONE silent scroll, never the foreground loop (bug 4)", () => {
  /** The measurements a replaced history reports: dropped, grown back, repeated. */
  const RETURN: readonly { content: number; viewport: number }[] = [
    { content: 800, viewport: 800 }, // the replace: every cell unmounted
    { content: 12000, viewport: 800 },
    { content: 40000, viewport: 800 },
    { content: 42000, viewport: 800 },
    { content: 42000, viewport: 800 },
    { content: 42000, viewport: 800 },
  ];

  /** What the screen does per measurement: land if a landing is owed, else follow. */
  const replay = (following: boolean): { scrollTo: number; animated: boolean }[] => {
    let landing = reattachLanding(following);
    const commands: { scrollTo: number; animated: boolean }[] = [];
    // `SessionScreen.land()` exactly: a measurement the landing CONSUMES — scrolled,
    // absorbed, or the one that ENDS it — never reaches the animated follow below.
    const absorb = (size: { content: number; viewport: number }): boolean => {
      const owed = landingPending(landing);
      const stepped = landingStep(landing, size, following, ROWS);
      landing = stepped.state;
      if (stepped.step?.scrollTo != null) {
        commands.push({ scrollTo: stepped.step.scrollTo, animated: stepped.step.animated });
      }
      return owed || landingPending(landing);
    };
    for (const size of RETURN) {
      if (absorb(size)) {
        continue; // the landing OWNS this measurement (that is the bug this pins)
      }
      const step = contentGrew({ following, unseen: false }, size);
      if (step.scrollTo !== null) {
        commands.push({ scrollTo: step.scrollTo, animated: step.animated });
      }
    }
    // The reveal timer, once the sizes go quiet: the ONE silent scroll — and the
    // growth it CAUSES (a FlatList renders the end's cells), which the landing
    // still owns and follows silently (Review round 1, finding 2), then a repeat
    // that ends it. Neither may reach the animated follow.
    const last = RETURN[RETURN.length - 1];
    if (last !== undefined) {
      const revealed = landingReveal(landing, last, following, ROWS);
      landing = revealed.state;
      if (revealed.step?.scrollTo != null) {
        commands.push({ scrollTo: revealed.step.scrollTo, animated: revealed.step.animated });
      }
      absorb({ content: last.content + 800, viewport: last.viewport }); // the cells it rendered
      absorb({ content: last.content + 800, viewport: last.viewport }); // quiet: over
    }
    return commands;
  };

  test("at the end: silent scrolls only, to the true end — nothing is ever seen moving", () => {
    const commands = replay(true);
    // The bug: 1 silent then 5 ANIMATED (0 → 11200 → 39200 → 41200 …), the loop —
    // and the reveal's own scroll rendered the end's cells, so the growth after it
    // is the same loop one step later (Review round 1, finding 2).
    expect(commands.filter((c) => c.animated)).toEqual([]);
    expect(commands.map((c) => c.scrollTo)).toEqual([41200, 42000]);
  });

  test("reading further up: not a single scroll command (they are never yanked)", () => {
    expect(replay(false)).toEqual([]);
  });

  test("the landing stays silent until the end STOPS moving, then hands over to the ordinary rules", () => {
    // It absorbs every measurement of the replace: nothing is scrolled while
    // the list is still re-measuring.
    let landing = reattachLanding(true);
    for (const size of RETURN.slice(0, 5)) {
      const step = landingStep(landing, size, true, ROWS);
      expect(step.step).toBeNull();
      landing = step.state;
    }
    expect(landingPending(landing)).toBe(true);
    // The sizes went quiet → ONE silent scroll; the landing keeps the list for the
    // growth that scroll causes (Review round 1, finding 2), and the next quiet
    // fire hands it back.
    const landed = landingReveal(landing, RETURN[RETURN.length - 1] ?? LONG, true, ROWS);
    expect(landed.step?.animated).toBe(false);
    expect(
      landingPending(
        landingReveal(landed.state, RETURN[RETURN.length - 1] ?? LONG, true, ROWS).state,
      ),
    ).toBe(false);
    expect(landingStep(landed.state, LONG, true, ROWS).step?.animated).toBe(false);
    // From here a NEW row is the ordinary animated follow, once.
    expect(contentGrew(initialFollow, { content: 42060, viewport: 800 })).toEqual({
      state: initialFollow,
      scrollTo: 41260,
      animated: true,
    });
  });

  test("the measurements that arrive AFTER the reveal still land silently — no animated scroll, ever (Review round 1, finding 2)", () => {
    // The reveal's silent scroll renders the END's cells, so a FlatList reports a
    // NEW content height right after it (`follow.ts:143-146` documents exactly
    // that for the opening landing). Handing the list back at the reveal sent each
    // of those through `contentGrew` — ANIMATED: the same loop, one step later.
    let landing = reattachLanding(true);
    const absorbed = landingStep(landing, { content: 41200, viewport: 800 }, true, ROWS);
    expect(absorbed.step).toBeNull();
    const revealed = landingReveal(absorbed.state, { content: 41200, viewport: 800 }, true, ROWS);
    expect(revealed.step).toEqual({ state: initialFollow, scrollTo: 40400, animated: false });
    // The landing is STILL owed (silently) for the growth its own scroll causes.
    expect(landingPending(revealed.state)).toBe(true);
    expect(revealed.state.settling).toBe(false); // never hidden: the rows are up
    landing = revealed.state;
    const moved = landingStep(landing, { content: 42000, viewport: 800 }, true, ROWS);
    expect(moved.step).toEqual({ state: initialFollow, scrollTo: 41200, animated: false });
    expect(landingPending(moved.state)).toBe(true);
    // A REPEATED height: the re-measure is over, and the scroll already got there.
    const quiet = landingStep(moved.state, { content: 42000, viewport: 800 }, true, ROWS);
    expect(quiet.step).toBeNull();
    expect(landingPending(quiet.state)).toBe(false);
    // From here a NEW row is the ordinary animated follow, once — the landing is
    // gone for good, it does not silence the stream.
    expect(contentGrew(initialFollow, { content: 42060, viewport: 800 })).toEqual({
      state: initialFollow,
      scrollTo: 41260,
      animated: true,
    });
  });

  test("a second reveal that lands nothing hands the list back (the timer is not a loop of its own)", () => {
    const revealed = landingReveal(reattachLanding(true), LONG, true, ROWS);
    expect(revealed.step?.animated).toBe(false);
    const again = landingReveal(revealed.state, LONG, true, ROWS);
    expect(again).toEqual({ state: landingDone, step: null }); // quiet → done, no command
    expect(landingPending(again.state)).toBe(false);
  });

  test("the post-reveal tail is BOUNDED too (a turn streaming through the return is not silenced for ever)", () => {
    let landing: Landing = landingReveal(
      reattachLanding(true),
      { content: 1000, viewport: 800 },
      true,
      ROWS,
    ).state;
    let rounds = 0;
    for (; rounds < 100; rounds += 1) {
      landing = landingStep(
        landing,
        { content: 2000 + rounds * 7, viewport: 800 },
        true,
        ROWS,
      ).state;
      if (!landing.silent) {
        break;
      }
    }
    expect(landing.silent).toBe(false);
    expect(rounds).toBeLessThan(100);
  });

  test("reading further up: the reveal never arms a tail in the first place (nothing is owed)", () => {
    const step = landingStep(reattachLanding(true), LONG, false, ROWS);
    expect(step.state.silent).toBe(false);
    expect(landingReveal(step.state, LONG, false, ROWS)).toEqual({
      state: landingDone,
      step: null,
    });
  });

  test("the re-attach's landing is still BOUNDED (a turn streaming through it cannot silence it for ever)", () => {
    let landing = reattachLanding(true);
    let rounds = 0;
    for (; rounds < 100; rounds += 1) {
      const next = landingStep(landing, { content: 40000 + rounds * 7, viewport: 800 }, true, ROWS);
      landing = next.state;
      if (!landing.silent) {
        break;
      }
    }
    expect(landing.silent).toBe(false);
    expect(rounds).toBeLessThan(100);
  });
});

describe("a slow attach still lands silently (Review round 2, NEW HIGH)", () => {
  // The bug: the empty list is laid out with `contentContainerStyle` `flexGrow: 1`,
  // so its content measurement is the VIEWPORT's height, not 0. That measurement
  // counted as a landing round, so `landingReveal` — 120 ms later — found
  // `content > 0` and returned `landingDone`. When the history arrived (any attach
  // slower than the timer, i.e. the normal case over the relay) `landingStep` had
  // nothing pending, and the rows went through `contentGrew` with `animated: true`:
  // a visible scroll through the whole transcript, the owner's original complaint.
  const VIEWPORT = { content: 800, viewport: 800 };

  test("the empty state's measurement is not a landing round (no end to land at yet)", () => {
    const empty = landingStep(landingStart, VIEWPORT, true, NO_ROWS);
    expect(empty.step).toBeNull(); // a scroll to 0 here is the bug it fixes
    expect(empty.state).toEqual(landingStart); // still hidden, still pending
  });

  test("the real slow-attach order: empty state, timer, then history — silent, never animated", () => {
    // 1. mount: the layout and the empty list's content report the viewport height.
    const laid = landingStep(
      landingStep(landingStart, { content: 0, viewport: 800 }, true, NO_ROWS).state,
      VIEWPORT,
      true,
      NO_ROWS,
    );
    expect(laid.state.settling).toBe(true);
    // 2. 120 ms pass with no rows (the attach is still in flight): the timer fires.
    const shown = landingReveal(laid.state, VIEWPORT, true, NO_ROWS);
    expect(shown.state).toEqual(landingAwaiting); // the empty state IS shown
    expect(shown.step).toBeNull();
    // 3. the history arrives: it LANDS, not animated — the bug was `step: null`
    //    here, which dropped it into `contentGrew`'s animated scroll.
    const landed = landingStep(shown.state, LONG, true, ROWS);
    expect(landed.step).toEqual({ state: initialFollow, scrollTo: 39200, animated: false });
    expect(landed.state.settling).toBe(true); // hidden for its own landing
    // And nothing on this path ever asked for an animated scroll.
    expect(contentGrew(initialFollow, LONG).animated).toBe(true); // the path NOT taken
  });

  test("a tall content container with no rows is still 'nothing to land' (its height is not a transcript's)", () => {
    const tall = landingReveal(landingStart, { content: 4000, viewport: 800 }, true, NO_ROWS);
    expect(tall.state).toEqual(landingAwaiting);
    expect(tall.step).toBeNull(); // a scroll to 3200 on an empty list is nonsense
  });
});

describe("the follow TARGET is the true end (docs/fix/mobile-chat-glitches.md, bug 3)", () => {
  test("the end INCLUDES the list's bottom padding (native content height − viewport)", () => {
    // RN's `scrollToEnd` stops at the last CELL's end: 16 pt (the padding) short.
    // 1000 pt of cells + 16 pt padding = 1016 native content height.
    const step = contentGrew(initialFollow, { content: 1016, viewport: 600 });
    expect(step.scrollTo).toBe(416);
  });

  test("content shorter than the viewport → 0 (never a negative offset)", () => {
    expect(endOffset({ content: 200, viewport: VIEW })).toBe(0);
    expect(contentGrew(initialFollow, { content: 200, viewport: VIEW }).scrollTo).toBe(0);
  });

  test("an unknown size (0 before the first layout) scrolls nowhere", () => {
    expect(contentGrew(initialFollow, { content: 1016, viewport: 0 }).scrollTo).toBeNull();
    expect(contentGrew(initialFollow, { content: 0, viewport: 600 }).scrollTo).toBeNull();
    expect(viewportChanged(initialFollow, { content: 0, viewport: 600 }).scrollTo).toBeNull();
  });

  test("the viewport shrinks while following → scroll to the NEW end", () => {
    const step = viewportChanged(initialFollow, { content: 2000, viewport: 520 });
    expect(step.scrollTo).toBe(1480);
    expect(step.state).toEqual(initialFollow);
  });

  test("the viewport changes while NOT following → nothing, and no unseen mark (no content arrived)", () => {
    const up: Follow = { following: false, unseen: false };
    const step = viewportChanged(up, { content: 2000, viewport: 520 });
    expect(step.scrollTo).toBeNull();
    expect(step.state).toBe(up);
  });
});

describe("landingOwns — a landing debt belongs to a person still at the end (Review round 2, finding 3)", () => {
  test("nothing was pending and nothing is owed → the ordinary follow runs", () => {
    expect(landingOwns(landingDone, landingDone, true)).toBe(false);
  });

  test("a measurement the landing absorbs or ends is consumed while following", () => {
    expect(landingOwns(landingQuiet, landingQuiet, true)).toBe(true);
    // The one that ENDS it repeats the height its own silent scroll reached.
    expect(landingOwns(landingQuiet, landingDone, true)).toBe(true);
    // A hidden opening landing is never the person's to break out of.
    expect(landingOwns(landingStart, landingStart, true)).toBe(true);
  });

  test("a landing still OWED after it owns the list whether or not the person follows", () => {
    // The opening landing's rows arrive while they read further up: `settling`
    // still hides them, so the follow must not scroll a hidden list.
    expect(landingOwns(landingStart, landingStart, false)).toBe(true);
    expect(landingOwns(landingAwaiting, landingStart, false)).toBe(true);
  });

  test("scrolled up MID-landing, the history that arrives is NEWS for the pill, not consumed", () => {
    // The regression: `landingQuiet` armed at the end, the person scrolls up while
    // the resync is in flight, `landingStep`'s `!following` exit ends the landing
    // with no step — and "pending before" alone still said "consumed", so
    // `contentGrew` never ran and `unseen` stayed false: a whole laptop turn
    // arrived with the "Jump to latest" pill still silent.
    const ended = landingStep(landingQuiet, LONG, false, ROWS);
    expect(ended.step).toBeNull();
    expect(ended.state).toEqual(landingDone);
    expect(landingOwns(landingQuiet, ended.state, false)).toBe(false);
    // So the screen falls through to `contentGrew`, which marks it.
    expect(contentGrew({ following: false, unseen: false }, LONG)).toEqual({
      state: { following: false, unseen: true },
      scrollTo: null,
      animated: true,
    });
  });

  test("...and the same person still at the END keeps the silent landing (bug 4 unbroken)", () => {
    expect(landingOwns(landingQuiet, landingStep(landingQuiet, LONG, true, ROWS).state, true)).toBe(
      true,
    );
  });
});

/**
 * docs/fix/mobile-qa-1117.md, bug 5: a scroll to the end that RN issues in the
 * same frame as a layout change (the Queued panel appearing or leaving, a reply
 * arriving) can land at the end the native view had BEFORE that change — short
 * by the panel's height — while `following` stays true, so nothing ever corrects
 * it. `settleStep` is the check the screen runs once the measurements go quiet.
 */
describe("settleStep — following, but parked short of the true end", () => {
  test("following and short of the end by more than the slack → scroll to the true end", async () => {
    const { settleStep } = await import("../src/follow.ts");
    // The QA's case: content 3000, viewport 600 → end 2400; the list sat at 2140
    // (the end before a 260 pt panel shrank the viewport).
    expect(settleStep(initialFollow, { offset: 2140, content: 3000, viewport: 600 })).toEqual({
      state: initialFollow,
      scrollTo: 2400,
      animated: true,
    });
  });

  test("at the end (within the slack) → nothing to do", async () => {
    const { SETTLE_SLACK_PT, settleStep } = await import("../src/follow.ts");
    const m = { content: 3000, viewport: 600 };
    expect(settleStep(initialFollow, { ...m, offset: 2400 })).toBeNull();
    expect(settleStep(initialFollow, { ...m, offset: 2400 - SETTLE_SLACK_PT })).toBeNull();
  });

  test("the person scrolled up (not following) → never yanked", async () => {
    const { settleStep } = await import("../src/follow.ts");
    const reading: Follow = { following: false, unseen: true };
    expect(settleStep(reading, { offset: 100, content: 3000, viewport: 600 })).toBeNull();
  });

  test("nothing measured yet, or content shorter than the viewport → nothing", async () => {
    const { settleStep } = await import("../src/follow.ts");
    expect(settleStep(initialFollow, { offset: 0, content: 0, viewport: 600 })).toBeNull();
    expect(settleStep(initialFollow, { offset: 0, content: 400, viewport: 600 })).toBeNull();
  });
});

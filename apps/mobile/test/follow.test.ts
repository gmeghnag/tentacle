/**
 * Owner B5 (2026-11-15): the transcript must FOLLOW the streaming answer —
 * scroll to the bottom as content arrives — unless the person scrolled up, in
 * which case it stays put and offers a "Jump to latest" pill.
 */
import { describe, expect, test } from "bun:test";
import {
  type Follow,
  LANDING_ROUNDS,
  NEAR_BOTTOM_PT,
  contentGrew,
  endOffset,
  initialFollow,
  jumpPill,
  jumped,
  landingDone,
  landingQuiet,
  landingStart,
  landingStep,
  nearBottom,
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

describe("the initial landing (docs/fix/mobile-open-at-end.md, item 1)", () => {
  test("the first measurement of a long history lands at the end, NOT animated", () => {
    const first = landingStep(landingStart, LONG, true);
    expect(first.step).not.toBeNull();
    expect(first.step?.scrollTo).toBe(39200);
    expect(first.step?.animated).toBe(false);
    // A landing is following (the pill is not offered for one frame).
    expect(first.step?.state).toEqual(initialFollow);
  });

  test("it keeps landing silently while the end keeps moving, then stops", () => {
    // A silent scroll renders more cells, so the native content height grows
    // under it: each new measurement lands again, still not animated.
    const a = landingStep(landingStart, LONG, true);
    const b = landingStep(a.state, { content: 44000, viewport: 800 }, true);
    expect(b.step?.animated).toBe(false);
    expect(b.step?.scrollTo).toBe(43200);
    expect(b.state.settling).toBe(true);
    // The height repeats: this measurement lands (same offset) and the NEXT one
    // is what lets the list be shown — the shown frame is already at the end.
    const c = landingStep(b.state, { content: 44000, viewport: 800 }, true);
    expect(c.step).toEqual({ state: initialFollow, scrollTo: 43200, animated: false });
    expect(c.state.settling).toBe(false);
    // Settled: the ordinary follow rules from here on.
    const d = landingStep(c.state, { content: 44100, viewport: 800 }, true);
    expect(d.state.settling).toBe(false);
    expect(d.step).toBeNull();
    expect(contentGrew(initialFollow, { content: 44100, viewport: 800 }).animated).toBe(true);
  });

  test("an unknown size lands nowhere (a scroll to 0 would be the bug it fixes)", () => {
    const none = landingStep(landingStart, { content: 0, viewport: 0 }, true);
    expect(none.step).toBeNull();
    expect(none.state.rounds).toBe(0);
    expect(landingStep(landingStart, { content: 40000, viewport: 0 }, true).step).toBeNull();
  });

  test("a history shorter than the screen lands at 0 (no negative offset, no animation)", () => {
    const short = landingStep(landingStart, { content: 200, viewport: 800 }, true);
    expect(short.step?.scrollTo).toBe(0);
    expect(short.step?.animated).toBe(false);
  });

  test("a never-repeating content height still ends the landing (the list is never left hidden)", () => {
    let landing = landingStart;
    let rounds = 0;
    for (; rounds < 100; rounds += 1) {
      const next = landingStep(landing, { content: 1000 + rounds * 7, viewport: 800 }, true);
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
    const step = landingStep(landingQuiet, LONG, true);
    expect(step.step?.animated).toBe(false);
    expect(step.step?.scrollTo).toBe(39200);
    // Nothing was hidden: the rows were already shown before the re-attach.
    expect(step.state.settling).toBe(false);
  });

  test("a foreground resync while the person reads further up does NOT yank them to the end", () => {
    const step = landingStep(landingQuiet, LONG, false);
    expect(step.step).toBeNull();
    expect(step.state.silent).toBe(false);
  });

  test("with nothing pending the ordinary rules apply (a later append IS animated)", () => {
    const step = landingStep(landingDone, LONG, true);
    expect(step.step).toBeNull();
    expect(contentGrew(initialFollow, LONG).animated).toBe(true);
    expect(viewportChanged(initialFollow, LONG).animated).toBe(true);
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

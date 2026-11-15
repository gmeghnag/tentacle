/**
 * Owner B5 (2026-11-15): the transcript must FOLLOW the streaming answer —
 * scroll to the bottom as content arrives — unless the person scrolled up, in
 * which case it stays put and offers a "Jump to latest" pill.
 */
import { describe, expect, test } from "bun:test";
import {
  type Follow,
  NEAR_BOTTOM_PT,
  contentGrew,
  initialFollow,
  jumpPill,
  jumped,
  nearBottom,
  scrolled,
} from "../src/follow.ts";

const VIEW = 600;
/** Metrics with the viewport `fromBottom` points above the end of 2000 pt of content. */
const at = (fromBottom: number) => ({
  offset: 2000 - VIEW - fromBottom,
  content: 2000,
  viewport: VIEW,
});

describe("follow (B5)", () => {
  test("a fresh screen follows: new content scrolls to the end, no pill", () => {
    const step = contentGrew(initialFollow);
    expect(step.scrollToEnd).toBe(true);
    expect(jumpPill(step.state)).toBe(false);
  });

  test("the person scrolls UP: new content does not move the list, and the pill shows", () => {
    const up = scrolled(initialFollow, at(300), true);
    expect(up.following).toBe(false);
    expect(jumpPill(up)).toBe(true);
    const step = contentGrew(up);
    expect(step.scrollToEnd).toBe(false);
    expect(step.state.unseen).toBe(true);
    expect(jumpPill(step.state)).toBe(true);
  });

  test("scrolling back to the bottom by hand resumes following and hides the pill", () => {
    const up: Follow = { following: false, unseen: true };
    const back = scrolled(up, at(10), true);
    expect(back).toEqual({ following: true, unseen: false });
    expect(contentGrew(back).scrollToEnd).toBe(true);
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
});

import { describe, expect, test } from "bun:test";
import {
  anchorOffset,
  anchorOnGrowth,
  applyScroll,
  clampOffset,
  isScrolledUp,
  windowFor,
} from "../src/scroll.ts";

describe("clampOffset", () => {
  test("bounds to [0, total-height]", () => {
    expect(clampOffset(-5, 100, 20)).toBe(0);
    expect(clampOffset(1000, 100, 20)).toBe(80);
    expect(clampOffset(30, 100, 20)).toBe(30);
  });

  test("is zero when content fits the viewport", () => {
    expect(clampOffset(5, 10, 20)).toBe(0);
  });
});

describe("windowFor", () => {
  test("follows the tail at offset 0", () => {
    expect(windowFor(100, 20, 0)).toEqual({ start: 80, end: 100 });
  });

  test("scrolls up by the offset", () => {
    expect(windowFor(100, 20, 30)).toEqual({ start: 50, end: 70 });
  });

  test("shows everything when content fits", () => {
    expect(windowFor(5, 20, 0)).toEqual({ start: 0, end: 5 });
  });
});

describe("applyScroll", () => {
  test("line up/down move one row within bounds", () => {
    expect(applyScroll(0, "lineUp", 100, 20)).toBe(1);
    expect(applyScroll(1, "lineDown", 100, 20)).toBe(0);
    expect(applyScroll(0, "lineDown", 100, 20)).toBe(0);
  });

  test("page up/down move a viewport minus one", () => {
    expect(applyScroll(0, "pageUp", 100, 20)).toBe(19);
    expect(applyScroll(19, "pageDown", 100, 20)).toBe(0);
  });

  test("top goes to the oldest, bottom follows the tail", () => {
    expect(applyScroll(0, "top", 100, 20)).toBe(80);
    expect(applyScroll(80, "bottom", 100, 20)).toBe(0);
  });
});

describe("isScrolledUp", () => {
  test("true only when a positive offset survives clamping", () => {
    expect(isScrolledUp(0, 100, 20)).toBe(false);
    expect(isScrolledUp(5, 100, 20)).toBe(true);
    expect(isScrolledUp(5, 10, 20)).toBe(false); // content fits
  });
});

describe("anchorOnGrowth", () => {
  test("keeps the read position when content grows while scrolled up", () => {
    // Was 30 from the bottom of 100 rows; 10 rows appended → 40 from bottom.
    expect(anchorOnGrowth(30, 100, 110, 20)).toBe(40);
  });

  test("stays at the tail in follow mode", () => {
    expect(anchorOnGrowth(0, 100, 110, 20)).toBe(0);
  });

  test("does nothing when content shrinks or is unchanged", () => {
    expect(anchorOnGrowth(30, 100, 100, 20)).toBe(30);
    expect(anchorOnGrowth(30, 100, 90, 20)).toBe(30);
  });
});

/**
 * S13 (`feat/app-decomp-13-pure-residue`): the App's rows-changed anchor rule,
 * out of the effect and into `scroll.ts`. The property is the pair — an updater
 * ONLY when the reader is anchored (else `null`: the offset is never touched),
 * and the arithmetic read at COMMIT time, not at render time.
 */
describe("anchorOffset (the App's rows-changed rule)", () => {
  const apply = (updater: ((offset: number) => number) | null, commitOffset: number) =>
    updater === null ? null : updater(commitOffset);

  test("scrolled up and rows grew: the offset grows by the new rows", () => {
    // 30 from the bottom of 100, 10 rows appended => 40 from the bottom of 110.
    const updater = anchorOffset({
      prevTotal: 100,
      total: 110,
      rendered: 30,
      selecting: false,
      viewport: 20,
    });
    expect(apply(updater, 30)).toBe(40);
  });

  test("a selection anchors too, even in follow mode (offset 0)", () => {
    // The content being selected (e.g. during a running turn) must not move.
    const updater = anchorOffset({
      prevTotal: 100,
      total: 110,
      rendered: 0,
      selecting: true,
      viewport: 20,
    });
    expect(apply(updater, 0)).toBe(10);
  });

  test("nothing anchors the reader => null: the App does not touch the offset", () => {
    expect(
      anchorOffset({ prevTotal: 100, total: 110, rendered: 0, selecting: false, viewport: 20 }),
    ).toBeNull();
  });

  test("rows did not grow (shrunk or unchanged) => null, whatever the offset", () => {
    expect(
      anchorOffset({ prevTotal: 100, total: 100, rendered: 30, selecting: true, viewport: 20 }),
    ).toBeNull();
    expect(
      anchorOffset({ prevTotal: 100, total: 90, rendered: 30, selecting: true, viewport: 20 }),
    ).toBeNull();
  });

  test("the updater reads the COMMIT offset and clamps to the new total", () => {
    const updater = anchorOffset({
      prevTotal: 90,
      total: 100,
      rendered: 5,
      selecting: false,
      viewport: 8,
    });
    // A scroll key batched in the same tick: the guard saw 5, the arithmetic gets 9.
    expect(apply(updater, 9)).toBe(19);
    // Clamped: 100 rows, an 8-row viewport => 92 is the maximum offset.
    expect(apply(updater, 90)).toBe(92);
    // A commit offset back at the tail in the same tick still grows by the rows
    // (the guard, not the arithmetic, is what reads `rendered`).
    expect(apply(updater, 0)).toBe(10);
  });
});

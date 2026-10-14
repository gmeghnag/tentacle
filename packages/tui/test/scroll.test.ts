import { describe, expect, test } from "bun:test";
import {
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

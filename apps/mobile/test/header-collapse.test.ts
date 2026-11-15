/**
 * Slice-6 visual review V1: with the keyboard up, Pair scrolled its large title
 * away and its card ran under the clock. The compact bar shows exactly when the
 * large title has slid under it.
 */
import { describe, expect, test } from "bun:test";
import { COLLAPSE_AT, COMPACT_BAR_HEIGHT, compactTitleShown } from "../src/header-collapse.ts";
import { size, typography } from "../src/theme.ts";

describe("compactTitleShown", () => {
  test("hidden at rest and while the large title is still (partly) below the bar", () => {
    expect(compactTitleShown(0)).toBe(false);
    expect(compactTitleShown(COLLAPSE_AT - 1)).toBe(false);
  });
  test("shown once the large title is fully under the bar, and beyond", () => {
    expect(compactTitleShown(COLLAPSE_AT)).toBe(true);
    expect(compactTitleShown(600)).toBe(true);
  });
  test("the pull-to-refresh rubber band and a bad offset never show it", () => {
    expect(compactTitleShown(-80)).toBe(false);
    expect(compactTitleShown(Number.NaN)).toBe(false);
  });
  test("the threshold is the buttons row + the title line − the bar", () => {
    expect(COLLAPSE_AT).toBe(
      size.headerList + typography.largeTitle.lineHeight - COMPACT_BAR_HEIGHT,
    );
  });
});

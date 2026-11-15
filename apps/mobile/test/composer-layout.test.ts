/**
 * `composerBottomPadding` (B1): the composer clears the home indicator when the
 * keyboard is closed, and sits right on the keyboard when it is open.
 */
import { describe, expect, test } from "bun:test";
import { COMPOSER_MIN_PADDING, composerBottomPadding } from "../src/composer-layout.ts";

describe("composerBottomPadding", () => {
  test("Face ID iPhone, keyboard closed: the home-indicator inset (34)", () => {
    expect(composerBottomPadding({ insetBottom: 34, keyboard: false })).toBe(34);
  });

  test("Face ID iPhone, keyboard open: the minimum (the keyboard covers the indicator)", () => {
    expect(composerBottomPadding({ insetBottom: 34, keyboard: true })).toBe(COMPOSER_MIN_PADDING);
  });

  test("no home indicator (SE): the minimum, open or closed — same as before", () => {
    expect(composerBottomPadding({ insetBottom: 0, keyboard: false })).toBe(8);
    expect(composerBottomPadding({ insetBottom: 0, keyboard: true })).toBe(8);
  });

  test("an inset below the minimum never shrinks the padding", () => {
    expect(composerBottomPadding({ insetBottom: 4, keyboard: false })).toBe(8);
  });
});

/**
 * Swipe-to-time, the pure half (docs/fix/mobile-open-at-end.md, slice B): WHICH
 * gesture a row claims, how far it travels, and the label it reveals. React-free
 * and injected (`AGENTS` §7: the component only renders).
 *
 * Mutations that must turn these red: `dx < -SLOP` → `dx <= -SLOP`; drop the 2:1
 * ratio; drop the `hasTime` gate (a row with no time would move for nothing); the
 * resistance curve replaced by `dx` (no cap) — `revealOffset` must never pass
 * `-REVEAL`; `at > 0` → `at !== undefined` (a `0` would read 1970).
 */
import { describe, expect, test } from "bun:test";
import { REVEAL, SLOP, claimsPan, revealOffset, timeLabel } from "../src/row-swipe.ts";

describe("claimsPan: a clearly horizontal LEFTWARD move, on a row that has a time", () => {
  test("a long leftward horizontal move is ours", () => {
    expect(claimsPan({ dx: -40, dy: 2 }, true)).toBe(true);
  });

  test("vertical (a scroll), diagonal, rightward (the back-swipe) and sub-slop are not", () => {
    expect(claimsPan({ dx: -40, dy: 40 }, true)).toBe(false); // 1:1
    expect(claimsPan({ dx: -30, dy: 20 }, true)).toBe(false); // 1.5:1
    expect(claimsPan({ dx: 40, dy: 2 }, true)).toBe(false); // rightward: native back
    expect(claimsPan({ dx: -SLOP, dy: 0 }, true)).toBe(false); // not PAST the slop
    expect(claimsPan({ dx: -SLOP - 1, dy: 1 }, true)).toBe(true);
  });

  test("a row with no time never claims: no dead gesture", () => {
    expect(claimsPan({ dx: -200, dy: 0 }, false)).toBe(false);
  });

  test("exactly 2:1 is still ours (the ratio is a floor, not a bound)", () => {
    expect(claimsPan({ dx: -24, dy: 12 }, true)).toBe(true);
    expect(claimsPan({ dx: -24, dy: 13 }, true)).toBe(false);
  });
});

describe("revealOffset: resistance, capped, monotone", () => {
  test("no move (or a rightward one) reveals nothing", () => {
    expect(revealOffset(0)).toBe(0);
    expect(revealOffset(50)).toBe(0);
  });

  test("leftward moves back and never past -REVEAL, however far the finger goes", () => {
    for (const dx of [-1, -20, -SLOP, -REVEAL, -500, -100_000]) {
      const off = revealOffset(dx);
      expect(off).toBeLessThan(0);
      expect(off).toBeGreaterThanOrEqual(-REVEAL);
    }
    // Far past the cap it converges on the label's width, never beyond it.
    expect(revealOffset(-100_000)).toBeGreaterThanOrEqual(-REVEAL);
    expect(revealOffset(-1_000)).toBeLessThan(-REVEAL + 1);
  });

  test("monotone: each further left movement reveals more (never less)", () => {
    let previous = 0;
    for (let dx = -1; dx >= -400; dx -= 7) {
      const off = revealOffset(dx);
      expect(off).toBeLessThanOrEqual(previous);
      previous = off;
    }
  });

  test("resistance: one REVEAL of travel has revealed 60-70% of a linear drag", () => {
    const revealed = -revealOffset(-REVEAL);
    expect(revealed).toBeLessThan(REVEAL);
    expect(revealed).toBeGreaterThan(REVEAL * 0.6);
  });
});

describe("timeLabel: what the swipe shows", () => {
  const fmt = (ms: number) => `T${ms}`;

  test("a known time uses the injected formatter", () => {
    expect(timeLabel(1_700_000_000_000, fmt)).toBe("T1700000000000");
  });

  test("absent, zero or negative: nothing (an unknown arrival, never 1970)", () => {
    expect(timeLabel(undefined, fmt)).toBeNull();
    expect(timeLabel(0, fmt)).toBeNull();
    expect(timeLabel(-5, fmt)).toBeNull();
  });

  test("the default formatter is the DEVICE's locale; only its shape is pinned", () => {
    // Not a fixed string (12/24 h is the device's): the shape and the fact it is
    // a real formatting of that instant are what we pin.
    const label = timeLabel(1_700_000_000_000);
    expect(label).not.toBeNull();
    expect(label ?? "").toMatch(/\d/);
    expect((label ?? "").length).toBeLessThanOrEqual(8);
  });
});

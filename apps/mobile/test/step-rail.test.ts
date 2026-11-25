/**
 * docs/fix/mobile-step-rail.md decision 3 — the branch off the rail onto a step's
 * `$ command` line, as GEOMETRY (`src/step-rail.ts`). Review round 1, finding 2:
 * the branch was a fixed 3 pt box, so at Dynamic Type sizes it had no room for
 * its own turn radius and read as a tick instead of a curve.
 */
import { describe, expect, test } from "bun:test";
import { BRANCH_TURN, branchGeometry } from "../src/step-rail.ts";
import { DENSE_FONT_SCALE, size, typography } from "../src/theme.ts";

describe("the rail's branch to the `$` line (decision 3)", () => {
  test("it is a limb, not a tick, at every type scale", () => {
    for (const scale of [1, 1.15, 1.4, DENSE_FONT_SCALE]) {
      const g = branchGeometry(scale);
      // Taller than the turn's own radius: a shorter box clamps the radius into a
      // wedge — the 3 pt tick the review found.
      expect(g.height).toBeGreaterThan(BRANCH_TURN);
      expect(g.top).toBeGreaterThan(0);
    }
  });

  test("it follows Dynamic Type: a bigger type, a taller branch", () => {
    const small = branchGeometry(1);
    const big = branchGeometry(DENSE_FONT_SCALE);
    expect(big.height).toBeGreaterThan(small.height);
    // It lands ON the `$` line's middle: one grown title line, then half a grown
    // mono line below the row's top (the box ends exactly there).
    const title = typography.step.lineHeight * DENSE_FONT_SCALE;
    const mono = typography.stepMono.lineHeight * DENSE_FONT_SCALE;
    expect(big.top + big.height).toBeCloseTo(title + mono / 2, 5);
  });

  test("it ends ON the `$` line's middle at EVERY scale — never past it", () => {
    // At the default type the stacked line's two rows are centred in one touch
    // target, so the `$` line's middle is (touch − title − mono)/2 + title + mono/2.
    for (const scale of [1, 1.15, 1.4]) {
      const title = typography.step.lineHeight * scale;
      const mono = typography.stepMono.lineHeight * scale;
      const mid = Math.max(0, (size.touch - title - mono) / 2) + title + mono / 2;
      const g = branchGeometry(scale);
      expect(g.top + g.height).toBeCloseTo(mid, 5);
    }
  });

  test("the scale is capped where the step's own texts are, and followed below 1", () => {
    // Past `DENSE_FONT_SCALE` the texts stop growing, so the branch does too.
    expect(branchGeometry(3)).toEqual(branchGeometry(DENSE_FONT_SCALE));
    // iOS's smallest type (xSmall, ~0.82) shrinks the texts: the branch follows
    // them onto the `$` line, and still has room for its turn.
    const xs = 0.82;
    const title = typography.step.lineHeight * xs;
    const mono = typography.stepMono.lineHeight * xs;
    const g = branchGeometry(xs);
    expect(g.top + g.height).toBeCloseTo((size.touch - title - mono) / 2 + title + mono / 2, 5);
    expect(g.height).toBeGreaterThan(BRANCH_TURN);
  });
});

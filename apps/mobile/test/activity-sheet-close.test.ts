/**
 * The Activity sheet's close (docs/fix/mobile-activity-sheet-reclose.md): one
 * close is ONE close — the sheet goes down once and is never drawn again on its
 * way out.
 *
 * The owner's bug (real iPhone, build b39119de), reproduced in simulator frames
 * and in the sheet's own `onLayout`: the close's spring brought the sheet to
 * 34 pt (its bottom inset), then the layout read 440 pt — the CONTENT height —
 * for ~0.4 s, with no React render and the close still in flight, then 34 again.
 * The spring undershoots 0 by under a point; a negative `height` is not a size
 * to Yoga, which lays the view out at its content's height.
 *
 * `spring` is RN 0.88's `SpringAnimation.onUpdate` (under-damped branch, the
 * frames a 60 Hz JS driver draws) and `interpolate` is `AnimatedInterpolation`'s
 * linear map with its `extrapolate` modes — both small enough to restate, so
 * the drawn heights are computed with the sheet's REAL constants.
 */
import { describe, expect, test } from "bun:test";
import { PANEL_HEIGHT, PANEL_SPRING } from "../src/activity-panel.ts";

type Range = {
  readonly inputRange: readonly number[];
  readonly outputRange: readonly number[];
  readonly extrapolate?: "extend" | "clamp" | "identity";
  readonly extrapolateLeft?: "extend" | "clamp" | "identity";
  readonly extrapolateRight?: "extend" | "clamp" | "identity";
};

function interpolate(range: Range, input: number): number {
  const [inMin = 0, inMax = 1] = range.inputRange;
  const [outMin = 0, outMax = 1] = range.outputRange;
  const left = range.extrapolateLeft ?? range.extrapolate ?? "extend";
  const right = range.extrapolateRight ?? range.extrapolate ?? "extend";
  if (input < inMin) {
    if (left === "identity") return input;
    if (left === "clamp") return outMin;
  }
  if (input > inMax) {
    if (right === "identity") return input;
    if (right === "clamp") return outMax;
  }
  return outMin + ((input - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/** The spring's frames from `from` to `to`, at rest after `seconds`. */
function spring(from: number, to: number, seconds = 1.5): number[] {
  const { damping: c, stiffness: k, mass: m } = PANEL_SPRING;
  const zeta = c / (2 * Math.sqrt(k * m));
  const omega0 = Math.sqrt(k / m);
  const omega1 = omega0 * Math.sqrt(1 - zeta * zeta);
  const x0 = to - from;
  const frames: number[] = [];
  for (let t = 1 / 60; t <= seconds; t += 1 / 60) {
    const envelope = Math.exp(-zeta * omega0 * t);
    frames.push(
      to -
        envelope *
          (((zeta * omega0 * x0) / omega1) * Math.sin(omega1 * t) + x0 * Math.cos(omega1 * t)),
    );
  }
  return frames;
}

const drawn = (frames: readonly number[]) => frames.map((v) => interpolate(PANEL_HEIGHT, v));

describe("a close is drawn going down once (the owner's re-open)", () => {
  test("the spring itself undershoots 0 on a close — the trigger the drawn height must absorb", () => {
    // Pins the mechanism, not the fix: if the spring ever stops overshooting,
    // this says so, and the clamp below is then merely defensive.
    expect(
      PANEL_SPRING.damping / (2 * Math.sqrt(PANEL_SPRING.stiffness * PANEL_SPRING.mass)),
    ).toBeLessThan(1);
    expect(Math.min(...spring(451, 0))).toBeLessThan(0);
  });

  test("no frame of a close draws a negative height, from either detent", () => {
    for (const from of [140, 451, 780]) {
      const heights = drawn(spring(from, 0));
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
    }
  });

  test("once the sheet reached 0 on a close, its layout never grows again (no re-open)", () => {
    // Yoga as observed (`onLayout`): a negative `height` lays the sheet out at
    // its content height (440 pt in the repro); any other height is itself.
    const CONTENT = 440;
    const layout = drawn(spring(451, 0)).map((h) => (h < 0 ? CONTENT : h));
    const down = layout.findIndex((h) => h <= 0.5);
    expect(down).toBeGreaterThan(-1);
    expect(Math.max(...layout.slice(down))).toBeLessThanOrEqual(0.5);
  });

  test("an open still draws the spring as it is, its overshoot above the detent included", () => {
    const frames = spring(0, 451);
    expect(drawn(frames)).toEqual(frames);
    expect(Math.max(...frames)).toBeGreaterThan(451);
  });
});

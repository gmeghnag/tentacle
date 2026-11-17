/**
 * The live "Thinking…" node's motion (docs/fix/mobile-qa-sweep.md, addendum
 * 09:36, mockup B + D): the ∴'s three dots breathe in sequence top → right →
 * left over ~1.5 s, a shimmer sweeps the word over ~2.2 s, and Reduce Motion is
 * a static ∴ in accent + a plain grey word. The curves are pure so they are
 * tested here; `ui/StepNode.tsx` only feeds them to `Animated` (native driver).
 */
import { describe, expect, test } from "bun:test";
import {
  BREATHE_MS,
  DOT_ORDER,
  SHIMMER_MS,
  breatheCurve,
  shimmerSweep,
  thinkingLook,
} from "../src/thinking-motion.ts";

/** The curve's value at `x` (linear between its points), as Animated would give it. */
function at(curve: { inputRange: readonly number[]; outputRange: readonly number[] }, x: number) {
  const { inputRange: i, outputRange: o } = curve;
  for (let k = 1; k < i.length; k += 1) {
    const a = i[k - 1] ?? 0;
    const b = i[k] ?? 1;
    if (x <= b) {
      const t = b === a ? 0 : (x - a) / (b - a);
      return (o[k - 1] ?? 0) + t * ((o[k] ?? 0) - (o[k - 1] ?? 0));
    }
  }
  return o[o.length - 1] ?? 0;
}

function peak(curve: { inputRange: readonly number[]; outputRange: readonly number[] }): number {
  let best = 0;
  let bestX = 0;
  for (let x = 0; x <= 1; x += 0.001) {
    const v = at(curve, x);
    if (v > best) {
      best = v;
      bestX = x;
    }
  }
  return bestX;
}

describe("the ∴ breathes (B)", () => {
  test("~1.5 s, three dots in the order top → right → left", () => {
    expect(BREATHE_MS).toBe(1500);
    expect(DOT_ORDER).toEqual(["top", "right", "left"]);
  });

  test("each curve is a valid Animated range: [0..1], strictly increasing, periodic", () => {
    for (let i = 0; i < 3; i += 1) {
      const c = breatheCurve(i);
      expect(c.inputRange[0]).toBe(0);
      expect(c.inputRange[c.inputRange.length - 1]).toBe(1);
      for (let k = 1; k < c.inputRange.length; k += 1) {
        expect(c.inputRange[k] ?? 0).toBeGreaterThan(c.inputRange[k - 1] ?? 0);
      }
      expect(c.outputRange.length).toBe(c.inputRange.length);
      // A loop restarts at 0: the end must meet the start, or the dot blinks.
      expect(c.outputRange[0]).toBeCloseTo(c.outputRange[c.outputRange.length - 1] ?? -1, 5);
      expect(Math.min(...c.outputRange)).toBeCloseTo(0.28, 5);
      expect(Math.max(...c.outputRange)).toBeCloseTo(1, 5);
    }
  });

  test("the dots peak one after another, 0.25 s apart, in DOT_ORDER", () => {
    const peaks = [0, 1, 2].map((i) => peak(breatheCurve(i)) * BREATHE_MS);
    expect(peaks[0]).toBeCloseTo(450, -1);
    expect(peaks[1]).toBeCloseTo(700, -1);
    expect(peaks[2]).toBeCloseTo(950, -1);
  });
});

describe("the word shimmers (D)", () => {
  test("~2.2 s, a band that enters fully off the left and leaves fully off the right", () => {
    expect(SHIMMER_MS).toBe(2200);
    const s = shimmerSweep(100);
    expect(s.band).toBeGreaterThan(0);
    expect(s.band).toBeLessThan(100);
    expect(s.from).toBe(-s.band);
    expect(s.to).toBe(100);
  });

  test("an unmeasured word (width 0) sweeps nothing", () => {
    expect(shimmerSweep(0).band).toBe(0);
  });
});

describe("Reduce Motion", () => {
  test("off: animated dots + shimmer; on: a static ∴ in accent, dots solid, plain grey word", () => {
    expect(thinkingLook(false)).toEqual({ animate: true, glyph: "accent", word: "sec" });
    expect(thinkingLook(true)).toEqual({ animate: false, glyph: "accent", word: "sec" });
  });
});

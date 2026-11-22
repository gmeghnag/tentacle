/**
 * docs/fix/mobile-running-row.md (owner 21/11, feat/shell-intent-line mockup
 * section C): a RUNNING tool step's node is the TUI's blinking dot — the done
 * dot's place and size, in accent, ON then OFF on the TUI's rhythm — not a
 * turning ring. Reduce Motion: a steady dot. The meaning is never the hue alone
 * (owner colour-blind): the blink and the trailing text tell running from done.
 */
import { describe, expect, test } from "bun:test";
import { BLINK_HALF_MS } from "../../../packages/tui/src/blink.ts";
import { STEP_BLINK_HALF_MS } from "../src/motion.ts";
import { STEP_BLINK_CURVE, runningDotLook } from "../src/step-blink.ts";

/** The curve's value at `x` (linear between its points), as Animated gives it. */
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

describe("the running step's node blinks like the TUI's bullet", () => {
  test("the phone's half-period IS the TUI's (500 ms ON, 500 ms OFF)", () => {
    expect(STEP_BLINK_HALF_MS).toBe(BLINK_HALF_MS);
  });

  test("a dot (not a ring), in accent, blinking; Reduce Motion: the same dot, steady", () => {
    expect(runningDotLook(false)).toEqual({ shape: "dot", fill: "accent", blink: true });
    expect(runningDotLook(true)).toEqual({ shape: "dot", fill: "accent", blink: false });
  });

  test("one loop: fully ON for the first half, fully OFF for the second — a blink, not a fade", () => {
    for (const x of [0, 0.1, 0.25, 0.45, 0.498]) {
      expect(at(STEP_BLINK_CURVE, x)).toBe(1);
    }
    for (const x of [0.5, 0.6, 0.75, 0.99, 1]) {
      expect(at(STEP_BLINK_CURVE, x)).toBe(0);
    }
  });

  test("the curve is valid for Animated: input 0..1, non-decreasing, one output per input", () => {
    const { inputRange, outputRange } = STEP_BLINK_CURVE;
    expect(inputRange[0]).toBe(0);
    expect(inputRange[inputRange.length - 1]).toBe(1);
    expect(outputRange).toHaveLength(inputRange.length);
    for (let k = 1; k < inputRange.length; k += 1) {
      expect((inputRange[k] ?? 0) > (inputRange[k - 1] ?? 0)).toBe(true);
    }
  });
});

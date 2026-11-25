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
import { STEP_BLINK_CURVE, runningDotLook, thoughtLook } from "../src/step-blink.ts";
import { darkPalette, lightPalette, petrolPalette } from "../src/theme.ts";

/** WCAG relative luminance of a `#rrggbb`.
 *  (The same figure `hub-opacity-band-look.test.ts` draws.) */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

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

describe("the reasoning node: a filled accent dot while thinking, a dim ring once thought", () => {
  test("live (Thinking) → thinking-live, filled accent — the same look as a running tool", () => {
    expect(thoughtLook(true)).toEqual({ node: "thinking-live", fill: "accent", ring: null });
    // Same size and place, and the SAME blink clock (never a second timer): the
    // running tool's look is what the live thought reuses.
    expect(thoughtLook(true).fill).toBe(runningDotLook(false).fill);
  });

  test("done (Thought) → thought-done, an outline in the dim token, never filled", () => {
    expect(thoughtLook(false)).toEqual({ node: "thought-done", fill: null, ring: "thought" });
  });

  test("the dim token is a palette entry in all three variants, close to the rail", () => {
    for (const palette of [lightPalette, darkPalette, petrolPalette]) {
      expect(typeof palette.thought).toBe("string");
      expect(palette.thought).not.toBe(palette.sep);
    }
    // Quiet, so a finished thought steps back behind the actions: nearer the rail
    // than the label it sits beside.
    expect(contrast(lightPalette.thought, lightPalette.page)).toBeLessThan(
      contrast(lightPalette.label, lightPalette.page),
    );
    expect(contrast(darkPalette.thought, darkPalette.page)).toBeLessThan(
      contrast(darkPalette.label, darkPalette.page),
    );
  });
});

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

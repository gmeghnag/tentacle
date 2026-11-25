/**
 * The live "Thinking…" node's motion (docs/fix/mobile-qa-sweep.md, addendum
 * 09:36, mockup B + D): the ∴'s three dots breathe in sequence top → right →
 * left over ~1.5 s, a shimmer sweeps the word over ~2.2 s, and Reduce Motion is
 * a static ∴ in accent + a plain grey word. The curves are pure so they are
 * tested here; `ui/StepNode.tsx` only feeds them to `Animated` (native driver).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BREATHE_MS,
  DOT_ORDER,
  SHIMMER_MS,
  breatheCurve,
  shimmerCanvas,
  shimmerFont,
  shimmerLine,
  shimmerSweep,
  thinkingElapsed,
  thinkingLabel,
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

  test("the band is a SOFT gradient: transparent at both edges, full at the centre — no hard edge to show (mutation: edge opacity 1 → red)", () => {
    const { stops, band } = shimmerSweep(120);
    expect(band).toBe(48); // ≈ 40 % of the word
    expect(Array.isArray(stops)).toBe(true);
    expect(stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(stops[0]?.opacity).toBe(0);
    expect(stops[stops.length - 1]?.opacity).toBe(0);
    expect(Math.max(...stops.map((s) => s.opacity))).toBe(1);
    expect(stops[1]?.opacity).toBe(1);
  });

  test("at both ends of the loop the band lies wholly off the glyphs (no bright sliver at a loop restart)", () => {
    for (const width of [1, 37, 120, 400]) {
      const s = shimmerSweep(width);
      expect(s.from + s.band).toBeLessThanOrEqual(0);
      expect(s.to).toBeGreaterThanOrEqual(width);
    }
  });
});

/**
 * docs/fix/mobile-running-row.md: the svg layer that draws the shimmering label
 * must draw the SAME text, in the SAME face, inside a canvas big enough for the
 * glyphs — the owner's phone showed «Test DNS 50 query con l» (the sentence cut
 * mid-word at the 45 % cap, no ellipsis) and «Thinkinɡ» (the italic g's tail
 * cut at the measured advance width), in the default theme and the Figtree beta.
 */
describe("the shimmering label's svg text (docs/fix/mobile-running-row.md)", () => {
  test("one laid-out line: the whole text, as is", () => {
    expect(shimmerLine([{ text: "Thinking" }])).toBe("Thinking");
    expect(shimmerLine([{ text: "Test DNS con 50 query" }])).toBe("Test DNS con 50 query");
  });

  test("more lines (the row is too narrow): the first line, cut at a word, ending in …", () => {
    expect(
      shimmerLine([{ text: "Test DNS con 50 query e latenze " }, { text: "misurate per ogni" }]),
    ).toBe("Test DNS con 50 query e…");
  });

  test("the … never makes the line wider: at least the last word goes (mutation: keep it → red)", () => {
    const first = "Test DNS con 50 query e latenze ";
    const cut = shimmerLine([{ text: first }, { text: "misurate" }]);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(first.trimEnd().length);
    expect(first.startsWith(cut.slice(0, -1))).toBe(true);
  });

  test("one word wider than the row (broken mid-word): two characters make room for the …", () => {
    expect(shimmerLine([{ text: "supercalifragilistic" }, { text: "expialidocious" }])).toBe(
      "supercalifragilist…",
    );
  });

  test("nothing laid out yet: nothing to draw", () => {
    expect(shimmerLine([])).toBe("");
  });

  test("the svg face is the RN text's face: Figtree under the beta, the system font otherwise", () => {
    expect(shimmerFont(null, "500")).toEqual({ fontWeight: "500", fontStyle: "italic" });
    // 500 is Medium Italic now that the face ships (docs/fix/mobile-transcript-type.md).
    expect(shimmerFont("figtree", "500")).toEqual({
      fontFamily: "Figtree-MediumItalic",
      fontWeight: "500",
      fontStyle: "italic",
    });
  });

  test("the canvas leaves room past the advance width for an italic overhang and a descender", () => {
    const c = shimmerCanvas(61.4, 20, 14);
    // Never narrower than the laid-out text, and a margin of ≥ 20 % of the size
    // to its right (an italic g/f/y leans past its advance) and below.
    expect(c.width).toBeGreaterThanOrEqual(61.4 + 14 * 0.2);
    expect(c.height).toBeGreaterThanOrEqual(20 + 14 * 0.2);
    expect(Number.isInteger(c.width) && Number.isInteger(c.height)).toBe(true);
    expect(shimmerCanvas(0, 0, 14)).toEqual({ width: 0, height: 0 });
  });
});

/**
 * Review round 1, finding 1: S1 shipped `shimmerStops`, which nothing imported
 * and nothing tested — a peak-opacity mutation there survived the suite. The
 * rule this pins is the one that would have caught it: this module exports the
 * curves the component draws, what the row SAYS (`thinkingElapsed`,
 * `thinkingLabel`), and nothing else. A symbol the plan has not justified is a
 * symbol with no consumer — it waits for its own slice, with its own test.
 */
/**
 * The ONE list of what `thinking-motion.ts` may export: the curves the component
 * draws (mockup B + D), and what the row says (S1). Anything else is a symbol
 * nothing declared a use for.
 */
const EXPORTS = [
  "BREATHE_MS",
  "SHIMMER_MS",
  "DOT_ORDER",
  "DotPos",
  "Curve",
  "breatheCurve",
  "shimmerSweep",
  "shimmerLine",
  "shimmerFont",
  "shimmerCanvas",
  "thinkingLook",
  "thinkingElapsed",
  "thinkingLabel",
];

describe("thinking-motion exports only what it is meant to", () => {
  test("the module's source declares nothing beyond that list (mutation: add `shimmerStops` back → red)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "thinking-motion.ts"), "utf8");
    const declared = [...src.matchAll(/^export (?:const|function|interface|type) (\w+)/gm)].map(
      (m) => m[1] ?? "",
    );
    // Not vacuous: the regex must find this module's exports at all.
    expect(declared.length).toBe(EXPORTS.length);
    expect([...declared].sort()).toEqual([...EXPORTS].sort());
  });
});

describe("Reduce Motion", () => {
  test("off: animated dots + shimmer; on: a static ∴ in accent, dots solid, plain grey word", () => {
    expect(thinkingLook(false)).toEqual({ animate: true, glyph: "accent", word: "sec" });
    expect(thinkingLook(true)).toEqual({ animate: false, glyph: "accent", word: "sec" });
  });
});

/**
 * docs/feat/mobile-thinking-images.md S1 (Owner Q1 = "B + seconds"): the word
 * loses its "…" — the seconds say it is moving — and they are written with a
 * STEADY width (zero-padded, drawn in tabular figures), so the trailing text
 * never jumps as it counts. `liveElapsed` keeps its own shape for tool rows.
 */
describe("thinkingElapsed — the seconds beside the word", () => {
  test("under a minute: whole seconds, no padding needed", () => {
    expect(thinkingElapsed(0)).toBe("0 s");
    expect(thinkingElapsed(-5)).toBe("0 s");
    expect(thinkingElapsed(999)).toBe("0 s");
    expect(thinkingElapsed(1000)).toBe("1 s");
    expect(thinkingElapsed(59_999)).toBe("59 s");
  });

  test("minutes: the seconds are zero-padded, so the width holds (mutation: `${s}` → “1 min 5 s” is a char shorter and the row twitches)", () => {
    expect(thinkingElapsed(60_000)).toBe("1 min 00 s");
    expect(thinkingElapsed(65_000)).toBe("1 min 05 s");
    expect(thinkingElapsed(125_400)).toBe("2 min 05 s");
    expect(thinkingElapsed(3_599_000)).toBe("59 min 59 s");
  });

  test("an hour and beyond: hours + padded minutes — never “120 min” (mutation: reuse `liveElapsed` → 2 h reads “120 min 0 s”)", () => {
    expect(thinkingElapsed(3_600_000)).toBe("1 h 00 min");
    expect(thinkingElapsed(7_320_000)).toBe("2 h 02 min");
  });

  test("the width holds until a unit gains a digit (the padding is what tabular figures hold)", () => {
    const width = (ms: number) => thinkingElapsed(ms).length;
    // 9 s → 10 s is the one place the digits grow under a minute: padding
    // cannot help a two-digit count start at one digit, so 0..9 s is drawn as
    // `N s` and the width steps up once, at 10 s.
    expect(width(5_000)).toBe(1 + " s".length);
    expect(width(10_000)).toBe(2 + " s".length);
    // From a minute on the seconds are zero-padded, so the width is constant
    // while the minute count keeps its digits (mutation: `${sec}` instead of
    // the padding → "1 min 5 s" is a char shorter than "1 min 00 s").
    const oneDigitMinutes = [60_000, 65_000, 599_000];
    expect(new Set(oneDigitMinutes.map(width)).size).toBe(1);
    const twoDigitMinutes = [600_000, 3_599_000];
    expect(new Set(twoDigitMinutes.map(width)).size).toBe(1);
    // A second minute digit is the honest exception: tabular figures steady the
    // digits, they cannot remove one.
    expect(width(600_000)).toBe(width(60_000) + 1);
    // Hours + padded minutes, same rule.
    const oneDigitHours = [3_600_000, 7_320_000];
    expect(new Set(oneDigitHours.map(width)).size).toBe(1);
  });
});

describe("thinkingLabel — the word and its clock, one call", () => {
  test("the word is “Thinking”, with no ellipsis (mutation: keep “Thinking…” → the mockup's word plus a dangling …)", () => {
    expect(thinkingLabel(0).word).toBe("Thinking");
    expect(thinkingLabel(12_900).word).toBe("Thinking");
  });

  test("the seconds are the same clock `thinkingElapsed` writes", () => {
    expect(thinkingLabel(0).seconds).toBe("0 s");
    expect(thinkingLabel(12_900).seconds).toBe("12 s");
    expect(thinkingLabel(125_000).seconds).toBe("2 min 05 s");
  });
});

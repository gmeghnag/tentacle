/**
 * The live "Thinking…" node's motion (docs/fix/mobile-qa-sweep.md, addendum
 * 09:36 — mockup B + D, `.tentacle/mockups/mobile-thinking-anim/`): the ∴'s
 * three dots breathe one after another (top → right → left, ~1.5 s, accent) and
 * a shimmer clipped to its glyphs sweeps the word "Thinking" (~2.2 s). Reduce Motion: a static ∴ in
 * accent and a plain grey word.
 *
 * Pure, React-free (AGENTS §7): the curves are numbers `ui/StepNode.tsx` hands
 * to `Animated.Value.interpolate` on the native driver (no JS timer per frame).
 */
import { formatClock } from "./clock.ts";
import { type AppFont, textFont } from "./theme-beta.ts";

/** One breath of the ∴, all three dots. */
export const BREATHE_MS = 1500;
/** One shimmer sweep across the word. */
export const SHIMMER_MS = 2200;
/** The order the dots light up in. */
export const DOT_ORDER = ["top", "right", "left"] as const;
export type DotPos = (typeof DOT_ORDER)[number];

/** An `Animated` interpolation over one loop (input 0..1). */
export interface Curve {
  readonly inputRange: readonly number[];
  readonly outputRange: readonly number[];
}

/** A dot at rest; it peaks at 1 (the mockup's `breathe` keyframes). */
const LOW = 0.28;
/** One dot's breath over one loop: rest, peak at 30 %, rest again at 60 %. */
const BREATH: readonly (readonly [number, number])[] = [
  [0, LOW],
  [0.3, 1],
  [0.6, LOW],
  [1, LOW],
];
/** Each next dot starts this much later (the mockup's 0.25 s stagger). */
const STAGGER_MS = 250;

/** The breath's value at `phase` (0..1), linear between keyframes. */
function breath(phase: number): number {
  for (let k = 1; k < BREATH.length; k += 1) {
    const [a, va] = BREATH[k - 1] ?? [0, LOW];
    const [b, vb] = BREATH[k] ?? [1, LOW];
    if (phase <= b) {
      return va + ((phase - a) / (b - a)) * (vb - va);
    }
  }
  return LOW;
}

/**
 * Dot `dot`'s (index into `DOT_ORDER`) opacity over one loop of the shared
 * clock: the breath shifted by its stagger and wrapped, so a loop that restarts
 * at 0 meets its own end (no blink).
 */
export function breatheCurve(dot: number): Curve {
  const delay = (dot * STAGGER_MS) / BREATHE_MS;
  const wrap = (x: number): number => Math.round((((x % 1) + 1) % 1) * 1e6) / 1e6;
  const points = [0, 1, ...BREATH.map(([p]) => wrap(p + delay))];
  const inputRange = [...new Set(points)].sort((a, b) => a - b);
  return { inputRange, outputRange: inputRange.map((x) => breath(wrap(x - delay))) };
}

/** The gradient across the band: transparent → full → transparent (no hard edge). */
const SHINE_STOPS: readonly { readonly offset: number; readonly opacity: number }[] = [
  { offset: 0, opacity: 0 },
  { offset: 0.5, opacity: 1 },
  { offset: 1, opacity: 0 },
];

/**
 * The shimmer over a word `width` pt wide (docs/feat/mobile-thinking-images.md
 * S2): a band ≈ 40 % of the word whose `x` runs from wholly off the word's left
 * edge to wholly off its right one, filled with a soft gradient (`stops`, as
 * `offset` 0..1 across the band and `opacity` of the bright colour).
 * `ui/StepNode.tsx` clips it to the word's glyphs, so only the letters brighten.
 * Width 0 (not measured yet) sweeps nothing.
 */
export function shimmerSweep(width: number): {
  readonly band: number;
  readonly from: number;
  readonly to: number;
  readonly stops: readonly { readonly offset: number; readonly opacity: number }[];
} {
  const band = width > 0 ? Math.round(width * 0.4) : 0;
  return { band, from: -band, to: width, stops: band > 0 ? SHINE_STOPS : [] };
}

/**
 * The elapsed clock beside the word, written with a STEADY width so the row does
 * not jump as it counts: `0 s` … `59 s`, then `1 min 05 s` (the seconds
 * zero-padded), then `1 h 02 min` from the first hour. `ui/StepNode.tsx`
 * (`ThinkingNode`) draws it in `palette.sec` with tabular figures; the format
 * itself is `clock.ts`'s `thinking` one.
 *
 * `liveElapsed` (`tool-summary.ts`) is a tool row's duration — that one is NOT
 * tabular, does not pad, and reads `120 min` after two hours; the live Thinking
 * row is the one place the width has to hold.
 */
export function thinkingElapsed(ms: number): string {
  return formatClock("thinking", ms);
}

/**
 * What the live row says: the word (no ellipsis — the clock is what says "still
 * going") and the elapsed time to set beside it; `ThinkingNode`
 * (`ui/StepNode.tsx`) draws both.
 */
export function thinkingLabel(ms: number): {
  readonly word: "Thinking";
  readonly seconds: string;
} {
  return { word: "Thinking", seconds: thinkingElapsed(ms) };
}

/**
 * What the node shows: animated (dots breathing, word shimmering) unless Reduce
 * Motion is on — then a static ∴ in accent (the dots solid) and a plain grey word.
 */
export function thinkingLook(reduceMotion: boolean): {
  readonly animate: boolean;
  readonly glyph: "accent";
  readonly word: "sec";
} {
  return { animate: !reduceMotion, glyph: "accent", word: "sec" };
}

/**
 * The text the shimmer's svg layer writes (docs/fix/mobile-running-row.md). The
 * svg cannot ellipsize, so it is told what fits: the label's own RN lines
 * (`onTextLayout` of the same text, wrapped at the label's REAL width). One
 * line: all of it. More (the row is too narrow): the first line, cut at a word —
 * at least its last word goes, so the `…` takes room that word had — or, one
 * word wider than the row, two characters. Before it was the WHOLE text drawn
 * into a box the RN text had ellipsized: «Test DNS 50 query con l», cut mid-word.
 */
export function shimmerLine(lines: readonly { readonly text: string }[]): string {
  const first = (lines[0]?.text ?? "").trimEnd();
  if (lines.length <= 1) {
    return first;
  }
  const space = first.lastIndexOf(" ");
  const kept = space > 0 ? first.slice(0, space).trimEnd() : first.slice(0, -2);
  return `${kept}…`;
}

/**
 * The svg glyphs' face: the RN label's own, from the same seam (`textFont`) — a
 * Figtree face under the beta theme, the system font (no family) otherwise.
 * Before, the svg had no family, so under the beta it drew the system font into
 * a box measured in Figtree.
 */
export function shimmerFont(
  font: AppFont,
  weight: string,
): {
  readonly fontFamily?: string;
  readonly fontWeight: string;
  readonly fontStyle: "normal" | "italic";
} {
  const { patch } = textFont({ fontWeight: weight, fontStyle: "italic" }, {}, font);
  return patch === null
    ? { fontWeight: weight, fontStyle: "italic" }
    : { fontFamily: patch.fontFamily, fontWeight: patch.fontWeight, fontStyle: patch.fontStyle };
}

/** The canvas's margin past the text, in font sizes: an italic tail, a descender. */
const OVERHANG = 0.3;

/**
 * The svg canvas over a label laid out `width` × `height`: whole points, with a
 * margin to the right and below, so an italic glyph leaning past its advance
 * width (the g of «Thinking») is not cut by the canvas edge. Before, the canvas
 * was the advance width, rounded — «Thinkinɡ». 0 × 0 until measured.
 */
export function shimmerCanvas(
  width: number,
  height: number,
  fontSize: number,
): { readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const pad = Math.ceil(fontSize * OVERHANG);
  return { width: Math.ceil(width) + pad, height: Math.ceil(height) + pad };
}

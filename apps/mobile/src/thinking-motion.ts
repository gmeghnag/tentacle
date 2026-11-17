/**
 * The live "Thinking…" node's motion (docs/fix/mobile-qa-sweep.md, addendum
 * 09:36 — mockup B + D, `.tentacle/mockups/mobile-thinking-anim/`): the ∴'s
 * three dots breathe one after another (top → right → left, ~1.5 s, accent) and
 * a shimmer sweeps the word "Thinking…" (~2.2 s). Reduce Motion: a static ∴ in
 * accent and a plain grey word.
 *
 * Pure, React-free (AGENTS §7): the curves are numbers `ui/StepNode.tsx` hands
 * to `Animated.Value.interpolate` on the native driver (no JS timer per frame).
 */

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

/**
 * The shimmer's bright band over a word `width` pt wide: it starts wholly off
 * the word's left edge and ends wholly off its right one. Width 0 (not measured
 * yet) sweeps nothing.
 */
export function shimmerSweep(width: number): {
  readonly band: number;
  readonly from: number;
  readonly to: number;
} {
  const band = width > 0 ? Math.round(width * 0.4) : 0;
  return { band, from: -band, to: width };
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

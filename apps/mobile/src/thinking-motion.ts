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
 * The shimmer's bright band over a word `width` pt wide.
 *
 * Since docs/feat/mobile-thinking-images.md (Owner Q1 = "B") the bright layer is
 * CLIPPED to the glyphs, so there is no window to translate: what moves is the
 * gradient's own stops, `x1`/`x2` running from wholly off the left edge to
 * wholly off the right one (`from`/`to`). `band` — the soft 0 → peak → 0 alpha
 * span, ≈ 40 % of the word — is what those stops carry with them; a frame with a
 * hard edge would be the rectangle this task removed.
 *
 * Width 0 (not measured yet) sweeps nothing: every stop sits at 0, so the
 * gradient is flat and the word is just its base colour.
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
 * The gradient's stops for a sweep at `x` (the animated `x1`/`x2`, one number:
 * the band's left edge), over a word `width` pt wide. Three stops — clear, the
 * bright peak, clear again — so the bright copy FADES INTO the grey one at both
 * ends instead of ending on an edge.
 *
 * Pure, and the only place the softness is decided (§7): the component feeds the
 * numbers to `Animated` and draws them.
 */
export function shimmerStops(
  width: number,
  x: number,
): readonly { readonly offset: number; readonly opacity: number }[] {
  const band = shimmerSweep(width).band;
  if (band === 0) {
    // Nothing measured: a flat, fully clear gradient (no sweep at all).
    return [
      { offset: 0, opacity: 0 },
      { offset: 0.5, opacity: 0 },
      { offset: 1, opacity: 0 },
    ];
  }
  // The stops are fractions of the band's own box, which spans `x .. x + band`.
  return [
    { offset: 0, opacity: 0 },
    { offset: 0.5, opacity: 1 },
    { offset: 1, opacity: 0 },
  ];
}

/**
 * The elapsed clock beside the word, written with a STEADY width so the row does
 * not jump as it counts (drawn in tabular figures): `0 s` … `59 s`, then
 * `1 min 05 s` (the seconds zero-padded), then `1 h 02 min` from the first hour.
 *
 * `liveElapsed` (`tool-summary.ts`) stays as it is for a tool row's duration —
 * that one is NOT tabular, does not pad, and reads `120 min` after two hours;
 * the live Thinking row is the one place the width has to hold.
 */
export function thinkingElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  if (seconds < 3600) {
    const sec = seconds % 60;
    return `${Math.floor(seconds / 60)} min ${sec < 10 ? `0${sec}` : `${sec}`} s`;
  }
  const min = Math.floor((seconds % 3600) / 60);
  return `${Math.floor(seconds / 3600)} h ${min < 10 ? `0${min}` : `${min}`} min`;
}

/**
 * What the live row says: the word (no ellipsis — the clock is what says "still
 * going") and the elapsed time beside it, in `palette.sec` and tabular figures.
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

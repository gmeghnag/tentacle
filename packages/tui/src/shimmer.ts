/**
 * The shimmer across the turn indicator's WORD (docs/feat/tui-thinking-shimmer.md).
 *
 * A soft highlight sweeps left to right over `Thinking…` / `Working…`, then the
 * label rests for a few ticks, then it sweeps again. Pure and framework-free: a
 * tick counter in, coloured spans out — the component only maps `tone` to a
 * palette colour (AGENTS §7).
 *
 * The ONE invariant everything else is built on: the spans CONCATENATE TO THE
 * LABEL, for every tick, forever. A sweep that added or dropped a cell would move
 * the TUI's rows every 80 ms — far worse than no shimmer — so the sweep measures
 * CELLS (`cells.ts`), not code points, and never splits a grapheme.
 *
 * Colours are the palette's, not ours: `base` is today's accent, `mid`/`peak` are
 * `theme.ts`'s two shimmer tokens, per mode. With colour off the caller passes
 * `color: false` and gets the plain label — the honest degradation, exactly as
 * `blink.ts` degrades a concealed bullet to a steady one.
 */
import { cellWidth, graphemes } from "./cells.ts";

/** How the sweep paints one run of the label. */
export type ShimmerTone = "base" | "mid" | "peak";

/** One painted run: its text, unchanged, and the tone it takes. */
export interface ShimmerSpan {
  readonly text: string;
  readonly tone: ShimmerTone;
}

/** The highlight's width in cells: a `mid`, a `peak`, a `mid`. */
export const SHIMMER_WINDOW = 3;

/** The label rests, fully base, for this many ticks after a sweep. */
export const SHIMMER_PAUSE_TICKS = 5;

/**
 * One sweep step. The spinner already re-renders every 80 ms, so the sweep rides
 * that clock: no timer of its own (the plan's whole point).
 */
export const SHIMMER_TICK_MS = 80;

export interface ShimmerOptions {
  /** Rest ticks after a sweep. Defaults to {@link SHIMMER_PAUSE_TICKS}. */
  readonly pauseTicks?: number;
  /** Colour on? `false` ⇒ one base span: the plain label, no animation. */
  readonly color?: boolean;
}

/** How many ticks one full sweep-plus-pause takes for `label`. */
export function shimmerPeriod(label: string, options: ShimmerOptions = {}): number {
  const pause = Math.max(0, Math.floor(options.pauseTicks ?? SHIMMER_PAUSE_TICKS));
  // The window slides from fully left to fully right: total + window - 1 phases.
  return Math.max(1, cellWidth(label) + SHIMMER_WINDOW - 1) + pause;
}

/**
 * The label split into tone runs at `tick`.
 *
 * Phases 0 and `total+1` are the window's entry and exit (it is still partly off
 * the label); phases `1..total` put the peak on cell 0..total-1, so the highlight
 * crosses the word exactly once. The rest of the period is the pause.
 */
export function shimmerSpans(
  label: string,
  tick: number,
  options: ShimmerOptions = {},
): ShimmerSpan[] {
  const plain: ShimmerSpan[] = [{ text: label, tone: "base" }];
  if (options.color === false || label === "") {
    return plain;
  }
  const period = shimmerPeriod(label, options);
  // Modulo-safe for a negative or absurd tick: a bad counter must not throw.
  const phase = ((Math.floor(tick) % period) + period) % period;
  const peakCell = phase - 1;
  const runs: { text: string; tone: ShimmerTone }[] = [];
  let cell = 0;
  for (const g of graphemes(label)) {
    const width = Math.max(1, cellWidth(g));
    const start = cell;
    const end = cell + width - 1;
    cell += width;
    // peak when the cell is under the window's centre, mid when it overlaps at
    // all: a wide grapheme the window only clips is mid, never half-painted.
    const tone: ShimmerTone =
      start <= peakCell && peakCell <= end
        ? "peak"
        : end >= peakCell - 1 && start <= peakCell + 1
          ? "mid"
          : "base";
    const last = runs.at(-1);
    if (last && last.tone === tone) {
      last.text += g;
    } else {
      runs.push({ text: g, tone });
    }
  }
  return runs;
}

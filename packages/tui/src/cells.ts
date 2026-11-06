/**
 * Terminal CELLS, not code points (the owner's rule, `tool-expand.ts`): the
 * status bar and the input border measure and cut text with `string-width`, so a
 * double-width character (CJK, emoji) never overflows the line Ink lays out.
 * Pure. Known limit, not ours: Ink's output grid disagrees with `string-width`
 * for single-unit (`✅`) and ZWJ emoji — see docs/library-bugs.md (Ink, output
 * grid); the measure here is right and there is no workaround.
 */
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The cells `s` takes on a terminal. */
export function cellWidth(s: string): number {
  return stringWidth(s);
}

function graphemes(s: string): string[] {
  return [...segmenter.segment(s)].map((part) => part.segment);
}

/** The longest prefix of `s` that takes at most `max` cells. */
export function headCells(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const w = stringWidth(g);
    if (used + w > max) {
      break;
    }
    out += g;
    used += w;
  }
  return out;
}

/** `s` cut to at most `max` cells, with a trailing `…` when it was cut. */
export function truncateCells(s: string, max: number): string {
  if (stringWidth(s) <= max) {
    return s;
  }
  return max <= 1 ? "…".slice(0, max) : `${headCells(s, max - 1)}…`;
}

/** The longest suffix of `s` that takes at most `max` cells. */
export function tailCells(s: string, max: number): string {
  let out = "";
  let used = 0;
  const parts = graphemes(s);
  for (let i = parts.length - 1; i >= 0; i--) {
    const g = parts[i] ?? "";
    const w = stringWidth(g);
    if (used + w > max) {
      break;
    }
    out = g + out;
    used += w;
  }
  return out;
}

/** `s` cut to `max` cells with a `…` in the MIDDLE (head and tail kept). */
export function middleCells(s: string, max: number): string {
  if (stringWidth(s) <= max) {
    return s;
  }
  if (max <= 1) {
    return "…";
  }
  const head = Math.ceil((max - 1) / 2);
  return `${headCells(s, head)}…${tailCells(s, max - 1 - head)}`;
}

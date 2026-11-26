/**
 * Pure text-selection math for the scroll buffer.
 *
 * A selection is two points in *absolute* buffer coordinates (`row` indexes into
 * the wrapped `allRows`, `col` is a character offset into that row's plain text).
 * The App maps mouse (screen) coordinates to these, then uses `extractSelection`
 * to produce the clipboard text and `rowSelectionRange` to paint the highlight.
 * Framework-free and fully testable.
 */
export interface Point {
  readonly row: number;
  readonly col: number;
}

export interface Selection {
  readonly anchor: Point;
  readonly head: Point;
}

/** Return the two points in reading order (start ≤ end). */
export function orderPoints(a: Point, b: Point): { start: Point; end: Point } {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: a, end: b };
  }
  return { start: b, end: a };
}

/** The selected text across `plainRows`, rows joined with newlines. */
export function extractSelection(plainRows: readonly string[], sel: Selection): string {
  const { start, end } = orderPoints(sel.anchor, sel.head);
  if (start.row === end.row) {
    return (plainRows[start.row] ?? "").slice(start.col, end.col);
  }
  const out: string[] = [(plainRows[start.row] ?? "").slice(start.col)];
  for (let r = start.row + 1; r < end.row; r++) {
    out.push(plainRows[r] ?? "");
  }
  out.push((plainRows[end.row] ?? "").slice(0, end.col));
  return out.join("\n");
}

/** The `[c0, c1)` selected column span on `row` (of length `rowLength`), or null. */
export function rowSelectionRange(
  sel: Selection,
  row: number,
  rowLength: number,
): [number, number] | null {
  const { start, end } = orderPoints(sel.anchor, sel.head);
  if (row < start.row || row > end.row) {
    return null;
  }
  const c0 = row === start.row ? start.col : 0;
  const c1 = row === end.row ? end.col : rowLength;
  const lo = Math.max(0, Math.min(rowLength, c0));
  const hi = Math.max(lo, Math.min(rowLength, c1));
  return [lo, hi];
}

/** Whether the selection spans at least one character. */
export function isNonEmpty(sel: Selection): boolean {
  return sel.anchor.row !== sel.head.row || sel.anchor.col !== sel.head.col;
}

/**
 * A release copies only a DELIBERATE selection: one that travelled at least this
 * many cells along a row, or crossed two rows. A press-release with less
 * movement is a click (a hand jitter while focusing the terminal), and copying
 * it silently overwrote the person's clipboard with a stray fragment.
 */
export const COPY_MIN_CELLS = 3;

/**
 * Whether `sel` is a deliberate selection (see `COPY_MIN_CELLS`).
 *
 * A ONE-row jump is not enough on its own: a cell is ~2x taller than wide, so a
 * press a pixel from a row boundary emits one drag report on the next row, and
 * the copy would take the rest of that row plus the next one's prefix — the same
 * stray-clipboard bug along the other axis. So the test is PHYSICAL travel,
 * direction-free: two rows apart, or `COPY_MIN_CELLS` along a row. Direction
 * must not matter, because the ordinary gesture for a phrase that wraps is the
 * tail of one row down to the head of the next, with the head LEFT of the
 * anchor (requiring forward travel silently dropped exactly that copy).
 */
export function isDeliberate(sel: Selection): boolean {
  const rows = Math.abs(sel.head.row - sel.anchor.row);
  const cols = Math.abs(sel.head.col - sel.anchor.col);
  return rows >= 2 || cols >= COPY_MIN_CELLS;
}

/** How long the status bar keeps the copy confirmation. */
export const COPIED_NOTE_MS = 2000;

/** The status bar's transient confirmation after a copy. */
export function copiedLabel(chars: number): string {
  return `Copied · ${chars} ${chars === 1 ? "char" : "chars"}`;
}

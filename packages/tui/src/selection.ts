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

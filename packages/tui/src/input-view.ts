/**
 * Project a (possibly multi-line) prompt buffer into the fixed-height input box.
 *
 * The value is split on `\n`; the cursor offset is mapped to a (row, col); and
 * when there are more rows than fit, a window is scrolled to keep the cursor
 * line visible. Pure, so the box's layout math and the renderer agree exactly.
 */
export interface InputView {
  /** The logical lines currently visible in the box. */
  readonly lines: readonly string[];
  /** Cursor position within `lines` (row relative to the window, col in chars). */
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** True when lines are hidden above / below the window (overflow indicators). */
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  /** Total logical line count (for the box-height / layout calculation). */
  readonly totalLines: number;
}

/**
 * @param value   the full buffer (may contain `\n`)
 * @param cursor  cursor offset into `value`
 * @param maxRows max logical lines the box may show (>= 1)
 */
export function inputView(value: string, cursor: number, maxRows: number): InputView {
  const max = Math.max(1, Math.floor(maxRows));
  const lines = value.split("\n");
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));

  // Map the offset to (row, col): walk lines, subtracting each line + its "\n".
  let row = 0;
  let col = clampedCursor;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]?.length ?? 0;
    if (col <= len) {
      row = i;
      break;
    }
    col -= len + 1; // +1 for the newline
  }

  if (lines.length <= max) {
    return {
      lines,
      cursorRow: row,
      cursorCol: col,
      moreAbove: false,
      moreBelow: false,
      totalLines: lines.length,
    };
  }
  // Window around the cursor line, clamped to the buffer.
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(row - half, lines.length - max));
  return {
    lines: lines.slice(start, start + max),
    cursorRow: row - start,
    cursorCol: col,
    moreAbove: start > 0,
    moreBelow: start + max < lines.length,
    totalLines: lines.length,
  };
}

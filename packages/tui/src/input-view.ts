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
  /** Logical index of the first visible line (0 when not windowed). */
  readonly windowStart: number;
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
      windowStart: 0,
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
    windowStart: start,
  };
}

/**
 * The `[c0, c1)` character span of a buffer selection `[start, end)` (absolute
 * offsets) on logical line `row`, or `null` when the row is outside the
 * selection. Mirrors `rowSelectionRange` from `selection.ts` for the input
 * buffer, whose rows are the value split on `\n`.
 */
export function inputSelectionSpan(
  value: string,
  start: number,
  end: number,
  row: number,
): [number, number] | null {
  if (start === end) {
    return null;
  }
  const lines = value.split("\n");
  // Absolute offsets of each row's start and end (excluding the `\n`).
  const starts: number[] = [0];
  for (let r = 0; r < lines.length; r++) {
    const len = lines[r]?.length ?? 0;
    const s = starts[r] ?? 0;
    starts.push(s + len + 1);
  }
  const rowStart = starts[row];
  const rowLen = row < lines.length ? (lines[row]?.length ?? 0) : 0;
  if (rowStart === undefined || rowStart >= end || rowStart + rowLen <= start) {
    return null;
  }
  const c0 = Math.max(0, start - (rowStart ?? 0));
  const c1 = Math.min(rowLen, end - (rowStart ?? 0));
  return c0 >= c1 ? null : [c0, c1];
}

/**
 * A run of cells in a rendered input row, flagged for inverse video. `inverse`
 * is semantic (selected, or the block cursor) — the renderer maps it to Ink's
 * `inverse`; it carries no colour, which stays presentation in the component.
 */
export interface InputSegment {
  readonly text: string;
  readonly inverse: boolean;
}

/** One rendered row of the input box: a gutter prefix plus content segments. */
export interface InputRow {
  /** Leading marker: "❯ " (first logical line), "  " (continuation), or an
   * "↑ "/"↓ " overflow arrow. */
  readonly prefix: string;
  /** True for the overflow-arrow prefix (rendered dim/grey, not the accent). */
  readonly gutter: boolean;
  /** Content split into inverse / non-inverse runs, left to right. */
  readonly segments: readonly InputSegment[];
}

/** The full input box as rows of segments — every selection/cursor/windowing
 * decision resolved here, so the component is a dumb renderer. */
export interface InputRender {
  readonly rows: readonly InputRow[];
}

/** Group a line into inverse/non-inverse segments given the set of inverse
 * columns, plus an optional trailing inverse cell (the block cursor at EOL). */
function toSegments(line: string, inverse: boolean[], trailingCursor: boolean): InputSegment[] {
  const segs: InputSegment[] = [];
  let i = 0;
  while (i < line.length) {
    const inv = inverse[i] ?? false;
    let j = i + 1;
    while (j < line.length && (inverse[j] ?? false) === inv) {
      j++;
    }
    segs.push({ text: line.slice(i, j), inverse: inv });
    i = j;
  }
  if (trailingCursor) {
    segs.push({ text: " ", inverse: true });
  }
  // Ink measures an empty <Text> as 0×0, which collapses the row; a blank row
  // must carry a single non-inverse space so it keeps its height.
  if (segs.length === 0) {
    segs.push({ text: " ", inverse: false });
  }
  return segs;
}

/**
 * Project the buffer into the input box as rows of inverse/plain segments, with
 * the selection highlight and the block cursor already resolved. Pure: the
 * renderer (`LineInput`) only maps rows → elements and adds colour.
 *
 * Selection is `[min(anchor,cursor), max(anchor,cursor))` when `anchor` is set
 * and differs from `cursor`; those cells render inverse. With no selection the
 * block cursor is a single inverse cell at `cursor` (a trailing space at EOL).
 * When a selection is active the highlight is the feedback — no separate cursor
 * cell is drawn (it sits at a selection edge, already inverse).
 *
 * @param anchor selection anchor, or `null` for none.
 */
export function inputRender(
  value: string,
  cursor: number,
  anchor: number | null,
  maxRows: number,
): InputRender {
  const view = inputView(value, cursor, maxRows);
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));
  const hasSel =
    anchor !== null && anchor !== clampedCursor && anchor >= 0 && anchor <= value.length;
  const selStart = hasSel ? Math.min(anchor, clampedCursor) : 0;
  const selEnd = hasSel ? Math.max(anchor, clampedCursor) : 0;

  const rows = view.lines.map((line, r): InputRow => {
    const li = view.windowStart + r;
    const firstLogicalVisible = !view.moreAbove && r === 0;
    const lastVisible = r === view.lines.length - 1;
    const gutter = (view.moreAbove && r === 0) || (view.moreBelow && lastVisible);
    const prefix =
      view.moreAbove && r === 0
        ? "↑ "
        : view.moreBelow && lastVisible
          ? "↓ "
          : firstLogicalVisible
            ? "❯ "
            : "  ";

    const inverse: boolean[] = new Array(line.length).fill(false);
    if (hasSel) {
      const span = inputSelectionSpan(value, selStart, selEnd, li);
      if (span) {
        for (let c = span[0]; c < span[1]; c++) {
          inverse[c] = true;
        }
      }
    }
    // The block cursor only shows when there is no active selection.
    const cursorHere = !hasSel && r === view.cursorRow;
    const cursorCol = Math.max(0, Math.min(line.length, view.cursorCol));
    let trailingCursor = false;
    if (cursorHere) {
      if (cursorCol < line.length) {
        inverse[cursorCol] = true;
      } else {
        trailingCursor = true;
      }
    }
    return { prefix, gutter, segments: toSegments(line, inverse, trailingCursor) };
  });

  return { rows };
}

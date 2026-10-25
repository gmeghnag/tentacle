import stringWidth from "string-width";

/**
 * Project a (possibly multi-line, possibly soft-wrapped) prompt buffer into the
 * fixed-height input box.
 *
 * The value is split on `\n` into logical lines, and each logical line is
 * soft-wrapped by display width into VISUAL rows (the renderer never lets Ink
 * wrap, because Ink would wrap each sibling `<Text>` of a row in its own
 * column and strand the cursor cell). The cursor offset is mapped to a visual
 * (row, col); when there are more rows than fit, a window is scrolled to keep
 * the cursor row visible. Pure, so the box's layout math and the renderer agree
 * exactly.
 */
export interface InputView {
  /** The visual rows currently visible in the box. */
  readonly lines: readonly string[];
  /** Absolute buffer offset of each visible row's first character. */
  readonly starts: readonly number[];
  /** Cursor position within `lines` (row relative to the window, col in UTF-16 units). */
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** True when rows are hidden above / below the window (overflow indicators). */
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  /** Total visual row count (for the box-height / layout calculation). */
  readonly totalLines: number;
  /** Index of the first visible visual row (0 when not windowed). */
  readonly windowStart: number;
}

/** Cells taken by the row prefix ("❯ " / "  " / "↑ " / "↓ "). */
export const INPUT_PREFIX_WIDTH = 2;

/** A TAB is DISPLAYED as this many spaces (the buffer keeps the `\t` byte). */
export const TAB_WIDTH = 4;

/** `text` as displayed: each TAB becomes `TAB_WIDTH` spaces (display only). */
export function expandTabs(text: string): string {
  return text.replaceAll("\t", " ".repeat(TAB_WIDTH));
}

/** A visual row: the half-open buffer span `[start, end)` (excluding any `\n`). */
interface VisualRow {
  readonly start: number;
  readonly end: number;
}

const segmenter = new Intl.Segmenter();

/**
 * Soft-wrap `value` into visual rows for a box `width` cells wide (prefix
 * included; `Infinity` = no wrapping). A row holds at most `width - 2` cells and
 * a wide character is never split. Cursor-at-EOL on a row that is exactly full
 * goes to a fresh empty row below it (the block cursor needs a cell of its own).
 */
function wrapRows(value: string, cursor: number, width: number): VisualRow[] {
  const room = Number.isFinite(width)
    ? Math.max(1, width - INPUT_PREFIX_WIDTH)
    : Number.POSITIVE_INFINITY;
  const rows: VisualRow[] = [];
  let base = 0;
  for (const line of value.split("\n")) {
    let rowStart = 0;
    let rowWidth = 0;
    if (Number.isFinite(room)) {
      for (const { segment, index } of segmenter.segment(line)) {
        const w = segment === "\t" ? TAB_WIDTH : stringWidth(segment);
        if (rowWidth + w > room && index > rowStart) {
          rows.push({ start: base + rowStart, end: base + index });
          rowStart = index;
          rowWidth = 0;
        }
        rowWidth += w;
      }
    }
    rows.push({ start: base + rowStart, end: base + line.length });
    if (rowWidth >= room && cursor === base + line.length) {
      rows.push({ start: base + line.length, end: base + line.length });
    }
    base += line.length + 1; // +1 for the newline
  }
  return rows;
}

/**
 * @param value   the full buffer (may contain `\n`)
 * @param cursor  cursor offset into `value`
 * @param maxRows max visual rows the box may show (>= 1)
 * @param width   box width in cells, prefix included (default: no wrapping)
 */
export function inputView(
  value: string,
  cursor: number,
  maxRows: number,
  width: number = Number.POSITIVE_INFINITY,
): InputView {
  const max = Math.max(1, Math.floor(maxRows));
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));
  const rows = wrapRows(value, clampedCursor, width);

  // The cursor sits on the last row starting at or before it: at a wrap
  // boundary that is the NEXT row (the cursor is on that row's first character).
  let row = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i]?.start ?? 0) <= clampedCursor) {
      row = i;
    }
  }
  const col = clampedCursor - (rows[row]?.start ?? 0);

  const start =
    rows.length <= max ? 0 : Math.max(0, Math.min(row - Math.floor(max / 2), rows.length - max));
  const visible = rows.slice(start, start + max);
  return {
    lines: visible.map((r) => value.slice(r.start, r.end)),
    starts: visible.map((r) => r.start),
    cursorRow: row - start,
    cursorCol: col,
    moreAbove: start > 0,
    moreBelow: start + max < rows.length,
    totalLines: rows.length,
    windowStart: start,
  };
}

/** Rows the input box occupies (content only, no border): visual rows, capped at `maxRows`. */
export function inputRowCount(
  value: string,
  cursor: number,
  width: number,
  maxRows: number,
): number {
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));
  return Math.min(wrapRows(value, clampedCursor, width).length, Math.max(1, Math.floor(maxRows)));
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
  /** Leading marker: "❯ " (first row), "  " (continuation / wrapped), or an
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

/** The `[from, to)` UTF-16 span of the grapheme cluster of `line` containing `col`. */
function graphemeSpan(line: string, col: number): [number, number] {
  for (const { segment, index } of segmenter.segment(line)) {
    if (col < index + segment.length) {
      return [index, index + segment.length];
    }
  }
  return [col, col + 1];
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
 * @param width  box width in cells for soft-wrapping (default: no wrapping).
 */
export function inputRender(
  value: string,
  cursor: number,
  anchor: number | null,
  maxRows: number,
  width: number = Number.POSITIVE_INFINITY,
): InputRender {
  const view = inputView(value, cursor, maxRows, width);
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));
  const hasSel =
    anchor !== null && anchor !== clampedCursor && anchor >= 0 && anchor <= value.length;
  const selStart = hasSel ? Math.min(anchor, clampedCursor) : 0;
  const selEnd = hasSel ? Math.max(anchor, clampedCursor) : 0;

  const rows = view.lines.map((line, r): InputRow => {
    const lastVisible = r === view.lines.length - 1;
    const gutter = (view.moreAbove && r === 0) || (view.moreBelow && lastVisible);
    const prefix =
      view.moreAbove && r === 0
        ? "↑ "
        : view.moreBelow && lastVisible
          ? "↓ "
          : !view.moreAbove && r === 0
            ? "❯ "
            : "  ";

    // `selected` covers a whole unit (a tab: all its cells); `cursorCell` marks
    // the block cursor (a tab: only its first cell).
    const selected: boolean[] = new Array(line.length).fill(false);
    const cursorCell: boolean[] = new Array(line.length).fill(false);
    if (hasSel) {
      const rowStart = view.starts[r] ?? 0;
      const c0 = Math.max(0, selStart - rowStart);
      const c1 = Math.min(line.length, selEnd - rowStart);
      for (let c = c0; c < c1; c++) {
        selected[c] = true;
      }
    }
    // The block cursor only shows when there is no active selection.
    const cursorHere = !hasSel && r === view.cursorRow;
    const cursorCol = Math.max(0, Math.min(line.length, view.cursorCol));
    let trailingCursor = false;
    if (cursorHere) {
      if (cursorCol < line.length) {
        const [from, to] = graphemeSpan(line, cursorCol);
        for (let c = from; c < to; c++) {
          cursorCell[c] = true;
        }
      } else {
        trailingCursor = true;
      }
    }
    // Expand each tab to TAB_WIDTH spaces for display.
    let shown = "";
    const inverse: boolean[] = [];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === "\t") {
        shown += " ".repeat(TAB_WIDTH);
        for (let k = 0; k < TAB_WIDTH; k++) {
          inverse.push((selected[c] ?? false) || (k === 0 && (cursorCell[c] ?? false)));
        }
      } else {
        shown += line[c];
        inverse.push((selected[c] ?? false) || (cursorCell[c] ?? false));
      }
    }
    return { prefix, gutter, segments: toSegments(shown, inverse, trailingCursor) };
  });

  return { rows };
}

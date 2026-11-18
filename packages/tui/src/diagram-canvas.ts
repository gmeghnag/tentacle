/**
 * The character grid the TUI's ASCII diagrams are drawn on
 * (docs/feat/model-diagrams.md D8). Shared by the flowchart and the sequence
 * renderers so both merge lines the same way.
 *
 * A line cell stores the DIRECTIONS it connects (up/down/left/right), not a
 * glyph: two lines meeting in one cell merge into the right junction (`┬`, `├`,
 * `┼`…) whatever order they were drawn in. Box borders are lines too, so an
 * edge leaving a box turns its border cell into `┬` by itself.
 *
 * Text cells hold a grapheme; a wide one (CJK, width 2) takes its cell and a
 * placeholder after it, so a row's cell count is its terminal width.
 *
 * Pure: no I/O, no colour — a cell carries a style NAME, painted by the caller.
 */
import { cellWidth } from "./cells.ts";

/** What a cell means; `diagram-lines` maps each to a theme token. */
export type DiagramStyle =
  | "text"
  | "border"
  | "decision"
  | "label"
  | "frame"
  | "title"
  | "subtle"
  | "keyword"
  | "id"
  | "arrow"
  | "string"
  | "comment";

/** One painted run of a row. */
export type DiagramSeg = readonly [DiagramStyle, string];
/** A row of runs; its width is the sum of its runs' cell widths. */
export type DiagramRow = readonly DiagramSeg[];

/** Line directions, as bits. */
export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;

/** How a line is drawn (the model's edge style; `dotted` also marks a reply). */
export type LineWeight = "solid" | "dotted" | "thick";

const JOIN: Readonly<Record<number, string>> = {
  [UP]: "│",
  [DOWN]: "│",
  [UP | DOWN]: "│",
  [LEFT]: "─",
  [RIGHT]: "─",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

/** Every glyph a line cell can become — what a test walks back along. */
export const LINE_GLYPHS = new Set([...Object.values(JOIN), "╎", "╌", "┃", "━"]);

interface Cell {
  ch: string;
  style: DiagramStyle;
  dirs: number;
  weight: LineWeight;
  /** A glyph that wins over the merged line (an arrowhead, `◇`, text). */
  fixed: boolean;
}

/** The placeholder after a wide grapheme. */
const WIDE_TAIL = "";

export class Canvas {
  private readonly cells: Cell[][] = [];

  /** The canvas grows to fit what is drawn; this is its current size. */
  get height(): number {
    return this.cells.length;
  }

  get width(): number {
    return this.cells.reduce((max, row) => Math.max(max, row.length), 0);
  }

  private cell(row: number, col: number): Cell {
    while (this.cells.length <= row) this.cells.push([]);
    const line = this.cells[row] as Cell[];
    while (line.length <= col) {
      line.push({ ch: " ", style: "text", dirs: 0, weight: "solid", fixed: false });
    }
    return line[col] as Cell;
  }

  /** Is the cell blank (never drawn on)? Out of range counts as blank. */
  isBlank(row: number, col: number): boolean {
    const c = this.cells[row]?.[col];
    return c === undefined || (c.dirs === 0 && !c.fixed);
  }

  /** The glyph a cell shows ("" for the tail of a wide grapheme). */
  glyph(row: number, col: number): string {
    const c = this.cells[row]?.[col];
    if (c === undefined) return " ";
    if (c.fixed || c.dirs === 0) return c.ch;
    return lineGlyph(c.dirs, c.weight);
  }

  /** Add directions to one cell (a line passing through, or a border). */
  link(
    row: number,
    col: number,
    dirs: number,
    style: DiagramStyle,
    weight: LineWeight = "solid",
  ): void {
    if (row < 0 || col < 0) return;
    const c = this.cell(row, col);
    c.dirs |= dirs;
    if (!c.fixed) c.style = style;
    if (weight !== "solid") c.weight = weight;
  }

  /** An axis-aligned line from one cell to another, both ends included. */
  line(
    r0: number,
    c0: number,
    r1: number,
    c1: number,
    style: DiagramStyle,
    weight: LineWeight = "solid",
  ): void {
    if (r0 === r1) {
      const [a, b] = c0 <= c1 ? [c0, c1] : [c1, c0];
      for (let c = a; c <= b; c++) {
        this.link(r0, c, (c > a ? LEFT : 0) | (c < b ? RIGHT : 0), style, weight);
      }
      return;
    }
    const [a, b] = r0 <= r1 ? [r0, r1] : [r1, r0];
    for (let r = a; r <= b; r++) {
      this.link(r, c0, (r > a ? UP : 0) | (r < b ? DOWN : 0), style, weight);
    }
  }

  /** A fixed glyph (arrowhead, `◇`): it wins over any line through the cell. */
  put(row: number, col: number, ch: string, style: DiagramStyle): void {
    if (row < 0 || col < 0) return;
    const c = this.cell(row, col);
    c.ch = ch;
    c.style = style;
    c.fixed = true;
  }

  /** Text from a cell rightwards; returns the cells it took (CJK counts 2). */
  text(row: number, col: number, s: string, style: DiagramStyle): number {
    let at = col;
    for (const g of graphemes(s)) {
      const w = cellWidth(g);
      if (w === 0) continue;
      this.put(row, at, g, style);
      if (w === 2) this.put(row, at + 1, WIDE_TAIL, style);
      at += w;
    }
    return at - col;
  }

  /** The grid as styled rows, trailing blanks trimmed. */
  rows(): DiagramRow[] {
    const out: DiagramRow[] = [];
    for (let r = 0; r < this.cells.length; r++) {
      const line = this.cells[r] as Cell[];
      let end = line.length;
      while (end > 0 && this.isBlank(r, end - 1)) end--;
      const segs: [DiagramStyle, string][] = [];
      for (let c = 0; c < end; c++) {
        const cell = line[c] as Cell;
        const ch = this.glyph(r, c);
        const style = cell.dirs === 0 && !cell.fixed ? "text" : cell.style;
        const last = segs[segs.length - 1];
        if (last !== undefined && last[0] === style) last[1] += ch;
        else segs.push([style, ch]);
      }
      out.push(segs);
    }
    return out;
  }
}

function lineGlyph(dirs: number, weight: LineWeight): string {
  const vertical = (dirs & (LEFT | RIGHT)) === 0;
  const horizontal = (dirs & (UP | DOWN)) === 0;
  if (weight === "dotted" && vertical) return "╎";
  if (weight === "dotted" && horizontal) return "╌";
  if (weight === "thick" && vertical) return "┃";
  if (weight === "thick" && horizontal) return "━";
  return JOIN[dirs] ?? "┼";
}

function graphemes(s: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
    (g) => g.segment,
  );
}

/** A row's width in cells. */
export function rowWidth(row: DiagramRow): number {
  return row.reduce((sum, [, text]) => sum + cellWidth(text), 0);
}

/** A row's plain text (no colour). */
export function rowText(row: DiagramRow): string {
  return row.map(([, text]) => text).join("");
}

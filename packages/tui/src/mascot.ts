/**
 * Polpetto — the startup header's pixel mascot (docs/feat/tui-mascot.md).
 *
 * Pure and framework-free: the bitmap, the nine palettes, the half-block
 * projection and the whole show/hide decision, so the one behaviour worth
 * testing lives here and a `.tsx` component only maps the result to strings
 * (AGENTS §7 "logic lives in pure modules"). No chalk: the colour LEVEL is an
 * input, so the decision is testable without a terminal.
 *
 * One terminal cell carries two vertical pixels: `▀` with fg = the top pixel
 * and bg = the bottom one, `▄` for the bottom alone, `█` when both are equal.
 */
import { cellWidth } from "./cells.ts";
import { shortPath } from "./status-line.ts";

/** The owner's drawing, verbatim: `.` empty, `K` outline, `E` eyes, `F` body, `S` body shade, `B` blush. */
export const MASCOT_BITMAP: readonly string[] = [
  "..KKKKK..",
  ".KSFFFSK.",
  "KSFFFFFSK",
  "KFEFFFEFK",
  "KFEFFFEFK",
  "KBBFSFBBK",
  ".KFFFFFK.",
  "KSSKSKSSK",
  ".KK.K.KK.",
  ".........",
];

/** A palette's five tones, as `#RRGGBB` (the task doc's table, verbatim). */
export interface Palette {
  readonly K: string;
  readonly E: string;
  readonly F: string;
  readonly S: string;
  readonly B: string;
}

/** The nine palettes, in the order `pickPalette` draws them. */
export const PALETTE_NAMES = [
  "soft",
  "logo",
  "glow",
  "cyan",
  "teal",
  "coral",
  "mint",
  "amber",
  "sky",
] as const;

export type PaletteName = (typeof PALETTE_NAMES)[number];

export const MASCOT_PALETTES: Readonly<Record<PaletteName, Palette>> = {
  soft: { K: "#7B3FC0", E: "#3E1A5E", F: "#B387EA", S: "#A274DE", B: "#DDBFF8" },
  logo: { K: "#6E36AE", E: "#3E1A5E", F: "#A267DB", S: "#9258CF", B: "#CFA8F3" },
  glow: { K: "#C9A6F2", E: "#3E1A5E", F: "#8E4BC4", S: "#8143B8", B: "#B583E0" },
  cyan: { K: "#0E8AA8", E: "#083A47", F: "#5FE0F2", S: "#3FCFE6", B: "#B7F3FB" },
  teal: { K: "#14857A", E: "#0A3B36", F: "#5CD6C4", S: "#40C2AF", B: "#B5EEE4" },
  coral: { K: "#C2475A", E: "#5A1622", F: "#F58C93", S: "#EC7480", B: "#FFC6C2" },
  mint: { K: "#3C9A5C", E: "#163D24", F: "#8FE0A6", S: "#73D28E", B: "#CFF5D9" },
  amber: { K: "#B7791F", E: "#4A2E07", F: "#F7C35C", S: "#EEB043", B: "#FFE3A8" },
  sky: { K: "#3A6FD0", E: "#13285A", F: "#8DB4F7", S: "#73A0F0", B: "#CFE0FF" },
};

/**
 * A palette drawn at random, ONCE per start (the palette lives on the item, so
 * every re-render and resize paints the same sprite). `rand` is injectable so
 * tests are deterministic; `rand() === 1` is clamped rather than off the end.
 */
export function pickPalette(rand: () => number = Math.random): PaletteName {
  const index = Math.min(
    PALETTE_NAMES.length - 1,
    Math.max(0, Math.floor(rand() * PALETTE_NAMES.length)),
  );
  return PALETTE_NAMES[index] ?? "soft";
}

/** One terminal cell of the sprite: a glyph, and the colours the halves carry. */
export interface MascotCell {
  readonly glyph: " " | "▀" | "▄" | "█";
  readonly fg?: string;
  readonly bg?: string;
}

/** The one pixel-row pair's cell: both empty → space, equal → `█`, one half → `▀`/`▄`, else `▀` over `▄`. */
function pairCell(top: string, bottom: string, palette: Palette): MascotCell {
  const above = toneOf(top, palette);
  const below = toneOf(bottom, palette);
  if (above === undefined && below === undefined) {
    return { glyph: " " };
  }
  // "Both equal" compares the RESOLVED COLOURS, not the letters.
  if (above !== undefined && above === below) {
    return { glyph: "█", fg: above };
  }
  if (below === undefined) {
    // A missing `above` cannot reach here: both are then undefined.
    return { glyph: "▀", fg: above as string };
  }
  if (above === undefined) {
    return { glyph: "▄", fg: below };
  }
  return { glyph: "▀", fg: above, bg: below };
}

/** A bitmap letter's hex, or undefined for `.` (no pixel). */
function toneOf(letter: string, palette: Palette): string | undefined {
  switch (letter) {
    case "K":
      return palette.K;
    case "E":
      return palette.E;
    case "F":
      return palette.F;
    case "S":
      return palette.S;
    case "B":
      return palette.B;
    default:
      return undefined;
  }
}

/** The sprite as 5 rows × 9 cells: the bitmap's pixel rows, two at a time. */
export function mascotCells(palette: Palette): MascotCell[][] {
  const rows: MascotCell[][] = [];
  for (let y = 0; y < MASCOT_BITMAP.length; y += 2) {
    const top = MASCOT_BITMAP[y] ?? "";
    const bottom = MASCOT_BITMAP[y + 1] ?? "";
    const width = Math.max(top.length, bottom.length);
    const row: MascotCell[] = [];
    for (let x = 0; x < width; x += 1) {
      row.push(pairCell(top[x] ?? ".", bottom[x] ?? ".", palette));
    }
    rows.push(row);
  }
  return rows;
}

const MASCOT_CELLS = 9;
/** The mascot's cells, plus the two spaces that separate it from the text. */
export const GUTTER = MASCOT_CELLS + 2;
/** The cwd keeps at least this many cells before the mascot yields to it. */
const MIN_PATH = 12;

/** One header line: `strong` is painted bold, `text` subtle (the space is inside `text`). */
export interface HeaderLine {
  readonly strong?: string;
  readonly text: string;
}

export interface HeaderInput {
  /** The CLI's release version; absent (a test, an unwired host) → `tentacle` alone. */
  readonly version?: string;
  readonly model: string;
  readonly cwd: string;
  readonly home?: string;
  readonly width: number;
  /** `chalk.level` AT CALL TIME: 0/1 hide the mascot (docs/feat/tui-mascot.md D6). */
  readonly colorLevel: number;
  readonly palette: PaletteName;
}

export interface HeaderView {
  /** The sprite, or null when it is hidden (too narrow, or colours too poor). */
  readonly mascot: MascotCell[][] | null;
  /** Always three lines: the text is kept and the MASCOT is what yields. */
  readonly lines: readonly [HeaderLine, HeaderLine, HeaderLine];
}

/**
 * The whole header decision. The mascot shows only when the colours are good
 * enough for its five tones AND the widest fixed piece of text still fits
 * beside it — so a row is never wrapped and the sprite is never split (the
 * scroll buffer carries only `38;2` across a wrap, render-lines `carryColor`).
 * The cwd is shortened first; below the threshold the mascot is what goes.
 */
export function headerView(input: HeaderInput): HeaderView {
  const title = input.version ? ` ${input.version}` : "";
  // The room the model name leaves the path: never below one cell.
  const pathBudget = (room: number): number => Math.max(1, room - cellWidth(input.model) - 3);
  const model = input.model;
  const needed = Math.max(
    cellWidth(`tentacle${title}`),
    cellWidth("/help for commands"),
    cellWidth(model) + 3 + MIN_PATH,
  );
  const shown = input.colorLevel >= 2 && input.width - GUTTER >= needed;
  const path = shortPath(input.cwd, input.home, pathBudget(input.width - (shown ? GUTTER : 0)));
  return {
    mascot: shown ? mascotCells(MASCOT_PALETTES[input.palette]) : null,
    lines: [
      { strong: "tentacle", text: title },
      { text: `${model} · ${path}` },
      { text: "/help for commands" },
    ],
  };
}

/**
 * The phone chart layout's shared vocabulary (docs/feat/model-charts.md D6 and
 * *iPhone visual language (rev 2)*): the view-model types `ui/chart/ChartView.tsx`
 * draws, and the text measuring every placement uses. Pure, React-free.
 *
 * Chart typography is MONOSPACE everywhere (owner, 2026-11-16), so a label's
 * width is its cell count × the face's advance — CJK counts two cells.
 */
import type { Hero } from "./chart-hero.ts";

/** A colour the component resolves: a palette slot by series, or a theme token. */
export type Paint =
  | { readonly series: number }
  | {
      readonly token:
        | "mutedLine"
        | "mutedBar"
        | "track"
        | "guide"
        | "guideStrong"
        | "secondary"
        | "label";
    };

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface LayoutPath {
  readonly d: string;
  readonly role: "line" | "fill" | "bar" | "track" | "sector" | "trend" | "swatch" | "baseline";
  /** The dataset (or slice) it draws; −1 for chrome. Colours stay on this index. */
  readonly series: number;
  readonly paint: Paint;
  readonly opacity: number;
  /** Stroked paths (lines, trend, baseline) carry a width; filled ones do not. */
  readonly strokeWidth?: number;
  readonly dash?: string;
  /** A vertical gradient fill: `paint` at `from` alpha fading to `to`. */
  readonly gradient?: { readonly from: number; readonly to: number };
  /** Sampled length, for the draw-in animation (strokeDasharray). */
  readonly length?: number;
  /** Bars and segments: their rectangle, before rounding. */
  readonly box?: Box;
  /** Bars: the highlighted one (argmax, or the latest column). */
  readonly highlight?: boolean;
  /** Bars and segments: the category index. */
  readonly index?: number;
  /** Sectors: their arc (radians clockwise from 12 o'clock, before the gap). */
  readonly arc?: {
    readonly a0: number;
    readonly a1: number;
    readonly ri: number;
    readonly ro: number;
  };
}

export interface LayoutDot {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly series: number;
  readonly paint: Paint;
  readonly opacity: number;
  /** Filled (A) or hollow with a stroke (B). */
  readonly hollow?: boolean;
  /** A soft halo behind the dot (A's end dot and scrub dot). */
  readonly halo?: { readonly r: number; readonly opacity: number };
  /** A surface-coloured ring around the dot, in pt. */
  readonly ring?: number;
  /** The series' marker, for a colour-blind read (default `circle`). */
  readonly shape?: DotShape;
}

/** A series marker: the mockup's solid ● / dashed ■ / dotted ▲ (three slots). */
export type DotShape = "circle" | "square" | "triangle";

export type TextRole =
  | "guide"
  | "x"
  | "direct"
  | "name"
  | "value"
  | "percent"
  | "center"
  | "centerSub"
  | "peak";

export interface LayoutText {
  readonly x: number;
  /** The text's baseline. */
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "middle" | "end";
  readonly size: number;
  readonly role: TextRole;
  readonly series?: number;
  readonly strong?: boolean;
  /** Inside-plot label: the page-coloured halo that keeps it readable over the data. */
  readonly halo?: boolean;
  /** The marker glyph drawn beside an inside-plot label (docs/feat/mobile-chart-labels.md D2). */
  readonly shape?: DotShape;
}

export interface GuideLine {
  readonly y: number;
  readonly value: number;
  readonly x1: number;
  readonly x2: number;
  readonly style: "dotted" | "solid";
}

export interface LegendItem {
  readonly series: number;
  readonly label: string;
  readonly paint: Paint;
  /** The series' last defined value, already formatted (`"148 k req"`); `""` when it has none. */
  readonly value: string;
  readonly shape: DotShape;
}

export interface ChartTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** Where the finger is: the rule, one dot per defined series, A's dim, the hero. */
export interface ScrubView {
  readonly index: number;
  readonly x: number;
  readonly dots: readonly LayoutDot[];
  /** The curve right of this x dims to 30 % (A); `null` when nothing dims. */
  readonly dimFromX: number | null;
  readonly hero: Hero;
}

export type LayoutKind = "line" | "area" | "bars" | "columns" | "stacked" | "donut" | "scatter";

export interface ChartLayout {
  readonly kind: LayoutKind;
  readonly width: number;
  readonly height: number;
  readonly plot: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly hero: Hero;
  readonly paths: readonly LayoutPath[];
  readonly dots: readonly LayoutDot[];
  readonly texts: readonly LayoutText[];
  readonly guides: readonly GuideLine[];
  /** A legend row replaces the direct labels when they cannot fit. */
  readonly legend: readonly LegendItem[] | null;
  /** The VoiceOver label (one element) and the table caption. */
  readonly summary: string;
  readonly table: ChartTable;
  /** x (pt) → the nearest scrubbable index, clamped at the edges; `null` when the chart does not scrub. */
  readonly hit: (x: number) => number | null;
  readonly scrubAt: (index: number) => ScrubView | null;
}

export interface LayoutOptions {
  readonly width: number;
  readonly height?: number;
  /** Dynamic Type's scale (1 = default, 2.35 = AX5). */
  readonly fontScale?: number;
  readonly locale?: string;
  /** Series the reader switched off in full screen (dataset indices). */
  readonly hidden?: ReadonlySet<number>;
  /** Text width in pt; defaults to the mono estimate. */
  readonly measure?: (text: string, size: number) => number;
  /**
   * Where a line/area chart names its series: inside the plot at each line's end
   * (default, no gutter), or in a legend above it. Ignored by every other kind.
   */
  readonly labels?: LabelMode;
}

/** See `LayoutOptions.labels`. */
export type LabelMode = "inside" | "legend";

/** The resolved options every builder gets. */
export interface Ctx {
  readonly width: number;
  readonly height: number | undefined;
  readonly fs: number;
  readonly locale: string;
  readonly hidden: ReadonlySet<number>;
  readonly measure: (text: string, size: number) => number;
  readonly labels: LabelMode;
}

/** SF Mono's advance, as a share of the point size. */
const MONO_ADVANCE = 0.61;

function wide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x20000
  );
}

/** Monospace cells of `text` (CJK = 2). */
export function textCells(text: string): number {
  let cells = 0;
  for (const ch of text) cells += wide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return cells;
}

export function monoWidth(text: string, size: number): number {
  return textCells(text) * size * MONO_ADVANCE;
}

/** `text` cut with `…` to fit `max` pt. */
export function fitText(text: string, max: number, size: number, measure = monoWidth): string {
  if (measure(text, size) <= max) return text;
  const chars = [...text];
  while (chars.length > 0 && measure(`${chars.join("")}…`, size) > max) chars.pop();
  return chars.length === 0 ? "" : `${chars.join("")}…`;
}

/** A text's box, from its anchor and size (cap height ≈ 0.72 × size above the baseline). */
export function textBox(t: LayoutText, measure: (text: string, size: number) => number): Box {
  const w = measure(t.text, t.size);
  const x = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w : t.x - w / 2;
  return { x, y: t.y - t.size * 0.8, w, h: t.size };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Text sizes (pt at fontScale 1). */
export const SIZE = {
  guide: 10.5,
  x: 11,
  direct: 12,
  row: 11.5,
  center: 17,
  centerSub: 8.5,
} as const;

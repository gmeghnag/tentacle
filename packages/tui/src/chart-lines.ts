/**
 * A chart as terminal rows (docs/feat/model-charts.md D5): `(spec, width,
 * mode, glyphs, expanded) → string[]` of chalk-styled lines, no wider than
 * `width`. Pure: no I/O, no React, no terminal writes — `render-lines` places
 * the rows like any other body (AGENTS §7).
 *
 * Forms, by type and width (the renderer is a pure function of width, so a
 * resize simply re-lays it out):
 * - line / area: a braille plot (2×4 dots per cell) at ≥ 60 cols, one
 *   sparkline row per series at 40–59, the data table below 40;
 * - scatter: the braille plot (2×2 dot marks) at ≥ 40 cols;
 * - bar: horizontal ⅛-cell bars (columns when ≤ 6 short labels), stacked rows
 *   by largest remainder; pie / doughnut: a 100 % bar + a legend with values;
 * - below 40 cols, every type is its data table.
 * Expanded adds 16 plot rows, per-series stats and the data table (≤ 50 rows).
 *
 * The chart takes a tool row's place, so there is no tool chrome here: a
 * caption (title · subtitle) and the chart, centred in the width (owner
 * requirement, *Owner requirements*).
 */
import {
  type ChartSpec,
  type NumberFormat,
  autoFormat,
  bucketMeans,
  datasetValues,
  dateTicks,
  downsampleLttb,
  effectiveXType,
  finiteValues,
  formatDate,
  formatNumber,
  formatPercent,
  niceTicks,
  parseIsoDate,
  thinLabels,
  usesPoints,
  validateChartSpec,
} from "@tentacle/core";
import chalk from "chalk";
import { cellWidth, truncateCells } from "./cells.ts";
import { type ThemeMode, colorStyler, themeMode, tokens } from "./theme.ts";

/** `tui.chartGlyphs`: braille (2×4 dots), or quadrant blocks for fonts without braille. */
export type ChartGlyphs = "braille" | "blocks";

export interface ChartLineOptions {
  /** The cells available; every returned line fits in it. */
  readonly width: number;
  /** Ctrl+O / a click: 16 plot rows, per-series stats and the data table. */
  readonly expanded?: boolean;
  readonly glyphs?: ChartGlyphs;
  /** The palette's mode; defaults to the TUI's own (decided once per launch). */
  readonly mode?: ThemeMode;
  /** Colour on? Defaults to `chalk.level > 0` (NO_COLOR → dotted series, `┅┅`). */
  readonly color?: boolean;
  /** BCP-47 tag for numbers and dates; defaults to the host's. */
  readonly locale?: string;
  /** IANA zone instants are shown in; defaults to the host's. */
  readonly zone?: string;
}

/** A chart wider than this is centred rather than stretched (a 200-col plot reads worse). */
export const CHART_MAX_WIDTH = 120;
/** Plot rows: compact and expanded. */
const PLOT_ROWS = { compact: 8, expanded: 16 } as const;
/** Data-table rows shown before `… +N more rows`. */
const TABLE_ROWS = { compact: 12, expanded: 50 } as const;
/** The width tiers (D5 *Forms by width*). */
const PLOT_MIN = 60;
const NARROW_BELOW = 40;

/** The quadrant blocks, indexed by bits TL=1 TR=2 BL=4 BR=8. */
export const QUAD_GLYPHS: readonly string[] = [
  " ",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
];
/** Braille dot bits by `[y % 4][x % 2]` (U+2800 + bits). */
const BRAILLE_DOTS: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const EIGHTHS_H = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const EIGHTHS_V = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** Fills per series when colour is off: the legend and the bars still tell series apart. */
const MONO_FILLS = ["█", "▓", "▒", "░"] as const;

// ── styled rows ──────────────────────────────────────────────────────────────

/** A segment's look: a text token, or a series index (`-1` = the folded "Other"). */
type Style = "text" | "title" | "subtle" | "dim" | "up" | "down" | number;
type Seg = readonly [Style, string];
type Row = Seg[];

interface Ctx {
  readonly cw: number;
  readonly expanded: boolean;
  readonly glyphs: ChartGlyphs;
  readonly color: boolean;
  readonly mode: ThemeMode;
  readonly locale: string;
  readonly zone: string | undefined;
}

const BLANK: Row = [["text", " "]];

function rowWidth(row: Row): number {
  return row.reduce((sum, [, text]) => sum + cellWidth(text), 0);
}

function padEnd(text: string, cells: number): string {
  return text + " ".repeat(Math.max(0, cells - cellWidth(text)));
}

function padStart(text: string, cells: number): string {
  return " ".repeat(Math.max(0, cells - cellWidth(text))) + text;
}

function maxWidth(texts: readonly string[]): number {
  return texts.reduce((max, text) => Math.max(max, cellWidth(text)), 0);
}

/** The row cut to `max` cells — the last guard; every form already fits by construction. */
function fitRow(row: Row, max: number): Row {
  if (rowWidth(row) <= max) return row;
  const out: Row = [];
  let used = 0;
  for (const [style, text] of row) {
    const w = cellWidth(text);
    if (used + w <= max) {
      out.push([style, text]);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push([style, truncateCells(text, room)]);
    break;
  }
  return out;
}

function styler(style: Style, ctx: Ctx): (text: string) => string {
  const t = tokens[ctx.mode];
  if (typeof style === "number") {
    const slot = style < 0 ? undefined : t.chart.series[style % t.chart.series.length];
    return colorStyler(slot ?? t.subtle);
  }
  switch (style) {
    case "title":
      return chalk.bold;
    case "subtle":
      return colorStyler(t.subtle);
    case "dim":
      return colorStyler(t.dim);
    case "up":
      return colorStyler(t.success);
    case "down":
      return colorStyler(t.error);
    default:
      return (text) => text;
  }
}

function paint(row: Row, ctx: Ctx): string {
  return row.map(([style, text]) => (ctx.color ? styler(style, ctx)(text) : text)).join("");
}

// ── the raster ───────────────────────────────────────────────────────────────

/** One series for {@link rasterize}: x in `0..1`, y in data units (`null` = a break). */
export interface RasterSeries {
  readonly index: number;
  readonly points: readonly { readonly x: number; readonly y: number | null }[];
  /** NO_COLOR: every third dot dropped, so series ≥ 2 read as dotted. */
  readonly dotted?: boolean;
  /** A 50 % dot fill from the line to the baseline. */
  readonly area?: boolean;
  /** 2×2 dot marks, no lines. */
  readonly scatter?: boolean;
}

export interface RasterFrame {
  readonly cols: number;
  readonly rows: number;
  readonly glyphs: ChartGlyphs;
  /** The y range the rows span (the nice ticks' `lo..hi`). */
  readonly lo: number;
  readonly hi: number;
  /** Where an area fills to (0 when in range, else the nearer edge). */
  readonly baseline?: number;
}

/** The cells (one glyph each) and which series owns each (`-1` = none). */
export interface Raster {
  readonly cells: string[][];
  readonly owner: number[][];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Series drawn into a `cols × rows` grid of braille (2×4) or quadrant (2×2)
 * cells. Consecutive defined points are joined by Bresenham lines; a point with
 * no defined neighbour is a 2×2 mark, so a single value is still visible. A
 * cell two series share takes the later series' colour (one foreground per cell).
 */
export function rasterize(series: readonly RasterSeries[], frame: RasterFrame): Raster {
  const braille = frame.glyphs === "braille";
  const cellH = braille ? 4 : 2;
  const cols = Math.max(1, frame.cols);
  const rows = Math.max(1, frame.rows);
  const W = cols * 2;
  const H = rows * cellH;
  const bits = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const owner = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  const span = frame.hi - frame.lo || 1;
  const px = (x: number): number => clamp(Math.round(x * (W - 1)), 0, W - 1);
  const py = (v: number): number =>
    clamp(Math.round((1 - (v - frame.lo) / span) * (H - 1)), 0, H - 1);
  const base = py(clamp(frame.baseline ?? frame.lo, frame.lo, frame.hi));

  const dot = (x: number, y: number, index: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const r = Math.floor(y / cellH);
    const c = Math.floor(x / 2);
    const bit = braille
      ? (BRAILLE_DOTS[y % 4] as readonly [number, number])[x % 2]
      : 1 << ((y % 2) * 2 + (x % 2));
    const line = bits[r] as number[];
    line[c] = (line[c] as number) | (bit as number);
    (owner[r] as number[])[c] = index;
  };

  for (const s of series) {
    let count = 0;
    const fill = (x: number, y: number): void => {
      const [from, to] = y < base ? [y + 1, base] : [base, y - 1];
      for (let yy = from; yy <= to; yy++) if ((x + yy) % 2 === 0) dot(x, yy, s.index);
    };
    const put = (x: number, y: number): void => {
      if (!s.dotted || count++ % 3 !== 2) dot(x, y, s.index);
      if (s.area) fill(x, y);
    };
    const mark = (x: number, y: number): void => {
      const x0 = Math.min(x, W - 2);
      const y0 = Math.min(y, H - 2);
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        dot(x0 + dx, y0 + dy, s.index);
      }
      if (s.area) fill(x, y);
    };
    const pts = s.points.map((p) => (p.y === null ? null : ([px(p.x), py(p.y)] as const)));
    let prev: readonly [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] ?? null;
      if (p === null) {
        prev = null;
        continue;
      }
      if (s.scatter || (prev === null && (pts[i + 1] ?? null) === null)) {
        mark(p[0], p[1]);
      } else if (prev === null) {
        put(p[0], p[1]);
      } else {
        line(prev, p, put);
      }
      prev = p;
    }
  }

  const cells = bits.map((line) =>
    line.map((b) =>
      b === 0 ? " " : braille ? String.fromCharCode(0x2800 + b) : (QUAD_GLYPHS[b] as string),
    ),
  );
  return { cells, owner };
}

/** Bresenham from `a` (exclusive: the previous segment drew it) to `b` (inclusive). */
function line(
  a: readonly [number, number],
  b: readonly [number, number],
  put: (x: number, y: number) => void,
): void {
  let [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 === x1 && y0 === y1) {
      put(x0, y0);
      return;
    }
    if (x0 !== a[0] || y0 !== a[1]) put(x0, y0);
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** A raster row as segments, one per run of the same owner. */
function rasterRow(raster: Raster, r: number): Row {
  const out: Row = [];
  const cells = raster.cells[r] ?? [];
  const owners = raster.owner[r] ?? [];
  let style: Style = "text";
  let text = "";
  for (let c = 0; c < cells.length; c++) {
    const glyph = cells[c] as string;
    const next: Style = glyph === " " ? "text" : (owners[c] as number);
    if (next !== style && text !== "") {
      out.push([style, text]);
      text = "";
    }
    style = next;
    text += glyph;
  }
  if (text !== "") out.push([style, text]);
  return out;
}

/**
 * LTTB for a plot `pixels` dots wide: at most one kept point per LTTB bucket, so
 * evenly spaced data land ≤ 2 points per dot column, and a spike survives.
 */
export function plotPoints(
  values: readonly (number | null)[],
  positions: readonly (number | null)[],
  pixels: number,
): { x: number; y: number | null }[] {
  const all = values.map((y, i) => ({ x: positions[i] ?? null, y }));
  const kept =
    values.length > pixels
      ? downsampleLttb(values, Math.max(3, pixels)).indices.map((i) => all[i])
      : all;
  return kept.flatMap((p) => (p === undefined || p.x === null ? [] : [{ x: p.x, y: p.y }]));
}

// ── axes ─────────────────────────────────────────────────────────────────────

/** The y axis' number format: the spec's, with `compact`/`full` decided once for all ticks. */
function numberFormat(
  axis: ChartSpec["y"],
  ctx: Ctx,
  maxAbs: number,
  forceFull = false,
): NumberFormat {
  const format = forceFull ? "full" : (axis?.format ?? autoFormat(maxAbs));
  return {
    format,
    locale: ctx.locale,
    ...(axis?.unit === undefined ? {} : { unit: axis.unit }),
    ...(axis?.decimals === undefined ? {} : { decimals: axis.decimals }),
  };
}

interface Tick {
  readonly pos: number;
  readonly text: string;
}

/** Where each dataset's points sit on x (`0..1`, `null` = unplaceable) and the x ticks. */
interface XModel {
  readonly positions: (number | null)[][];
  readonly ticks: Tick[];
  /** `times in Europe/Rome` when instants are drawn in a zone other than UTC. */
  readonly note?: string;
}

const DAY = 86_400_000;

function rawXs(spec: ChartSpec): (number | string)[][] {
  if (usesPoints(spec)) {
    return spec.datasets.map((d) => d.data.map((p) => (typeof p === "object" && p ? p.x : "")));
  }
  const labels = spec.labels ?? [];
  return spec.datasets.map(() => [...labels]);
}

function unitPositions(
  values: readonly (number | null)[],
  lo: number,
  hi: number,
): (number | null)[] {
  return values.map((v) => (v === null ? null : hi === lo ? 0.5 : (v - lo) / (hi - lo)));
}

function xModel(spec: ChartSpec, ctx: Ctx, plotCols: number): XModel {
  const raws = rawXs(spec);
  const maxTicks = Math.max(2, Math.floor(plotCols / 8));
  const type = effectiveXType(spec);
  if (type === "date") {
    const parsed = raws.map((xs) => xs.map((x) => parseIsoDate(String(x))));
    const first = parsed.flat().find((d) => d !== null);
    const instant = first?.kind === "instant";
    const zone = instant ? ctx.zone : "UTC";
    const times = parsed.map((ds) => ds.map((d) => (d === null ? null : d.ms)));
    const defined = times.flat().filter((t): t is number => t !== null);
    const lo = Math.min(...defined);
    const hi = Math.max(...defined);
    const positions = times.map((ts) => unitPositions(ts, lo, hi));
    const at =
      hi === lo ? [lo] : dateTicks(lo, hi, maxTicks, zone).filter((t) => t >= lo && t <= hi);
    const step = at.length > 1 ? (at[1] as number) - (at[0] as number) : 0;
    const granularity =
      at.length < 2
        ? (first?.granularity ?? "day")
        : step >= 360 * DAY
          ? "year"
          : step >= 28 * DAY
            ? "month"
            : step >= DAY
              ? "day"
              : "minute";
    const opts = { locale: ctx.locale, ...(zone === undefined ? {} : { zone }) };
    const label = (t: number): string => {
      if (granularity !== "minute") return formatDate(t, granularity, opts);
      // A midnight tick names its day: `00:00` alone loses the reader on a 48 h axis.
      const clock = formatDate(t, "minute", { ...opts, locale: "en-GB" });
      return clock === "00:00" ? formatDate(t, "day", opts) : formatDate(t, "minute", opts);
    };
    const ticks = at.map((t) => ({ pos: hi === lo ? 0.5 : (t - lo) / (hi - lo), text: label(t) }));
    const shownZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return instant && shownZone !== "UTC"
      ? { positions, ticks, note: `times in ${shownZone}` }
      : { positions, ticks };
  }
  if (type === "number") {
    const nums = raws.map((xs) => xs.map((x) => (Number.isFinite(Number(x)) ? Number(x) : null)));
    const defined = nums.flat().filter((v): v is number => v !== null);
    const nice = niceTicks(Math.min(...defined), Math.max(...defined), maxTicks);
    const format = numberFormat(spec.x, ctx, Math.max(Math.abs(nice.lo), Math.abs(nice.hi)));
    return {
      positions: nums.map((vs) => unitPositions(vs, nice.lo, nice.hi)),
      ticks: nice.ticks.map((t) => ({
        pos: (t - nice.lo) / (nice.hi - nice.lo || 1),
        text: formatNumber(t, format),
      })),
    };
  }
  // Category: first appearance order, evenly spaced.
  const order: string[] = [];
  for (const xs of raws) for (const x of xs) if (!order.includes(String(x))) order.push(String(x));
  const at = (i: number): number => (order.length === 1 ? 0.5 : i / (order.length - 1));
  return {
    positions: raws.map((xs) => xs.map((x) => at(order.indexOf(String(x))))),
    ticks: order.map((text, i) => ({ pos: at(i), text })),
  };
}

/**
 * The x label row: labels thinned by measured width (`thinLabels`), centred on
 * their dot column, clamped inside the plot, never touching (≥ 1 space between).
 */
function labelRow(ticks: readonly Tick[], plotCols: number): string {
  const W = plotCols * 2;
  const kept = thinLabels(
    ticks.map((t) => t.pos),
    ticks.map((t) => cellWidth(t.text)),
    plotCols - 1,
  );
  type Placed = { start: number; text: string };
  const placed: Placed[] = [];
  const end = (p: Placed | undefined): number =>
    p === undefined ? Number.NEGATIVE_INFINITY : p.start + cellWidth(p.text);
  for (const [k, index] of kept.entries()) {
    const tick = ticks[index] as Tick;
    const text = truncateCells(tick.text, plotCols);
    const w = cellWidth(text);
    const centre = Math.floor(Math.round(tick.pos * (W - 1)) / 2);
    const start = clamp(centre - Math.floor(w / 2), 0, plotCols - w);
    const last = k === kept.length - 1;
    // The last label orients the reader, so it wins over the ones it would touch.
    while (last && placed.length > 1 && end(placed[placed.length - 1]) + 1 > start) {
      placed.pop();
    }
    if (end(placed[placed.length - 1]) + 1 > start) continue;
    placed.push({ start, text });
  }
  let out = "";
  for (const p of placed) out = padEnd(out, p.start) + p.text;
  return out;
}

// ── legend ───────────────────────────────────────────────────────────────────

function lineGlyph(index: number, ctx: Ctx, scatter: boolean): string {
  if (scatter) return ctx.glyphs === "braille" ? "⣿" : "█";
  if (!ctx.color && index > 0) return "┅┅";
  return ctx.glyphs === "braille" ? "━━" : "▀▀";
}

function fillGlyph(index: number, ctx: Ctx): string {
  return ctx.color ? "█" : (MONO_FILLS[Math.max(0, index) % MONO_FILLS.length] as string);
}

/** `━━ 2026   ━━ 2025`, wrapped to the width: glyph in the series colour, name in `subtle`. */
function legendRows(
  items: readonly { glyph: string; name: string; index: number }[],
  ctx: Ctx,
): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
  for (const item of items) {
    const name = truncateCells(item.name, 24);
    const segs: Row = [
      [item.index, item.glyph],
      ["subtle", ` ${name}`],
    ];
    if (row.length > 0 && rowWidth(row) + 3 + rowWidth(segs) > ctx.cw) {
      rows.push(row);
      row = [];
    }
    if (row.length > 0) row.push(["text", "   "]);
    row.push(...segs);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function lastDefined(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (typeof v === "number") return v;
  }
  return null;
}

/** Expanded: one legend row per series with its min / max / last. */
function statRows(spec: ChartSpec, ctx: Ctx, format: NumberFormat, scatter: boolean): Row[] {
  const nameW = Math.min(24, maxWidth(spec.datasets.map((d) => d.label)));
  return spec.datasets.map((dataset, i) => {
    const values = datasetValues(spec, i);
    const finite = finiteValues(values);
    const last = lastDefined(values);
    const parts =
      finite.length === 0
        ? ["no values"]
        : [
            `min ${formatNumber(Math.min(...finite), format)}`,
            `max ${formatNumber(Math.max(...finite), format)}`,
            `last ${formatNumber(last ?? 0, format)}`,
          ];
    const head: Row = [
      [i, lineGlyph(i, ctx, scatter)],
      ["subtle", ` ${padEnd(truncateCells(dataset.label, nameW), nameW)}  `],
    ];
    // Whole facts only: drop the trailing ones that do not fit rather than cut a number.
    const room = ctx.cw - rowWidth(head);
    let stats = parts[0] as string;
    for (const part of parts.slice(1)) {
      if (cellWidth(`${stats} · ${part}`) > room) break;
      stats = `${stats} · ${part}`;
    }
    return [...head, ["text", stats]];
  });
}

// ── line / area / scatter: the plot ──────────────────────────────────────────

function plotRows(spec: ChartSpec, ctx: Ctx): Row[] | null {
  const scatter = spec.type === "scatter";
  const area = spec.type === "area";
  const h = ctx.expanded ? PLOT_ROWS.expanded : PLOT_ROWS.compact;
  // Stacked areas plot their running totals.
  const raw = spec.datasets.map((_, i) => datasetValues(spec, i));
  const ys =
    area && spec.stacked === true
      ? raw.map((_, i) =>
          (raw[i] as (number | null)[]).map((v, k) =>
            v === null ? null : raw.slice(0, i + 1).reduce((sum, s) => sum + (s[k] ?? 0), 0),
          ),
        )
      : raw;
  const all = ys.flatMap((s) => finiteValues(s));
  if (all.length === 0) return null;
  const ticks = niceTicks(Math.min(...all), Math.max(...all), Math.floor(h / 2) + 1, area);
  const format = numberFormat(spec.y, ctx, Math.max(Math.abs(ticks.lo), Math.abs(ticks.hi)));
  const labels = ticks.ticks.map((t) => formatNumber(t, format));
  const gw = maxWidth(labels);
  const pw = ctx.cw - gw - 2;
  if (pw < 16) return null;
  const x = xModel(spec, ctx, pw);
  const series: RasterSeries[] = ys.map((values, i) => ({
    index: i,
    points: scatter
      ? values.map((y, k) => ({
          x: x.positions[i]?.[k] ?? 0,
          y: x.positions[i]?.[k] == null ? null : y,
        }))
      : plotPoints(values, x.positions[i] ?? [], pw * 2),
    dotted: !ctx.color && i > 0,
    area,
    scatter,
  }));
  // Stacked: the top total first, so each lower series owns its own band's cells.
  const order = area && spec.stacked === true ? [...series].reverse() : series;
  const raster = rasterize(order, {
    cols: pw,
    rows: h,
    glyphs: ctx.glyphs,
    lo: ticks.lo,
    hi: ticks.hi,
    baseline: 0,
  });
  const cellH = ctx.glyphs === "braille" ? 4 : 2;
  const tickRow = new Map<number, string>();
  ticks.ticks.forEach((t, i) => {
    const y = Math.round((1 - (t - ticks.lo) / (ticks.hi - ticks.lo || 1)) * (h * cellH - 1));
    const row = Math.floor(y / cellH);
    if (!tickRow.has(row)) tickRow.set(row, labels[i] as string);
  });
  const rows: Row[] = ctx.expanded
    ? statRows(spec, ctx, format, scatter)
    : legendRows(
        spec.datasets.map((d, i) => ({
          glyph: lineGlyph(i, ctx, scatter),
          name: d.label,
          index: i,
        })),
        ctx,
      );
  for (let r = 0; r < h; r++) {
    const label = tickRow.get(r);
    rows.push([
      ["dim", `${padStart(label ?? "", gw)} ${label === undefined ? "│" : "┤"}`],
      ...rasterRow(raster, r),
    ]);
  }
  rows.push([["dim", `${" ".repeat(gw + 1)}└${"─".repeat(pw)}`]]);
  rows.push([["dim", " ".repeat(gw + 2) + labelRow(x.ticks, pw)]]);
  const captions = [
    spec.x?.title === undefined ? "" : `x: ${spec.x.title}`,
    spec.y?.title === undefined ? "" : `y: ${spec.y.title}`,
    x.note ?? "",
  ].filter((c) => c !== "");
  if (captions.length > 0) rows.push([["subtle", " ".repeat(gw + 2) + captions.join(" · ")]]);
  return rows;
}

// ── line / area at 40–59 cols: one sparkline row per series ──────────────────

function sparkRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const all = finiteValues(spec.datasets.flatMap((_, i) => datasetValues(spec, i)));
  const format = numberFormat(
    spec.y,
    ctx,
    all.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
  );
  const nameW = Math.min(12, maxWidth(spec.datasets.map((d) => d.label)));
  return spec.datasets.map((dataset, i) => {
    const values = datasetValues(spec, i);
    const finite = finiteValues(values);
    const first = values.find((v): v is number => typeof v === "number") ?? null;
    const last = lastDefined(values);
    const stats: Row = [];
    if (first !== null && last !== null) {
      stats.push(["text", `${formatNumber(first, format)} → ${formatNumber(last, format)}`]);
      if (first !== 0 && last !== first) {
        const change = Math.round(((last - first) / Math.abs(first)) * 100);
        stats.push([
          last > first ? "up" : "down",
          ` ${last > first ? "↑" : "↓"}${Math.abs(change)}%`,
        ]);
      }
    }
    const room = ctx.cw - nameW - 1 - 2 - rowWidth(stats);
    const cells = clamp(room, 4, Math.max(4, values.length));
    const means = bucketMeans(values, cells);
    const defined = finiteValues(means);
    const lo = Math.min(...defined);
    const hi = Math.max(...defined);
    const spark = means
      .map((v) =>
        v === null
          ? " "
          : (SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)] as string),
      )
      .join("");
    return [
      ["subtle", `${padEnd(truncateCells(dataset.label, nameW), nameW)} `],
      [i, finite.length === 0 ? "" : spark],
      ["text", "  "],
      ...stats,
    ];
  });
}

// ── bars ─────────────────────────────────────────────────────────────────────

/** The category names of a bar/pie chart: its labels, else the first dataset's x. */
function categories(spec: ChartSpec): string[] {
  if (spec.labels !== undefined) return spec.labels.map(String);
  return (spec.datasets[0]?.data ?? []).map((p) => (typeof p === "object" && p ? String(p.x) : ""));
}

/** `cells` split among `parts` by largest remainder: the lengths sum exactly. */
export function splitCells(parts: readonly number[], cells: number): number[] {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p), 0);
  const raw = parts.map((p) => (total === 0 ? 0 : (Math.max(0, p) / total) * cells));
  const out = raw.map(Math.floor);
  let rest = cells - out.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0 || total === 0) break;
    out[i] = (out[i] as number) + 1;
    rest--;
  }
  return out;
}

/** A positive bar of `units` eighths: whole cells, then the ⅛ remainder. */
function eighths(units: number): string {
  return "█".repeat(Math.floor(units / 8)) + EIGHTHS_H[units % 8];
}

function barFormat(spec: ChartSpec, ctx: Ctx): NumberFormat {
  const all = chartNumbers(spec);
  return numberFormat(
    spec.y,
    ctx,
    all.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
  );
}

function chartNumbers(spec: ChartSpec): number[] {
  return spec.datasets.flatMap((_, i) => finiteValues(datasetValues(spec, i)));
}

function labelWidth(names: readonly string[], ctx: Ctx): number {
  return Math.min(maxWidth(names), Math.max(6, Math.floor(ctx.cw * 0.3)), 24);
}

/**
 * Horizontal bars with ⅛-cell precision, the value after each bar. Negative
 * values grow left from a shared 0 column (half-cell precision: only `▐` exists
 * on the right side of a cell). Several datasets → one row each per category.
 */
function hbarRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const names = categories(spec);
  const format = barFormat(spec, ctx);
  const all = chartNumbers(spec);
  const posMax = Math.max(0, ...all);
  const negMax = Math.max(0, ...all.map((v) => -v));
  const lw = labelWidth(names, ctx);
  const texts = spec.datasets.map((_, i) =>
    datasetValues(spec, i).map((v) => (v === null ? "—" : formatNumber(v, format))),
  );
  const vw = maxWidth(texts.flat());
  const bw = Math.max(1, ctx.cw - lw - 2 - vw);
  const negCells = negMax > 0 ? Math.round((bw * negMax) / (posMax + negMax)) : 0;
  const posCells = bw - negCells;
  const rows: Row[] =
    spec.datasets.length > 1
      ? legendRows(
          spec.datasets.map((d, i) => ({
            glyph: fillGlyph(i, ctx).repeat(2),
            name: d.label,
            index: i,
          })),
          ctx,
        )
      : [];
  names.forEach((name, c) => {
    spec.datasets.forEach((_, i) => {
      const v = datasetValues(spec, i)[c] ?? null;
      const label = i === 0 ? padEnd(truncateCells(name, lw), lw) : " ".repeat(lw);
      const row: Row = [["subtle", `${label} `]];
      let bar = "";
      let neg = "";
      if (v !== null && v >= 0 && posMax > 0)
        bar = eighths(Math.round((v / posMax) * posCells * 8));
      if (v !== null && v < 0) {
        const halves = Math.round((-v / negMax) * negCells * 2);
        neg = (halves % 2 === 1 ? "▐" : "") + "█".repeat(Math.floor(halves / 2));
      }
      if (!ctx.color) {
        const fill = fillGlyph(i, ctx);
        bar = bar.replaceAll("█", fill);
        neg = neg.replaceAll("█", fill);
      }
      if (negCells > 0) row.push(["text", " ".repeat(negCells - cellWidth(neg))], [i, neg]);
      row.push([i, bar], ["text", `${bar === "" && neg === "" ? "" : " "}${texts[i]?.[c] ?? ""}`]);
      rows.push(row);
    });
  });
  return rows;
}

/** Columns (`▁▂▃▄▅▆▇█`): one dataset, ≤ 6 short, non-negative categories. */
function columnRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const names = categories(spec);
  const values = datasetValues(spec, 0);
  const h = ctx.expanded ? PLOT_ROWS.expanded : PLOT_ROWS.compact;
  const max = Math.max(0, ...finiteValues(values));
  const ticks = niceTicks(0, max, Math.floor(h / 2) + 1, true);
  const format = numberFormat(spec.y, ctx, ticks.hi);
  const labels = ticks.ticks.map((t) => formatNumber(t, format));
  const gw = maxWidth(labels);
  const colW = Math.min(12, Math.floor((ctx.cw - gw - 2) / names.length));
  const barW = Math.max(1, colW - 2);
  const tickRow = new Map<number, string>();
  ticks.ticks.forEach((t, i) => {
    const r = h - Math.round((t / (ticks.hi || 1)) * h);
    if (!tickRow.has(r)) tickRow.set(r, labels[i] as string);
  });
  const units = values.map((v) => (v === null ? 0 : Math.round((v / (ticks.hi || 1)) * h * 8)));
  const rows: Row[] = [];
  for (let r = 0; r < h; r++) {
    const fromBottom = h - 1 - r;
    const label = tickRow.get(r);
    const row: Row = [["dim", `${padStart(label ?? "", gw)} ${label === undefined ? "│" : "┤"}`]];
    for (const u of units) {
      const level = clamp(u - fromBottom * 8, 0, 8);
      const glyph = EIGHTHS_V[level] as string;
      row.push([0, glyph.repeat(barW)], ["text", " ".repeat(colW - barW)]);
    }
    rows.push(row);
  }
  rows.push([["dim", `${padStart(tickRow.get(h) ?? "", gw)} └${"─".repeat(colW * names.length)}`]]);
  const under = names.map((n) => {
    const text = truncateCells(n, colW - 1);
    const left = Math.floor((barW - cellWidth(text)) / 2);
    return padEnd(" ".repeat(Math.max(0, left)) + text, colW);
  });
  rows.push([["subtle", " ".repeat(gw + 2) + under.join("")]]);
  return rows;
}

/** Stacked rows: whole-cell segments (one colour per cell), the total after. */
function stackedRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const names = categories(spec);
  const format = barFormat(spec, ctx);
  const lw = labelWidth(names, ctx);
  const parts = names.map((_, c) =>
    spec.datasets.map((__, i) => Math.max(0, datasetValues(spec, i)[c] ?? 0)),
  );
  const totals = parts.map((p) => p.reduce((sum, v) => sum + v, 0));
  const max = Math.max(0, ...totals);
  const texts = totals.map((t) => formatNumber(t, format));
  const bw = Math.max(1, ctx.cw - lw - 2 - maxWidth(texts));
  const rows = legendRows(
    spec.datasets.map((d, i) => ({ glyph: fillGlyph(i, ctx).repeat(2), name: d.label, index: i })),
    ctx,
  );
  names.forEach((name, c) => {
    const cells = max === 0 ? 0 : Math.round(((totals[c] as number) / max) * bw);
    const split = splitCells(parts[c] as number[], cells);
    rows.push([
      ["subtle", `${padEnd(truncateCells(name, lw), lw)} `],
      ...split.map((k, i): Seg => [i, fillGlyph(i, ctx).repeat(k)]),
      ["text", ` ${texts[c]}`],
    ]);
  });
  return rows;
}

function barRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const all = chartNumbers(spec);
  const negative = all.some((v) => v < 0);
  if (spec.stacked === true && !negative && spec.datasets.length > 1) return stackedRows(spec, ctx);
  const names = categories(spec);
  const columns =
    spec.datasets.length === 1 &&
    !negative &&
    names.length <= 6 &&
    names.every((n) => cellWidth(n) <= 8) &&
    Math.floor((ctx.cw - 8) / names.length) >= 4;
  return columns ? columnRows(spec, ctx) : hbarRows(spec, ctx);
}

// ── pie / doughnut: a 100 % bar and a legend with values ──────────────────────

/** Slices beyond this are folded into one "Other" (Owner Q7). */
const PIE_SLICES = 6;

function pieRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const names = categories(spec);
  const values = datasetValues(spec, 0).map((v) => Math.max(0, v ?? 0));
  let slices = names.map((name, i) => ({ name, value: values[i] ?? 0, index: i }));
  if (slices.length > PIE_SLICES + 1) {
    const top = [...slices].sort((a, b) => b.value - a.value).slice(0, PIE_SLICES);
    const rest = slices.filter((s) => !top.includes(s));
    slices = [
      ...slices.filter((s) => top.includes(s)),
      { name: "Other", value: rest.reduce((sum, s) => sum + s.value, 0), index: -1 },
    ];
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const format = numberFormat(spec.y, ctx, total);
  const split = splitCells(
    slices.map((s) => s.value),
    ctx.cw,
  );
  const nw = Math.min(24, maxWidth(slices.map((s) => s.name)));
  const vs = slices.map((s) => formatNumber(s.value, format));
  const ps = slices.map((s) => (total === 0 ? "—" : formatPercent(s.value / total, ctx.locale)));
  const vw = maxWidth([...vs, formatNumber(total, format)]);
  const pw = maxWidth(ps);
  const rows: Row[] = [
    split.map((k, i): Seg => [slices[i]?.index ?? -1, fillGlyph(i, ctx).repeat(k)]),
  ];
  slices.forEach((s, i) => {
    rows.push([
      [s.index, fillGlyph(i, ctx).repeat(2)],
      ["subtle", ` ${padEnd(truncateCells(s.name, nw), nw)}  `],
      ["text", padStart(vs[i] as string, vw)],
      ["subtle", `  ${padStart(ps[i] as string, pw)}`],
    ]);
  });
  rows.push([
    ["subtle", `   ${padEnd("total", nw)}  `],
    ["text", padStart(formatNumber(total, format), vw)],
  ]);
  return rows;
}

// ── the data table (the faithful fallback, and the expanded form's tail) ──────

function tableRows(spec: ChartSpec, ctx: Ctx, max: number): Row[] {
  const format = numberFormat(spec.y, ctx, 0, true);
  const cell = (v: number | null): string => (v === null ? "—" : formatNumber(v, format));
  let head: string[];
  let body: string[][];
  if (spec.type === "pie" || spec.type === "doughnut") {
    const values = datasetValues(spec, 0);
    const total = finiteValues(values).reduce((sum, v) => sum + v, 0);
    head = ["", "value", "%"];
    body = categories(spec).map((name, i) => {
      const v = values[i] ?? null;
      return [
        name,
        cell(v),
        v === null || total === 0 ? "—" : formatPercent(v / total, ctx.locale),
      ];
    });
  } else if (usesPoints(spec)) {
    const several = spec.datasets.length > 1;
    head = [...(several ? ["series"] : []), spec.x?.title ?? "x", spec.y?.title ?? "y"];
    const xFormat = numberFormat(spec.x, ctx, 0, true);
    body = spec.datasets.flatMap((d) =>
      d.data.map((p) => {
        const point = typeof p === "object" && p ? p : { x: "", y: null };
        const x = typeof point.x === "number" ? formatNumber(point.x, xFormat) : point.x;
        return [...(several ? [d.label] : []), x, cell(point.y)];
      }),
    );
  } else {
    head = [spec.x?.title ?? "", ...spec.datasets.map((d) => d.label)];
    body = (spec.labels ?? []).map((label, k) => [
      String(label),
      ...spec.datasets.map((_, i) => cell(datasetValues(spec, i)[k] ?? null)),
    ]);
  }
  const firstMax = Math.max(6, Math.floor(ctx.cw * 0.4));
  const all = head.map((h, c) => {
    const w = maxWidth([h, ...body.map((r) => r[c] ?? "")]);
    return c === 0 ? Math.min(w, firstMax) : w;
  });
  // A number cut in half lies: columns that do not fit are dropped whole, and said so.
  let shownCols = 1;
  while (
    shownCols < all.length &&
    all.slice(0, shownCols + 1).reduce((s, w) => s + w + 2, -2) <= ctx.cw
  ) {
    shownCols++;
  }
  const dropped = all.length - shownCols;
  const widths = all.slice(0, shownCols);
  head = head.slice(0, shownCols);
  body = body.map((r) => r.slice(0, shownCols));
  const line = (cells: readonly string[], numbers: Style, names: Style): Row =>
    cells.flatMap(
      (text, c): Row => [
        [
          c === 0 ? names : numbers,
          c === 0
            ? padEnd(truncateCells(text, widths[0] as number), widths[0] as number)
            : padStart(text, widths[c] as number),
        ],
        ["text", c < cells.length - 1 ? "  " : ""],
      ],
    );
  const total = widths.reduce((sum, w) => sum + w + 2, -2);
  const shown = body.length > max ? body.slice(0, max) : body;
  const rows: Row[] = [line(head, "dim", "dim"), [["dim", "─".repeat(Math.min(ctx.cw, total))]]];
  for (const r of shown) rows.push(line(r, "text", "subtle"));
  if (body.length > shown.length) {
    const more = `… +${body.length - shown.length} more rows`;
    const hint = `${more} · ctrl+o to expand`;
    rows.push([["subtle", ctx.expanded || cellWidth(hint) > ctx.cw ? more : hint]]);
  }
  if (dropped > 0) rows.push([["subtle", `… +${dropped} more column${dropped === 1 ? "" : "s"}`]]);
  return rows;
}

// ── the chart ────────────────────────────────────────────────────────────────

/** The caption: title (bold) and subtitle (subtle) — the only chrome a chart wears. */
function captionRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const title: Row = [["title", truncateCells(spec.title, ctx.cw)]];
  if (spec.subtitle === undefined) return [title];
  const inline: Row = [...title, ["subtle", ` · ${spec.subtitle}`]];
  if (rowWidth(inline) <= ctx.cw) return [inline];
  return [title, [["subtle", truncateCells(spec.subtitle, ctx.cw)]]];
}

function bodyRows(spec: ChartSpec, ctx: Ctx): Row[] {
  const tableMax = ctx.expanded ? TABLE_ROWS.expanded : TABLE_ROWS.compact;
  if (ctx.cw < NARROW_BELOW) return tableRows(spec, ctx, tableMax);
  const pie = spec.type === "pie" || spec.type === "doughnut";
  let rows: Row[];
  if (pie) rows = pieRows(spec, ctx);
  else if (spec.type === "bar") rows = barRows(spec, ctx);
  else if (spec.type === "scatter" || ctx.cw >= PLOT_MIN) {
    rows =
      plotRows(spec, ctx) ??
      (spec.type === "scatter" ? tableRows(spec, ctx, tableMax) : sparkRows(spec, ctx));
  } else rows = sparkRows(spec, ctx);
  // The pie's legend already IS its table.
  if (ctx.expanded && !pie) rows = [...rows, BLANK, ...tableRows(spec, ctx, TABLE_ROWS.expanded)];
  return rows;
}

function hostLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * The rows a `chart` tool call draws, from its own arguments — or `undefined`
 * when those are not a spec this client can draw (not JSON, or refused by the
 * shared validator: a pod can forge them, AGENTS §7).
 *
 * The client re-validates here on every draw, with the same caps as the daemon
 * (docs/feat/model-charts.md D1/C4): the worst a forged or newer-than-this-build
 * spec does is fall back to the generic tool row, never a crash and never an
 * error message in the transcript.
 */
export function chartToolBody(
  args: string,
  options: ChartLineOptions,
): readonly string[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return undefined;
  }
  const validation = validateChartSpec(raw);
  return validation.ok ? chartLines(validation.spec, options) : undefined;
}

/**
 * A validated chart spec as terminal lines: caption, then the form its type and
 * the width call for. Every line is at most `width` cells; a chart narrower than
 * the width (capped at {@link CHART_MAX_WIDTH}) is centred.
 */
export function chartLines(spec: ChartSpec, options: ChartLineOptions): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const ctx: Ctx = {
    cw: Math.min(width, CHART_MAX_WIDTH),
    expanded: options.expanded === true,
    glyphs: options.glyphs ?? "braille",
    color: options.color ?? chalk.level > 0,
    mode: options.mode ?? themeMode(),
    locale: options.locale ?? hostLocale(),
    zone: options.zone,
  };
  const pad = " ".repeat(Math.floor((width - ctx.cw) / 2));
  return [...captionRows(spec, ctx), ...bodyRows(spec, ctx)].map(
    (row) => pad + paint(fitRow(row, ctx.cw), ctx),
  );
}

/**
 * The phone chart layouts for bars, stacked bars, donuts and scatters
 * (docs/feat/model-charts.md *iPhone visual language (rev 2)*; owner picks:
 * bar B, stacked B, donut B, scatter A). Pure, React-free; `chart-layout.ts`
 * dispatches here.
 */
import {
  type ChartSpec,
  datasetValues,
  effectiveXType,
  formatDate,
  formatNumber,
  niceTicks,
  parseIsoDate,
  yFormat,
} from "@tentacle/core";
import { domain, barSide, barUp, dodge, n1, rectPath, sector } from "./chart-geometry.ts";
import { chartWords, heroOf, isStacked, scatterTrend, xTexts } from "./chart-hero.ts";
import {
  chartSummary,
  chartTable,
  guideItems,
  labelsFit,
  legendOf,
  pickXLabels,
} from "./chart-layout-axis.ts";
import {
  type ChartLayout,
  type Ctx,
  type LayoutDot,
  type LayoutPath,
  type LayoutText,
  SIZE,
  fitText,
} from "./chart-layout-kit.ts";

/** Up to this many categories a bar chart is Screen-Time rows; more is columns. */
export const ROWS_MAX = 12;
/** B's stacked column: share of its slot, and the gap between segments (pt). */
export const STACK_WIDTH = 0.34;
export const STACK_GAP = 1.5;
export const STACK_RADIUS = 3;
/** Slices shown before the rest fold into "Altro" (the TUI's rule: never fold one slice alone). */
export const DONUT_SLICES = 6;

/** A rounded rectangle (both ends): the bar track and the legend swatch. */
function capsule(x: number, y: number, w: number, h: number, r: number): string {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.min(r, w / 2, h / 2);
  return `M${n1(x + rr)},${n1(y)}H${n1(x + w - rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x + w)},${n1(y + rr)}V${n1(y + h - rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x + w - rr)},${n1(y + h)}H${n1(x + rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x)},${n1(y + h - rr)}V${n1(y + rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x + rr)},${n1(y)}Z`;
}

function visibleOf(spec: ChartSpec, ctx: Ctx): number[] {
  return spec.datasets.map((_, k) => k).filter((k) => !ctx.hidden.has(k));
}

function categoryCount(spec: ChartSpec): number {
  return Math.max(0, ...spec.datasets.map((d) => d.data.length));
}

/** The first index of the max (ties → first), or −1. */
function argmax(values: readonly (number | null)[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (typeof v === "number" && (best < 0 || v > (values[best] as number))) best = i;
  });
  return best;
}

const noScrub = { hit: () => null, scrubAt: () => null };

export function barLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  if (isStacked(spec)) return stackedLayout(spec, ctx);
  return categoryCount(spec) <= ROWS_MAX ? rowsLayout(spec, ctx) : columnsLayout(spec, ctx);
}

/** B rows: a mono name column, a faint track, 9 pt bars, the value right-aligned. */
function rowsLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  const { width, fs, locale, measure } = ctx;
  const visible = visibleOf(spec, ctx);
  const names = xTexts(spec, locale)[0] ?? [];
  const n = categoryCount(spec);
  const size = SIZE.row * fs;
  const single = visible.length === 1;
  const bar = 9;
  const rowH = Math.max(23, Math.round(size + 11), single ? 0 : 8 + visible.length * (bar + 3));
  const format = yFormat(spec, locale);
  const values = visible.map((k) => datasetValues(spec, k));
  const valueTexts = single
    ? (values[0] ?? []).map((v) => (typeof v === "number" ? formatNumber(v, format) : "—"))
    : [];
  const vw = single ? Math.max(0, ...valueTexts.map((t) => measure(t, size))) + 8 : 0;
  const nameMax = Math.max(0, ...names.map((t) => measure(t, size)));
  const nameW = Math.max(0, Math.min(nameMax, width * 0.38, width - vw - 8 - width * 0.35));
  const x0 = nameW + 8;
  const bw = Math.max(1, width - x0 - vw);
  const all = values.flat().filter((v): v is number => typeof v === "number");
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all) || (lo < 0 ? 0 : 1);
  const X = (v: number): number => x0 + ((v - lo) / (hi - lo || 1)) * bw;
  const base = X(0);
  const top = single ? argmax(values[0] ?? []) : -1;
  const paths: LayoutPath[] = [];
  const texts: LayoutText[] = [];
  for (let i = 0; i < n; i++) {
    const y = i * rowH;
    const mid = y + rowH / 2;
    texts.push({
      x: 0,
      y: mid + size * 0.35,
      text: fitText(names[i] ?? "", nameW, size, measure),
      anchor: "start",
      size,
      role: "name",
      strong: i === top,
    });
    const first = mid - (visible.length * (bar + 3) - 3) / 2;
    paths.push({
      d: capsule(
        x0,
        single ? mid - bar / 2 : first,
        bw,
        single ? bar : visible.length * (bar + 3) - 3,
        2.5,
      ),
      role: "track",
      series: -1,
      paint: { token: "track" },
      opacity: 1,
      index: i,
    });
    visible.forEach((k, j) => {
      const v = (values[j] ?? [])[i];
      if (typeof v !== "number" || v === 0) return;
      const by = single ? mid - bar / 2 : first + j * (bar + 3);
      const end = v > 0 ? Math.max(X(v), base + 2) : Math.min(X(v), base - 2);
      paths.push({
        d: barSide(base, end, by, bar, 2.5),
        role: "bar",
        series: k,
        paint: { series: k },
        opacity: single && i !== top ? 0.38 : 1,
        box: { x: Math.min(base, end), y: by, w: Math.abs(end - base), h: bar },
        highlight: i === top,
        index: i,
      });
    });
    if (single) {
      texts.push({
        x: width,
        y: mid + size * 0.35,
        text: valueTexts[i] ?? "",
        anchor: "end",
        size,
        role: "value",
        strong: i === top,
      });
    }
  }
  const height = n * rowH;
  return {
    kind: "bars",
    width,
    height,
    plot: { left: x0, right: x0 + bw, top: 0, bottom: height },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots: [],
    texts,
    guides: [],
    legend: single ? null : legendOf(spec, visible, (k) => ({ series: k })),
    summary: chartSummary(spec, locale),
    table: chartTable(spec, locale),
    ...noScrub,
  };
}

/** x labels at column centres, clamped inside the chart, thinned by measured width. */
function columnLabels(
  names: readonly string[],
  centre: (i: number) => number,
  y: number,
  ctx: Ctx,
  limit: number,
  strongAt: number,
): LayoutText[] {
  const size = SIZE.x * ctx.fs;
  const cands: LayoutText[] = names.map((text, i) => {
    const half = ctx.measure(text, size) / 2;
    const x = Math.min(Math.max(centre(i), half), limit - half);
    return { x, y, text, anchor: "middle", size, role: "x", strong: i === strongAt };
  });
  return pickXLabels(cands, ctx.measure);
}

/** B columns (more than ROWS_MAX categories): 34 % of the slot, the max highlighted. */
function columnsLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  const { width, fs, locale } = ctx;
  const height = ctx.height ?? Math.round(200 + 24 * (fs - 1));
  const visible = visibleOf(spec, ctx);
  const names = xTexts(spec, locale)[0] ?? [];
  const n = categoryCount(spec);
  const values = visible.map((k) => datasetValues(spec, k));
  const [lo, hi] = domain(
    values.flat().filter((v): v is number => typeof v === "number"),
    true,
  );
  const top = Math.round(8 + SIZE.guide * fs);
  const bottom = height - Math.round(10 + SIZE.x * fs);
  const Y = (v: number): number => top + (1 - (v - lo) / (hi - lo || 1)) * (bottom - top);
  const slot = width / Math.max(1, n);
  const group = slot * STACK_WIDTH;
  const w = group / Math.max(1, visible.length);
  const single = visible.length === 1;
  const best = single ? argmax(values[0] ?? []) : -1;
  const paths: LayoutPath[] = [];
  for (let i = 0; i < n; i++) {
    const gx = i * slot + (slot - group) / 2;
    visible.forEach((k, j) => {
      const v = (values[j] ?? [])[i];
      if (typeof v !== "number") return;
      const x = gx + j * w;
      const d = barUp(x, w, Y(0), Y(v), STACK_RADIUS);
      if (d === "") return;
      paths.push({
        d,
        role: "bar",
        series: k,
        paint: { series: k },
        opacity: single && i !== best ? 0.38 : 1,
        box: { x, y: Math.min(Y(0), Y(v)), w, h: Math.abs(Y(0) - Y(v)) },
        highlight: i === best,
        index: i,
      });
    });
  }
  const g = guideItems(spec, ctx, { lo, hi, x1: 0, x2: width, style: "solid" }, Y, "start", []);
  const centre = (i: number): number => i * slot + slot / 2;
  const xLabels = columnLabels(names, centre, height - 5, ctx, width, best);
  return {
    kind: "columns",
    width,
    height,
    plot: { left: 0, right: width, top, bottom },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots: [],
    texts: [...g.texts, ...xLabels],
    guides: g.guides,
    legend: single ? null : legendOf(spec, visible, (k) => ({ series: k })),
    summary: chartSummary(spec, locale),
    table: chartTable(spec, locale),
    hit: (x) => (n === 0 ? null : Math.min(n - 1, Math.max(0, Math.floor(x / slot)))),
    scrubAt: (i) =>
      i >= 0 && i < n
        ? { index: i, x: centre(i), dots: [], dimFromX: null, hero: heroOf(spec, i, locale) }
        : null,
  };
}

/** One stacked segment: its value range, and whether it is the rounded outer one. */
interface Segment {
  readonly k: number;
  readonly from: number;
  readonly to: number;
  readonly outer: boolean;
}

/** Segments of column `i`: positives stack up from 0, negatives down; the outermost of each is rounded. */
export function stackSegments(
  values: readonly (readonly (number | null)[])[],
  visible: readonly number[],
  i: number,
): Segment[] {
  const out: Segment[] = [];
  for (const sign of [1, -1]) {
    let acc = 0;
    const ks = visible.filter((_, j) => {
      const v = values[j]?.[i];
      return typeof v === "number" && Math.sign(v) === sign;
    });
    ks.forEach((k, at) => {
      const v = values[visible.indexOf(k)]?.[i] as number;
      out.push({ k, from: acc, to: acc + v, outer: at === ks.length - 1 });
      acc += v;
    });
  }
  return out;
}

/** B stacked: thin solid columns, 1,5 pt gaps, the top rounded, the max total labelled. */
function stackedLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  const { width, fs, locale } = ctx;
  const height = ctx.height ?? Math.round(200 + 24 * (fs - 1));
  const visible = visibleOf(spec, ctx);
  const names = xTexts(spec, locale)[0] ?? [];
  const n = categoryCount(spec);
  const values = visible.map((k) => datasetValues(spec, k));
  const columns = Array.from({ length: n }, (_, i) => stackSegments(values, visible, i));
  const ends = columns.flatMap((segs) => segs.map((s) => s.to));
  const [lo, hi] = domain(ends.length > 0 ? ends : [0], true);
  const top = Math.round(8 + SIZE.guide * fs);
  const bottom = height - Math.round(10 + SIZE.x * fs);
  const Y = (v: number): number => top + (1 - (v - lo) / (hi - lo || 1)) * (bottom - top);
  const format = yFormat(spec, locale);
  const last = n - 1;
  const dSize = SIZE.row * fs;
  const lineH = dSize * 1.2;
  const nameOf = (k: number): string => {
    const v = datasetValues(spec, k)[last];
    const label = spec.datasets[k]?.label ?? "";
    return typeof v === "number" ? `${label} ${formatNumber(v, format)}` : label;
  };
  const gutterW =
    visible.length > 0 ? Math.max(...visible.map((k) => ctx.measure(nameOf(k), dSize))) + 12 : 0;
  const useLegend = !labelsFit(visible.length, lineH, bottom - top, gutterW, width);
  const pw = useLegend ? width : width - gutterW;
  const slot = pw / Math.max(1, n);
  const bw = slot * STACK_WIDTH;
  const paths: LayoutPath[] = [];
  const totals = columns.map((segs) =>
    segs.filter((s) => s.to > 0).reduce((m, s) => Math.max(m, s.to), 0),
  );
  const maxAt = argmax(totals);
  columns.forEach((segs, i) => {
    const x = i * slot + (slot - bw) / 2;
    for (const s of segs) {
      const inner = s.from !== 0;
      const up = s.to > s.from;
      // The gap comes off this segment's inner end, so heights + gaps = the column, exactly.
      const y0 = Y(s.from) + (inner ? (up ? -STACK_GAP : STACK_GAP) : 0);
      const y1 = Y(s.to);
      const h = Math.abs(y0 - y1);
      const d = s.outer ? barUp(x, bw, y0, y1, STACK_RADIUS) : rectPath(x, Math.min(y0, y1), bw, h);
      if (d === "") continue;
      paths.push({
        d,
        role: "bar",
        series: s.k,
        paint: { series: s.k },
        opacity: 1,
        box: { x, y: Math.min(y0, y1), w: bw, h },
        highlight: i === last,
        index: i,
      });
    }
  });
  const texts: LayoutText[] = [];
  if (maxAt >= 0) {
    texts.push({
      x: maxAt * slot + slot / 2,
      y: Y(totals[maxAt] as number) - 5,
      text: formatNumber(totals[maxAt] as number, format),
      anchor: "middle",
      size: SIZE.x * fs,
      role: "value",
    });
  }
  if (!useLegend && n > 0) {
    const mids = visible.map((k) => {
      const s = columns[last]?.find((seg) => seg.k === k);
      return (s ? (Y(s.from) + Y(s.to)) / 2 : Y(0)) + dSize / 3;
    });
    const placed = dodge(mids, lineH, top + dSize * 0.8, bottom);
    visible.forEach((k, j) => {
      texts.push({
        x: pw + 8,
        y: placed[j] as number,
        text: nameOf(k),
        anchor: "start",
        size: dSize,
        role: "direct",
        series: k,
      });
    });
  }
  const g = guideItems(spec, ctx, { lo, hi, x1: 0, x2: pw, style: "solid" }, Y, "start", texts);
  const centre = (i: number): number => i * slot + slot / 2;
  return {
    kind: "stacked",
    width,
    height,
    plot: { left: 0, right: pw, top, bottom },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots: [],
    texts: [...g.texts, ...columnLabels(names, centre, height - 5, ctx, pw, last), ...texts],
    guides: g.guides,
    legend: useLegend ? legendOf(spec, visible, (k) => ({ series: k })) : null,
    summary: chartSummary(spec, locale),
    table: chartTable(spec, locale),
    hit: (x) => (n === 0 ? null : Math.min(n - 1, Math.max(0, Math.floor(x / slot)))),
    scrubAt: (i) =>
      i >= 0 && i < n
        ? { index: i, x: centre(i), dots: [], dimFromX: null, hero: heroOf(spec, i, locale) }
        : null,
  };
}

/** The donut's slices after folding: name, value, colour slot. */
export function donutSlices(
  spec: ChartSpec,
  locale: string,
): { name: string; value: number; slot: number }[] {
  const names = xTexts(spec, locale)[0] ?? [];
  const values = datasetValues(spec, 0).map((v) => Math.max(0, v ?? 0));
  const slices = values.map((value, i) => ({ name: names[i] ?? "", value, slot: i }));
  if (slices.length <= DONUT_SLICES + 1) return slices;
  const keep = new Set(
    [...slices].sort((a, b) => b.value - a.value || a.slot - b.slot).slice(0, DONUT_SLICES),
  );
  const kept = slices.filter((s) => keep.has(s)).map((s, k) => ({ ...s, slot: k }));
  const rest = slices.filter((s) => !keep.has(s)).reduce((sum, s) => sum + s.value, 0);
  return [...kept, { name: chartWords(locale).other, value: rest, slot: DONUT_SLICES }];
}

/** Donut ring geometry (B: a thin 13 pt ring). */
export const DONUT = { ri: 47, ro: 60, corner: 2.5, gap: 2.5 } as const;

/** B donut: a thin ring left, a mono mini-table (name · value · %) right, the total centred. */
/**
 * The donut's disc in a layout of `height` (the ring's centre and outer radius):
 * the ONE place it is placed, read by the layout below and by the gallery's
 * thumbnail (`chart-thumb.ts`), whose view box is this disc alone.
 */
export function donutDisc(height: number): { cx: number; cy: number; r: number } {
  return { cx: DONUT.ro + 6, cy: height / 2, r: DONUT.ro };
}

export function donutLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  const { width, fs, locale, measure } = ctx;
  const slices = donutSlices(spec, locale);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const size = SIZE.row * fs;
  const rowH = Math.max(30, size + 14);
  const height = ctx.height ?? Math.max(136, slices.length * rowH + 16);
  const { ri, ro } = DONUT;
  const { cx, cy } = donutDisc(height);
  const paths: LayoutPath[] = [];
  let a = 0;
  for (const [k, s] of slices.entries()) {
    const a0 = a;
    a += total === 0 ? 0 : (s.value / total) * Math.PI * 2;
    if (s.value <= 0) continue;
    paths.push({
      d: sector(cx, cy, ri, ro, a0, a, DONUT.corner, DONUT.gap),
      role: "sector",
      series: s.slot,
      paint: { series: s.slot },
      opacity: 1,
      arc: { a0, a1: a, ri, ro },
      index: k,
    });
  }
  const format = { ...yFormat(spec, locale), format: "full" as const };
  // The unit rides the sub-line ("€ TOTALE"), so the centre number goes bare.
  const { unit: _unit, ...bare } = format;
  const totalText = formatNumber(total, bare);
  const centreSize = Math.min(SIZE.center * fs, (2 * ri - 10) / Math.max(1, measure(totalText, 1)));
  const sub = [spec.y?.unit ?? "", chartWords(locale).total]
    .filter((t) => t !== "")
    .join(" ")
    .toUpperCase();
  const texts: LayoutText[] = [
    {
      x: cx,
      y: cy + centreSize * 0.2,
      text: totalText,
      anchor: "middle",
      size: centreSize,
      role: "center",
      strong: true,
    },
    {
      x: cx,
      y: cy + centreSize * 0.2 + SIZE.centerSub * fs + 4,
      text: sub,
      anchor: "middle",
      size: Math.min(SIZE.centerSub * fs, (2 * ri - 14) / Math.max(1, measure(sub, 1))),
      role: "centerSub",
    },
  ];
  const x0 = cx + ro + 24;
  const pcts = slices.map((s) => (total === 0 ? "—" : `${Math.round((s.value / total) * 100)}%`));
  const vals = slices.map((s) => formatNumber(s.value, format));
  const pctW = Math.max(0, ...pcts.map((t) => measure(t, size)));
  const valW = Math.max(0, ...vals.map((t) => measure(t, size)));
  const valEnd = width - pctW - 12;
  const nameRoom = Math.max(0, valEnd - valW - 12 - (x0 + 16));
  const y0 = cy - (slices.length * rowH) / 2;
  slices.forEach((s, k) => {
    const y = y0 + k * rowH;
    const base = y + rowH / 2 + size * 0.35;
    paths.push({
      d: capsule(x0, y + rowH / 2 - 4, 8, 8, 2),
      role: "swatch",
      series: s.slot,
      paint: { series: s.slot },
      opacity: 1,
      index: k,
    });
    texts.push({
      x: x0 + 16,
      y: base,
      text: fitText(s.name, nameRoom, size, measure),
      anchor: "start",
      size,
      role: "name",
      series: s.slot,
    });
    texts.push({
      x: valEnd,
      y: base,
      text: vals[k] ?? "",
      anchor: "end",
      size,
      role: "value",
      series: s.slot,
    });
    texts.push({
      x: width,
      y: base,
      text: pcts[k] ?? "",
      anchor: "end",
      size,
      role: "percent",
      series: s.slot,
    });
    if (k < slices.length - 1) {
      paths.push({
        d: `M${n1(x0)},${n1(y + rowH)}H${n1(width)}`,
        role: "baseline",
        series: -1,
        paint: { token: "guide" },
        opacity: 1,
        strokeWidth: 0.6,
      });
    }
  });
  return {
    kind: "donut",
    width,
    height,
    plot: { left: 0, right: width, top: 0, bottom: height },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots: [],
    texts,
    guides: [],
    legend: null,
    summary: chartSummary(spec, locale),
    table: {
      header: [spec.x?.title ?? "", spec.datasets[0]?.label ?? "", "%"],
      rows: slices.map((s, k) => [s.name, vals[k] ?? "", pcts[k] ?? ""]),
    },
    ...noScrub,
  };
}

/** A point's x as a number (dates: epoch ms), or `null`. */
function xNumber(x: number | string, date: boolean): number | null {
  const v = date ? (parseIsoDate(String(x))?.ms ?? null) : typeof x === "number" ? x : Number(x);
  return v !== null && Number.isFinite(v) ? v : null;
}

/** A scatter: filled 9 pt dots with a surface ring, a dashed least-squares line (A). */
export function scatterLayout(spec: ChartSpec, ctx: Ctx): ChartLayout {
  const { width, fs, locale } = ctx;
  const height = ctx.height ?? Math.round(206 + 24 * (fs - 1));
  const visible = visibleOf(spec, ctx);
  const date = effectiveXType(spec) === "date";
  const pts = visible.map((k) =>
    (spec.datasets[k]?.data ?? []).flatMap((p) => {
      if (typeof p !== "object" || p === null || p.y === null) return [];
      const x = xNumber(p.x, date);
      return x === null ? [] : [[x, p.y] as [number, number]];
    }),
  );
  const flat = pts.flat();
  const xsAll = flat.map((p) => p[0]);
  const xMin = Math.min(...xsAll);
  const xMax = Math.max(...xsAll);
  const nice = date ? { lo: xMin, hi: xMax } : niceTicks(xMin, xMax, 4, xMin >= 0);
  const [lo, hi] = domain(
    flat.map((p) => p[1]),
    false,
  );
  const top = Math.round(8 + SIZE.guide * fs);
  const bottom = height - Math.round(10 + SIZE.x * fs);
  const X = (v: number): number => 6 + ((v - nice.lo) / (nice.hi - nice.lo || 1)) * (width - 12);
  const Y = (v: number): number => top + (1 - (v - lo) / (hi - lo || 1)) * (bottom - top);
  const paths: LayoutPath[] = [];
  const trend = date ? null : scatterTrend(spec);
  if (trend && flat.length > 0) {
    paths.push({
      d: `M${n1(X(xMin))},${n1(Y(trend.a + trend.b * xMin))}L${n1(X(xMax))},${n1(Y(trend.a + trend.b * xMax))}`,
      role: "trend",
      series: -1,
      paint: { token: "secondary" },
      opacity: 0.55,
      strokeWidth: 1.25,
      dash: "4 4",
    });
  }
  const dots: LayoutDot[] = [];
  visible.forEach((k, j) => {
    for (const [x, y] of pts[j] ?? [])
      dots.push({
        x: X(x),
        y: Y(y),
        r: 4.5,
        series: k,
        paint: { series: k },
        opacity: 0.9,
        ring: 1.5,
      });
  });
  const dSize = SIZE.direct * fs;
  const lineH = dSize * 1.2;
  const multi = visible.length >= 2;
  const useLegend = multi && !labelsFit(visible.length, lineH, bottom - top, 0, width);
  const direct: LayoutText[] = [];
  if (multi && !useLegend) {
    const ends = visible.map((_, j) =>
      (pts[j] ?? []).reduce<[number, number] | null>(
        (b, p) => (b === null || p[0] > b[0] ? p : b),
        null,
      ),
    );
    const placed = dodge(
      ends.map((e) => (e ? Y(e[1]) - 10 : top)),
      lineH,
      top + dSize * 0.8,
      bottom - 4,
    );
    visible.forEach((k, j) => {
      const e = ends[j];
      if (!e) return;
      const text = spec.datasets[k]?.label ?? "";
      direct.push({
        x: Math.min(X(e[0]) + 8, width - ctx.measure(text, dSize)),
        y: placed[j] as number,
        text,
        anchor: "start",
        size: dSize,
        role: "direct",
        series: k,
        strong: true,
      });
    });
  }
  const g = guideItems(
    spec,
    ctx,
    { lo, hi, x1: 0, x2: width, style: "dotted" },
    Y,
    "start",
    direct,
  );
  const { unit: xUnit, ...xBare } = { ...spec.x, locale };
  const first = spec.datasets[0]?.data[0];
  const granularity =
    (typeof first === "object" && first ? parseIsoDate(String(first.x))?.granularity : undefined) ??
    "day";
  const xText = (v: number, withUnit: boolean): string => {
    if (date) return formatDate(v, granularity, { locale });
    return formatNumber(v, withUnit && xUnit !== undefined ? { ...xBare, unit: xUnit } : xBare);
  };
  const size = SIZE.x * fs;
  const xLabels = pickXLabels(
    [
      {
        x: X(nice.lo),
        y: height - 5,
        text: xText(nice.lo, false),
        anchor: "start",
        size,
        role: "x",
      },
      { x: X(nice.hi), y: height - 5, text: xText(nice.hi, true), anchor: "end", size, role: "x" },
    ],
    ctx.measure,
  );
  return {
    kind: "scatter",
    width,
    height,
    plot: { left: 0, right: width, top, bottom },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots,
    texts: [...g.texts, ...xLabels, ...direct],
    guides: g.guides,
    legend: useLegend ? legendOf(spec, visible, (k) => ({ series: k })) : null,
    summary: chartSummary(spec, locale),
    table: chartTable(spec, locale),
    ...noScrub,
  };
}

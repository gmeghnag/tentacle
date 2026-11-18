/**
 * The phone chart layout's shared pieces (docs/feat/model-charts.md D6 + rev 2):
 * x positions, x-label picking, guides, the legend fallback test, the summary
 * and the data table — used by every chart kind in `chart-layout.ts` and
 * `chart-layout-shapes.ts`. Pure, React-free.
 */
import {
  type ChartSpec,
  datasetValues,
  effectiveXType,
  formatNumber,
  parseIsoDate,
  specXPositions,
  summarizeChart,
  usesPoints,
  yFormat,
} from "@tentacle/core";
import { guides } from "./chart-geometry.ts";
import { xTexts } from "./chart-hero.ts";
import {
  type ChartTable,
  type Ctx,
  type DotShape,
  type GuideLine,
  type LayoutText,
  type LegendItem,
  type Paint,
  SIZE,
  overlaps,
  textBox,
} from "./chart-layout-kit.ts";

/** The VoiceOver sentence: the title, then each series' facts (core `summarizeChart`). */
export function chartSummary(spec: ChartSpec, locale: string): string {
  const facts = summarizeChart(spec, { locale }).series;
  return [spec.title, ...(spec.subtitle ? [spec.subtitle] : []), ...facts].join(". ");
}

/** The data table: x, then one column per series, numbers in full. */
export function chartTable(spec: ChartSpec, locale: string): ChartTable {
  const format = { ...yFormat(spec, locale), format: "full" as const };
  const xs = xTexts(spec, locale);
  const header = [spec.x?.title ?? "", ...spec.datasets.map((d) => d.label)];
  const cell = (v: number | null | undefined): string =>
    typeof v === "number" ? formatNumber(v, format) : "—";
  if (usesPoints(spec)) {
    const rows = spec.datasets.flatMap((_, k) =>
      datasetValues(spec, k).map((v, i) => [
        xs[k]?.[i] ?? "",
        ...spec.datasets.map((__, c) => (c === k ? cell(v) : "")),
      ]),
    );
    return { header, rows };
  }
  const rows = (spec.labels ?? []).map((_, i) => [
    xs[0]?.[i] ?? "",
    ...spec.datasets.map((__, k) => cell(datasetValues(spec, k)[i])),
  ]);
  return { header, rows };
}

/** Each dataset's x positions in `0..1` (`null` = unplaceable). */
export function seriesPositions(spec: ChartSpec): (number | null)[][] {
  if (!usesPoints(spec)) {
    const shared = specXPositions(spec);
    return spec.datasets.map((d) => d.data.map((_, i) => shared[i] ?? null));
  }
  const date = effectiveXType(spec) === "date";
  const raw = spec.datasets.map((d) =>
    d.data.map((p) => {
      const x = typeof p === "object" && p ? p.x : null;
      if (x === null) return null;
      const v = date ? (parseIsoDate(String(x))?.ms ?? null) : Number(x);
      return v !== null && Number.isFinite(v) ? v : null;
    }),
  );
  const all = raw.flat().filter((v): v is number => v !== null);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  return raw.map((xs) =>
    xs.map((v) => (v === null ? null : hi === lo ? 0.5 : (v - lo) / (hi - lo))),
  );
}

/**
 * x labels from `candidates`: the ends first (the last wins when they touch),
 * then the rest left to right where they touch nothing kept.
 */
export function pickXLabels(
  candidates: readonly LayoutText[],
  measure: (text: string, size: number) => number,
): LayoutText[] {
  if (candidates.length === 0) return [];
  const pad = 6;
  const box = (t: LayoutText) => {
    const b = textBox(t, measure);
    return { ...b, x: b.x - pad / 2, w: b.w + pad };
  };
  const last = candidates[candidates.length - 1] as LayoutText;
  const kept: LayoutText[] = [last];
  const first = candidates[0] as LayoutText;
  if (candidates.length > 1 && !overlaps(box(first), box(last))) kept.unshift(first);
  for (const t of candidates.slice(1, -1)) {
    if (kept.every((k) => !overlaps(box(k), box(t)))) kept.push(t);
  }
  return kept.sort((a, b) => a.x - b.x);
}

/** Guide hairlines and their labels (top and bottom only), a label dropped where it hits `avoid`. */
export function guideItems(
  spec: ChartSpec,
  ctx: Ctx,
  span: { lo: number; hi: number; x1: number; x2: number; style: "dotted" | "solid" },
  y: (v: number) => number,
  labelAt: "start" | "end",
  avoid: readonly LayoutText[],
  ceiling?: number,
): { guides: GuideLine[]; texts: LayoutText[] } {
  // `ceiling`: the top hairline is the axis' ceiling itself, so a stacked area
  // never draws its stack above the top guide (docs/feat/mobile-chart-labels.md D4).
  const values =
    ceiling === undefined
      ? guides(span.lo, span.hi, 3)
      : [...guides(span.lo, ceiling, 3).filter((v) => v < ceiling), ceiling];
  const format = yFormat(spec, ctx.locale);
  const lines = values.map((value) => ({
    y: y(value),
    value,
    x1: span.x1,
    x2: span.x2,
    style: span.style,
  }));
  const texts: LayoutText[] = [];
  values.forEach((value, k) => {
    if (k !== 0 && k !== values.length - 1) return;
    const t: LayoutText = {
      x: labelAt === "end" ? span.x2 : span.x1,
      y: y(value) - 5,
      text: formatNumber(value, format),
      anchor: labelAt,
      size: SIZE.guide * ctx.fs,
      role: "guide",
    };
    const hit = avoid.some((a) => overlaps(textBox(a, ctx.measure), textBox(t, ctx.measure)));
    if (!hit) texts.push(t);
  });
  return { guides: lines, texts };
}

/**
 * The series marker for slot `k`: solid ● / dashed ■ / dotted ▲, cycling every
 * three (docs/feat/mobile-chart-labels.md D5). Colour alone is not a readable
 * channel for every reader, and this is what ties a label to its line.
 */
export function markShape(k: number): DotShape {
  return (["circle", "square", "triangle"] as const)[k % 3] as DotShape;
}

/** The stroke dash of series `k`, in the same three slots (round caps make `0.1 4` dots). */
export function markDash(k: number): string | undefined {
  return [undefined, "6 4", "0.1 4"][k % 3];
}

/**
 * Whether C (labels inside the plot) fits this chart at all: `n` labels of
 * `h` pt must fit the plot's height, and no name may take more than 45 % of the
 * width — else the chart falls back to A (the legend above). Pure, so the
 * decision is testable without a renderer.
 */
export function insideFits(
  names: readonly string[],
  h: number,
  room: number,
  width: number,
  size: number,
  measure: (text: string, size: number) => number,
): boolean {
  if (names.length * h > room) return false;
  return names.every((name) => measure(name, size) <= width * 0.45);
}

/** Whether direct labels fit: `n` lines of `h` pt in `room` pt, and a gutter ≤ 40 % of the width. */
export function labelsFit(
  n: number,
  h: number,
  room: number,
  gutter: number,
  width: number,
): boolean {
  return n * h <= room && gutter <= width * 0.4;
}

export function legendOf(
  spec: ChartSpec,
  visible: readonly number[],
  paintOf: (k: number) => Paint,
  valueText: (k: number) => string = () => "",
): LegendItem[] {
  return visible.map((k) => ({
    series: k,
    label: spec.datasets[k]?.label ?? "",
    paint: paintOf(k),
    value: valueText(k),
    shape: markShape(k),
  }));
}

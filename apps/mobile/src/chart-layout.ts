/**
 * The phone chart's layout (docs/feat/model-charts.md D6 + *iPhone visual
 * language (rev 2, modern)*): spec in, everything `ui/chart/ChartView.tsx`
 * draws out — paths, dots, texts, guides, legend, hero, summary, table, and the
 * scrub's `hit` / `scrubAt`. Pure and React-free; the component only maps it to
 * `<Svg>` elements (AGENTS §7 "logic lives in pure modules").
 *
 * The owner's picks (2026-11-16): line A · bar B · stacked B · area B · donut B
 * · scatter A · scrub A; monospace chart typography throughout. Only the picked
 * variant of each is built — no runtime style switch.
 *
 * The spec is re-validated here with the daemon's own validator: a pod can
 * forge `rawInput` (AGENTS §7 "a pod is not trusted"), so an invalid one gets
 * `null` and the row falls back to the generic tool row.
 */
import {
  type ChartSpec,
  datasetValues,
  downsampleLttb,
  formatNumber,
  usesPoints,
  validateChartSpec,
  yFormat,
} from "@tentacle/core";
import { domain, type Pt, curveLength, dodge, monotonePath, n1, runs } from "./chart-geometry.ts";
import { heroOf, isStacked, xTexts } from "./chart-hero.ts";
import {
  chartSummary,
  chartTable,
  guideItems,
  insideFits,
  legendOf,
  markDash,
  markShape,
  pickXLabels,
  seriesPositions,
} from "./chart-layout-axis.ts";
import {
  type ChartLayout,
  type Ctx,
  type LayoutDot,
  type LayoutOptions,
  type LayoutPath,
  type LayoutText,
  type Paint,
  SIZE,
  monoWidth,
} from "./chart-layout-kit.ts";
import { barLayout, donutLayout, scatterLayout } from "./chart-layout-shapes.ts";

export type * from "./chart-layout-kit.ts";

/** The validated spec of a tool call's arguments (object or JSON text), or `null`. */
export function chartSpecOf(raw: unknown): ChartSpec | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const result = validateChartSpec(value);
  return result.ok ? result.spec : null;
}

/** The layout of a chart at `width`, or `null` for a spec that does not validate. */
export function chartLayout(raw: unknown, options: LayoutOptions): ChartLayout | null {
  const spec = chartSpecOf(raw);
  if (!spec || !(options.width > 0) || !Number.isFinite(options.width)) return null;
  const ctx: Ctx = {
    width: options.width,
    height: options.height,
    fs: Math.max(1, options.fontScale ?? 1),
    locale: options.locale ?? "en",
    hidden: options.hidden ?? new Set(),
    measure: options.measure ?? monoWidth,
    labels: options.labels ?? "inside",
  };
  switch (spec.type) {
    case "line":
      return lineLayout(spec, ctx, false);
    case "area":
      return lineLayout(spec, ctx, true);
    case "bar":
      return barLayout(spec, ctx);
    case "pie":
    case "doughnut":
      return donutLayout(spec, ctx);
    case "scatter":
      return scatterLayout(spec, ctx);
  }
}

function lastDefined(ys: readonly (number | null)[]): number {
  for (let i = ys.length - 1; i >= 0; i--) if (typeof ys[i] === "number") return i;
  return -1;
}

/**
 * D4: the mockup's y ceiling for an area — 2 × the first nice half-step at or
 * above `max / 2` (1,033 → 1,200; 455 → 500). `null` when there is nothing to
 * scale (empty, all-zero or negative data keeps `domain()`'s answer).
 */
function niceCeiling(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const max = Math.max(...values);
  if (!(max > 0) || !Number.isFinite(max)) return undefined;
  const half = max / 2;
  const p = 10 ** Math.floor(Math.log10(half));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * p >= half) return Number((2 * m * p).toPrecision(12));
  }
  return undefined;
}

/** Line (direction A) and area (direction B). */
function lineLayout(spec: ChartSpec, ctx: Ctx, area: boolean): ChartLayout {
  const A = !area;
  const { width, fs, locale } = ctx;
  const height = ctx.height ?? Math.round(176 + 24 * (fs - 1));
  const visible = spec.datasets.map((_, k) => k).filter((k) => !ctx.hidden.has(k));
  const stacked = isStacked(spec);
  const ys = spec.datasets.map((_, k) => datasetValues(spec, k));
  if (stacked) {
    const acc: number[] = [];
    for (const k of visible) {
      ys[k] = (ys[k] ?? []).map((v, i) => {
        const sum = (acc[i] ?? 0) + (v ?? 0);
        acc[i] = sum;
        return v === null ? null : sum;
      });
    }
  }
  const pos = seriesPositions(spec);
  const xs = xTexts(spec, locale);
  const values = visible.flatMap((k) =>
    (ys[k] ?? []).filter((v): v is number => typeof v === "number"),
  );
  const [lo, hi0] = domain(values, area);
  // D4: a stacked area's ceiling must include the stack (the repro's 1,033 was
  // drawn above a 1,000 guide, which reads as the line overshooting the scale).
  // The ceiling is the mockup's even-nice value, and `guideItems` puts the top
  // hairline ON it. `domain()` itself is untouched — bars share it.
  const ceiling = area ? niceCeiling(values) : undefined;
  const hi = ceiling ?? hi0;
  const top = Math.round(8 + SIZE.guide * fs);
  const bottom = height - Math.round(10 + SIZE.x * fs);
  const multi = visible.length >= 2;
  const yCompact = yFormat(spec, locale);
  const dSize = SIZE.direct * fs;
  const lineH = dSize * 1.2;
  /** A series' last defined value, formatted the axis' way (`"148 k req"`). */
  const lastText = (k: number): string => {
    const raw = datasetValues(spec, k);
    const v = raw[lastDefined(raw)];
    return typeof v === "number" ? formatNumber(v, yCompact) : "";
  };
  const names = visible.map((k) => spec.datasets[k]?.label ?? "");
  // Where the series are named (docs/feat/mobile-chart-labels.md D1-D3): inside
  // the plot at each line's end (C, the default) or in a legend above it (A).
  // Either way the plot is FULL WIDTH — the gutter the old direct labels paid for
  // took up to 35 % of it on a stacked area.
  const inside =
    multi &&
    ctx.labels === "inside" &&
    insideFits(names, lineH, bottom - 3 - (top + dSize * 0.8), width, dSize, ctx.measure);
  const useLegend = multi && !inside;
  const right = width;
  const X = (p: number): number => 2 + p * (right - 4);
  const Y = (v: number): number => top + (1 - (v - lo) / (hi - lo || 1)) * (bottom - top);
  const paintOf = (k: number): Paint =>
    A && k === 1 && spec.datasets.length === 2 ? { token: "mutedLine" } : { series: k };
  const strokeOf = (k: number): number => (A ? (k === 0 ? 2.5 : 1.75) : k === 0 ? 2 : 1.5);

  const paths: LayoutPath[] = [];
  const dots: LayoutDot[] = [];
  if (area) {
    paths.push({
      d: `M0,${n1(bottom)}H${n1(right)}`,
      role: "baseline",
      series: -1,
      paint: { token: "guideStrong" },
      opacity: 1,
      strokeWidth: 0.8,
    });
  }
  for (const k of [...visible].reverse()) {
    let series = ys[k] ?? [];
    let idx = series.map((_, i) => i);
    const target = Math.floor(2 * right);
    if (series.length > target) {
      const down = downsampleLttb(series, target);
      series = down.values;
      idx = down.indices;
    }
    const p = pos[k] ?? [];
    const xAt = (j: number): number | null => {
      const at = p[idx[j] as number];
      return at === null || at === undefined ? null : X(at);
    };
    const pieces = runs(series, xAt, Y);
    const fill = stacked || k === 0;
    for (const run of pieces) {
      if (fill) {
        const end = run[run.length - 1] as Pt;
        const start = run[0] as Pt;
        paths.push({
          d: `${monotonePath(run)}L${n1(end[0])},${n1(bottom)}L${n1(start[0])},${n1(bottom)}Z`,
          role: "fill",
          series: k,
          paint: { series: k },
          opacity: 1,
          gradient: { from: A ? 0.22 : 0.16, to: 0 },
        });
      }
    }
    for (const run of pieces) {
      if (run.length === 1) {
        const [x, y] = run[0] as Pt;
        dots.push({ x, y, r: 2.5, series: k, paint: paintOf(k), opacity: 1 });
        continue;
      }
      paths.push({
        d: monotonePath(run),
        role: "line",
        series: k,
        paint: paintOf(k),
        opacity: 1,
        strokeWidth: strokeOf(k),
        ...(markDash(k) === undefined ? {} : { dash: markDash(k) }),
        length: curveLength(run),
      });
    }
  }
  if (!ctx.hidden.has(0)) {
    const y0 = ys[0] ?? [];
    const i = lastDefined(y0);
    const at = pos[0]?.[i];
    if (i >= 0 && at !== null && at !== undefined) {
      const x = X(at);
      const y = Y(y0[i] as number);
      dots.push(
        A
          ? {
              x,
              y,
              r: 3.75,
              series: 0,
              paint: { series: 0 },
              opacity: 1,
              halo: { r: 7.5, opacity: 0.18 },
              ring: 1.5,
            }
          : { x, y, r: 3, series: 0, paint: { series: 0 }, opacity: 1, hollow: true },
      );
    }
  }

  // Direct labels (C): the series name just above each line's end — inside its
  // own band for a stacked area — dodged apart vertically, haloed so the data
  // underneath stays readable, with the series' own marker beside it.
  const direct: LayoutText[] = [];
  if (inside) {
    const cumBelow = (k: number): number => {
      const idx = visible.indexOf(k);
      const prev = idx > 0 ? visible[idx - 1] : undefined;
      if (prev === undefined) return 0;
      return (ys[prev] ?? [])[lastDefined(ys[k] ?? [])] ?? 0;
    };
    const items = visible.flatMap((k) => {
      const y = ys[k] ?? [];
      const i = lastDefined(y);
      const at = pos[k]?.[i];
      if (i < 0 || at === null || at === undefined) return [];
      const end = Y(y[i] as number);
      return [
        {
          k,
          i,
          at,
          // Stacked: the middle of its own band, not the top of the stack.
          target: stacked ? (end + Y(cumBelow(k))) / 2 + dSize / 3 : end - 8,
        },
      ];
    });
    const placed = dodge(
      items.map((it) => it.target),
      lineH,
      top + dSize * 0.8,
      bottom - 3,
    );
    items.forEach((it, j) => {
      const name = spec.datasets[it.k]?.label ?? "";
      const w = ctx.measure(name, dSize);
      const y = placed[j] as number;
      // Anchor `end` at the line's end, but never let the text leave the plot:
      // past the left edge it flips to `start` and keeps room for its marker.
      const endX = X(it.at) - 10;
      const flip = endX - w < 12;
      direct.push({
        x: flip ? 12 : endX,
        y,
        text: name,
        anchor: flip ? "start" : "end",
        size: dSize,
        role: "direct",
        series: it.k,
        halo: true,
        shape: markShape(it.k),
      });
    });
    // One marker per label, in the series' colour: the text is the page colour's
    // neighbour, so the dot is what ties a name to its line.
    for (const t of direct) {
      if (t.series === undefined) continue;
      const w = ctx.measure(t.text, t.size);
      const left = t.anchor === "end" ? t.x - w : t.x;
      dots.push({
        x: left - 8,
        y: t.y - t.size / 3,
        r: 3.2,
        series: t.series,
        paint: { series: t.series },
        opacity: 1,
        ring: 1.5,
        shape: markShape(t.series),
      });
    }
  }

  const g = guideItems(
    spec,
    ctx,
    { lo, hi, x1: 0, x2: right, style: A ? "dotted" : "solid" },
    Y,
    A && !inside ? "end" : "start",
    direct,
    ceiling,
  );

  // x labels: A first · middle · last; B every k (≤ 5).
  const ref = visible.reduce(
    (best, k) => ((pos[k]?.length ?? 0) > (pos[best]?.length ?? 0) ? k : best),
    visible[0] ?? 0,
  );
  const refPos = pos[ref] ?? [];
  const n = refPos.length;
  const step = A ? Math.max(1, Math.round((n - 1) / 2)) : Math.max(1, Math.ceil(n / 5));
  const cand: number[] = [];
  for (let i = 0; i < n; i += step) cand.push(i);
  if (cand[cand.length - 1] !== n - 1 && n > 0) cand.push(n - 1);
  const xSize = SIZE.x * fs;
  const xCands: LayoutText[] = cand
    .filter((i) => refPos[i] !== null && refPos[i] !== undefined)
    .map((i, j, all) => ({
      x: X(refPos[i] as number),
      y: height - 5,
      text: xs[ref]?.[i] ?? "",
      anchor:
        j === 0 && all.length > 1
          ? "start"
          : j === all.length - 1 && all.length > 1
            ? "end"
            : "middle",
      size: xSize,
      role: "x",
    }));
  const xLabels = pickXLabels(xCands, ctx.measure);

  const pos0 = pos[0] ?? [];
  const hit = (x: number): number | null => {
    let best: number | null = null;
    let dist = Number.POSITIVE_INFINITY;
    pos0.forEach((p, i) => {
      if (p === null) return;
      const d = Math.abs(X(p) - x);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };
  const scrubAt = (i: number) => {
    const p = pos0[i];
    if (p === null || p === undefined) return null;
    const x = X(p);
    const scrubDots: LayoutDot[] = [];
    for (const k of visible) {
      if (k !== 0 && usesPoints(spec)) continue;
      const v = (ys[k] ?? [])[i];
      if (typeof v !== "number") continue;
      const y = Y(v);
      scrubDots.push(
        A
          ? {
              x,
              y,
              r: 4.5,
              series: k,
              paint: paintOf(k),
              opacity: 1,
              halo: { r: 9, opacity: 0.2 },
              ring: 2,
            }
          : { x, y, r: 3.5, series: k, paint: paintOf(k), opacity: 1, hollow: true },
      );
    }
    return { index: i, x, dots: scrubDots, dimFromX: A ? x : null, hero: heroOf(spec, i, locale) };
  };

  return {
    kind: area ? "area" : "line",
    width,
    height,
    plot: { left: 0, right, top, bottom },
    hero: heroOf(spec, undefined, locale),
    paths,
    dots,
    texts: [...g.texts, ...xLabels, ...direct],
    guides: g.guides,
    legend: useLegend ? legendOf(spec, visible, paintOf, lastText) : null,
    summary: chartSummary(spec, locale),
    table: chartTable(spec, locale),
    hit,
    scrubAt,
  };
}

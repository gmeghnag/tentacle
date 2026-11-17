/**
 * Axis scales and downsampling for charts (docs/feat/model-charts.md D4,
 * `scale.ts`). Pure: no I/O, no React, no locale.
 *
 * Ticks come from Heckbert's "nice numbers", because a reader can compare
 * `0, 5k, 10k` at a glance and cannot compare `0, 4871, 9742`. Bars and areas
 * always include 0 (a bar that does not start at 0 lies about its length);
 * lines use a padded range so a flat series does not fill the plot.
 */

/** A chart's y range, snapped to round numbers with the ticks in it. */
export interface Ticks {
  readonly lo: number;
  readonly hi: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/** One of Heckbert's nice numbers (1/2/5/10 × 10^n), rounded or truncated. */
function niceNumber(value: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

/** Round `value` to the digits its magnitude deserves (kills `0.30000000000000004`). */
function clean(value: number): number {
  return Number(value.toPrecision(15));
}

/**
 * Ticks for `[min, max]` on at most `maxTicks` rows.
 *
 * `zero` widens the range to include 0 — the right call for bars and areas, and
 * never for a line whose data live far from 0 (a latency chart). `min === max`
 * gets ±10 % (or `[0, 1]` at 0), so one point still has a plot to sit in.
 */
export function niceTicks(min: number, max: number, maxTicks: number, zero = false): Ticks {
  const safeMax = Number.isFinite(max) ? max : 0;
  const safeMin = Number.isFinite(min) ? min : 0;
  let a = zero ? Math.min(0, safeMin) : Math.min(safeMin, safeMax);
  let b = zero ? Math.max(0, safeMax) : Math.max(safeMin, safeMax);
  if (a === b) {
    const spread = a === 0 ? 1 : Math.abs(a) * 0.1;
    a -= spread;
    b += spread;
  }
  const rows = Math.max(2, Math.floor(maxTicks));
  const rough = niceNumber(b - a, false) / (rows - 1);
  let step = niceNumber(rough, true);
  // Nice steps are coarse: `0..987` in 8 rows lands on 100 and gives 11 ticks.
  // Step up through 2/5/10 until the count fits — the count is the constraint.
  for (let guard = 0; guard < 8; guard++) {
    const lo = Math.floor(a / step) * step;
    const hi = Math.ceil(b / step) * step;
    if (Math.round((hi - lo) / step) + 1 <= rows + 1) break;
    step = niceNumber(step * 1.5, true);
  }
  const lo = clean(Math.floor(a / step) * step);
  const hi = clean(Math.ceil(b / step) * step);
  const ticks: number[] = [];
  // A sum of steps drifts; multiply instead, so `0.1` steps stay exact.
  for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(clean(lo + i * step));
  return { lo, hi, step, ticks };
}

/**
 * Ticks for a time axis, as round steps a person reads: 1/5/15/30 minutes,
 * 1/3/6/12 hours, a day, a week, a month, a quarter, a year.
 *
 * Instants stay on LOCAL round hours across a DST change (a 23-hour day keeps
 * its 00:00 and 23:00 ticks), because the reader's clock is the local one.
 */
export function dateTicks(t0: number, t1: number, maxTicks: number, zone?: string): number[] {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return [lo];
  const steps = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    3 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    86_400_000,
    7 * 86_400_000,
  ];
  const rows = Math.max(2, Math.floor(maxTicks));
  const target = (hi - lo) / (rows - 1);
  const fixed = steps.find((step) => step >= target);
  if (fixed === undefined) return monthTicks(lo, hi, rows, zone);
  const first = Math.ceil(lo / fixed) * fixed;
  const out: number[] = [];
  for (let t = first; t <= hi; t += fixed) out.push(t);
  return out.length > 0 ? out : [lo];
}

/** Month/quarter/year ties for a span too long for a fixed step. */
function monthTicks(lo: number, hi: number, rows: number, zone?: string): number[] {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
  });
  const months = (t: number): number => {
    // Hermes on iOS has no `formatToParts` (a TypeError crashed the chart's
    // row, docs/fix/mobile-qa-sweep.md): parse en-US numeric "M/YYYY" instead.
    if (typeof format.formatToParts !== "function") {
      const match = /(\d+)\D+(\d+)/.exec(format.format(new Date(t)));
      return match ? Number(match[2]) * 12 + (Number(match[1]) - 1) : 1970 * 12;
    }
    const parts = format.formatToParts(new Date(t));
    const year = Number(parts.find((p) => p.type === "year")?.value ?? 1970);
    const month = Number(parts.find((p) => p.type === "month")?.value ?? 1);
    return year * 12 + (month - 1);
  };
  const from = months(lo);
  const to = months(hi);
  const span = Math.max(1, to - from);
  const stepMonths = [1, 3, 6, 12].find((step) => step >= span / Math.max(1, rows - 1)) ?? 12;
  const out: number[] = [];
  for (let m = Math.ceil(from / stepMonths) * stepMonths; m <= to; m += stepMonths) {
    out.push(Date.UTC(Math.floor(m / 12), m % 12, 1));
  }
  return out.length > 0 ? out : [lo];
}

/**
 * The indices of `positions` (0..1, ascending) whose labels fit without
 * touching: greedy left to right, first and last always kept (the ends are what
 * a reader orients by), each kept label at least `gap` cells from the previous.
 */
export function thinLabels(
  positions: readonly number[],
  widths: readonly number[],
  gap: number,
): number[] {
  const n = Math.min(positions.length, widths.length);
  if (n === 0) return [];
  if (n === 1) return [0];
  const span = (i: number): [number, number] => {
    const centre = (positions[i] as number) * gap;
    const half = (widths[i] as number) / 2;
    return [centre - half, centre + half];
  };
  const kept: number[] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const [start, finish] = span(i);
    if (i === 0 || start >= end + 1) {
      kept.push(i);
      end = finish;
    }
  }
  // The last label is what orients the reader ("… nov, dic"), so it wins over
  // the one before it when the two would touch.
  if (kept[kept.length - 1] !== n - 1) {
    const lastStart = span(n - 1)[0];
    while (kept.length > 0 && span(kept[kept.length - 1] as number)[1] >= lastStart - 1) kept.pop();
    kept.push(n - 1);
  }
  return kept;
}

/** A line/area series' values downsampled to `target` points, keeping the peaks. */
export interface Downsampled {
  /** The kept values, in order. */
  readonly values: (number | null)[];
  /** The source indices the kept values came from (for the x labels). */
  readonly indices: number[];
}

/**
 * Largest-Triangle-Three-Buckets, as Chart.js' own decimation plugin uses it:
 * each bucket keeps the point that makes the biggest triangle with its
 * neighbours, so a single spike in 1 000 points survives down to 200 (the mockup
 * script proves it, docs/feat/model-charts.md *Mockups*). `null`s break the line
 * and are kept as breaks.
 */
export function downsampleLttb(values: readonly (number | null)[], target: number): Downsampled {
  const n = values.length;
  const all = values.map((_, i) => i);
  if (target >= n || target < 3) return { values: [...values], indices: all };
  const keep: number[] = [0];
  const every = (n - 2) / (target - 2);
  let anchor = 0;
  for (let bucket = 0; bucket < target - 2; bucket++) {
    const nextStart = Math.floor((bucket + 1) * every) + 1;
    const nextEnd = Math.min(n, Math.floor((bucket + 2) * every) + 1);
    let avgX = 0;
    let avgY = 0;
    let counted = 0;
    for (let i = nextStart; i < nextEnd; i++) {
      avgX += i;
      avgY += values[i] ?? 0;
      counted++;
    }
    avgX /= Math.max(1, counted);
    avgY /= Math.max(1, counted);
    const start = Math.floor(bucket * every) + 1;
    const end = Math.min(n, Math.floor((bucket + 1) * every) + 1);
    let best = start;
    let area = -1;
    const anchorY = values[anchor] ?? 0;
    for (let i = start; i < end; i++) {
      const y = values[i];
      if (y === null || y === undefined) continue;
      const size = Math.abs((anchor - avgX) * (y - anchorY) - (anchor - i) * (avgY - anchorY));
      if (size > area) {
        area = size;
        best = i;
      }
    }
    keep.push(best);
    anchor = best;
  }
  keep.push(n - 1);
  // A `null` is a BREAK in the line, so every run of nulls must keep at least one
  // of itself — otherwise LTTB quietly bridges a gap that the data says exists.
  for (let i = 0; i < n; i++) {
    if (values[i] !== null) continue;
    let end = i;
    while (end < n && values[end] === null) end++;
    const hasRepresentative = keep.some((index) => index >= i && index < end);
    if (!hasRepresentative) keep.push(i + Math.floor((end - i) / 2));
    i = end - 1;
  }
  keep.sort((x, y) => x - y);
  const unique = keep.filter((index, at) => at === 0 || index !== keep[at - 1]);
  return { values: unique.map((i) => values[i] ?? null), indices: unique };
}

/**
 * Bucket means for a sparkline: exactly `cells` values, one per cell, `null`
 * only when a whole bucket is empty (a real gap, not a zero).
 */
export function bucketMeans(values: readonly (number | null)[], cells: number): (number | null)[] {
  const n = values.length;
  if (n === 0 || cells <= 0) return [];
  if (cells >= n) return [...values];
  const out: (number | null)[] = [];
  for (let cell = 0; cell < cells; cell++) {
    const start = Math.floor((cell * n) / cells);
    const end = Math.max(start + 1, Math.floor(((cell + 1) * n) / cells));
    let sum = 0;
    let counted = 0;
    for (let i = start; i < end && i < n; i++) {
      const value = values[i];
      if (value === null || value === undefined) continue;
      sum += value;
      counted++;
    }
    out.push(counted === 0 ? null : sum / counted);
  }
  return out;
}

/** The finite values of a series (ticks are computed over the defined ones only). */
export function finiteValues(values: readonly (number | null)[]): number[] {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

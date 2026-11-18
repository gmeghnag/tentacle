/**
 * The one summary of a chart: its numbers, said in a sentence (docs/feat/
 * model-charts.md D4, `summary.ts`).
 *
 * The same strings serve the tool's result line (what the model and an old
 * client read), the phone's VoiceOver label and the data table's caption — one
 * place, so they cannot drift.
 *
 * Pure: no I/O, no React.
 */
import { type NumberFormat, formatNumber } from "./format.ts";
import { finiteValues } from "./scale.ts";
import type { ChartSpec } from "./spec.ts";

/** What a chart's numbers say, one line each. */
export interface ChartSummary {
  /** `line "Ricavi 2026" · 2 series × 12 · y 11,8k–20,8k €` — the tool's result. */
  readonly line: string;
  /** One line per series: its extremes and its direction (VoiceOver reads these). */
  readonly series: readonly string[];
}

/** The values of one dataset as plain numbers (points contribute their `y`). */
export function datasetValues(spec: ChartSpec, index: number): (number | null)[] {
  const dataset = spec.datasets[index];
  if (!dataset) return [];
  return dataset.data.map((value) =>
    typeof value === "object" && value !== null ? value.y : value,
  );
}

/** Every finite value in the chart (the y range the reader is looking at). */
export function chartValues(spec: ChartSpec): number[] {
  return spec.datasets.flatMap((_, index) => finiteValues(datasetValues(spec, index)));
}

/** The y extent of the drawn values, or `null` when nothing is defined. */
export function chartExtent(spec: ChartSpec): { min: number; max: number } | null {
  const values = chartValues(spec);
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** The axis' number format, as the spec asked for it. */
export function yFormat(spec: ChartSpec, locale?: string): NumberFormat {
  return { ...spec.y, ...(locale === undefined ? {} : { locale }) };
}

/** `12,5k–20,8k €` — the extent written with the axis' unit and format. */
function extentText(spec: ChartSpec, locale?: string): string {
  const extent = chartExtent(spec);
  if (!extent) return "no values";
  const format = yFormat(spec, locale);
  return `${formatNumber(extent.min, format)}–${formatNumber(extent.max, format)}`;
}

function firstDefined(values: readonly (number | null)[]): number | null {
  return values.find((value): value is number => typeof value === "number") ?? null;
}

function lastDefined(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (typeof value === "number") return value;
  }
  return null;
}

/**
 * The chart, as a sentence: the tool's result line (so the model learns what the
 * user sees) and the per-series facts VoiceOver reads.
 *
 * `notes` are the validator's remarks (dropped styling keys) — they ride the
 * result, because that is the one place the model reads.
 */
export function summarizeChart(
  spec: ChartSpec,
  options: { locale?: string; notes?: readonly string[] } = {},
): ChartSummary {
  const format = yFormat(spec, options.locale);
  const points = spec.datasets[0]?.data.length ?? 0;
  const headline = [
    `${spec.type} ${JSON.stringify(spec.title)}`,
    `${spec.datasets.length} series × ${points}`,
    `y ${extentText(spec, options.locale)}`,
  ].join(" · ");

  const series = spec.datasets.map((dataset, index) => {
    const values = finiteValues(datasetValues(spec, index));
    if (values.length === 0) return `${dataset.label}: no values`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const first = firstDefined(datasetValues(spec, index));
    const last = lastDefined(datasetValues(spec, index));
    const parts = [
      `${dataset.label}: min ${formatNumber(min, format)}, max ${formatNumber(max, format)}`,
    ];
    if (first !== null && last !== null) {
      parts.push(`from ${formatNumber(first, format)} to ${formatNumber(last, format)}`);
      if (first !== 0) {
        const change = ((last - first) / Math.abs(first)) * 100;
        const sign = change > 0 ? "+" : change < 0 ? "−" : "";
        parts.push(`${sign}${Math.abs(change).toFixed(1)}%`);
      }
    }
    const peak = datasetValues(spec, index).indexOf(max);
    const label = spec.labels?.[peak];
    if (label !== undefined) parts.push(`peak at ${label}`);
    return parts.join(", ");
  });

  const notes = options.notes ?? [];
  const line =
    notes.length > 0
      ? `Chart shown to the user: ${headline} · ${notes.join(" · ")}`
      : `Chart shown to the user: ${headline}`;
  return { line, series };
}

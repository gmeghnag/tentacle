/** Shared chart fixtures for the phone chart tests (docs/feat/model-charts.md, slice C5). */
import { type ChartSpec, validateChartSpec } from "@tentacle/core";

export function spec(raw: unknown): ChartSpec {
  const result = validateChartSpec(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.spec;
}

const MONTHS = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

/** The mockup's revenue: 2026 up to October, 2025 the whole year. */
export const REVENUE = spec({
  type: "line",
  title: "Ricavi",
  labels: MONTHS,
  y: { unit: "€" },
  datasets: [
    {
      label: "2026",
      data: [11800, 12500, 13900, 14100, 15800, 16200, 17600, 18100, 19400, 20800, null, null],
    },
    {
      label: "2025",
      data: [10200, 10900, 11500, 11800, 12600, 13100, 13900, 14300, 15200, 16400, 17100, 18900],
    },
  ],
});

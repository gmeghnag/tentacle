/** Shared chart fixtures for the phone chart tests (docs/feat/model-charts.md, slice C5). */
import { type ChartSpec, validateChartSpec } from "@tentacle/core";

export function spec(raw: unknown): ChartSpec {
  const result = validateChartSpec(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.spec;
}

/**
 * The mockup's two real charts (docs/feat/mobile-chart-labels.md): a 3-series
 * stacked area (gutter-hungry) and a 3-series line with a gap in series 1.
 */
export const TRAFFIC = spec({
  type: "area",
  stacked: true,
  title: "Composizione traffico per canale",
  y: { unit: "k req" },
  labels: [
    "settimana 1",
    "settimana 2",
    "settimana 3",
    "settimana 4",
    "settimana 5",
    "settimana 6",
  ],
  datasets: [
    { label: "web", data: [380, 400, 420, 440, 452, 455] },
    { label: "mobile", data: [350, 370, 395, 410, 433, 430] },
    { label: "api", data: [110, 120, 130, 140, 152, 148] },
  ],
});

export const LATENCY = spec({
  type: "line",
  title: "Latenza p95 per endpoint",
  y: { unit: "ms" },
  labels: ["Nov 10", "Nov 11", "Nov 12", "Nov 13", "Nov 14", "Nov 15", "Nov 16"],
  datasets: [
    { label: "storage", data: [120, 115, 130, 125, 140, 135, 128] },
    { label: "auth", data: [85, 90, null, null, 78, 82, 90] },
    { label: "api", data: [70, 75, 82, 88, 95, 90, 49] },
  ],
});

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

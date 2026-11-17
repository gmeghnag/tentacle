/**
 * The T3 chart fixtures (docs/feat/model-charts.md *Tests*): the mockup
 * datasets, as a model would send them. Deterministic (a seeded generator), so
 * the frames they render are stable.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const REV25 = [11800, 12400, 13100, 12900, 14200, 15100, 14800, 13900, 15600, 16400, 17100, 18900];
const REV26 = [12500, 14100, 13800, 15200, 16900, 17400, 18100, 17600, 19300, 20800, null, null];

const r = rng(7);
const LAT_T: string[] = [];
const P50: number[] = [];
const P95: number[] = [];
for (let i = 0; i < 96; i++) {
  LAT_T.push(new Date(Date.UTC(2026, 10, 14, 12, 0) + i * 30 * 60_000).toISOString());
  const spike = i > 70 && i < 76 ? 70 : 0;
  const base = 170 + 38 * Math.sin((i / 96) * Math.PI * 4 - 1) + (r() - 0.5) * 22 + spike;
  P50.push(Math.round(base));
  P95.push(Math.round(base * 1.85 + (r() - 0.5) * 40));
}

const s = rng(11);
const scatterPoints = (lo: number, span: number, slope: number, noise: number) =>
  Array.from({ length: 22 }, () => {
    const x = Math.round(lo + s() * span);
    return { x, y: Math.round((24 + x * slope + (s() - 0.5) * noise) * 10) / 10 };
  });

export const FIXTURES: Record<string, unknown> = {
  line: {
    type: "line",
    title: "Ricavi mensili 2025 vs 2026",
    labels: MONTHS,
    datasets: [
      { label: "2026", data: REV26 },
      { label: "2025", data: REV25 },
    ],
    y: { unit: "€", format: "compact" },
  },
  latency: {
    type: "line",
    title: "Latenza API — ultime 48 h",
    subtitle: "p50 e p95, un punto ogni 30 min",
    labels: LAT_T,
    datasets: [
      { label: "p50", data: P50 },
      { label: "p95", data: P95 },
    ],
    x: { type: "date" },
    y: { unit: "ms" },
  },
  hbar: {
    type: "bar",
    title: "Durata test per package",
    subtitle: "bun test, ultimo run",
    labels: [
      "daemon",
      "cli",
      "tui",
      "agent",
      "mobile",
      "client",
      "transport",
      "tools",
      "core",
      "protocol",
    ],
    datasets: [
      { label: "secondi", data: [38.5, 26.8, 21.7, 17.3, 14.6, 12.9, 9.4, 6.1, 4.2, 1.8] },
    ],
    y: { unit: "s", decimals: 1 },
  },
  vbar: {
    type: "bar",
    title: "PR per settimana",
    labels: ["w43", "w44", "w45", "w46"],
    datasets: [{ label: "PR", data: [12, 19, 7, 15] }],
  },
  stacked: {
    type: "bar",
    title: "Token al giorno per modello",
    subtitle: "settimana 46",
    stacked: true,
    labels: ["lun", "mar", "mer", "gio", "ven", "sab", "dom"],
    datasets: [
      { label: "Opus", data: [412000, 388000, 455000, 501000, 476000, 120000, 98000] },
      { label: "DeepSeek", data: [220000, 260000, 240000, 310000, 290000, 80000, 60000] },
      { label: "Qwen locale", data: [150000, 170000, 160000, 140000, 180000, 210000, 190000] },
    ],
  },
  pie: {
    type: "doughnut",
    title: "Costo per modello — novembre",
    labels: ["Opus", "DeepSeek", "Sonnet", "Haiku"],
    datasets: [{ label: "€", data: [61.2, 18.4, 9.8, 2.1] }],
    y: { unit: "€", decimals: 2 },
  },
  scatter: {
    type: "scatter",
    title: "Tempo di build vs righe modificate",
    datasets: [
      { label: "bugfix", data: scatterPoints(10, 380, 0.06, 14) },
      { label: "feature", data: scatterPoints(120, 780, 0.085, 22) },
    ],
    x: { title: "righe modificate" },
    y: { title: "secondi", unit: "s" },
  },
};

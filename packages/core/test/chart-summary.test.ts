/**
 * T1.16 — `summarizeChart`: the ONE sentence a chart's numbers make, shared by
 * the tool's result line (what the model, and an old client, reads), the phone's
 * VoiceOver label and the table's caption (docs/feat/model-charts.md D4).
 *
 * RED before the code: `summarizeChart` did not exist.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalChartJson,
  chartSpecBytes,
  effectiveXType,
  validateChartSpec,
} from "../src/index.ts";
import { summarizeChart } from "../src/index.ts";

/** A validated spec, throwing when the fixture is wrong. */
function spec(raw: unknown) {
  const result = validateChartSpec(raw);
  if (!result.ok) throw new Error(`fixture refused: ${result.errors.join(" | ")}`);
  return result.spec;
}

const REVENUE = spec({
  type: "line",
  title: "Ricavi mensili 2025",
  labels: ["gen", "feb", "mar"],
  datasets: [{ label: "Ricavi", data: [12500, 14000, 13800] }],
  y: { unit: "€", format: "compact" },
});

describe("summarizeChart", () => {
  test("the result line names the type, the title, the shape and the extent", () => {
    const summary = summarizeChart(REVENUE, { locale: "it" });
    expect(summary.line).toBe(
      'Chart shown to the user: line "Ricavi mensili 2025" · 1 series × 3 · y 12,5k €–14k €',
    );
  });

  test("two series, and the series facts VoiceOver reads", () => {
    const two = spec({
      type: "bar",
      title: "Confronto",
      labels: ["gen", "feb"],
      datasets: [
        { label: "2025", data: [10, 20] },
        { label: "2026", data: [12, 30] },
      ],
      y: { unit: "€", format: "full" },
    });
    const summary = summarizeChart(two, { locale: "it" });
    expect(summary.line).toContain("2 series × 2");
    expect(summary.line).toContain("y 10 €–30 €");
    expect(summary.series).toHaveLength(2);
    expect(summary.series[0]).toContain("2025: min 10 €, max 20 €");
    expect(summary.series[0]).toContain("from 10 € to 20 €");
    expect(summary.series[0]).toContain("+100.0%");
    expect(summary.series[0]).toContain("peak at feb");
  });

  test("the validator's notes ride the result line (the model learns what was dropped)", () => {
    const styled = spec({
      type: "line",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [1, 2], tension: 0.4 }],
    });
    const notes = ["ignored tension — the app chooses colours and styling"];
    const summary = summarizeChart(styled, { notes, locale: "en" });
    expect(summary.line).toContain("ignored tension — the app chooses colours and styling");
  });

  test("a point-form chart says its series count too", () => {
    const scatter = spec({
      type: "scatter",
      title: "Latenza",
      datasets: [
        {
          label: "p95",
          data: [
            { x: 1, y: 10 },
            { x: 2, y: 20 },
          ],
        },
      ],
      y: { unit: "ms", format: "full" },
    });
    expect(summarizeChart(scatter, { locale: "en" }).line).toContain("1 series × 2");
    expect(effectiveXType(scatter)).toBe("number");
  });

  test("nulls are gaps, not values", () => {
    const gapped = spec({
      type: "line",
      title: "T",
      labels: ["a", "b", "c"],
      datasets: [{ label: "A", data: [5, null, 15] }],
      y: { format: "full" },
    });
    expect(summarizeChart(gapped, { locale: "en" }).line).toContain("y 5–15");
  });
});

describe("the canonical bytes (the artifact version, C8 reads them)", () => {
  test("the same chart always serializes to the same bytes, field order fixed", () => {
    const one = spec({
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1], backgroundColor: "red" }],
    });
    const two = spec({
      labels: ["a"],
      datasets: [{ label: "A", data: [1] }],
      title: "T",
      type: "line",
    });
    expect(canonicalChartJson(one)).toBe(canonicalChartJson(two));
    expect(chartSpecBytes(one)).toBe(new TextEncoder().encode(canonicalChartJson(one)).length);
  });

  test("absent optionals are absent from the bytes", () => {
    const bytes = canonicalChartJson(REVENUE);
    expect(bytes).not.toContain("stacked");
    expect(bytes).not.toContain("subtitle");
    expect(bytes).toContain('"unit":"€"');
  });
});

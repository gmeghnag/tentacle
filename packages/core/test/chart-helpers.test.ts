/**
 * The C1 helpers the renderers call (docs/feat/model-charts.md D2/D4): plot
 * positions for a validated spec, the colour a dataset index earns, and the
 * model-facing JSON Schema's agreement with the validator's caps.
 *
 * RED before the code: none of these existed.
 */
import { describe, expect, test } from "bun:test";
import {
  CHART_CAPS,
  CHART_JSON_SCHEMA,
  CHART_TYPES,
  effectiveXType,
  seriesColor,
  specDates,
  specXPositions,
  usesPoints,
  validateChartSpec,
} from "../src/index.ts";

function spec(raw: unknown) {
  const result = validateChartSpec(raw);
  if (!result.ok) throw new Error(`fixture refused: ${result.errors.join(" | ")}`);
  return result.spec;
}

describe("plot positions", () => {
  test("categories sit evenly, a single one in the middle", () => {
    const three = spec({
      type: "line",
      title: "T",
      labels: ["a", "b", "c"],
      datasets: [{ label: "S", data: [1, 2, 3] }],
    });
    expect(specXPositions(three)).toEqual([0, 0.5, 1]);
    const one = spec({
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "S", data: [1] }],
    });
    expect(specXPositions(one)).toEqual([0.5]);
  });

  test("a number axis is proportional to its values, not their order", () => {
    const uneven = spec({
      type: "line",
      title: "T",
      labels: [0, 10, 40],
      datasets: [{ label: "S", data: [1, 2, 3] }],
      x: { type: "number" },
    });
    expect(specXPositions(uneven)).toEqual([0, 0.25, 1]);
  });

  test("a date axis follows elapsed time and is monotone", () => {
    const dates = spec({
      type: "line",
      title: "T",
      labels: ["2026-01-01", "2026-01-02", "2026-01-11"],
      datasets: [{ label: "S", data: [1, 2, 3] }],
      x: { type: "date" },
    });
    const positions = specXPositions(dates);
    expect(positions[0]).toBe(0);
    expect(positions[2]).toBe(1);
    expect(positions[1]).toBeCloseTo(1 / 10, 10);
    expect(specDates(dates)).toHaveLength(3);
  });

  test("point-form x drives a scatter's positions", () => {
    const scatter = spec({
      type: "scatter",
      title: "T",
      datasets: [
        {
          label: "S",
          data: [
            { x: 2, y: 1 },
            { x: 22, y: 2 },
          ],
        },
      ],
    });
    expect(effectiveXType(scatter)).toBe("number");
    expect(specXPositions(scatter)).toEqual([0, 1]);
  });

  test("usesPoints tells the two data forms apart", () => {
    const plain = spec({
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "S", data: [1] }],
    });
    expect(usesPoints(plain)).toBe(false);
    const points = spec({
      type: "scatter",
      title: "T",
      datasets: [{ label: "S", data: [{ x: 1, y: 1 }] }],
    });
    expect(usesPoints(points)).toBe(true);
  });
});

describe("seriesColor", () => {
  test("colour follows the dataset index, in both schemes", () => {
    expect(seriesColor(0, "light")).toBe("#0786a6");
    expect(seriesColor(1, "dark")).toBe("#d95926");
    expect(seriesColor(7, "light")).toBe("#e34948");
  });

  test("hiding a series never moves another one's colour (index, not rank)", () => {
    expect(seriesColor(2, "dark")).toBe("#9085e9");
    expect(seriesColor(3, "dark")).toBe("#c98500");
  });

  test("beyond 8 it wraps, and never returns undefined", () => {
    expect(seriesColor(8, "light")).toBe(seriesColor(0, "light"));
    expect(seriesColor(-1, "light")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("CHART_JSON_SCHEMA", () => {
  const properties = CHART_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
  const datasets = properties.datasets as {
    maxItems: number;
    minItems: number;
    items: { properties: { data: { maxItems: number } } };
  };
  const data = datasets.items.properties.data;

  test("it lists exactly the validator's types", () => {
    expect(properties.type?.enum).toEqual([...CHART_TYPES]);
  });

  test("its caps are the validator's caps (they cannot drift)", () => {
    expect(datasets.maxItems).toBe(CHART_CAPS.datasets);
    expect(data.maxItems).toBe(CHART_CAPS.points);
    expect(properties.title?.maxLength).toBe(CHART_CAPS.title);
    expect(properties.subtitle?.maxLength).toBe(CHART_CAPS.subtitle);
  });

  test("the required fields are the validator's required fields", () => {
    expect(CHART_JSON_SCHEMA.required).toEqual(["type", "title", "datasets"]);
  });

  test("it is closed, so the model reads which keys exist", () => {
    expect(CHART_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  test("the data description states the point form's scope (Review round 2, finding 2)", () => {
    const description = String((data as unknown as { description: string }).description);
    expect(description).toContain('an x whose type is "number"/"date"');
    expect(description).toContain("never for pie/doughnut");
    expect(description).toContain("same x in every series");
  });
});

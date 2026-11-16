/**
 * The hostile-input cases (§9 failure modes): a pod can forge `rawInput`, and a
 * client re-validates whatever it finds in a row's `args` before drawing. So the
 * validator must never throw, always say something actionable, and never leak a
 * JS internal (`undefined`, `[object Object]`, `NaN`) into a sentence a model reads.
 *
 * Found RED by a fuzz harness before these two sentences existed: a non-string
 * title reported `title must be text — title is missing — give the chart a short
 * title…` (the "you did not give it" sentence reused as the type complaint), and a
 * date in a value slot only got the generic "write a number" without saying that
 * dates live in `labels`.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalChartJson,
  chartExtent,
  specDates,
  specXPositions,
  summarizeChart,
  validateChartSpec,
} from "../src/index.ts";

/** Errors, throwing when a junk input was accepted. */
function errors(raw: unknown): readonly string[] {
  const result = validateChartSpec(raw);
  if (result.ok) throw new Error(`expected a refusal: ${JSON.stringify(raw)}`);
  return result.errors;
}

describe("a value slot cannot hold a date", () => {
  test("it says where the date belongs", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "S", data: ["2026-03-01"] }],
    };
    expect(errors(raw)[0]).toBe(
      'datasets[0].data[0] is the date "2026-03-01" — labels hold dates; a value is a number (or null for a gap)',
    );
  });
});

describe("a non-string where text is required", () => {
  test("the complaint is about the type, not that the field is missing", () => {
    const raw = { type: "line", title: 42, labels: ["a"], datasets: [{ label: "S", data: [1] }] };
    expect(errors(raw)).toEqual(["title must be text — write it as a plain string"]);
  });

  test("the same for a series label and an axis title", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: ["S"], data: [1] }],
      y: { title: 7 },
    };
    // Axes are read before datasets (the x type decides how labels/points parse),
    // so the order here is the reader's, not the alphabet's.
    expect(errors(raw)).toEqual([
      "y.title must be text — name the quantity",
      "datasets[0].label must be text — write it as a plain string",
    ]);
  });
});

describe("junk in, sentences out (a bounded fuzz)", () => {
  // Deterministic LCG, so a failure names the same case every run.
  let seed = 20261116;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const WEIRD: readonly unknown[] = [
    null,
    undefined,
    0,
    -0,
    1e-9,
    1e15,
    -1e15,
    1e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "0",
    "x",
    "2026-03-01",
    "2026-03-01T10:00:00Z",
    "2026-02",
    "2026-02-30",
    "\u0000",
    "🙂",
    [],
    {},
    true,
  ];
  const pick = (): unknown => WEIRD[Math.floor(rand() * WEIRD.length)];

  /** One field of a valid spec replaced by junk (or a whole dataset's data). */
  function mutate(raw: Record<string, unknown>): Record<string, unknown> {
    const out = structuredClone(raw) as Record<string, unknown>;
    const value = pick();
    switch (Math.floor(rand() * 6)) {
      case 0:
        out.type = value;
        break;
      case 1:
        out.title = value;
        break;
      case 2:
        out.labels = rand() < 0.5 ? value : [value];
        break;
      case 3:
        out.datasets = rand() < 0.5 ? value : [{ label: value, data: [value] }];
        break;
      case 4:
        out.y = value;
        break;
      default: {
        const datasets = out.datasets;
        if (Array.isArray(datasets) && datasets.length > 0) {
          (datasets[0] as { data: unknown }).data = [value, value, value];
        } else out.datasets = "not-an-array";
      }
    }
    return out;
  }

  const BASE = {
    type: "line",
    title: "T",
    labels: ["a", "b", "c"],
    datasets: [{ label: "S", data: [1, 2, 3] }],
    y: { unit: "€", format: "compact" },
  };

  test("never throws, ≤ 8 errors, and no JS internal leaks into a sentence", () => {
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      let raw: Record<string, unknown> = BASE;
      const rounds = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < rounds; k++) raw = mutate(raw);
      const result = validateChartSpec(raw);
      if (result.ok) {
        accepted++;
        // The ok path feeds the renderers, so exercise it too.
        canonicalChartJson(result.spec);
        specXPositions(result.spec);
        specDates(result.spec);
        chartExtent(result.spec);
        summarizeChart(result.spec, { locale: "it", notes: result.notes });
        continue;
      }
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeLessThanOrEqual(8);
      for (const message of result.errors) {
        expect(message).not.toMatch(/\bundefined\b|\[object|NaN/);
      }
    }
    // The fuzz must reach BOTH arms, or it proves nothing about the ok path.
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(3000);
  });
});

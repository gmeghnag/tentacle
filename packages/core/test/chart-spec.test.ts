/**
 * T1 — the chart spec and its validator (docs/feat/model-charts.md C1, D2).
 *
 * RED before the code: `packages/core/src/chart/` did not exist, so every case
 * here failed on the missing module; each message is the small model's fix, so
 * the assertions are literal sentences, not "some error".
 */
import { describe, expect, test } from "bun:test";
import { type ChartSpec, chartSpecBytes, validateChartSpec } from "../src/index.ts";

/** The validator's errors, throwing when the spec was accepted. */
function errors(raw: unknown): readonly string[] {
  const result = validateChartSpec(raw);
  if (result.ok) throw new Error("expected the spec to be refused, it was accepted");
  return result.errors;
}

/** The accepted spec, throwing when it was refused. */
function accepted(raw: unknown): ChartSpec {
  const result = validateChartSpec(raw);
  if (!result.ok)
    throw new Error(`expected the spec to pass, errors: ${result.errors.join(" | ")}`);
  return result.spec;
}

describe("T1.1 valid specs", () => {
  const OWNER = {
    type: "line",
    title: "Ricavi 2026",
    labels: ["gen", "feb", "mar"],
    datasets: [{ label: "Ricavi", data: [12.5, 14.1, 13.8] }],
    y: { unit: "€", format: "compact" },
    x: { type: "category" },
  };

  test("the owner's example (D2 form: x/y axis objects, format compact|full)", () => {
    const spec = accepted(OWNER);
    expect(spec.type).toBe("line");
    expect(spec.datasets).toHaveLength(1);
    expect(spec.y?.format).toBe("compact");
  });

  test("one valid spec per type", () => {
    const specs = [
      OWNER,
      {
        type: "bar",
        title: "Vendite",
        labels: ["a", "b"],
        datasets: [{ label: "S", data: [1, 2] }],
      },
      {
        type: "area",
        title: "Richieste",
        labels: ["2026-01", "2026-02"],
        datasets: [{ label: "S", data: [1, null] }],
        stacked: true,
        x: { type: "date" },
      },
      { type: "pie", title: "Quote", labels: ["a", "b"], datasets: [{ label: "Q", data: [3, 7] }] },
      {
        type: "doughnut",
        title: "Quote",
        labels: ["a", "b", "c"],
        datasets: [{ label: "Q", data: [3, 7, 0] }],
      },
      {
        type: "scatter",
        title: "Latenza",
        datasets: [
          {
            label: "p95",
            data: [
              { x: 1, y: 12 },
              { x: 2, y: 9 },
            ],
          },
        ],
        x: { type: "number", title: "righe", unit: "k" },
        y: { title: "ms", unit: "ms", format: "full", decimals: 1 },
      },
    ];
    for (const raw of specs) expect(accepted(raw).type).toBe(raw.type as ChartSpec["type"]);
  });

  test("a spec's unknown-free shape is returned sanitized (only the known fields)", () => {
    const spec = accepted({ ...OWNER, backgroundColor: "red" });
    expect(Object.keys(spec).sort()).toEqual(
      ["datasets", "labels", "title", "type", "x", "y"].sort(),
    );
  });
});

describe("T1.2 strings for numbers", () => {
  const one = (value: unknown): readonly string[] =>
    errors({
      type: "line",
      title: "T",
      labels: ["gen"],
      datasets: [{ label: "A", data: [value] }],
    });

  test('"12.5" — write the number, no quotes', () => {
    expect(one("12.5")[0]).toBe(
      'datasets[0].data[0] is the string "12.5" — write the number 12.5 (no quotes)',
    );
  });

  test('"14,1" — dot as the decimal separator', () => {
    expect(one("14,1")[0]).toBe(
      'datasets[0].data[0] is the string "14,1" — write 14.1 (dot as decimal separator, no thousands separator)',
    );
  });

  test('"1.234,5" — same fix, and the corrected literal is in the message', () => {
    const [first] = one("1.234,5");
    expect(first).toContain("1234.5");
    expect(first).toContain("dot as decimal separator");
  });

  test('"12k" and "€12" — the plain number, and the unit goes on the axis', () => {
    expect(one("12k")[0]).toContain("write the plain number 12000");
    expect(one("12k")[0]).toContain("the axis format prints it short");
    expect(one("€12")[0]).toContain("write the plain number 12");
    expect(one("€12")[0]).toContain('put "€" in y.unit');
  });

  test("a non-numeric string still names the path", () => {
    expect(one("n/d")[0]).toContain('datasets[0].data[0] is the string "n/d"');
  });
});

describe("T1.3 shape", () => {
  test("length mismatch names both counts", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"],
      datasets: [
        { label: "A", data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
        { label: "B", data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      ],
    };
    expect(errors(raw)).toEqual([
      "datasets[1].data has 10 values but labels has 12 — give one value per label (null for a gap)",
    ]);
  });

  test("missing labels, with the way out", () => {
    const raw = { type: "line", title: "T", datasets: [{ label: "A", data: [1, 2] }] };
    expect(errors(raw)[0]).toBe(
      'labels is missing — line charts need one label per value (or use {x, y} points with x.type "number" or "date")',
    );
  });

  test("empty datasets", () => {
    expect(errors({ type: "line", title: "T", labels: ["a"], datasets: [] })[0]).toBe(
      "datasets is empty — give at least one series with at least one value",
    );
  });

  test("empty data", () => {
    expect(
      errors({ type: "line", title: "T", labels: [], datasets: [{ label: "A", data: [] }] })[0],
    ).toBe("datasets[0].data is empty — give at least one value per label");
  });

  test("all null", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [null, null] }],
    };
    expect(errors(raw)).toContain("datasets[0].data has no values (all null)");
  });

  test("all null in the point form too (Review round 2, finding 1)", () => {
    const raw = {
      type: "scatter",
      title: "T",
      datasets: [
        {
          label: "A",
          data: [
            { x: 1, y: null },
            { x: 2, y: null },
          ],
        },
      ],
    };
    expect(errors(raw)).toContain("datasets[0].data has no values (all null)");
  });

  test("…but one real value among the gaps is still valid", () => {
    const raw = {
      type: "scatter",
      title: "T",
      datasets: [
        {
          label: "A",
          data: [
            { x: 1, y: null },
            { x: 2, y: 3 },
          ],
        },
      ],
    };
    expect(accepted(raw).type).toBe("scatter");
  });

  test("missing title and missing type", () => {
    expect(errors({ labels: ["a"], datasets: [{ label: "A", data: [1] }] })).toContain(
      "type is missing — allowed: line, bar, area, pie, doughnut, scatter",
    );
    expect(
      errors({ type: "line", labels: ["a"], datasets: [{ label: "A", data: [1] }] }),
    ).toContain("title is missing — give the chart a short title (it is the transcript header)");
  });

  test("a nameless series is refused", () => {
    const raw = { type: "line", title: "T", labels: ["a"], datasets: [{ data: [1] }] };
    expect(errors(raw)).toContain("datasets[0].label is missing — give each series a name");
  });

  test("every error at once, capped at 8", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      datasets: [{ label: "A", data: ["x", "x", "x", "x", "x", "x", "x", "x", "x"] }],
    };
    const list = errors(raw);
    expect(list.length).toBeGreaterThan(1);
    expect(list.length).toBeLessThanOrEqual(8);
  });
});

describe("T1.13 the point form is scoped (Review round 2, finding 2)", () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i + 1, y: i }));

  test("pie and doughnut take slices from labels, never points", () => {
    for (const type of ["pie", "doughnut"]) {
      // ONE sentence: the form is refused, and no spurious "labels is missing".
      expect(errors({ type, title: "T", datasets: [{ label: "A", data: points(2) }] })).toEqual([
        `datasets[0].data uses {x, y} points — a ${type} takes one number per label (put the slice names in labels)`,
      ]);
    }
  });

  test("a bar with points and no x type is refused (the category cap cannot see them)", () => {
    expect(
      errors({ type: "bar", title: "T", datasets: [{ label: "A", data: points(3) }] }),
    ).toEqual([
      'datasets[0].data uses {x, y} points — the x axis must be numeric: add x: {"type": "number"} (or "date")',
    ]);
  });

  test("…and with a number x, the 60-category cap counts the points", () => {
    const bar = (n: number) => ({
      type: "bar",
      title: "T",
      datasets: [{ label: "A", data: points(n) }],
      x: { type: "number" },
    });
    expect(accepted(bar(60)).type).toBe("bar");
    expect(errors(bar(61))[0]).toBe(
      'datasets[0].data has 61 points (max 60 categories for a bar chart) — fold the smallest into "Other" or use a line chart',
    );
  });

  test("a stacked chart needs every series on the same x", () => {
    const stacked = (aligned: boolean) => ({
      type: "area",
      title: "T",
      stacked: true,
      x: { type: "number" },
      datasets: [
        {
          label: "A",
          data: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
        {
          label: "B",
          data: aligned
            ? [
                { x: 1, y: 2 },
                { x: 2, y: 1 },
              ]
            : [
                { x: 2, y: 1 },
                { x: 3, y: 2 },
              ],
        },
      ],
    });
    expect(accepted(stacked(true)).type).toBe("area");
    expect(errors(stacked(false))[0]).toBe(
      "datasets[1].data has different x values from datasets[0].data — a stacked chart sums one column at a time, so every series needs the same x (or use stacked: false)",
    );
  });

  test("an unknown type is not double-charged for the axis it never had", () => {
    expect(
      errors({ type: "donut", title: "T", datasets: [{ label: "A", data: points(2) }] }),
    ).toEqual([
      'unknown type "donut" — did you mean "doughnut"? Allowed: line, bar, area, pie, doughnut, scatter',
    ]);
  });

  test("the legitimate point forms still pass", () => {
    const line = (x: unknown) => ({
      type: "line",
      title: "T",
      datasets: [{ label: "A", data: points(2) }],
      x,
    });
    expect(accepted(line({ type: "number" })).type).toBe("line");
    expect(
      accepted({
        type: "line",
        title: "T",
        datasets: [{ label: "A", data: [{ x: "2026-03-01", y: 1 }] }],
        x: { type: "date" },
      }).type,
    ).toBe("line");
    expect(
      accepted({ type: "scatter", title: "T", datasets: [{ label: "A", data: points(2) }] }).type,
    ).toBe("scatter");
  });
});

describe("T1.4 unknown or misspelled type", () => {
  const withType = (type: string): readonly string[] =>
    errors({ type, title: "T", labels: ["a"], datasets: [{ label: "A", data: [1] }] });

  test("donut → doughnut", () => {
    expect(withType("donut")[0]).toBe(
      'unknown type "donut" — did you mean "doughnut"? Allowed: line, bar, area, pie, doughnut, scatter',
    );
  });

  test("the Chart.js habits: column, histogram, lines", () => {
    expect(withType("column")[0]).toContain('did you mean "bar"');
    expect(withType("histogram")[0]).toContain('did you mean "bar"');
    expect(withType("lines")[0]).toContain('did you mean "line"');
  });

  test("no close match: the allowed list only", () => {
    expect(withType("radar")[0]).toBe(
      'unknown type "radar" — allowed: line, bar, area, pie, doughnut, scatter',
    );
  });
});

describe("T1.5 Chart.js habits", () => {
  test("options is an error that says where those settings went", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1] }],
      options: { scales: { y: { beginAtZero: true } } },
    };
    expect(errors(raw)[0]).toBe(
      '"options" is not used — put stacked at the top level and axis settings in "x"/"y" (unit, format, decimals, title)',
    );
  });

  test("styling keys are dropped with a note, never an error", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [1, 2], backgroundColor: "#f00", tension: 0.4 }],
    };
    const result = validateChartSpec(raw);
    if (!result.ok) throw new Error(result.errors.join(" | "));
    expect(result.notes).toEqual([
      "ignored backgroundColor, tension — the app chooses colours and styling",
    ]);
    const dataset = result.spec.datasets[0];
    expect(dataset).toBeDefined();
    if (dataset) expect(Object.keys(dataset).sort()).toEqual(["data", "label"]);
  });

  test("any other unknown key is an error naming the allowed ones", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1], foo: 1 }],
    };
    expect(errors(raw)[0]).toBe('unknown field "foo" at datasets[0] — allowed: label, data');
  });

  test("unknown top-level and axis keys too", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1] }],
      plugins: {},
      y: { unit: "€", grid: { color: "red" } },
    };
    expect(errors(raw)).toEqual([
      'unknown field "plugins" — allowed: type, title, subtitle, labels, datasets, stacked, x, y',
      'unknown field "grid" at y — allowed: title, unit, format, decimals',
    ]);
  });

  test('y.format "k" is not a format: the two values are named', () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1] }],
      y: { format: "k" },
    };
    expect(errors(raw)[0]).toBe(
      'y.format "k" is not valid — allowed: compact, full (or leave it out and the client picks)',
    );
  });
});

describe("T1.6 too large to chart", () => {
  test("1e16 asks for a scaled number", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1e16] }],
    };
    expect(errors(raw)[0]).toBe(
      "datasets[0].data[0] is too large to chart exactly — scale it (e.g. millions) and say so in y.unit",
    );
  });

  test("1e15 is still exact enough", () => {
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["a"],
        datasets: [{ label: "A", data: [1e15] }],
      }).type,
    ).toBe("line");
  });

  test("a non-finite number (forged args, not JSON) is refused", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [Number.NaN] }],
    };
    expect(errors(raw)[0]).toContain("datasets[0].data[0] is not a finite number");
  });
});

describe("T1.7 signs", () => {
  test("negative bar values are valid (bars grow both ways from 0)", () => {
    const spec = accepted({
      type: "bar",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [-3, 2] }],
    });
    expect(spec.type).toBe("bar");
  });

  test("a negative pie slice is refused", () => {
    const raw = {
      type: "pie",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [-3, 2] }],
    };
    expect(errors(raw)[0]).toBe(
      "pie values must be ≥ 0 and not all 0 — use a bar chart for signed values",
    );
  });

  test("an all-zero pie is refused", () => {
    const raw = {
      type: "doughnut",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [0, 0] }],
    };
    expect(errors(raw)[0]).toBe(
      "pie values must be ≥ 0 and not all 0 — use a bar chart for signed values",
    );
  });

  test("a pie with two datasets is refused", () => {
    const raw = {
      type: "pie",
      title: "T",
      labels: ["a"],
      datasets: [
        { label: "A", data: [1] },
        { label: "B", data: [2] },
      ],
    };
    expect(errors(raw)[0]).toBe(
      "pie/doughnut take exactly one dataset — make one chart per series",
    );
  });

  test("stacked only on bar/area", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a"],
      datasets: [{ label: "A", data: [1] }],
      stacked: true,
    };
    expect(errors(raw)[0]).toBe(
      'stacked works with bar and area only — use type "area" with stacked: true',
    );
  });
});

describe("T1.8 degenerate but valid", () => {
  test("a single point", () => {
    expect(
      accepted({ type: "line", title: "T", labels: ["a"], datasets: [{ label: "A", data: [5] }] })
        .type,
    ).toBe("line");
  });

  test("all values equal", () => {
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["a", "b"],
        datasets: [{ label: "A", data: [5, 5] }],
      }).type,
    ).toBe("line");
  });
});

describe("T1.9 dates", () => {
  const withLabels = (labels: unknown[]): readonly string[] =>
    errors({
      type: "line",
      title: "T",
      labels,
      datasets: [{ label: "A", data: labels.map(() => 1) }],
      x: { type: "date" },
    });

  test("a non-ISO label is refused with the three accepted forms", () => {
    expect(withLabels(["03/01/2026"])[0]).toBe(
      'labels[0] "03/01/2026" is not an ISO date — write 2026-03-01 (or 2026-03, or 2026-03-01T14:00:00Z)',
    );
  });

  test("the four accepted forms", () => {
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["2026-03", "2026-04"],
        datasets: [{ label: "A", data: [1, 2] }],
        x: { type: "date" },
      }).type,
    ).toBe("line");
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["2026-03-01"],
        datasets: [{ label: "A", data: [1] }],
        x: { type: "date" },
      }).type,
    ).toBe("line");
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["2026-03-01T14:00:00Z"],
        datasets: [{ label: "A", data: [1] }],
        x: { type: "date" },
      }).type,
    ).toBe("line");
    expect(
      accepted({
        type: "line",
        title: "T",
        labels: ["2026-03-01T14:00+01:00"],
        datasets: [{ label: "A", data: [1] }],
        x: { type: "date" },
      }).type,
    ).toBe("line");
  });

  test("a calendar date and an instant in one chart are refused", () => {
    expect(withLabels(["2026-03-01", "2026-03-02T10:00:00Z"])).toContain(
      "labels mix dates and times — use one form",
    );
  });

  test("an impossible calendar date is not an ISO date", () => {
    expect(withLabels(["2026-02-31"])[0]).toContain("is not an ISO date");
  });

  test("number x takes numbers (and its points' x is one too)", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: [1, 2],
      datasets: [{ label: "A", data: [{ x: "nope", y: 1 }] }],
      x: { type: "number" },
    };
    expect(errors(raw)[0]).toContain('datasets[0].data[0].x is the string "nope"');
  });

  test("a number axis refuses categorical labels, and says why", () => {
    const raw = {
      type: "line",
      title: "T",
      labels: ["a", "b"],
      datasets: [{ label: "A", data: [1, 2] }],
      x: { type: "number" },
    };
    expect(errors(raw)[0]).toBe(
      'labels[0] is the string "a" — x.type is "number", so give numbers',
    );
  });
});

describe("T1.12 caps", () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `S${i}`, data: [1, 2] }));

  test("8 series pass, 9 fail with the folding advice", () => {
    expect(
      accepted({ type: "line", title: "T", labels: ["a", "b"], datasets: series(8) }).datasets,
    ).toHaveLength(8);
    expect(errors({ type: "line", title: "T", labels: ["a", "b"], datasets: series(9) })[0]).toBe(
      'datasets has 9 series (max 8) — keep the 7 largest and fold the rest into "Other"',
    );
  });

  test("1000 points pass, 1001 fail with the aggregation advice", () => {
    const labels = Array.from({ length: 1000 }, (_, i) => i);
    const data = Array.from({ length: 1000 }, (_, i) => i);
    expect(
      accepted({ type: "line", title: "T", labels, datasets: [{ label: "A", data }] }).type,
    ).toBe("line");
    const long = Array.from({ length: 1001 }, (_, i) => i);
    expect(
      errors({ type: "line", title: "T", labels: long, datasets: [{ label: "A", data: long }] })[0],
    ).toBe(
      "datasets[0].data has 1001 points (max 1000 per series) — aggregate (e.g. per hour) or sample",
    );
  });

  test("60 bar categories pass, 61 fail", () => {
    const labels = (n: number) => Array.from({ length: n }, () => "x");
    const data = (n: number) => Array.from({ length: n }, () => 1);
    expect(
      accepted({
        type: "bar",
        title: "T",
        labels: labels(60),
        datasets: [{ label: "A", data: data(60) }],
      }).type,
    ).toBe("bar");
    expect(
      errors({
        type: "bar",
        title: "T",
        labels: labels(61),
        datasets: [{ label: "A", data: data(61) }],
      })[0],
    ).toBe(
      'labels has 61 categories (max 60 for a bar chart) — fold the smallest into "Other" or use a line chart',
    );
  });

  test("64 KiB: 64 KiB on the nose passes, a byte more fails", () => {
    // The cap is measured on the CANONICAL bytes (what the artifact stores), so
    // the test walks the size the same way the reader does: 400 category labels
    // each one character longer, until the byte count crosses 65 536.
    // (A styling key cannot be used — it is dropped, so it never reaches the bytes.)
    const wide = (length: number) =>
      Array.from({ length: 400 }, (_, i) => `${i}`.padStart(length, "x"));
    const sized = (length: number) => ({
      type: "line",
      title: "T",
      labels: wide(length),
      datasets: Array.from({ length: 8 }, () => ({
        label: "S",
        data: Array.from({ length: 400 }, () => 123456789012345),
      })),
    });
    let lastAccepted = 0;
    let refusedAt = 0;
    for (let length = 1; length <= 400; length++) {
      const result = validateChartSpec(sized(length));
      if (result.ok) {
        lastAccepted = chartSpecBytes(result.spec);
        continue;
      }
      refusedAt = length;
      break;
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(lastAccepted).toBeLessThanOrEqual(64 * 1024);
    expect(errors(sized(refusedAt))[0]).toBe(
      `the chart is too large (${Math.ceil((lastAccepted + 400) / 1024)} KiB > 64 KiB) — aggregate, sample or split it`,
    );
  });

  test("string caps name their limit", () => {
    const base = { type: "line", title: "T", labels: ["a"], datasets: [{ label: "A", data: [1] }] };
    expect(errors({ ...base, title: "x".repeat(121) })[0]).toBe(
      "title is 121 characters (max 120) — shorten it",
    );
    expect(errors({ ...base, subtitle: "x".repeat(161) })[0]).toBe(
      "subtitle is 161 characters (max 160) — shorten it",
    );
    expect(errors({ ...base, datasets: [{ label: "x".repeat(61), data: [1] }] })[0]).toBe(
      "datasets[0].label is 61 characters (max 60) — shorten it",
    );
    expect(errors({ ...base, x: { title: "x".repeat(41) } })[0]).toBe(
      "x.title is 41 characters (max 40) — shorten it",
    );
    expect(errors({ ...base, y: { decimals: 7 } })[0]).toBe(
      "y.decimals 7 is not valid — an integer 0..6",
    );
  });

  test("not an object at all", () => {
    expect(errors(null)[0]).toBe(
      "the chart spec must be an object — give type, title and datasets",
    );
    expect(errors("chart")[0]).toBe(
      "the chart spec must be an object — give type, title and datasets",
    );
  });
});

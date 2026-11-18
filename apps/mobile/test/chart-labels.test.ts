/**
 * `feat/mobile-chart-labels` — C (labels INSIDE the plot, default) and A (the
 * compact legend above it), plus the mockup's two all-variant fixes (a stacked
 * area's y ceiling, one stroke + marker per series). Pure: `chartLayout` only.
 */
import { describe, expect, test } from "bun:test";
import { monoWidth, overlaps, textBox } from "../src/chart-layout-kit.ts";
import { chartLayout } from "../src/chart-layout.ts";
import { LATENCY, REVENUE, TRAFFIC, spec } from "./chart-fixtures.ts";

/** The repro's phone width: 393 pt minus the transcript's 32 pt of margins. */
const W = 361;

function must(layout: ReturnType<typeof chartLayout>): NonNullable<typeof layout> {
  if (!layout) throw new Error("expected a layout");
  return layout;
}

const labels = (l: NonNullable<ReturnType<typeof chartLayout>>) =>
  l.texts.filter((t) => t.role === "direct");

describe("C · labels inside the plot (default)", () => {
  for (const [name, raw] of [
    ["stacked area", TRAFFIC],
    ["line", LATENCY],
  ] as const) {
    test(`${name}: full-width plot, one name-only label per series, no legend`, () => {
      const l = must(chartLayout(raw, { width: W, locale: "en" }));
      // The whole point of C: no gutter. The repro's 35 % / 17 % are gone.
      expect(l.plot.right).toBe(W);
      expect(l.legend).toBeNull();
      const direct = labels(l);
      expect(direct.map((t) => t.text).sort()).toEqual(raw.datasets.map((d) => d.label).sort());
      for (const t of direct) {
        expect(t.halo).toBe(true);
        expect(t.anchor).toBe("end");
        const box = textBox(t, monoWidth);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(W + 1e-9);
        expect(box.y).toBeGreaterThanOrEqual(l.plot.top);
        expect(t.y).toBeLessThanOrEqual(l.plot.bottom + 1e-9);
      }
      // Collisions are resolved vertically, so no two labels overlap.
      for (let i = 0; i < direct.length; i++) {
        for (let j = i + 1; j < direct.length; j++) {
          const a = direct[i] as (typeof direct)[number];
          const b = direct[j] as (typeof direct)[number];
          expect(overlaps(textBox(a, monoWidth), textBox(b, monoWidth))).toBe(false);
        }
      }
    });
  }

  test("a stacked label sits inside its OWN band, not on top of the stack", () => {
    // Review round 1, finding 2 (D2's "band's mid"): the y target is the band's
    // middle, so it must lie between the cumulative value at k and the one below.
    const l = must(chartLayout(TRAFFIC, { width: W, locale: "en" }));
    // Y(v) — the layout's value→pt map, recovered from two of its own guides.
    const gs = [...l.guides].sort((a, b) => a.value - b.value);
    const g0 = gs[0];
    const g1 = gs[gs.length - 1];
    if (!g0 || !g1) throw new Error("expected guides");
    const Y = (v: number): number =>
      g0.y + ((v - g0.value) * (g1.y - g0.y)) / (g1.value - g0.value);
    const data = TRAFFIC.datasets.map((d) => d.data[5] as number);
    for (const t of labels(l)) {
      const k = t.series ?? -1;
      if (k < 0) throw new Error("expected a series");
      const below = data.slice(0, k).reduce((s, v) => s + v, 0);
      const cum = below + (data[k] as number);
      const top = Y(cum);
      const bottom = Y(below);
      // Inside the band, dodge or no dodge: strictly below its ceiling, and no
      // further than one row height below its floor (the band's mid is the target).
      expect(t.y).toBeGreaterThan(top);
      expect(t.y).toBeLessThan(bottom + 1e-6);
    }
  });

  test("a series with a gap is labelled at its own last DEFEND point, not the last x", () => {
    const l = must(chartLayout(LATENCY, { width: W, locale: "en" }));
    const auth = labels(l).find((t) => t.text === "auth");
    if (!auth) throw new Error("expected an auth label");
    // auth ends at Nov 16 (index 6, its last defined point) — so its label sits
    // at the right edge, like the others; the value column is what is gone.
    expect(auth.x).toBeGreaterThan(W / 2);
    const gapped = must(
      chartLayout(
        spec({
          type: "line",
          title: "x",
          labels: ["a", "b", "c", "d", "e"],
          datasets: [
            { label: "one", data: [1, 2, 3, 4, 5] },
            { label: "two", data: [5, 4, 3, null, null] },
          ],
        }),
        { width: W },
      ),
    );
    const two = labels(gapped).find((t) => t.text === "two");
    if (!two) throw new Error("expected a two label");
    const one = labels(gapped).find((t) => t.text === "one");
    if (!one) throw new Error("expected a one label");
    expect(two.x).toBeLessThan(one.x);
  });

  test("every label carries a marker dot in its series colour", () => {
    const l = must(chartLayout(TRAFFIC, { width: W, locale: "en" }));
    const markers = l.dots.filter((d) => d.ring !== undefined && d.r < 4);
    expect(markers.map((d) => d.series).sort()).toEqual([0, 1, 2]);
    expect(markers.every((d) => "series" in d.paint)).toBe(true);
  });

  test("a single series gets no label (the hero says it)", () => {
    const one = spec({ ...REVENUE, datasets: [REVENUE.datasets[1]] });
    const solo = must(chartLayout(one, { width: W, locale: "it" }));
    expect(labels(solo)).toHaveLength(0);
    expect(solo.plot.right).toBe(W);
  });
});

describe("C · the auto-fallback to A", () => {
  test("too many short names for the plot's height fall back too", () => {
    // 8 short names fit the width but not the height at AX5: the height rule,
    // alone (the width rule is what the long-name case below proves).
    const many = {
      type: "line",
      title: "x",
      labels: ["a", "b", "c", "d"],
      datasets: Array.from({ length: 8 }, (_, k) => ({ label: `s${k}`, data: [1, 2, 3, 4 + k] })),
    };
    const l = must(chartLayout(spec(many), { width: W, fontScale: 2.35 }));
    expect(labels(l)).toHaveLength(0);
    expect(l.legend).toHaveLength(8);
  });

  test("8 series with 60-char names cannot fit inside: a legend, no direct labels", () => {
    const long = Array.from({ length: 8 }, (_, k) => ({
      label: `series ${k} `.padEnd(60, "x"),
      data: [1, 2, 3, 4 + k],
    }));
    const l = must(
      chartLayout(
        spec({ type: "line", title: "x", labels: ["a", "b", "c", "d"], datasets: long }),
        { width: W, locale: "en" },
      ),
    );
    expect(labels(l)).toHaveLength(0);
    expect(l.legend?.map((i) => i.series)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(l.plot.right).toBe(W);
  });
});

describe('A · labels: "legend" (the setting)', () => {
  test("no direct labels; each item carries the name, its last value and a shape", () => {
    const l = must(chartLayout(TRAFFIC, { width: W, locale: "en", labels: "legend" }));
    expect(labels(l)).toHaveLength(0);
    expect(l.plot.right).toBe(W);
    expect(l.legend?.map((i) => [i.series, i.label, i.value, i.shape])).toEqual([
      [0, "web", "455 k req", "circle"],
      [1, "mobile", "430 k req", "square"],
      [2, "api", "148 k req", "triangle"],
    ]);
  });

  test("a gap-valued series shows its last DEFINED value", () => {
    // series 0 of REVENUE ends in two nulls (Oct is its last defined point).
    const l = must(chartLayout(REVENUE, { width: W, locale: "it", labels: "legend" }));
    const first = l.legend?.[0];
    expect(first?.label).toBe("2026");
    // `yFormat`, the same formatting the old gutter labels used.
    expect(first?.value).toBe("20,8k €");
  });
});

describe("D4 · the stacked area's y ceiling", () => {
  test("the top guide covers the stacked total (1,033 → a nice 1,200)", () => {
    const l = must(chartLayout(TRAFFIC, { width: W, locale: "en" }));
    const top = Math.max(...l.guides.map((g) => g.value));
    expect(top).toBeGreaterThanOrEqual(1033);
    // Every drawn point sits at or below the top guide, so nothing overshoots.
    const topY = Math.min(...l.guides.map((g) => g.y));
    for (const p of l.paths.filter((q) => q.role === "line")) {
      for (const m of p.d.match(/[\d.]+,([\d.]+)/g) ?? []) {
        expect(Number(m.split(",")[1])).toBeGreaterThanOrEqual(topY - 1e-9);
      }
    }
  });

  test("a non-stacked line keeps its padded domain (no change)", () => {
    const l = must(chartLayout(LATENCY, { width: W, locale: "en" }));
    expect(Math.max(...l.guides.map((g) => g.value))).toBe(150);
  });
});

describe("D5 · a stroke + marker per series", () => {
  test("series 0 solid, 1 dashed, 2 dotted; the markers circle/square/triangle", () => {
    const l = must(chartLayout(LATENCY, { width: W, locale: "en" }));
    // A gap splits a series into runs, so one series can own several paths: the
    // dash must be the same on all of them.
    const bySeries = new Map<number, Set<string>>();
    for (const p of l.paths.filter((q) => q.role === "line")) {
      const set = bySeries.get(p.series) ?? new Set<string>();
      set.add(p.dash ?? "");
      bySeries.set(p.series, set);
    }
    expect([...bySeries].sort((a, b) => a[0] - b[0]).map(([k, d]) => [k, [...d]])).toEqual([
      [0, [""]],
      [1, ["6 4"]],
      [2, ["0.1 4"]],
    ]);
    const shapes = labels(l).map((t) => [t.text, t.shape ?? "circle"]);
    expect(shapes.sort()).toEqual([
      ["api", "triangle"],
      ["auth", "square"],
      ["storage", "circle"],
    ]);
  });

  test("a single series has no dash (today's look)", () => {
    const solo = spec({ ...REVENUE, datasets: [REVENUE.datasets[1]] });
    const l = must(chartLayout(solo, { width: W, locale: "it" }));
    expect(l.paths.filter((p) => p.role === "line").every((p) => p.dash === undefined)).toBe(true);
  });

  test("area series take the same dashes", () => {
    const l = must(chartLayout(TRAFFIC, { width: W, locale: "en" }));
    expect(
      l.paths
        .filter((p) => p.role === "line")
        .map((p) => [p.series, p.dash ?? ""])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [0, ""],
      [1, "6 4"],
      [2, "0.1 4"],
    ]);
  });
});

describe("non-regression: bar / scatter / donut ignore the label mode", () => {
  const CASES = [
    {
      type: "bar",
      title: "Build",
      labels: ["core", "tui", "cli", "agent"],
      y: { unit: "s" },
      datasets: [{ label: "s", data: [12.5, 48.2, 30, 7] }],
    },
    {
      type: "doughnut",
      title: "Costi",
      labels: ["Opus", "Sonnet"],
      datasets: [{ label: "€", data: [31.2, 12.4] }],
    },
    {
      type: "scatter",
      title: "Righe",
      datasets: [
        { label: "bugfix", data: [10, 90, 170, 250].map((x) => ({ x, y: 20 + 0.06 * x })) },
        { label: "feature", data: [120, 300, 480].map((x) => ({ x, y: 30 + 0.085 * x })) },
      ],
    },
  ] as const;
  for (const raw of CASES) {
    test(`${raw.type}: deep-equal with and without the option`, () => {
      const s = spec(raw);
      const a = must(chartLayout(s, { width: W, locale: "it" }));
      const b = must(chartLayout(s, { width: W, locale: "it", labels: "legend" }));
      expect(b).toEqual(a);
    });
  }
});

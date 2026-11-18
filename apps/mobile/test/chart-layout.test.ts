/**
 * T5.1–T5.5, T5.7, T5.9 (labels), T5.11, T5.14 — `chartLayout`, the phone's
 * pure chart layout (docs/feat/model-charts.md D6 + *iPhone visual language
 * (rev 2)*; owner picks line A, bar/stacked/area/donut B, scatter A).
 */
import { describe, expect, test } from "bun:test";
import { heroOf } from "../src/chart-hero.ts";
import { guideItems } from "../src/chart-layout-axis.ts";
import {
  type ChartLayout,
  type Ctx,
  type LayoutText,
  monoWidth,
  overlaps,
  textBox,
} from "../src/chart-layout-kit.ts";
import { chartLayout, chartSpecOf } from "../src/chart-layout.ts";
import { REVENUE } from "./chart-fixtures.ts";

function must(layout: ChartLayout | null): ChartLayout {
  if (!layout) throw new Error("expected a layout");
  return layout;
}

const W = 358; // a 390 pt iPhone minus 16 pt margins

const BARS = {
  type: "bar",
  title: "Build",
  labels: ["core", "tui", "cli", "agent"],
  y: { unit: "s" },
  datasets: [{ label: "s", data: [12.5, 48.2, 30, 7] }],
};
const PIE = {
  type: "pie",
  title: "Costi",
  labels: ["Opus", "Sonnet", "Haiku"],
  y: { unit: "€", decimals: 2 },
  datasets: [{ label: "€", data: [31.2, 12.4, 1.1] }],
};
const SCATTER = {
  type: "scatter",
  title: "Righe",
  x: { unit: "righe" },
  y: { unit: "s" },
  datasets: [
    {
      label: "bugfix",
      data: [10, 50, 90, 130, 170, 210, 250, 290].map((x) => ({ x, y: 20 + 0.06 * x + (x % 3) })),
    },
    { label: "feature", data: [120, 300, 480, 660, 840].map((x) => ({ x, y: 30 + 0.085 * x })) },
  ],
};
const AREA = {
  type: "area",
  title: "Utenti",
  labels: ["gen", "feb", "mar", "apr", "mag", "giu"],
  datasets: [
    { label: "web", data: [120, 140, 135, 170, 190, 210] },
    { label: "app", data: [40, 55, 60, 80, 95, 120] },
  ],
};

function texts(layout: ChartLayout, role: LayoutText["role"]): LayoutText[] {
  return layout.texts.filter((t) => t.role === role);
}

function noOverlap(list: readonly LayoutText[]): boolean {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (
        overlaps(
          textBox(list[i] as LayoutText, monoWidth),
          textBox(list[j] as LayoutText, monoWidth),
        )
      )
        return false;
    }
  }
  return true;
}

describe("T5.1 fixtures per type (the owner's picks)", () => {
  test("line (A): two strokes, series 1 muted, one gradient fill, dotted guides, end dot with halo, first·mid·last x", () => {
    const l = must(chartLayout(REVENUE, { width: W, locale: "it" }));
    expect(l.kind).toBe("line");
    const lines = l.paths.filter((p) => p.role === "line");
    expect(lines.map((p) => [p.series, p.paint, p.strokeWidth])).toEqual([
      [1, { token: "mutedLine" }, 1.75],
      [0, { series: 0 }, 2.5],
    ]);
    expect(lines.every((p) => (p.length ?? 0) > 100)).toBe(true);
    const fills = l.paths.filter((p) => p.role === "fill");
    expect(fills.map((p) => [p.series, p.gradient])).toEqual([[0, { from: 0.22, to: 0 }]]);
    expect(l.guides.map((g) => g.value)).toEqual([10000, 15000, 20000]);
    expect(l.guides.every((g) => g.style === "dotted")).toBe(true);
    expect(texts(l, "guide").map((t) => [t.text, t.anchor])).toEqual([
      ["10k €", "start"],
      ["20k €", "start"],
    ]);
    expect(texts(l, "x").map((t) => t.text)).toEqual(["gennaio", "luglio", "dicembre"]);
    // The end dot, plus one marker per inside label (docs/feat/mobile-chart-labels.md D2).
    expect(l.dots).toHaveLength(3);
    expect(l.dots[0]).toMatchObject({ series: 0, r: 3.75, halo: { r: 7.5, opacity: 0.18 } });
    expect(
      l.dots
        .filter((d) => d.ring !== undefined && d.r === 3.2)
        .map((d) => d.series)
        .sort(),
    ).toEqual([0, 1]);
    expect(
      texts(l, "direct")
        .map((t) => t.text)
        .sort(),
    ).toEqual(["2025", "2026"]);
    expect(l.legend).toBeNull();
  });

  test("area (B): palette strokes, a baseline hairline, solid guides labelled at the start, valued end labels", () => {
    const l = must(chartLayout(AREA, { width: W, locale: "it" }));
    expect(l.kind).toBe("area");
    expect(l.paths.filter((p) => p.role === "line").map((p) => p.paint)).toEqual([
      { series: 1 },
      { series: 0 },
    ]);
    expect(l.paths.some((p) => p.role === "baseline")).toBe(true);
    expect(l.paths.find((p) => p.role === "fill")?.gradient).toEqual({ from: 0.16, to: 0 });
    expect(l.guides.every((g) => g.style === "solid")).toBe(true);
    expect(texts(l, "guide").every((t) => t.anchor === "start" && t.x === 0)).toBe(true);
    expect(
      texts(l, "direct")
        .map((t) => t.text)
        .sort(),
    ).toEqual(["app", "web"]);
    expect(l.dots[0]?.hollow).toBe(true);
  });

  test("bars (B, ≤ 12 categories): rows with a track, 9 pt bars, the max highlighted, the rest at 38 %", () => {
    const l = must(chartLayout(BARS, { width: W, locale: "it" }));
    expect(l.kind).toBe("bars");
    expect(l.paths.filter((p) => p.role === "track")).toHaveLength(4);
    const bars = l.paths.filter((p) => p.role === "bar");
    expect(bars.map((p) => [p.index, p.opacity, p.highlight])).toEqual([
      [0, 0.38, false],
      [1, 1, true],
      [2, 0.38, false],
      [3, 0.38, false],
    ]);
    expect(bars.every((p) => p.box?.h === 9)).toBe(true);
    expect(texts(l, "value").map((t) => t.text)).toEqual(["12,5 s", "48,2 s", "30 s", "7 s"]);
    expect(l.height).toBe(4 * 23);
  });

  test("bars with > 12 categories become columns (orientation choice)", () => {
    const labels = Array.from({ length: 30 }, (_, i) => `d${i + 1}`);
    const l = must(
      chartLayout(
        { ...BARS, labels, datasets: [{ label: "s", data: labels.map((_, i) => i + 1) }] },
        { width: W },
      ),
    );
    expect(l.kind).toBe("columns");
    expect(l.paths.filter((p) => p.role === "bar")).toHaveLength(30);
  });

  test("donut (B): a thin ring of rounded sectors, a mini-table, the total centred", () => {
    const l = must(chartLayout(PIE, { width: W, locale: "it" }));
    expect(l.kind).toBe("donut");
    const sectors = l.paths.filter((p) => p.role === "sector");
    expect(sectors.map((p) => p.series)).toEqual([0, 1, 2]);
    expect(sectors.every((p) => p.arc?.ri === 47 && p.arc.ro === 60)).toBe(true);
    expect(texts(l, "center").map((t) => t.text)).toEqual(["44,70"]);
    expect(texts(l, "centerSub").map((t) => t.text)).toEqual(["€ TOTALE"]);
    expect(texts(l, "percent").map((t) => t.text)).toEqual(["70%", "28%", "2%"]);
    expect(texts(l, "value").map((t) => t.text)).toEqual(["31,20 €", "12,40 €", "1,10 €"]);
  });

  test("donut: more than 7 slices fold the smallest into Altro", () => {
    const labels = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const l = must(
      chartLayout(
        { ...PIE, labels, datasets: [{ label: "€", data: [9, 8, 7, 6, 5, 4, 3, 2, 1] }] },
        { width: W, locale: "it" },
      ),
    );
    expect(texts(l, "name").map((t) => t.text)).toEqual(["a", "b", "c", "d", "e", "f", "Altro"]);
  });

  test("scatter (A): ringed dots, a dashed trend line when the fit holds, labels at each series' rightmost point", () => {
    const l = must(chartLayout(SCATTER, { width: W, locale: "it" }));
    expect(l.kind).toBe("scatter");
    expect(l.dots).toHaveLength(13);
    expect(l.dots.every((d) => d.r === 4.5 && d.ring === 1.5)).toBe(true);
    expect(l.paths.filter((p) => p.role === "trend").map((p) => p.dash)).toEqual(["4 4"]);
    expect(texts(l, "direct").map((t) => t.text)).toEqual(["bugfix", "feature"]);
    expect(texts(l, "x").map((t) => t.text)).toEqual(["0", "1.000 righe"]);
  });
});

describe("T5.2 hit", () => {
  const l = must(chartLayout({ ...REVENUE, datasets: [REVENUE.datasets[1]] }, { width: W }));
  const X = (i: number): number => 2 + (i * (l.plot.right - 4)) / 11;
  test("returns the nearest index", () => {
    expect(l.hit(X(5))).toBe(5);
    expect(l.hit(X(5) + 3)).toBe(5);
    expect(l.hit((X(5) + X(6)) / 2 + 0.5)).toBe(6);
    expect(l.hit((X(5) + X(6)) / 2 - 0.5)).toBe(5);
  });
  test("clamps at the edges", () => {
    expect(l.hit(-500)).toBe(0);
    expect(l.hit(5000)).toBe(11);
  });
  test("charts that do not scrub answer null", () => {
    expect(must(chartLayout(BARS, { width: W })).hit(100)).toBeNull();
    expect(must(chartLayout(PIE, { width: W })).hit(100)).toBeNull();
  });
});

describe("T5.3 label thinning never overlaps (fontScale 1 and 2.35)", () => {
  const labels = Array.from(
    { length: 40 },
    (_, i) => `categoria ${String(i + 1).padStart(2, "0")}`,
  );
  for (const fontScale of [1, 2.35]) {
    test(`columns, 40 long labels, fontScale ${fontScale}`, () => {
      const l = must(
        chartLayout(
          { ...BARS, labels, datasets: [{ label: "s", data: labels.map((_, i) => (i * 7) % 13) }] },
          { width: W, fontScale },
        ),
      );
      const xs = texts(l, "x");
      // At AX5 one 12-character label is ~190 pt: only the last (orienting) one fits.
      expect(xs.length).toBeGreaterThanOrEqual(fontScale === 1 ? 2 : 1);
      expect(xs[xs.length - 1]?.text).toBe("categoria 40");
      expect(noOverlap(xs)).toBe(true);
      for (const t of xs) {
        const b = textBox(t, monoWidth);
        expect(b.x).toBeGreaterThanOrEqual(-1e-9);
        expect(b.x + b.w).toBeLessThanOrEqual(W + 1e-9);
      }
    });
    test(`line, CJK labels, fontScale ${fontScale}`, () => {
      const cjk = ["一月一月一月", "二月二月二月", "三月三月三月", "四月四月四月", "五月五月五月"];
      const l = must(
        chartLayout(
          {
            type: "line",
            title: "x",
            labels: cjk,
            datasets: [{ label: "s", data: [1, 2, 3, 2, 4] }],
          },
          { width: 200, fontScale },
        ),
      );
      expect(noOverlap(texts(l, "x"))).toBe(true);
      expect(noOverlap(l.texts)).toBe(true);
    });
  }
});

describe("T5.4 hiding a series", () => {
  const three = {
    type: "line",
    title: "x",
    labels: ["a", "b", "c", "d"],
    datasets: [
      { label: "s0", data: [10, 12, 11, 13] },
      { label: "s1", data: [100, 120, 110, 130] },
      { label: "s2", data: [20, 22, 21, 23] },
    ],
  };
  test("keeps the others' colours and recomputes the guides on the visible series", () => {
    const all = must(chartLayout(three, { width: W }));
    const some = must(chartLayout(three, { width: W, hidden: new Set([1]) }));
    expect(some.paths.filter((p) => p.role === "line").map((p) => [p.series, p.paint])).toEqual([
      [2, { series: 2 }],
      [0, { series: 0 }],
    ]);
    expect(Math.max(...all.guides.map((g) => g.value))).toBeGreaterThanOrEqual(100);
    expect(Math.max(...some.guides.map((g) => g.value))).toBeLessThan(30);
  });
});

describe("T5.5 forged specs → null", () => {
  test("strings for numbers, unknown type, broken JSON, empty data, zero width", () => {
    expect(
      chartLayout(
        { type: "line", title: "x", labels: ["a"], datasets: [{ label: "s", data: ["12.5"] }] },
        { width: W },
      ),
    ).toBeNull();
    expect(
      chartLayout(
        { type: "radar", title: "x", labels: ["a"], datasets: [{ label: "s", data: [1] }] },
        { width: W },
      ),
    ).toBeNull();
    expect(chartLayout('{"type":"line",', { width: W })).toBeNull();
    expect(
      chartLayout({ type: "line", title: "x", labels: [], datasets: [] }, { width: W }),
    ).toBeNull();
    expect(chartLayout(42, { width: W })).toBeNull();
    expect(chartLayout(REVENUE, { width: 0 })).toBeNull();
    expect(chartLayout(REVENUE, { width: Number.NaN })).toBeNull();
  });
  test("the tool call's raw JSON text is accepted like the object", () => {
    expect(chartSpecOf(JSON.stringify(BARS))?.title).toBe("Build");
    expect(must(chartLayout(JSON.stringify(BARS), { width: W })).kind).toBe("bars");
  });
});

describe("T5.7 summary (it/en)", () => {
  test("the VoiceOver sentence carries the title and each series' numbers in the reader's locale", () => {
    const it = must(chartLayout(REVENUE, { width: W, locale: "it" })).summary;
    const en = must(chartLayout(REVENUE, { width: W, locale: "en" })).summary;
    expect(it.startsWith("Ricavi. 2026: ")).toBe(true);
    expect(it).toContain("20,8k €");
    expect(en).toContain("€20.8k");
    expect(it).toContain("2025: ");
  });
  test("the table has one row per label, numbers in full", () => {
    const t = must(chartLayout(REVENUE, { width: W, locale: "it" })).table;
    expect(t.header).toEqual(["", "2026", "2025"]);
    expect(t.rows).toHaveLength(12);
    expect(t.rows[9]).toEqual(["ottobre", "20.800 €", "16.400 €"]);
    expect(t.rows[11]).toEqual(["dicembre", "—", "18.900 €"]);
  });
});

describe("T5.9 guide labels", () => {
  test("labels only on the top and bottom guide", () => {
    for (const raw of [REVENUE, AREA, SCATTER]) {
      const l = must(chartLayout(raw, { width: W, locale: "it" }));
      const ys = texts(l, "guide").map((t) => t.y + 5);
      const ends = [l.guides[0]?.y, l.guides[l.guides.length - 1]?.y];
      for (const y of ys) expect(ends).toContain(y);
    }
  });
  test("a guide label that collides with a direct label is dropped (the label wins)", () => {
    const ctx: Ctx = {
      width: W,
      height: 176,
      fs: 1,
      locale: "it",
      hidden: new Set(),
      measure: monoWidth,
      labels: "inside",
    };
    const y = (v: number): number => 150 - v;
    const spec = chartSpecOf(REVENUE);
    if (!spec) throw new Error("spec");
    const free = guideItems(
      spec,
      ctx,
      { lo: 0, hi: 100, x1: 0, x2: 300, style: "dotted" },
      y,
      "end",
      [],
    );
    expect(free.texts).toHaveLength(2);
    const top = free.texts[1] as LayoutText;
    const blocker: LayoutText = {
      x: top.x - 10,
      y: top.y,
      text: "2026",
      anchor: "end",
      size: 12,
      role: "direct",
    };
    const hit = guideItems(
      spec,
      ctx,
      { lo: 0, hi: 100, x1: 0, x2: 300, style: "dotted" },
      y,
      "end",
      [blocker],
    );
    expect(hit.texts.map((t) => t.text)).toEqual([free.texts[0]?.text ?? ""]);
  });
});

describe("T5.11 direct labels", () => {
  const close = {
    type: "line",
    title: "x",
    labels: ["a", "b", "c", "d"],
    datasets: [
      { label: "alfa", data: [10, 11, 12, 20.0] },
      { label: "beta", data: [10, 11, 12, 20.1] },
      { label: "gamma", data: [10, 11, 12, 19.9] },
      { label: "delta", data: [10, 11, 12, 5] },
    ],
  };
  test("never overlap, keep the end values' order, stay inside the plot", () => {
    const l = must(chartLayout(close, { width: W }));
    const direct = texts(l, "direct");
    expect(direct).toHaveLength(4);
    expect(noOverlap(direct)).toBe(true);
    const byY = [...direct].sort((a, b) => a.y - b.y).map((t) => t.text);
    expect(byY).toEqual(["beta", "alfa", "gamma", "delta"]);
    for (const t of direct) {
      const b = textBox(t, monoWidth);
      expect(b.y).toBeGreaterThanOrEqual(l.plot.top - 1e-9);
      expect(t.y).toBeLessThanOrEqual(l.plot.bottom + 1e-9);
    }
  });
  test("at fontScale 2.35 the overflow returns the legend fallback", () => {
    const many = {
      ...close,
      datasets: Array.from({ length: 7 }, (_, k) => ({
        label: `serie ${k}`,
        data: [1, 2, 3, 4 + k],
      })),
    };
    const l = must(chartLayout(many, { width: W, fontScale: 2.35 }));
    expect(texts(l, "direct")).toHaveLength(0);
    expect(l.legend?.map((i) => i.series)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(must(chartLayout(many, { width: W, fontScale: 1 })).legend).toBeNull();
  });
});

describe("T5.14 scrub binding", () => {
  const l = must(chartLayout(REVENUE, { width: W, locale: "it" }));
  test("scrubAt(i): x = X(i), one dot per non-null series, the hero at i", () => {
    const X = (i: number): number => 2 + (i * (l.plot.right - 4)) / 11;
    const at7 = l.scrubAt(7);
    expect(at7?.x).toBeCloseTo(X(7), 9);
    expect(at7?.dots.map((d) => d.series)).toEqual([0, 1]);
    expect(at7?.dimFromX).toBe(at7?.x ?? -1);
    expect(at7?.hero).toEqual(heroOf(REVENUE, 7, "it"));
    expect(l.scrubAt(11)?.dots.map((d) => d.series)).toEqual([1]); // 2026 is null in December
    expect(l.hit(at7?.x ?? -1)).toBe(7);
  });
  test("release returns to the last value", () => {
    expect(l.hero).toEqual(heroOf(REVENUE, undefined, "it"));
    expect(l.hero.num).toBe("20.800");
  });
});

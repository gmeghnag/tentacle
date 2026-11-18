/**
 * T3 — the TUI chart renderer (docs/feat/model-charts.md *Tests*, slice C3).
 * Frames are pinned as snapshots (colour off and on); the properties below are
 * what the frames must keep at every width.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CHART_PALETTE, type ChartSpec, contrastRatio, validateChartSpec } from "@tentacle/core";
import chalk from "chalk";
import { cellWidth } from "../src/cells.ts";
import {
  type ChartLineOptions,
  QUAD_GLYPHS,
  type RasterSeries,
  chartLines,
  plotPoints,
  rasterize,
  splitCells,
} from "../src/chart-lines.ts";
import { stripAnsi } from "../src/render-lines.ts";
import { tokens } from "../src/theme.ts";
import { FIXTURES } from "./chart-fixtures.ts";

function spec(raw: unknown): ChartSpec {
  const v = validateChartSpec(raw);
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
  return v.spec;
}

const BASE = { color: false, locale: "it", zone: "UTC", mode: "dark" } as const;
const plain = (s: ChartSpec, o: Partial<ChartLineOptions> & { width: number }): string[] =>
  chartLines(s, { ...BASE, ...o }).map(stripAnsi);

const fixture = (name: string): ChartSpec => spec(FIXTURES[name]);
const NAMES = Object.keys(FIXTURES);
const isBraille = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x2800 && cp <= 0x28ff;
};
const SPARK = new Set(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]);

let level: typeof chalk.level;
beforeAll(() => {
  level = chalk.level;
});
afterAll(() => {
  chalk.level = level;
});

describe("T3 frames (snapshots)", () => {
  const cases: [string, number, boolean][] = [
    ["line", 120, false],
    ["line", 80, false],
    ["line", 120, true],
    ["line", 80, true],
    ["latency", 80, false],
    ["hbar", 80, false],
    ["vbar", 80, false],
    ["stacked", 80, false],
    ["pie", 80, false],
    ["scatter", 80, false],
  ];
  for (const [name, width, expanded] of cases) {
    test(`${name} ${width}${expanded ? " expanded" : ""} — colour off`, () => {
      expect(plain(fixture(name), { width, expanded }).join("\n")).toMatchSnapshot();
    });
    test(`${name} ${width}${expanded ? " expanded" : ""} — colour on`, () => {
      chalk.level = 3;
      const lines = chartLines(fixture(name), { ...BASE, color: true, width, expanded });
      chalk.level = level;
      expect(lines.join("\n")).toMatchSnapshot();
    });
  }
});

describe("T3.1 no line wider than the width", () => {
  test("every fixture, widths 20..200, compact/expanded, braille/blocks, colour on/off", () => {
    const failures: string[] = [];
    chalk.level = 3;
    for (const name of NAMES) {
      const s = fixture(name);
      for (let width = 20; width <= 200; width += 3) {
        for (const expanded of [false, true]) {
          for (const glyphs of ["braille", "blocks"] as const) {
            for (const color of [false, true]) {
              const lines = chartLines(s, { ...BASE, width, expanded, glyphs, color });
              for (const line of lines) {
                const w = cellWidth(stripAnsi(line));
                if (w > width) failures.push(`${name}@${width} ${glyphs} ${color}: ${w}`);
              }
            }
          }
        }
      }
    }
    chalk.level = level;
    expect(failures).toEqual([]);
  }, 60_000); // ~7 s alone, more under a loaded gate: bun's 5 s default timed it out (17/11)

  test("a narrow table drops whole columns, never cuts a number", () => {
    const lines = plain(fixture("stacked"), { width: 18 });
    expect(lines.join("\n")).not.toMatch(/\d…/);
    expect(lines[lines.length - 1]).toBe("… +2 more columns");
    expect(lines).toContain("lun  412.000");
    expect(plain(fixture("stacked"), { width: 24 }).at(-1)).toBe("… +1 more column");
  });

  test("a chart narrower than the width is centred (cap 120)", () => {
    const lines = plain(fixture("hbar"), { width: 200 });
    for (const line of lines) expect(line.startsWith(" ".repeat(40))).toBe(true);
    expect(lines.some((l) => l.slice(40).startsWith("daemon"))).toBe(true);
  });
});

// ── T3.2 braille dots lie on the Bresenham path ─────────────────────────────

/** The dots a rendered cell holds, decoded back from its glyph. */
function dotsOf(cells: string[][], glyphs: "braille" | "blocks"): Set<string> {
  const BR = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ];
  const out = new Set<string>();
  cells.forEach((row, r) => {
    row.forEach((ch, c) => {
      if (ch === " ") return;
      if (glyphs === "braille") {
        const bits = (ch.codePointAt(0) ?? 0x2800) - 0x2800;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 2; x++) {
            if (bits & (BR[y]?.[x] ?? 0)) out.add(`${c * 2 + x},${r * 4 + y}`);
          }
        }
      } else {
        const bits = QUAD_GLYPHS.indexOf(ch);
        for (let q = 0; q < 4; q++) {
          if (bits & (1 << q)) out.add(`${c * 2 + (q % 2)},${r * 2 + Math.floor(q / 2)}`);
        }
      }
    });
  });
  return out;
}

/** An independent Bresenham, endpoints inclusive. */
function bresenham(a: [number, number], b: [number, number]): string[] {
  const out: string[] = [];
  let [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push(`${x0},${y0}`);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

describe("T3.2 every dot lies on its series' Bresenham path", () => {
  for (const glyphs of ["braille", "blocks"] as const) {
    test(glyphs, () => {
      const cols = 20;
      const rows = 4;
      const W = cols * 2;
      const H = rows * (glyphs === "braille" ? 4 : 2);
      // Pixel vertices; x = px/(W-1) and y = (H-1) - py with lo 0, hi H-1 map exactly.
      const vertices: [number, number][] = [
        [0, H - 1],
        [7, 2],
        [16, 9 % H],
        [25, 0],
        [39, H - 3],
      ];
      const series: RasterSeries = {
        index: 0,
        points: vertices.map(([x, y]) => ({ x: x / (W - 1), y: H - 1 - y })),
      };
      const raster = rasterize([series], { cols, rows, glyphs, lo: 0, hi: H - 1 });
      const expected = new Set<string>();
      for (let i = 1; i < vertices.length; i++) {
        for (const d of bresenham(
          vertices[i - 1] as [number, number],
          vertices[i] as [number, number],
        )) {
          expected.add(d);
        }
      }
      expect([...dotsOf(raster.cells, glyphs)].sort()).toEqual([...expected].sort());
    });
  }

  test("a lone point is a 2×2 mark; a null breaks the line", () => {
    const raster = rasterize(
      [
        {
          index: 0,
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: null },
            { x: 1, y: 3 },
          ],
        },
      ],
      { cols: 4, rows: 1, glyphs: "braille", lo: 0, hi: 3 },
    );
    // Two isolated points (the null between them), 4 dots each.
    expect(dotsOf(raster.cells, "braille").size).toBe(8);
  });
});

// ── T3.3 x labels ────────────────────────────────────────────────────────────

describe("T3.3 x labels never overlap", () => {
  const xLabelRow = (lines: string[]): string => {
    const axis = lines.findIndex((l) => l.includes("└"));
    return lines[axis + 1] ?? "";
  };
  test("months at every width ≥ 60: known labels, in order, separated", () => {
    const months = [
      "gen",
      "feb",
      "mar",
      "apr",
      "mag",
      "giu",
      "lug",
      "ago",
      "set",
      "ott",
      "nov",
      "dic",
    ];
    for (let width = 60; width <= 200; width += 7) {
      const tokens = xLabelRow(plain(fixture("line"), { width }))
        .trim()
        .split(/\s+/);
      const at = tokens.map((t) => months.indexOf(t));
      expect({ width, unknown: at.filter((i) => i < 0).length }).toEqual({ width, unknown: 0 });
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(new Set(at).size).toBe(at.length);
      expect(at[0]).toBe(0);
      expect(at[at.length - 1]).toBe(11);
    }
  });
  test("52 labels that cannot all fit: thinned, never merged, first and last kept", () => {
    const labels = Array.from({ length: 52 }, (_, i) => `w${String(i + 1).padStart(2, "0")}`);
    const s = spec({
      type: "line",
      title: "t",
      labels,
      datasets: [{ label: "x", data: labels.map((_, i) => i % 7) }],
    });
    for (let width = 60; width <= 200; width += 5) {
      const row = xLabelRow(plain(s, { width }));
      const tokens = row.trim().split(/\s+/);
      const at = tokens.map((t) => labels.indexOf(t));
      expect({ width, unknown: at.filter((i) => i < 0) }).toEqual({ width, unknown: [] });
      expect(at).toEqual([...new Set(at)].sort((a, b) => a - b));
      expect(at[0]).toBe(0);
      expect(at[at.length - 1]).toBe(51);
      expect(cellWidth(row)).toBeLessThanOrEqual(width);
    }
  });
  test("numeric x of a scatter: increasing ticks, separated", () => {
    for (let width = 40; width <= 200; width += 9) {
      const tokens = xLabelRow(plain(fixture("scatter"), { width }))
        .trim()
        .split(/\s+/);
      // `it` groups thousands with "." (`1.000`).
      const values = tokens.map((t) => Number(t.replaceAll(".", "")));
      expect(values.every(Number.isFinite)).toBe(true);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    }
  });
});

// ── T3.4 bars ────────────────────────────────────────────────────────────────

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
function barUnits(line: string): number {
  const full = [...line].filter((ch) => ch === "█").length;
  const part = [...line].map((ch) => EIGHTHS.indexOf(ch)).find((i) => i > 0) ?? 0;
  return full * 8 + part;
}

describe("T3.4 bar lengths in ⅛ cells = round(v / max · cells · 8)", () => {
  test("hbar fixture, widths 40..120", () => {
    const data = [38.5, 26.8, 21.7, 17.3, 14.6, 12.9, 9.4, 6.1, 4.2, 1.8];
    for (let width = 40; width <= 120; width += 5) {
      // The bar rows (the caption wraps to two lines below 46 cols).
      const rows = plain(fixture("hbar"), { width }).filter((l) => /\d s$/.test(l));
      expect(rows.length).toBe(data.length);
      const cells = barUnits(rows[0] as string) / 8;
      expect(Number.isInteger(cells)).toBe(true);
      rows.forEach((row, i) => {
        expect(barUnits(row)).toBe(Math.round(((data[i] as number) / 38.5) * cells * 8));
      });
    }
  });

  test("negative bars grow left from a shared 0 column", () => {
    const s = spec({
      type: "bar",
      title: "Saldo",
      labels: ["a", "b", "c", "d", "e", "f", "g"],
      datasets: [{ label: "x", data: [-5, 10, -2.5, 4, 0, 1, 2] }],
    });
    const rows = plain(s, { width: 60 }).slice(1);
    const zeroOf = (row: string, negative: boolean): number =>
      negative
        ? cellWidth(row.slice(0, row.lastIndexOf("█") + 1))
        : cellWidth(row.slice(0, row.indexOf("█")));
    const zero = zeroOf(rows[1] as string, false);
    expect(zeroOf(rows[0] as string, true)).toBe(zero);
    expect(zeroOf(rows[3] as string, false)).toBe(zero);
    expect((rows[0] as string).indexOf("█")).toBeLessThan((rows[1] as string).indexOf("█"));
  });

  test("stacked rows: segments sum to round(total/max · cells) — largest remainder", () => {
    expect(splitCells([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(splitCells([0, 0], 5)).toEqual([0, 0]);
    for (let cells = 0; cells < 40; cells++) {
      const split = splitCells([412, 220, 150], cells);
      expect(split.reduce((a, b) => a + b, 0)).toBe(cells);
    }
    const rows = plain(fixture("stacked"), { width: 80 }).slice(2);
    const lengths = rows.map((r) => [...r].filter((ch) => "█▓▒░".includes(ch)).length);
    const totals = [782, 818, 855, 951, 946, 410, 348];
    const max = lengths[3] as number;
    lengths.forEach((n, i) => expect(n).toBe(Math.round(((totals[i] as number) / 951) * max)));
  });

  test("pie: one 100 % row, > 7 slices fold into 6 + Other", () => {
    const labels = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const s = spec({
      type: "pie",
      title: "Quote",
      labels,
      datasets: [{ label: "n", data: [9, 8, 7, 6, 5, 4, 3, 2, 1] }],
    });
    const lines = plain(s, { width: 60 });
    expect([...(lines[1] as string)].length).toBe(60);
    const legend = lines.slice(2, -1);
    expect(legend.length).toBe(7);
    expect(legend[6]).toContain("Other");
    expect(legend[6]).toContain("6");
  });
});

// ── T3.5 / T3.6 ──────────────────────────────────────────────────────────────

const plotCells = (lines: string[]): string[] =>
  lines.flatMap((l) => {
    const at = Math.max(l.indexOf("┤"), l.indexOf("│"));
    return at < 0 ? [] : [l.slice(at + 1)];
  });

describe("T3.5 one point / equal values", () => {
  test("a single point is a visible 2×2 mark", () => {
    const s = spec({
      type: "line",
      title: "t",
      labels: ["a"],
      datasets: [{ label: "x", data: [5] }],
    });
    const dots = plotCells(plain(s, { width: 80 }))
      .join("")
      .split("")
      .filter(isBraille)
      .reduce(
        (n, ch) => n + ((ch.codePointAt(0) ?? 0x2800) - 0x2800).toString(2).split("1").length - 1,
        0,
      );
    expect(dots).toBe(4);
  });
  test("equal values draw one flat line in one row", () => {
    const s = spec({
      type: "line",
      title: "t",
      labels: ["a", "b", "c", "d"],
      datasets: [{ label: "x", data: [3, 3, 3, 3] }],
    });
    const rows = plotCells(plain(s, { width: 80 })).filter((r) => [...r].some(isBraille));
    expect(rows.length).toBe(1);
  });
  test("one bar is drawn", () => {
    const s = spec({
      type: "bar",
      title: "t",
      labels: ["a"],
      datasets: [{ label: "x", data: [3] }],
    });
    expect(plain(s, { width: 80 }).some((l) => l.includes("█"))).toBe(true);
  });
});

describe("T3.6 1000 points on 80 cols", () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i === 613 ? 100 : 10 + Math.sin(i / 40)));
  const positions = values.map((_, i) => i / 999);
  test("≤ 2 kept points per dot column, the spike kept", () => {
    const pixels = 146;
    const kept = plotPoints(values, positions, pixels);
    const perColumn = new Map<number, number>();
    for (const p of kept) {
      const col = Math.round(p.x * (pixels - 1));
      perColumn.set(col, (perColumn.get(col) ?? 0) + 1);
    }
    expect(Math.max(...perColumn.values())).toBeLessThanOrEqual(2);
    expect(kept.some((p) => p.y === 100)).toBe(true);
  });
  test("the spike reaches the plot's top rows", () => {
    const s = spec({
      type: "line",
      title: "t",
      labels: values.map((_, i) => `p${i}`),
      datasets: [{ label: "x", data: values }],
    });
    const rows = plotCells(plain(s, { width: 80 }));
    expect([...(rows[1] ?? "")].some(isBraille) || [...(rows[0] ?? "")].some(isBraille)).toBe(true);
  });
});

// ── T3.7 CJK ────────────────────────────────────────────────────────────────

describe("T3.7 CJK labels are measured at width 2", () => {
  test("bars start on one column; a long label is cut with …", () => {
    const s = spec({
      type: "bar",
      title: "都市",
      labels: ["東京都", "大阪", "名古屋市中央区役所前の通り", "札幌", "福岡", "神戸", "京都"],
      datasets: [{ label: "x", data: [9, 7, 5, 4, 3, 2, 1] }],
    });
    for (const width of [40, 60, 80]) {
      const rows = plain(s, { width }).slice(1);
      const starts = rows.map((r) => cellWidth(r.slice(0, r.indexOf("█"))));
      expect(new Set(starts).size).toBe(1);
      expect(rows.some((r) => r.includes("…"))).toBe(true);
      for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(width);
    }
  });
});

// ── T3.8 width tiers ─────────────────────────────────────────────────────────

describe("T3.8 width tiers ≥ 60 / 40–59 / < 40", () => {
  const has = (lines: string[], pred: (ch: string) => boolean): boolean =>
    lines.slice(1).some((l) => [...l].some(pred));
  test("line", () => {
    expect(has(plain(fixture("line"), { width: 60 }), isBraille)).toBe(true);
    for (const width of [59, 40]) {
      const lines = plain(fixture("line"), { width });
      expect(has(lines, isBraille)).toBe(false);
      expect(has(lines, (ch) => SPARK.has(ch))).toBe(true);
      expect(lines.length).toBe(3);
    }
    const table = plain(fixture("line"), { width: 39 });
    expect(has(table, isBraille) || has(table, (ch) => SPARK.has(ch))).toBe(false);
    expect(table.join("\n")).toContain("12.500 €");
  });
  test("scatter plots from 40, bars are bars from 40; everything is a table below", () => {
    expect(has(plain(fixture("scatter"), { width: 40 }), isBraille)).toBe(true);
    expect(has(plain(fixture("hbar"), { width: 40 }), (ch) => ch === "█")).toBe(true);
    for (const name of NAMES) {
      const lines = plain(fixture(name), { width: 39 });
      expect({ name, glyphs: has(lines, (ch) => isBraille(ch) || SPARK.has(ch)) }).toEqual({
        name,
        glyphs: false,
      });
    }
  });
});

// ── T3.9 / T3.10 / T3.11 ─────────────────────────────────────────────────────

describe("T3.9 blocks uses only quadrant glyphs", () => {
  test("no braille anywhere; plot cells are QUAD glyphs", () => {
    for (const name of ["line", "latency", "scatter"]) {
      const lines = plain(fixture(name), { width: 80, glyphs: "blocks" });
      expect(lines.some((l) => [...l].some(isBraille))).toBe(false);
      for (const row of plotCells(lines)) {
        for (const ch of row) expect(QUAD_GLYPHS.includes(ch)).toBe(true);
      }
    }
  });
});

describe("T3.10 colour level 0", () => {
  test("series 2 is dotted (every 3rd dot dropped) and its legend is ┅┅", () => {
    const lines = plain(fixture("line"), { width: 80 });
    expect(lines[1]).toBe("━━ 2026   ┅┅ 2025");
    const points = Array.from({ length: 31 }, (_, i) => ({ x: i / 30, y: 0 }));
    const frame = { cols: 31, rows: 1, glyphs: "braille", lo: 0, hi: 1 } as const;
    const solid = dotsOf(rasterize([{ index: 0, points }], frame).cells, "braille").size;
    const dotted = dotsOf(
      rasterize([{ index: 1, points, dotted: true }], frame).cells,
      "braille",
    ).size;
    expect(dotted).toBe(solid - Math.floor(solid / 3));
  });
  test("defaults to chalk.level: 0 → no SGR, dotted legend", () => {
    chalk.level = 0;
    const lines = chartLines(fixture("line"), { width: 80, locale: "it", mode: "dark" });
    chalk.level = level;
    expect(lines.join("")).not.toContain("\u001b[");
    expect(lines[1]).toContain("┅┅ 2025");
  });
  test("bars and stacks tell series apart with fills", () => {
    expect(plain(fixture("stacked"), { width: 80 })[1]).toBe(
      "██ Opus   ▓▓ DeepSeek   ▒▒ Qwen locale",
    );
  });
});

describe("T3.11 no glyph has the Emoji property", () => {
  test("every fixture, both glyph sets, compact and expanded", () => {
    const bad = new Set<string>();
    for (const name of NAMES) {
      for (const glyphs of ["braille", "blocks"] as const) {
        for (const expanded of [false, true]) {
          for (const width of [30, 50, 80, 120]) {
            for (const line of plain(fixture(name), { width, glyphs, expanded })) {
              for (const ch of line)
                if (ch.charCodeAt(0) > 0x7f && /\p{Emoji}/u.test(ch)) bad.add(ch);
            }
          }
        }
      }
    }
    expect([...bad]).toEqual([]);
  });
});

// ── colour and tokens ────────────────────────────────────────────────────────

const sgr = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

describe("colour", () => {
  test("series wear their palette slot per mode; names wear subtle", () => {
    chalk.level = 3;
    const dark = chartLines(fixture("line"), {
      ...BASE,
      color: true,
      width: 80,
      mode: "dark",
    }).join("\n");
    const light = chartLines(fixture("line"), {
      ...BASE,
      color: true,
      width: 80,
      mode: "light",
    }).join("\n");
    chalk.level = level;
    expect(dark).toContain(sgr(CHART_PALETTE.dark[0] as string));
    expect(dark).toContain(sgr(CHART_PALETTE.dark[1] as string));
    expect(light).toContain(sgr(CHART_PALETTE.light[0] as string));
    expect(dark).not.toContain(sgr(CHART_PALETTE.light[0] as string));
    expect(dark).toContain(`${sgr(tokens.dark.subtle)} 2026`);
  });

  test("tokens.chart.series is the shared palette in both modes", () => {
    expect(tokens.dark.chart.series).toEqual(CHART_PALETTE.dark);
    expect(tokens.light.chart.series).toEqual(CHART_PALETTE.light);
  });

  test("glyph contrast ≥ 3:1 — dark on #1e1e1e, light on white except the named relief slots", () => {
    // Relief (Palette validation): yellow and magenta on white — legend + table carry them.
    const RELIEF_LIGHT = [3, 4];
    const low = (slots: readonly string[], bg: string, except: number[]): number[] =>
      slots.flatMap((hex, i) => (contrastRatio(hex, bg) < 3 && !except.includes(i) ? [i] : []));
    expect(low(tokens.dark.chart.series, "#1e1e1e", [])).toEqual([]);
    expect(low(tokens.light.chart.series, "#ffffff", RELIEF_LIGHT)).toEqual([]);
    expect(low(tokens.light.chart.series, "#ffffff", []).sort()).toEqual(RELIEF_LIGHT);
  });
});

describe("expanded form", () => {
  test("16 plot rows, one stat row per series, the table capped at 50", () => {
    const labels = Array.from({ length: 60 }, (_, i) => `d${i}`);
    const s = spec({
      type: "line",
      title: "t",
      labels,
      datasets: [{ label: "x", data: labels.map((_, i) => i * 2) }],
    });
    const lines = plain(s, { width: 80, expanded: true });
    expect(
      plotCells(
        lines.slice(
          0,
          lines.findIndex((l) => l.includes("└")),
        ),
      ).length,
    ).toBe(16);
    expect(lines[1]).toContain("min 0 · max 118 · last 118");
    expect(lines[lines.length - 1]).toBe("… +10 more rows");
  });
  test("instants name the zone they are drawn in", () => {
    const lines = plain(fixture("latency"), { width: 80, zone: "Europe/Rome" });
    expect(lines.join("\n")).toContain("times in Europe/Rome");
    expect(plain(fixture("latency"), { width: 80 }).join("\n")).not.toContain("times in");
  });
});

/**
 * The gallery's chart thumbnail (docs/feat/mobile-gallery-polish.md): every
 * chart kind draws INSIDE its tile, with no legend, and only when legible.
 *
 * The bug (owner, 2026-11-20): the tile was the transcript layout at 40×32 — a
 * donut's fixed 60 pt ring and its legend chips, a bar chart's natural 128 pt
 * height, an inverted 32 pt plot — drawn unclipped, so bars and legend chips
 * spilled down the list. The property pinned here is the one that kills it:
 * every coordinate a tile draws lies inside the view box it scales into its box.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import type { LayoutPath } from "../src/chart-layout-kit.ts";
import {
  type ChartThumbGeometry,
  MIN_DOT,
  MIN_MARK,
  MIN_STROKE,
  SCATTER_ASPECT,
  type ViewBox,
  chartThumbAt,
  chartThumbGeometry,
  thumbScale,
  viewBoxAttr,
} from "../src/chart-thumb.ts";
import { darkPalette, lightPalette } from "../src/theme.ts";

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu"];

/** The owner's screenshot, as fixtures: the six kinds the e2e flow 35 draws too. */
const SPECS: Readonly<Record<string, unknown>> = {
  scatter: {
    type: "scatter",
    title: "Peso vs altezza",
    datasets: [
      {
        label: "A",
        data: [
          { x: 160, y: 55 },
          { x: 170, y: 68 },
          { x: 180, y: 80 },
          { x: 175, y: 72 },
          { x: 165, y: 60 },
        ],
      },
      {
        label: "B",
        data: [
          { x: 158, y: 50 },
          { x: 168, y: 62 },
          { x: 178, y: 75 },
        ],
      },
    ],
  },
  pie: {
    type: "pie",
    title: "Quote",
    labels: ["Alpha", "Beta", "Gamma", "Delta"],
    datasets: [{ label: "Quota", data: [40, 30, 20, 10] }],
  },
  doughnut: {
    type: "doughnut",
    title: "Budget",
    labels: ["Infra", "Persone", "Marketing", "Altro", "Viaggi"],
    datasets: [{ label: "EUR", data: [50, 30, 10, 6, 4] }],
  },
  area: {
    type: "area",
    stacked: true,
    title: "Traffico",
    labels: MONTHS,
    datasets: [
      { label: "Web", data: [10, 12, 14, 13, 16, 18] },
      { label: "App", data: [5, 6, 8, 9, 11, 12] },
      { label: "API", data: [2, 3, 3, 4, 5, 6] },
    ],
  },
  bar: {
    type: "bar",
    title: "Ricavi per regione",
    labels: ["Nord", "Centro", "Sud", "Isole"],
    datasets: [
      { label: "2026", data: [120, 90, 70, 40] },
      { label: "2025", data: [100, 85, 60, 38] },
    ],
  },
  stress: {
    type: "line",
    title: "Stress 180 punti",
    labels: Array.from({ length: 180 }, (_, i) => `p${i}`),
    datasets: [
      {
        label: "S",
        data: Array.from({ length: 180 }, (_, i) =>
          Math.round(50 + 40 * Math.sin(i / 9) + ((i * 37) % 11)),
        ),
      },
    ],
  },
};

/** A chart with forty bars: legible in a big box, a smear in a 52 pt one. */
const CROWDED = {
  type: "bar",
  title: "Quaranta",
  labels: Array.from({ length: 40 }, (_, i) => `c${i}`),
  datasets: [{ label: "v", data: Array.from({ length: 40 }, (_, i) => 10 + i) }],
};

const LIST_TILE = { width: 52, height: 52 } as const;
const GRID_CELL = { width: 128, height: 128 } as const;

function meta(id: string, bytes: Uint8Array): ArtifactMeta {
  return {
    artifactId: id,
    version: 1,
    sha256: "a".repeat(64),
    size: bytes.length,
    mimeType: "application/vnd.tentacle.chart+json",
    kind: "chart",
    title: id,
    callId: "c1",
    createdAt: 0,
  };
}

function geometryOf(raw: unknown, palette = lightPalette): ChartThumbGeometry | null {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  return chartThumbGeometry(meta("x", bytes), bytes, { fontScale: 1, locale: "it", palette });
}

/**
 * Every END POINT a path's commands draw to (absolute M/L/H/V/C/A/Z, the only
 * commands the layouts emit) — a control point or an arc's radius is not a place
 * on the drawing. An arc's bulge between end points is covered separately: a
 * donut's view box is its disc (`ro`), checked below.
 */
function endPoints(d: string): [number, number][] {
  const out: [number, number][] = [];
  const tokens = d.match(/[MLHVCAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let cmd = "";
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/[MLHVCAZ]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z") continue;
    }
    if (cmd === "M" || cmd === "L") {
      x = num();
      y = num();
    } else if (cmd === "H") {
      x = num();
    } else if (cmd === "V") {
      y = num();
    } else if (cmd === "C") {
      i += 4;
      x = num();
      y = num();
    } else if (cmd === "A") {
      i += 5;
      x = num();
      y = num();
    } else {
      throw new Error(`unexpected path command in ${d}`);
    }
    out.push([x, y]);
  }
  return out;
}

function inside(v: ViewBox, x: number, y: number): boolean {
  const eps = 0.05;
  return x >= v.x - eps && x <= v.x + v.w + eps && y >= v.y - eps && y <= v.y + v.h + eps;
}

describe("chartThumbGeometry — the tile's marks and the box that holds them", () => {
  for (const [name, raw] of Object.entries(SPECS)) {
    test(`${name}: every drawn point is inside the view box (nothing spills)`, () => {
      const g = geometryOf(raw);
      expect(g).not.toBeNull();
      if (g === null) return;
      const v = g.viewBox;
      expect(v.w).toBeGreaterThan(0);
      expect(v.h).toBeGreaterThan(0);
      const out: string[] = [];
      for (const p of g.paths) {
        for (const [x, y] of endPoints(p.d)) {
          if (!inside(v, x, y)) out.push(`${p.role} ${x},${y}`);
        }
        if (p.arc !== undefined) {
          // A sector's arc reaches `ro` from the centre: the disc must fit.
          expect(p.arc.ro * 2).toBeLessThanOrEqual(Math.min(v.w, v.h) + 0.05);
        }
      }
      for (const d of g.dots) {
        if (!inside(v, d.x - d.r, d.y - d.r) || !inside(v, d.x + d.r, d.y + d.r)) {
          out.push(`dot ${d.x},${d.y} r${d.r}`);
        }
      }
      expect({ name, out }).toEqual({ name, out: [] });
    });

    test(`${name}: no legend, no text, no guide — marks only`, () => {
      const g = geometryOf(raw);
      expect(g).not.toBeNull();
      const roles = new Set<LayoutPath["role"]>((g?.paths ?? []).map((p) => p.role));
      // `swatch` IS the legend chip; `track`/`baseline` are chrome.
      for (const chrome of ["swatch", "baseline", "track"] as const) {
        expect({ name, chrome, drawn: roles.has(chrome) }).toEqual({ name, chrome, drawn: false });
      }
      expect(g?.paths.length ?? 0).toBeGreaterThan(0);
    });
  }

  test("a pie/doughnut's view box IS its disc: square, centred on the ring (the legend beside it is out)", () => {
    for (const name of ["pie", "doughnut"]) {
      const g = geometryOf(SPECS[name]);
      if (g === null) throw new Error(name);
      const ro = g.paths[0]?.arc?.ro ?? 0;
      expect(ro).toBeGreaterThan(0);
      expect({ name, w: g.viewBox.w, h: g.viewBox.h }).toEqual({ name, w: 2 * ro, h: 2 * ro });
      const cx = g.viewBox.x + g.viewBox.w / 2;
      const cy = g.viewBox.y + g.viewBox.h / 2;
      for (const p of g.paths) {
        for (const [x, y] of endPoints(p.d)) {
          expect(Math.hypot(x - cx, y - cy)).toBeLessThanOrEqual(ro + 0.1);
        }
      }
    }
  });

  test("a scatter's view box is its cloud of points (its axes may start at 0), never a sliver", () => {
    const g = geometryOf(SPECS.scatter);
    if (g === null) throw new Error("scatter");
    const xs = g.dots.map((d) => d.x);
    const ys = g.dots.map((d) => d.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // The cloud fills its long side (only the dots' own size is margin) …
    const long = Math.max(g.viewBox.w, g.viewBox.h);
    expect(Math.max(spanX, spanY) / long).toBeGreaterThan(0.8);
    // … and the box is never thinner than SCATTER_ASPECT of that side.
    expect(Math.min(g.viewBox.w, g.viewBox.h) / long).toBeGreaterThanOrEqual(SCATTER_ASPECT - 1e-9);
  });

  test("a line chart draws its line, not the fill under it; an area keeps its fills", () => {
    const line = geometryOf(SPECS.stress);
    expect(line?.paths.map((p) => p.role)).toEqual(["line"]);
    expect(geometryOf(SPECS.area)?.paths.some((p) => p.role === "fill")).toBe(true);
  });

  test("a scatter keeps its dots; a line's annotation dots are dropped", () => {
    expect(geometryOf(SPECS.scatter)?.dots.length).toBe(8);
    expect(geometryOf(SPECS.stress)?.dots.length).toBe(0);
    expect(geometryOf(SPECS.area)?.dots.length).toBe(0);
  });

  test("a spec that does not re-validate (a pod's forgery) has no geometry", () => {
    expect(geometryOf({ type: "bar", title: "x", datasets: [{ label: "x", data: ["1"] }] })).toBe(
      null,
    );
  });

  test("the scheme follows the palette (dark tiles draw dark colours)", () => {
    expect(geometryOf(SPECS.pie, darkPalette)?.view.scheme).toBe("dark");
    expect(geometryOf(SPECS.pie, lightPalette)?.view.scheme).toBe("light");
  });
});

describe("chartThumbAt — the drawing at one tile's size, or the kind's symbol", () => {
  test("each kind is legible in the 52 pt list tile and the grid cell, at exactly that size", () => {
    for (const [name, raw] of Object.entries(SPECS)) {
      const g = geometryOf(raw);
      if (g === null) throw new Error(name);
      for (const box of [LIST_TILE, GRID_CELL]) {
        const t = chartThumbAt(g, box);
        expect({ name, box, drawn: t !== null }).toEqual({ name, box, drawn: true });
        expect(t?.width).toBe(box.width);
        expect(t?.height).toBe(box.height);
      }
    }
  });

  test("forty bars: a symbol in the 52 pt tile, a drawing in a big one (MIN_MARK)", () => {
    const g = geometryOf(CROWDED);
    if (g === null) throw new Error("crowded");
    expect(g.thinnest).not.toBeNull();
    const at = (box: { width: number; height: number }) =>
      (g.thinnest ?? 0) * thumbScale(g.viewBox, box);
    expect(at(LIST_TILE)).toBeLessThan(MIN_MARK);
    expect(chartThumbAt(g, LIST_TILE)).toBeNull();
    const big = { width: 600, height: 600 };
    expect(at(big)).toBeGreaterThanOrEqual(MIN_MARK);
    expect(chartThumbAt(g, big)).not.toBeNull();
  });

  test("an empty box draws nothing (the row has not been measured)", () => {
    const g = geometryOf(SPECS.pie);
    if (g === null) throw new Error("pie");
    expect(chartThumbAt(g, { width: 0, height: 52 })).toBeNull();
  });

  test("strokes and scatter dots keep a visible on-screen size when scaled down", () => {
    for (const name of ["stress", "area", "scatter"]) {
      const g = geometryOf(SPECS[name]);
      if (g === null) throw new Error(name);
      const t = chartThumbAt(g, LIST_TILE);
      if (t === null) throw new Error(name);
      const s = thumbScale(t.viewBox, LIST_TILE);
      for (const p of t.paths) {
        if (p.strokeWidth !== undefined) {
          expect(p.strokeWidth * s).toBeGreaterThanOrEqual(MIN_STROKE - 1e-9);
        }
      }
      for (const d of t.dots) expect(d.r * s).toBeGreaterThanOrEqual(MIN_DOT - 1e-9);
    }
  });

  test("viewBoxAttr is the SVG attribute order: x y w h", () => {
    expect(viewBoxAttr({ x: -1, y: 2, w: 30, h: 40 })).toBe("-1 2 30 40");
  });
});

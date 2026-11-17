/**
 * T5.8 / T5.9 / T5.12 / T5.13 — the phone chart's geometry
 * (docs/feat/model-charts.md *iPhone visual language (rev 2)* items 1, 2, 5, 6).
 */
import { describe, expect, test } from "bun:test";
import {
  domain,
  type Pt,
  barSide,
  barUp,
  cubicAt,
  guides,
  monotoneCubics,
  padAngle,
  runs,
  sector,
} from "../src/chart-geometry.ts";
import { STACK_GAP } from "../src/chart-layout-shapes.ts";
import { chartLayout } from "../src/chart-layout.ts";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fuzz series: plateaus, spikes, sign changes and null gaps. */
function fuzzSeries(r: () => number): (number | null)[] {
  const n = 2 + Math.floor(r() * 60);
  const out: (number | null)[] = [];
  let v = (r() - 0.5) * 100;
  for (let i = 0; i < n; i++) {
    const pick = r();
    if (pick < 0.08) out.push(null);
    else if (pick < 0.3)
      out.push(v); // plateau
    else if (pick < 0.38)
      out.push(v + (r() < 0.5 ? -1 : 1) * 1000 * r()); // spike
    else {
      v = (r() - 0.5) * 200; // sign changes
      out.push(v);
    }
  }
  return out;
}

describe("T5.8 monotone cubic never overshoots", () => {
  test("1 000 fuzz series, every segment sampled 32× stays inside its endpoints' range", () => {
    const r = rng(42);
    let segments = 0;
    let worst = 0;
    for (let s = 0; s < 1000; s++) {
      const ys = fuzzSeries(r);
      // Uneven x spacing too (date axes): the weighted mean must hold there.
      let x = 0;
      const xs = ys.map(() => {
        x += 1 + r() * 9;
        return x;
      });
      for (const run of runs(
        ys,
        (i) => xs[i] ?? null,
        (v) => v,
      )) {
        for (const c of monotoneCubics(run)) {
          segments++;
          const lo = Math.min(c.from[1], c.to[1]);
          const hi = Math.max(c.from[1], c.to[1]);
          for (let k = 1; k < 32; k++) {
            const y = cubicAt(c, k / 32)[1];
            worst = Math.max(worst, lo - y, y - hi);
          }
        }
      }
    }
    expect(segments).toBeGreaterThan(10_000);
    expect(worst).toBeLessThan(1e-9);
  });

  test("a null is a break: two runs, never bridged", () => {
    const parts = runs(
      [1, 2, null, 3, 4],
      (i) => i,
      (v) => v,
    );
    expect(parts).toEqual([
      [
        [0, 1],
        [1, 2],
      ],
      [
        [3, 3],
        [4, 4],
      ],
    ]);
  });
});

/** A nice value: a whole multiple of 1, 2 or 5 × 10^n for the guides' own step. */
function isNiceSet(values: readonly number[]): boolean {
  if (values.length < 2) return true;
  // The step from a subtraction of large values carries float noise: round it to its nice digits.
  const step = Number(((values[1] as number) - (values[0] as number)).toPrecision(6));
  const exp = Math.floor(Math.log10(step));
  const f = Number((step / 10 ** exp).toPrecision(6));
  if (![1, 2, 5, 10].includes(f)) return false;
  return values.every((v) => Math.abs(v / step - Math.round(v / step)) < 1e-6);
}

describe("T5.9 guides", () => {
  test("≤ 3 values, nice, all inside the domain (500 random domains)", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const a = (r() - 0.5) * 10 ** Math.floor(r() * 7);
      const b = a + r() * 10 ** Math.floor(r() * 7) + 1e-3;
      const [lo, hi] = domain([a, b], r() < 0.5);
      const g = guides(lo, hi, 3);
      expect(g.length).toBeGreaterThanOrEqual(1);
      expect(g.length).toBeLessThanOrEqual(3);
      for (const v of g) {
        expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(v).toBeLessThanOrEqual(hi + 1e-9);
      }
      expect(isNiceSet(g)).toBe(true);
    }
  });
});

/** Every arc command's end point in a path string. */
function arcEnds(d: string): Pt[] {
  const out: Pt[] = [];
  for (const m of d.matchAll(/A[\d.]+,[\d.]+ 0 [01] [01] (-?[\d.]+),(-?[\d.]+)/g)) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

describe("T5.12 bars", () => {
  test("only the data end is rounded; the base is flat", () => {
    const up = barUp(10, 8, 100, 40, 3);
    expect(up.startsWith("M10,100V")).toBe(true);
    for (const [, y] of arcEnds(up)) expect(y).toBeLessThanOrEqual(43); // arcs at the top (y1 = 40)
    const down = barUp(10, 8, 100, 160, 3); // negative bar: rounds its lower end
    for (const [, y] of arcEnds(down)) expect(y).toBeGreaterThanOrEqual(157);
    const right = barSide(0, 80, 5, 9, 4.5);
    for (const [x] of arcEnds(right)) expect(x).toBeGreaterThanOrEqual(75.5);
  });

  test("a zero-height bar draws no path; r is clamped to the width and the height", () => {
    expect(barUp(0, 8, 100, 100, 3)).toBe("");
    expect(barUp(0, 8, 100, 99.9, 3)).toBe("");
    expect(barSide(0, 0.1, 0, 9, 4.5)).toBe("");
    expect(barUp(0, 4, 100, 50, 10)).toContain("A2,2 "); // w/2
    expect(barUp(0, 40, 100, 98, 10)).toContain("A2,2 "); // h
  });

  test("stacked: segment heights + gaps equal the column exactly; only the top segment is rounded", () => {
    const spec = {
      type: "bar",
      title: "Token",
      stacked: true,
      labels: ["lun", "mar", "mer"],
      datasets: [
        { label: "input", data: [100, 200, 150] },
        { label: "output", data: [50, 0, 70] },
        { label: "cache", data: [30, 60, 10] },
      ],
    };
    const layout = chartLayout(spec, { width: 360, locale: "it" });
    expect(layout?.kind).toBe("stacked");
    const bars = (layout?.paths ?? []).filter((p) => p.role === "bar");
    for (let i = 0; i < 3; i++) {
      const col = bars.filter((p) => p.index === i);
      const boxes = col.map((p) => p.box).filter((b) => b !== undefined);
      const top = Math.min(...boxes.map((b) => b.y));
      const base = Math.max(...boxes.map((b) => b.y + b.h));
      const sum = boxes.reduce((s, b) => s + b.h, 0) + (boxes.length - 1) * STACK_GAP;
      expect(sum).toBeCloseTo(base - top, 9);
      const rounded = col.filter((p) => p.d.includes("A"));
      expect(rounded).toHaveLength(1);
      expect(rounded[0]?.box?.y).toBe(top);
    }
    // the zero output on "mar" draws nothing (2 segments there)
    expect(bars.filter((p) => p.index === 1)).toHaveLength(2);
  });
});

/** Flatten an SVG path (M/L/H/V/A/Z, absolute) to polygons and return its signed area sum. */
function pathArea(d: string): number {
  const tokens = d.match(/[MLHVAZ]|-?[\d.]+/g) ?? [];
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  let area = 0;
  let poly: Pt[] = [];
  let cur: Pt = [0, 0];
  const close = () => {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k] as Pt;
      const b = poly[(k + 1) % poly.length] as Pt;
      area += a[0] * b[1] - b[0] * a[1];
    }
    poly = [];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      if (poly.length) close();
      cur = [num(), num()];
      poly.push(cur);
    } else if (cmd === "L") {
      cur = [num(), num()];
      poly.push(cur);
    } else if (cmd === "H") {
      cur = [num(), cur[1]];
      poly.push(cur);
    } else if (cmd === "V") {
      cur = [cur[0], num()];
      poly.push(cur);
    } else if (cmd === "A") {
      const r = num();
      num();
      num();
      const large = num();
      const sweep = num();
      const end: Pt = [num(), num()];
      // SVG endpoint → centre parameterisation (circle).
      const [x1, y1] = cur;
      const [x2, y2] = end;
      const mx = (x1 - x2) / 2;
      const my = (y1 - y2) / 2;
      const rr = Math.max(r, Math.hypot(mx, my));
      const q = Math.sqrt(Math.max(0, (rr * rr - mx * mx - my * my) / (mx * mx + my * my || 1)));
      const sign = large === sweep ? -1 : 1;
      const cx = sign * q * my + (x1 + x2) / 2;
      const cy = -sign * q * mx + (y1 + y2) / 2;
      let t1 = Math.atan2(y1 - cy, x1 - cx);
      let t2 = Math.atan2(y2 - cy, x2 - cx);
      if (sweep === 1 && t2 < t1) t2 += 2 * Math.PI;
      if (sweep === 0 && t2 > t1) t1 += 2 * Math.PI;
      for (let k = 1; k <= 64; k++) {
        const t = t1 + ((t2 - t1) * k) / 64;
        poly.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
      }
      cur = end;
    } else if (cmd === "Z") close();
  }
  if (poly.length) close();
  return area / 2;
}

describe("T5.13 donut sectors", () => {
  const RI = 47;
  const RO = 60;
  const ring = Math.PI * (RO * RO - RI * RI);

  /** Each slice's area plus the annular strip its two pads took ("after the gaps"), as a share of the ring. */
  function shares(values: readonly number[]): { area: number[]; want: number[] } {
    const total = values.reduce((s, v) => s + v, 0);
    let a = 0;
    const area = values.map((v) => {
      const a0 = a;
      a += (v / total) * Math.PI * 2;
      const pad = Math.min(padAngle(2.5, RI, RO), (a - a0) / 4);
      const strip = pad * (RO * RO - RI * RI); // 2·pad of annulus: ½·2pad·(ro²−ri²)
      return Math.abs(pathArea(sector(100, 100, RI, RO, a0, a, 2.5, 2.5))) + strip;
    });
    return { area: area.map((x) => x / ring), want: values.map((v) => v / total) };
  }

  test("areas are proportional to the values within 1 percentage point after the gaps", () => {
    const { area, want } = shares([31.2, 22.4, 18, 12.1, 9.6, 4.4, 2.3]);
    area.forEach((s, k) => expect(Math.abs(s - (want[k] as number))).toBeLessThan(0.01));
  });

  test("a 0,5 % slice still yields a non-empty path", () => {
    const tiny = sector(100, 100, RI, RO, 0, 0.005 * Math.PI * 2, 2.5, 2.5);
    expect(tiny).not.toBe("");
    expect(Math.abs(pathArea(tiny))).toBeGreaterThan(0.25 * 0.005 * ring);
  });

  test("a single slice draws the full ring", () => {
    const full = sector(100, 100, RI, RO, 0, Math.PI * 2, 2.5, 2.5);
    expect(Math.abs(pathArea(full)) / ring).toBeCloseTo(1, 2);
  });
});

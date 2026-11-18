/**
 * The phone chart's geometry primitives (docs/feat/model-charts.md, *iPhone
 * visual language (rev 2, modern)* items 1, 2, 4, 5, 6). Pure: numbers in, SVG
 * path strings out — no React, no `react-native-svg`. `chart-layout.ts` composes
 * them; `ui/chart/ChartView.tsx` only draws the strings.
 *
 * Coordinates are points, y grows DOWN (SVG). Angles are radians, clockwise
 * from 12 o'clock.
 */
import { niceTicks } from "@tentacle/core";

export type Pt = readonly [number, number];

/** One decimal, no `-0`, no trailing `.0`: short, stable path strings. */
export function n1(v: number): string {
  const s = v.toFixed(1);
  return s === "-0.0" ? "0" : s.replace(/\.0$/, "");
}

/**
 * Monotone cubic tangents: Fritsch–Carlson with Brodlie's weighted harmonic
 * mean. 0 at a local extremum or a sign change; the ends take their one-sided
 * slope. With these, no segment leaves its endpoints' y range.
 */
export function monotoneTangents(p: readonly Pt[]): number[] {
  const n = p.length;
  if (n < 2) return new Array(n).fill(0);
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = p[i] as Pt;
    const b = p[i + 1] as Pt;
    dx.push(b[0] - a[0]);
    m.push(b[0] === a[0] ? 0 : (b[1] - a[1]) / (b[0] - a[0]));
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = m[0] as number;
  t[n - 1] = m[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const a = m[i - 1] as number;
    const b = m[i] as number;
    if (a * b <= 0) continue;
    const w1 = 2 * (dx[i] as number) + (dx[i - 1] as number);
    const w2 = (dx[i] as number) + 2 * (dx[i - 1] as number);
    t[i] = (w1 + w2) / (w1 / a + w2 / b);
  }
  return t;
}

/** One cubic Bézier per segment, control points at ±h/3. */
export interface Cubic {
  readonly from: Pt;
  readonly c1: Pt;
  readonly c2: Pt;
  readonly to: Pt;
}

export function monotoneCubics(p: readonly Pt[]): Cubic[] {
  const t = monotoneTangents(p);
  const out: Cubic[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [xa, ya] = p[i] as Pt;
    const [xb, yb] = p[i + 1] as Pt;
    const h = (xb - xa) / 3;
    out.push({
      from: [xa, ya],
      c1: [xa + h, ya + (t[i] as number) * h],
      c2: [xb - h, yb - (t[i + 1] as number) * h],
      to: [xb, yb],
    });
  }
  return out;
}

/** The monotone curve through `p` as an SVG path (`M…C…`). */
export function monotonePath(p: readonly Pt[]): string {
  const first = p[0];
  if (!first) return "";
  let d = `M${n1(first[0])},${n1(first[1])}`;
  for (const c of monotoneCubics(p)) {
    d += `C${n1(c.c1[0])},${n1(c.c1[1])} ${n1(c.c2[0])},${n1(c.c2[1])} ${n1(c.to[0])},${n1(c.to[1])}`;
  }
  return d;
}

/** A point on a cubic at `s ∈ [0, 1]`. */
export function cubicAt(c: Cubic, s: number): Pt {
  const u = 1 - s;
  const a = u * u * u;
  const b = 3 * u * u * s;
  const k = 3 * u * s * s;
  const e = s * s * s;
  return [
    a * c.from[0] + b * c.c1[0] + k * c.c2[0] + e * c.to[0],
    a * c.from[1] + b * c.c1[1] + k * c.c2[1] + e * c.to[1],
  ];
}

/**
 * The curve's length, sampled (`react-native-svg` has no reliable
 * `pathLength`; the draw-in animation needs it, item 8).
 */
export function curveLength(p: readonly Pt[], samples = 16): number {
  if (p.length < 2) return 0;
  let length = 0;
  for (const c of monotoneCubics(p)) {
    let prev = c.from;
    for (let k = 1; k <= samples; k++) {
      const next = cubicAt(c, k / samples);
      length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      prev = next;
    }
  }
  return length;
}

/** A series split at its `null`s: a gap is a break, never bridged. */
export function runs(
  ys: readonly (number | null)[],
  xAt: (i: number) => number | null,
  yAt: (v: number) => number,
): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  ys.forEach((v, i) => {
    const x = xAt(i);
    if (v === null || x === null) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else cur.push([x, yAt(v)]);
  });
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * The value domain: lines get a tight range padded 12 % each side; bars and
 * areas start at 0 and get 8 % headroom.
 */
export function domain(values: readonly number[], zero: boolean): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (zero) {
    const a = Math.min(0, lo);
    const b = Math.max(0, hi);
    const span = b - a || 1;
    return [a < 0 ? a - span * 0.08 : a, b > 0 || a === 0 ? b + span * 0.08 : b];
  }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  return [lo - pad, hi + pad];
}

/** At most `max` nice values inside `[lo, hi]` (the hairline guides). */
export function guides(lo: number, hi: number, max = 3): number[] {
  for (let k = max + 1; k >= 2; k--) {
    const inside = niceTicks(lo, hi, k).ticks.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
    if (inside.length >= 1 && inside.length <= max) return inside;
  }
  return [];
}

/**
 * A vertical bar from the baseline `y0` to the value `y1`, only the data end
 * rounded (`r` clamped to half the width and to the height). A bar shorter
 * than 0.2 pt draws nothing. A negative bar (`y1 > y0`) rounds its lower end.
 */
export function barUp(x: number, w: number, y0: number, y1: number, r: number): string {
  const h = Math.abs(y0 - y1);
  if (h <= 0.2 || w <= 0) return "";
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (y1 <= y0) {
    return `M${n1(x)},${n1(y0)}V${n1(y1 + rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x + rr)},${n1(y1)}H${n1(x + w - rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x + w)},${n1(y1 + rr)}V${n1(y0)}Z`;
  }
  return `M${n1(x)},${n1(y0)}V${n1(y1 - rr)}A${n1(rr)},${n1(rr)} 0 0 0 ${n1(x + rr)},${n1(y1)}H${n1(x + w - rr)}A${n1(rr)},${n1(rr)} 0 0 0 ${n1(x + w)},${n1(y1 - rr)}V${n1(y0)}Z`;
}

/**
 * A horizontal bar from the baseline `x0` to the value `x1`, row `y..y+h`, the
 * data end rounded with `r` (clamped to h/2 and to the length).
 */
export function barSide(x0: number, x1: number, y: number, h: number, r: number): string {
  const w = Math.abs(x1 - x0);
  if (w <= 0.2 || h <= 0) return "";
  const rr = Math.max(0, Math.min(r, h / 2, w));
  if (x1 >= x0) {
    return `M${n1(x0)},${n1(y)}H${n1(x1 - rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x1)},${n1(y + rr)}V${n1(y + h - rr)}A${n1(rr)},${n1(rr)} 0 0 1 ${n1(x1 - rr)},${n1(y + h)}H${n1(x0)}Z`;
  }
  return `M${n1(x0)},${n1(y)}H${n1(x1 + rr)}A${n1(rr)},${n1(rr)} 0 0 0 ${n1(x1)},${n1(y + rr)}V${n1(y + h - rr)}A${n1(rr)},${n1(rr)} 0 0 0 ${n1(x1 + rr)},${n1(y + h)}H${n1(x0)}Z`;
}

/** A plain rectangle path (unrounded stacked segments). */
export function rectPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0.2 || w <= 0) return "";
  return `M${n1(x)},${n1(y)}H${n1(x + w)}V${n1(y + h)}H${n1(x)}Z`;
}

/** The pad angle a `gap` (pt) takes from each side of a sector at its mid radius. */
export function padAngle(gap: number, ri: number, ro: number): number {
  return gap / 2 / ((ri + ro) / 2);
}

/** The corner radius a sector of `sweep` radians can carry (a thin slice → sharp). */
export function sectorCorner(cr: number, ri: number, ro: number, sweep: number): number {
  const half = Math.sin(Math.min(sweep / 2, Math.PI / 2));
  const max = Math.min(
    (ro - ri) / 2,
    half >= 1 ? Number.POSITIVE_INFINITY : (ri * half) / (1 - half),
  );
  return Math.max(0, Math.min(cr, max));
}

/**
 * An annular sector with four tangent corner arcs and a `gap` (pt) to its
 * neighbours. A full turn (one slice) is a whole ring, drawn as two arcs.
 */
export function sector(
  cx: number,
  cy: number,
  ri: number,
  ro: number,
  a0: number,
  a1: number,
  cr: number,
  gap: number,
): string {
  const pt = (r: number, a: number): string =>
    `${n1(cx + r * Math.sin(a))},${n1(cy - r * Math.cos(a))}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-9) {
    const ring = (r: number, sweep: 0 | 1): string =>
      `M${pt(r, 0)}A${n1(r)},${n1(r)} 0 1 ${sweep} ${pt(r, Math.PI)}A${n1(r)},${n1(r)} 0 1 ${sweep} ${pt(r, 0)}Z`;
    return `${ring(ro, 1)}${ring(ri, 0)}`;
  }
  // A slice thinner than its gap keeps half its angle: a 0,5 % share stays visible.
  const pad = Math.min(padAngle(gap, ri, ro), (a1 - a0) / 4);
  const b0 = a0 + pad;
  const b1 = a1 - pad;
  const sweep = Math.max(1e-4, b1 - b0);
  const c = sectorCorner(cr, ri, ro, sweep);
  const to = Math.asin(Math.min(1, c / (ro - c)));
  const ti = Math.asin(Math.min(1, c / (ri + c)));
  const large = (s: number): number => (s > Math.PI ? 1 : 0);
  const ro2 = (ro - c) * Math.cos(to);
  const ri2 = (ri + c) * Math.cos(ti);
  const arc = (r: number): string => `${n1(r)},${n1(r)}`;
  return (
    `M${pt(ro, b0 + to)}A${arc(ro)} 0 ${large(sweep - 2 * to)} 1 ${pt(ro, b1 - to)}` +
    `A${arc(c)} 0 0 1 ${pt(ro2, b1)}L${pt(ri2, b1)}A${arc(c)} 0 0 1 ${pt(ri, b1 - ti)}` +
    `A${arc(ri)} 0 ${large(sweep - 2 * ti)} 0 ${pt(ri, b0 + ti)}A${arc(c)} 0 0 1 ${pt(ri2, b0)}` +
    `L${pt(ro2, b0)}A${arc(c)} 0 0 1 ${pt(ro, b0 + to)}Z`
  );
}

/**
 * Labels pushed apart vertically to at least `h` between centres, kept inside
 * `[lo, hi]`, the input order preserved. Callers check `n·h ≤ hi − lo` first
 * (else a legend row replaces the labels, item 4).
 */
export function dodge(ys: readonly number[], h: number, lo: number, hi: number): number[] {
  const idx = ys.map((_, i) => i).sort((a, b) => (ys[a] as number) - (ys[b] as number) || a - b);
  const v = idx.map((i) => ys[i] as number);
  for (let k = 1; k < v.length; k++) v[k] = Math.max(v[k] as number, (v[k - 1] as number) + h);
  if (v.length > 0 && (v[v.length - 1] as number) > hi) {
    v[v.length - 1] = hi;
    for (let k = v.length - 2; k >= 0; k--)
      v[k] = Math.min(v[k] as number, (v[k + 1] as number) - h);
  }
  if (v.length > 0 && (v[0] as number) < lo) {
    v[0] = lo;
    for (let k = 1; k < v.length; k++) v[k] = Math.max(v[k] as number, (v[k - 1] as number) + h);
  }
  const out: number[] = new Array(ys.length);
  idx.forEach((i, k) => {
    out[i] = v[k] as number;
  });
  return out;
}

/** Least-squares line `y = a + b·x` and its r² (`null` with < 2 distinct x). */
export function leastSquares(
  pts: readonly Pt[],
): { readonly a: number; readonly b: number; readonly r2: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

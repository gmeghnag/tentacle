/**
 * The chart palette (docs/feat/model-charts.md D4, Owner Q3 = palette A) and the
 * checks that keep it honest.
 *
 * Colour follows the dataset INDEX — never its rank, never a re-assignment when a
 * series is hidden — so a reader who learned "teal is 2025" is never lied to.
 * The same slots serve the TUI and the app (a chart must look like the same chart
 * in both places).
 *
 * The validation is ported from the dataviz palette validator (`Palette
 * validation` in the task doc: OKLCH lightness band, chroma floor, Machado-2009
 * CVD ΔE, normal-vision floor, WCAG contrast). It lives here as CODE, not as a
 * paragraph, so a slot edited by hand fails `bun test` instead of shipping
 * (T1.15). Pure: no I/O, no React.
 */

/** A value per colour scheme (a palette's slots, or the surface it was checked on). */
export interface PerMode<T> {
  readonly light: T;
  readonly dark: T;
}

/** The eight categorical slots per scheme. */
export type SeriesPalette = PerMode<readonly string[]>;

/**
 * Palette A ("Tentacle"): slot 1 is a saturated teal near the app accent, then
 * orange, violet, yellow, magenta, green, blue, red.
 *
 * Rectified by the validator, not by eye: the app's own accent
 * (`#0E7490`) FAILS the chroma floor (0.094) and the dark accent teal
 * (`#22b8d4`-class) falls outside the dark lightness band — hence `#0786a6` /
 * `#0fa0bd` in slot 1 rather than the accent token.
 */
export const CHART_PALETTE: SeriesPalette = {
  light: ["#0786a6", "#eb6834", "#6250d6", "#eda100", "#e87ba4", "#008300", "#2a78d6", "#e34948"],
  dark: ["#0fa0bd", "#d95926", "#9085e9", "#c98500", "#d55181", "#0ca30c", "#3987e5", "#e66767"],
};

/** The surface each palette was validated against (`Palette validation`). */
export const PALETTE_SURFACE: PerMode<string> = { light: "#FFFFFF", dark: "#1F1F1E" };

/** The colour of dataset `index` — the slot its position earns, wrapping at 8. */
export function seriesColor(index: number, scheme: "light" | "dark"): string {
  const slots = CHART_PALETTE[scheme];
  const slot = slots[Math.abs(Math.trunc(index)) % slots.length];
  return slot ?? (scheme === "dark" ? "#ffffff" : "#000000");
}

// ── the validator's math (ported from dataviz/scripts/validate_palette.js) ──────

/** OKLCH L band per mode: outside it a hue reads as too dark/too light to compare. */
const LIGHTNESS_BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] } as const;
/** Below this OKLCH chroma a hue reads as gray. */
const CHROMA_FLOOR = 0.1;
/** OKLab ΔE×100, min(protan, deutan): ≥ target passes, ≥ floor warns, else fails. */
const CVD_TARGET = 8;
const CVD_FLOOR = 6;
/** OKLab ΔE×100 between neighbours, unsimulated — a hard gate for everyone else. */
const NORMAL_FLOOR = 15;
/** WCAG contrast vs the surface; below it, relief (visible labels / a table) is required. */
const CONTRAST_MIN = 3;

/** Machado, Oliveira & Fernandes (2009) severity-1.0 CVD transforms, linear RGB. */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

function hexToSrgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  return [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearOf(hex: string): [number, number, number] {
  const [r, g, b] = hexToSrgb(hex);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = linearOf(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

function oklabFromLinear([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH lightness and chroma of a hex colour. */
export function oklch(hex: string): { l: number; c: number } {
  const [l, a, b] = oklabFromLinear(linearOf(hex));
  return { l, c: Math.hypot(a, b) };
}

function simulate(hex: string, kind: "protan" | "deutan"): [number, number, number] {
  const [r, g, b] = linearOf(hex);
  const matrix = MACHADO[kind];
  const channel = (row: readonly number[]): number =>
    Math.max(
      0,
      Math.min(1, (row[0] as number) * r + (row[1] as number) * g + (row[2] as number) * b),
    );
  return [channel(matrix[0]), channel(matrix[1]), channel(matrix[2])];
}

function deltaE(a: string, b: string, kind?: "protan" | "deutan"): number {
  const left = oklabFromLinear(kind ? simulate(a, kind) : linearOf(a));
  const right = oklabFromLinear(kind ? simulate(b, kind) : linearOf(b));
  return 100 * Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

/** One check's outcome; `relief` is a warning that a label/table must exist. */
export type PaletteCheckState = "pass" | "warn" | "relief" | "fail";

/** A palette check, as the validator reports it. */
export interface PaletteCheck {
  readonly check: string;
  readonly state: PaletteCheckState;
  readonly detail: string;
}

/** A palette's verdict: the checks, plus whether any of them hard-fails. */
export interface PaletteReport {
  readonly checks: readonly PaletteCheck[];
  readonly ok: boolean;
}

function pairList(length: number, pairs: "adjacent" | "all"): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    const last = pairs === "all" ? length : Math.min(length, i + 2);
    for (let j = i + 1; j < last; j++) out.push([i, j]);
  }
  return out;
}

/**
 * The palette validator's five computable checks, for one mode.
 *
 * `pairs: "adjacent"` is the right list for lines, bars and stacks (neighbours
 * are what a reader compares); `"all"` is the right one for a scatter, where any
 * two dots may sit side by side (Owner Q3: scatter keeps shapes for exactly the
 * dark first-3 warn band this reports).
 */
export function validatePalette(
  slots: readonly string[],
  options: {
    readonly mode: "light" | "dark";
    readonly surface?: string;
    readonly pairs?: "adjacent" | "all";
  },
): PaletteReport {
  const mode = options.mode;
  const surface = options.surface ?? PALETTE_SURFACE[mode];
  const pairs = options.pairs ?? "adjacent";
  const [lo, hi] = LIGHTNESS_BAND[mode];
  const checks: PaletteCheck[] = [];

  const offBand = slots.filter((hex) => {
    const l = oklch(hex).l;
    return l < lo || l > hi;
  });
  checks.push({
    check: "Lightness band",
    state: offBand.length === 0 ? "pass" : "fail",
    detail:
      offBand.length === 0
        ? `all ${slots.length} in L ${lo}–${hi}`
        : `outside band: ${offBand.join(", ")}`,
  });

  const lowChroma = slots.filter((hex) => oklch(hex).c < CHROMA_FLOOR);
  checks.push({
    check: "Chroma floor",
    state: lowChroma.length === 0 ? "pass" : "fail",
    detail:
      lowChroma.length === 0
        ? `all ${slots.length} ≥ ${CHROMA_FLOOR}`
        : `reads gray: ${lowChroma.join(", ")}`,
  });

  const list = pairList(slots.length, pairs);
  const worstCvd = list.reduce<{ d: number; a: string; b: string; kind: string } | null>(
    (worst, [i, j]) => {
      let found = worst;
      for (const kind of ["protan", "deutan"] as const) {
        const d = deltaE(slots[i] as string, slots[j] as string, kind);
        if (!found || d < found.d)
          found = { d, a: slots[i] as string, b: slots[j] as string, kind };
      }
      return found;
    },
    null,
  );
  const cvd = worstCvd?.d ?? 99;
  checks.push({
    check: "CVD separation",
    state: cvd >= CVD_TARGET ? "pass" : cvd >= CVD_FLOOR ? "warn" : "fail",
    detail: worstCvd
      ? `worst ${pairs === "all" ? "all-pairs" : "adjacent"} ${worstCvd.a}↔${worstCvd.b} ΔE ${cvd.toFixed(1)} (${worstCvd.kind})`
      : "n/a",
  });

  const worstNormal = list.reduce<{ d: number; a: string; b: string } | null>((worst, [i, j]) => {
    const d = deltaE(slots[i] as string, slots[j] as string);
    return !worst || d < worst.d ? { d, a: slots[i] as string, b: slots[j] as string } : worst;
  }, null);
  const normal = worstNormal?.d ?? 99;
  checks.push({
    check: "Normal-vision floor",
    state: normal >= NORMAL_FLOOR ? "pass" : "fail",
    detail: worstNormal
      ? `worst ${pairs === "all" ? "all-pairs" : "adjacent"} ${worstNormal.a}↔${worstNormal.b} ΔE ${normal.toFixed(1)}`
      : "n/a",
  });

  const lowContrast = slots.filter((hex) => contrastRatio(hex, surface) < CONTRAST_MIN);
  checks.push({
    check: "Contrast vs surface",
    state: lowContrast.length === 0 ? "pass" : "relief",
    detail:
      lowContrast.length === 0
        ? `all ${slots.length} ≥ ${CONTRAST_MIN}:1`
        : `below ${CONTRAST_MIN}:1 — relief required (visible labels or a table): ${lowContrast.join(", ")}`,
  });

  return { checks, ok: checks.every((check) => check.state !== "fail") };
}

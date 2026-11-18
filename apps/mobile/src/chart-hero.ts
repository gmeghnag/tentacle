/**
 * The phone chart's hero: the big number above the plot, its delta pill and the
 * context line (docs/feat/model-charts.md, *iPhone visual language (rev 2)*
 * item 3). Scrubbing re-asks it at the finger's index (item 7), so it is one
 * pure function of the spec and an index — React-free.
 *
 * The pill is never green/red: a spec has no polarity ("▲ latency" is bad
 * news). ▲ U+25B2 / ▼ U+25BC carry no Emoji property (T5.15).
 */
import {
  type ChartSpec,
  datasetValues,
  effectiveXType,
  formatDate,
  formatNumber,
  formatParts,
  parseIsoDate,
  usesPoints,
} from "@tentacle/core";
import { leastSquares } from "./chart-geometry.ts";

export interface HeroDelta {
  /** 1 up, −1 down, 0 flat. */
  readonly sign: 1 | -1 | 0;
  /** The change in percent, unrounded. */
  readonly pct: number;
  /** `▲ 26,8%`. */
  readonly text: string;
}

export interface Hero {
  /** `20.800` — the full format with the spec's decimals. */
  readonly num: string;
  /** `€`, `token`, `s ogni 100 righe`, or `""`. */
  readonly unit: string;
  readonly unitBefore: boolean;
  readonly delta?: HeroDelta;
  /** A secondary capsule (scatter: `r² 0,85`). */
  readonly chip?: string;
  /** `ottobre 2026 · vs ottobre 2025`. */
  readonly context: string;
}

/** The two languages the app speaks; anything not Italian reads English. */
export function chartLang(locale: string): "it" | "en" {
  return locale.toLowerCase().startsWith("it") ? "it" : "en";
}

const WORDS = {
  it: {
    since: "da",
    highest: "il più alto di",
    total: "totale",
    per: "ogni",
    points: "punti",
    trend: "tendenza",
    other: "Altro",
  },
  en: {
    since: "since",
    highest: "highest of",
    total: "total",
    per: "per",
    points: "points",
    trend: "trend",
    other: "Other",
  },
} as const;

export function chartWords(locale: string): (typeof WORDS)["it" | "en"] {
  return WORDS[chartLang(locale)];
}

/** One decimal in the locale: `26,8` / `26.8`. */
function oneDecimal(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/** `(cur − ref)/|ref|`, or nothing when there is no honest reference. */
export function heroDelta(cur: number, ref: number | null, locale: string): HeroDelta | undefined {
  if (ref === null || ref === 0 || !Number.isFinite(ref)) return undefined;
  const pct = ((cur - ref) / Math.abs(ref)) * 100;
  const sign = pct > 0 ? 1 : pct < 0 ? -1 : 0;
  return { sign, pct, text: `${sign < 0 ? "▼" : "▲"} ${oneDecimal(Math.abs(pct), locale)}%` };
}

/** The x label of each dataset's point `i`, as a reader reads it. */
export function xTexts(spec: ChartSpec, locale: string): string[][] {
  const type = effectiveXType(spec);
  const raws: (string | number)[][] = usesPoints(spec)
    ? spec.datasets.map((d) => d.data.map((p) => (typeof p === "object" && p ? p.x : "")))
    : spec.datasets.map(() => [...(spec.labels ?? [])]);
  return raws.map((xs) =>
    xs.map((x) => {
      if (type === "date") {
        const parsed = parseIsoDate(String(x));
        return parsed ? formatDate(parsed.ms, parsed.granularity, { locale }) : String(x);
      }
      if (type === "number" && Number.isFinite(Number(x))) {
        return formatNumber(Number(x), { ...spec.x, locale });
      }
      return String(x);
    }),
  );
}

function lastIndex(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (typeof values[i] === "number") return i;
  return -1;
}

function firstIndex(values: readonly (number | null)[]): number {
  return values.findIndex((v) => typeof v === "number");
}

function heroNumber(spec: ChartSpec, value: number, locale: string): Omit<Hero, "context"> {
  const parts = formatParts(value, {
    format: "full",
    locale,
    ...(spec.y?.unit === undefined ? {} : { unit: spec.y.unit }),
    ...(spec.y?.decimals === undefined ? {} : { decimals: spec.y.decimals }),
  });
  return { num: parts.number, unit: parts.unit, unitBefore: parts.unitBefore };
}

const EMPTY: Hero = { num: "—", unit: "", unitBefore: false, context: "" };

/**
 * One series' hero: its value at `at` (or at its last defined point) against its
 * own previous DEFINED point — the mockup's "a series vs itself" rule, used for
 * a highlighted series in A and for a 3+-series line/area
 * (docs/feat/mobile-chart-labels.md D6). A gap is skipped, never bridged.
 */
function ownSeriesHero(
  spec: ChartSpec,
  series: number,
  at: number | undefined,
  locale: string,
  xs: readonly (readonly string[])[],
): Hero {
  const values = datasetValues(spec, series);
  const i = at !== undefined && at >= 0 && at < values.length ? at : lastIndex(values);
  const cur = values[i];
  if (i < 0 || typeof cur !== "number") return EMPTY;
  let p = -1;
  for (let j = i - 1; j >= 0; j--) {
    if (typeof values[j] === "number") {
      p = j;
      break;
    }
  }
  const prev = p >= 0 ? (values[p] as number) : null;
  const delta = heroDelta(cur, prev, locale);
  const label = xs[series]?.[i] ?? xs[0]?.[i] ?? "";
  const name = spec.datasets[series]?.label ?? "";
  const head = name === "" ? label : `${label} ${name}`;
  const context = prev === null ? head : `${head} · vs ${xs[series]?.[p] ?? ""}`;
  return {
    ...heroNumber(spec, cur, locale),
    ...(delta ? { delta } : {}),
    context,
  };
}

/** Whether this chart stacks its series (bars and areas only). */
export function isStacked(spec: ChartSpec): boolean {
  return (
    spec.stacked === true &&
    (spec.type === "bar" || spec.type === "area") &&
    spec.datasets.length > 1
  );
}

/** Column totals of a stacked chart (`null` where no series has a value). */
export function stackTotals(spec: ChartSpec): (number | null)[] {
  const n = Math.max(0, ...spec.datasets.map((d) => d.data.length));
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let any = false;
    for (let k = 0; k < spec.datasets.length; k++) {
      const v = datasetValues(spec, k)[i];
      if (typeof v === "number") {
        sum += v;
        any = true;
      }
    }
    out.push(any ? sum : null);
  }
  return out;
}

/**
 * The hero at index `at` (a scrub), or at rest (`at` absent): the latest value
 * for lines/areas/stacks, the max for bars, the total for donuts, the trend for
 * scatters.
 */
export function heroOf(
  spec: ChartSpec,
  at: number | undefined,
  locale: string,
  series?: number,
): Hero {
  const words = chartWords(locale);
  const xs = xTexts(spec, locale);
  if (spec.type === "pie" || spec.type === "doughnut") {
    const values = datasetValues(spec, 0).map((v) => Math.max(0, v ?? 0));
    const total = values.reduce((s, v) => s + v, 0);
    if (at !== undefined && at >= 0 && at < values.length) {
      const share =
        total === 0 ? "" : ` · ${oneDecimal(((values[at] ?? 0) / total) * 100, locale)}%`;
      return {
        ...heroNumber(spec, values[at] ?? 0, locale),
        context: `${xs[0]?.[at] ?? ""}${share}`,
      };
    }
    return { ...heroNumber(spec, total, locale), context: words.total };
  }
  if (spec.type === "scatter") return scatterHero(spec, locale);
  if (isStacked(spec)) {
    const totals = stackTotals(spec);
    const i = at ?? lastIndex(totals);
    const cur = totals[i];
    if (typeof cur !== "number") return EMPTY;
    const prev = i > 0 ? (totals[i - 1] ?? null) : null;
    const delta = heroDelta(cur, prev, locale);
    const label = xs[0]?.[i] ?? "";
    const context = prev === null ? label : `${label} · vs ${xs[0]?.[i - 1] ?? ""}`;
    return { ...heroNumber(spec, cur, locale), ...(delta ? { delta } : {}), context };
  }
  const v0 = datasetValues(spec, 0);
  if (spec.type === "bar") {
    const finite = v0.filter((v): v is number => typeof v === "number");
    if (finite.length === 0) return EMPTY;
    if (at !== undefined) {
      const v = v0[at];
      return typeof v === "number"
        ? { ...heroNumber(spec, v, locale), context: xs[0]?.[at] ?? "" }
        : EMPTY;
    }
    const max = Math.max(...finite);
    const i = v0.indexOf(max);
    return {
      ...heroNumber(spec, max, locale),
      context: `${xs[0]?.[i] ?? ""} · ${words.highest} ${finite.length}`,
    };
  }
  // line / area
  // A highlighted series (A, docs/feat/mobile-chart-labels.md D6): itself vs its
  // own previous DEFINED point — never against a different series.
  if (series !== undefined) return ownSeriesHero(spec, series, at, locale, xs);
  const i = at ?? lastIndex(v0);
  const cur = v0[i];
  if (typeof cur !== "number") return EMPTY;
  const label = xs[0]?.[i] ?? "";
  const second = spec.datasets.length === 2 ? spec.datasets[1] : undefined;
  if (second) {
    const j = usesPoints(spec) ? (xs[1] ?? []).indexOf(label) : i;
    const ref = j >= 0 ? (datasetValues(spec, 1)[j] ?? null) : null;
    if (typeof ref === "number") {
      const delta = heroDelta(cur, ref, locale);
      const first = spec.datasets[0]?.label ?? "";
      return {
        ...heroNumber(spec, cur, locale),
        ...(delta ? { delta } : {}),
        context: `${label} ${first} · vs ${label} ${second.label}`,
      };
    }
  }
  // 3+ series is not a comparison of one against another (the mockup's complaint:
  // "Nov 16 storage · vs Nov 16 auth" compares unrelated scales), so series 0
  // refers to itself. A single series keeps its "since the first point" read.
  if (spec.datasets.length >= 3) return ownSeriesHero(spec, 0, at, locale, xs);
  const f = firstIndex(v0);
  const delta = f === i ? undefined : heroDelta(cur, v0[f] ?? null, locale);
  return {
    ...heroNumber(spec, cur, locale),
    ...(delta ? { delta } : {}),
    context: f === i ? label : `${label} · ${words.since} ${xs[0]?.[f] ?? ""}`,
  };
}

/** The pooled `{x, y}` points of a scatter (numbers only). */
export function scatterPoints(spec: ChartSpec): [number, number][] {
  const out: [number, number][] = [];
  for (const d of spec.datasets) {
    for (const p of d.data) {
      if (typeof p !== "object" || p === null || p.y === null) continue;
      const x = typeof p.x === "number" ? p.x : Number(p.x);
      if (Number.isFinite(x)) out.push([x, p.y]);
    }
  }
  return out;
}

/** Below these, a fitted slope is noise dressed as a fact. */
export const TREND_MIN_POINTS = 8;
export const TREND_MIN_R2 = 0.5;

/** The scatter's trend, when it is worth a headline. */
export function scatterTrend(
  spec: ChartSpec,
): { readonly a: number; readonly b: number; readonly r2: number } | null {
  const pts = scatterPoints(spec);
  if (pts.length < TREND_MIN_POINTS) return null;
  const fit = leastSquares(pts);
  return fit && fit.r2 >= TREND_MIN_R2 ? fit : null;
}

function scatterHero(spec: ChartSpec, locale: string): Hero {
  const words = chartWords(locale);
  const count = spec.datasets.reduce(
    (sum, d) =>
      sum + d.data.filter((p) => typeof p === "object" && p !== null && p.y !== null).length,
    0,
  );
  const fit = effectiveXType(spec) === "date" ? null : scatterTrend(spec);
  if (!fit) {
    return {
      num: formatNumber(count, { locale }),
      unit: words.points,
      unitBefore: false,
      context: "",
    };
  }
  const pts = scatterPoints(spec);
  const xMax = Math.max(...pts.map((p) => Math.abs(p[0])));
  const step = xMax > 0 ? 10 ** Math.floor(Math.log10(xMax)) : 1;
  const slope = fit.b * step;
  const sign = slope > 0 ? "+" : slope < 0 ? "−" : "";
  const num = `${sign}${formatNumber(Math.abs(slope), { decimals: 1, locale, format: "full" })}`;
  const xUnit = spec.x?.unit ?? spec.x?.title ?? "";
  const unit = [spec.y?.unit ?? "", words.per, formatNumber(step, { locale }), xUnit]
    .filter((s) => s !== "")
    .join(" ");
  const r2 = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(fit.r2);
  return {
    num,
    unit,
    unitBefore: false,
    chip: `r² ${r2}`,
    context: `${words.trend} · ${formatNumber(count, { locale })} ${words.points}`,
  };
}

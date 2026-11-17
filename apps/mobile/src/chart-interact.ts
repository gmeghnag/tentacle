/**
 * The phone chart's interactions (docs/feat/model-charts.md slice C7): full
 * screen (B: series toggles + a KPI strip), the in-place `Grafico | Tabella`
 * toggle (table A, with a Δ column), Share → CSV, VoiceOver's actions, the
 * appear animation's descriptor and the scrub's per-event outcome. Pure and
 * React-free (AGENTS §7): `ui/chart/*` only renders what these return.
 */
import { type ChartSpec, datasetValues, formatNumber, usesPoints, yFormat } from "@tentacle/core";
import { type HeroDelta, chartLang, heroDelta, heroOf, isStacked, xTexts } from "./chart-hero.ts";
import type { ChartTable, LayoutKind } from "./chart-layout-kit.ts";
import { SCRUB_IDLE, type ScrubEvent, type ScrubState, reduceScrub } from "./chart-scrub.ts";

const UI = {
  it: {
    chart: "Grafico",
    table: "Tabella",
    share: "Condividi",
    close: "Chiudi",
    showTable: "Mostra tabella dati",
    showChart: "Mostra grafico",
    open: "Apri a schermo intero",
    last: "ULTIMO",
    mean: "MEDIA",
    max: "MASSIMO",
    shown: "visibile",
    hiddenWord: "nascosta",
  },
  en: {
    chart: "Chart",
    table: "Table",
    share: "Share",
    close: "Close",
    showTable: "Show data table",
    showChart: "Show chart",
    open: "Open full screen",
    last: "LAST",
    mean: "MEAN",
    max: "MAX",
    shown: "shown",
    hiddenWord: "hidden",
  },
} as const;

export type ChartUiWords = (typeof UI)["it" | "en"];

export function chartUiWords(locale: string): ChartUiWords {
  return UI[chartLang(locale)];
}

// ── Table (A: tabular figures + a Δ column) ───────────────────────────────

/**
 * The table the toggle shows: the layout's table, plus a Δ column (series 0 vs
 * series 1 at the same x) when the chart is a two-series comparison. Stacked
 * parts and point clouds have no honest Δ, so they keep the plain table.
 */
export function tableView(spec: ChartSpec, table: ChartTable, locale: string): ChartTable {
  if (spec.datasets.length !== 2 || usesPoints(spec) || isStacked(spec)) return table;
  if (spec.type === "pie" || spec.type === "doughnut") return table;
  const a = datasetValues(spec, 0);
  const b = datasetValues(spec, 1);
  return {
    header: [...table.header, "Δ"],
    rows: table.rows.map((row, i) => {
      const cur = a[i];
      const ref = b[i];
      const d =
        typeof cur === "number" && typeof ref === "number"
          ? heroDelta(cur, ref, locale)
          : undefined;
      return [...row, d?.text ?? ""];
    }),
  };
}

// ── Share → CSV ──────────────────────────────────────────────────────────

/**
 * One CSV cell (RFC 4180). A TEXT cell that a spreadsheet would run as a
 * formula (`=`, `+`, `-`, `@`, tab, CR) gets a leading `'`: labels come from the
 * model, and a shared file is opened elsewhere. Numbers are written raw.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The chart's data as CSV: raw numbers (no locale grouping), labels as written. */
export function chartCsv(spec: ChartSpec): string {
  const header = [spec.x?.title ?? "x", ...spec.datasets.map((d) => d.label)];
  const lines: (string | number | null)[][] = [header];
  if (usesPoints(spec)) {
    spec.datasets.forEach((dataset, k) => {
      for (const p of dataset.data) {
        if (typeof p !== "object" || p === null) continue;
        lines.push([String(p.x), ...spec.datasets.map((_, c) => (c === k ? p.y : null))]);
      }
    });
  } else {
    (spec.labels ?? []).forEach((label, i) => {
      lines.push([
        String(label),
        ...spec.datasets.map((_, k) => datasetValues(spec, k)[i] ?? null),
      ]);
    });
  }
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\n");
}

// ── Full screen: series toggles (colours never move) + KPI strip (B) ───────

/**
 * Toggle dataset `k`. The last visible series cannot be switched off (an empty
 * plot answers nothing); an index out of range changes nothing.
 */
export function toggleSeries(
  hidden: ReadonlySet<number>,
  k: number,
  count: number,
): ReadonlySet<number> {
  if (!Number.isInteger(k) || k < 0 || k >= count) return hidden;
  const next = new Set(hidden);
  if (next.has(k)) {
    next.delete(k);
    return next;
  }
  if (count - next.size <= 1) return hidden;
  next.add(k);
  return next;
}

export interface SeriesChip {
  readonly series: number;
  readonly label: string;
  readonly on: boolean;
  /** The VoiceOver label: `2025, visibile`. */
  readonly a11y: string;
}

/** One toggle per dataset; none when there is only one (nothing to compare). */
export function seriesChips(
  spec: ChartSpec,
  hidden: ReadonlySet<number>,
  locale: string,
): SeriesChip[] {
  if (spec.datasets.length < 2) return [];
  const w = chartUiWords(locale);
  return spec.datasets.map((d, k) => {
    const on = !hidden.has(k);
    return { series: k, label: d.label, on, a11y: `${d.label}, ${on ? w.shown : w.hiddenWord}` };
  });
}

export interface Kpi {
  /** `ULTIMO · ott`. */
  readonly key: string;
  readonly value: string;
  readonly delta?: HeroDelta;
  /** The x of the max. */
  readonly sub?: string;
}

/**
 * Full screen B's strip: last · mean · max of the first VISIBLE series. Only
 * for charts read along x (lines, areas, bars, columns); a donut or a point
 * cloud has no "last", so no strip.
 */
export function fullScreenKpis(
  spec: ChartSpec,
  hidden: ReadonlySet<number>,
  locale: string,
): Kpi[] {
  if (usesPoints(spec) || spec.type === "pie" || spec.type === "doughnut") return [];
  const k = spec.datasets.findIndex((_, i) => !hidden.has(i));
  if (k < 0) return [];
  const values = datasetValues(spec, k);
  const defined = values.flatMap((v, i) => (typeof v === "number" ? [i] : []));
  const lastAt = defined.at(-1);
  if (lastAt === undefined) return [];
  const w = chartUiWords(locale);
  const xs = xTexts(spec, locale)[k] ?? [];
  const format = { ...yFormat(spec, locale), format: "full" as const };
  const num = (i: number) => values[i] as number;
  const mean = defined.reduce((s, i) => s + num(i), 0) / defined.length;
  const maxAt = defined.reduce((m, i) => (num(i) > num(m) ? i : m), lastAt);
  const delta = k === 0 ? heroOf(spec, lastAt, locale).delta : undefined;
  const label = spec.datasets[k]?.label ?? "";
  return [
    {
      key: `${w.last} · ${xs[lastAt] ?? ""}`,
      value: formatNumber(num(lastAt), format),
      ...(delta === undefined ? {} : { delta }),
    },
    { key: `${w.mean} ${label}`.trim(), value: formatNumber(mean, format) },
    { key: w.max, value: formatNumber(num(maxAt), format), sub: xs[maxAt] ?? "" },
  ];
}

// ── VoiceOver: one element, two actions ─────────────────────────────────────

export type ChartA11yAction = "activate" | "showTable" | "showChart";

/** The element's custom actions; the table/chart one follows what is shown. */
export function chartA11yActions(
  mode: "chart" | "table",
  locale: string,
): { name: string; label: string }[] {
  const w = chartUiWords(locale);
  return [
    { name: "activate", label: w.open },
    mode === "chart"
      ? { name: "showTable", label: w.showTable }
      : { name: "showChart", label: w.showChart },
  ];
}

/** An action event's name → what the row does (unknown names do nothing). */
export function chartA11yEffect(name: string): ChartA11yAction | null {
  return name === "activate" || name === "showTable" || name === "showChart" ? name : null;
}

// ── Appear animation (rev 2 item 8): a descriptor, not code ─────────────────

export const SPRING = { damping: 14, stiffness: 170 } as const;
export const DRAW_MS = 900;
export const FADE_DELAY_MS = 550;
export const FADE_MS = 450;
export const REDUCED_MS = 280;
export const DONUT_FROM = 0.82;

export type ChartMotion =
  /** History rows, rows scrolled back into view: drawn still. */
  | { readonly kind: "still" }
  /** Reduce Motion: opacity 0 → 1 only. */
  | { readonly kind: "fade"; readonly ms: number }
  /** Lines: the stroke draws in, the rest fades in after it. */
  | {
      readonly kind: "draw";
      readonly ms: number;
      readonly fadeDelay: number;
      readonly fadeMs: number;
    }
  /** Bars and columns grow from their baseline with a spring. */
  | { readonly kind: "grow"; readonly axis: "x" | "y" }
  /** The donut scales up from 0.82 with a spring, fading in. */
  | { readonly kind: "pop"; readonly from: number };

export function chartMotion(
  kind: LayoutKind,
  flags: { readonly animate: boolean; readonly reduceMotion: boolean },
): ChartMotion {
  if (!flags.animate) return { kind: "still" };
  if (flags.reduceMotion) return { kind: "fade", ms: REDUCED_MS };
  switch (kind) {
    case "line":
    case "area":
    case "scatter":
      return { kind: "draw", ms: DRAW_MS, fadeDelay: FADE_DELAY_MS, fadeMs: FADE_MS };
    case "bars":
      return { kind: "grow", axis: "x" };
    case "columns":
    case "stacked":
      return { kind: "grow", axis: "y" };
    case "donut":
      return { kind: "pop", from: DONUT_FROM };
  }
}

/**
 * What `ui/chart/ChartAppear.tsx` animates for a motion, as plain data (the
 * component only maps it to `Animated`). `wipe` = the plot revealed left to
 * right over its width (the line's draw-in); `scale` = a spring from `from`
 * about `origin`; `opacity` = a 0 → 1 fade. Reduce Motion → opacity ONLY.
 */
export interface AppearPlan {
  readonly opacity?: { readonly ms: number; readonly delay: number };
  readonly wipe?: { readonly ms: number };
  readonly scale?: {
    readonly axis: "x" | "y" | "both";
    readonly from: number;
    readonly origin: "left" | "bottom" | "center";
  };
  /** Transforms and opacity run on the native driver; the wipe's width cannot. */
  readonly native: boolean;
}

export function appearPlan(motion: ChartMotion): AppearPlan | null {
  switch (motion.kind) {
    case "still":
      return null;
    case "fade":
      return { opacity: { ms: motion.ms, delay: 0 }, native: true };
    case "draw":
      return { wipe: { ms: motion.ms }, native: false };
    case "grow":
      return {
        scale: { axis: motion.axis, from: 0, origin: motion.axis === "x" ? "left" : "bottom" },
        native: true,
      };
    case "pop":
      return {
        scale: { axis: "both", from: motion.from, origin: "center" },
        opacity: { ms: FADE_MS, delay: 0 },
        native: true,
      };
  }
}

/** Full screen's plot box: the window minus the safe area, the header and the KPI strip. */
export function fullScreenPlotSize(
  window: { readonly width: number; readonly height: number },
  insets: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  },
  hasKpis: boolean,
): { width: number; height: number } {
  const SIDE = 16;
  const HEADER = 52;
  const KPIS = hasKpis ? 64 : 0;
  const width = Math.max(0, window.width - insets.left - insets.right - 2 * SIDE);
  const height = Math.max(120, window.height - insets.top - insets.bottom - HEADER - KPIS - 16);
  return { width, height };
}

/**
 * Whether this row plays its appear animation: once per call id, and only when
 * it is first seen LIVE (`running`). A row rebuilt from history arrives settled;
 * a row scrolled back into view was already seen. Records the id either way.
 */
export function claimAppear(seen: Set<string>, id: string, status: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return status === "running";
}

// ── Scrub: one responder event → what the view does ─────────────────────────

export interface ScrubOutcome {
  readonly state: ScrubState;
  /** The scrubbed index; `null` = at rest; `undefined` = unchanged. */
  readonly index?: number | null;
  readonly tick: boolean;
  /** Give the gesture back to the list (it scrolls). */
  readonly yield: boolean;
  /** A short press that never became a hold or a pan: open full screen. */
  readonly tap: boolean;
}

/** `reduceScrub` + the tap it does not model (an up while still pressing). */
export function scrubOutcome(
  state: ScrubState,
  event: ScrubEvent,
  hit: (x: number) => number | null,
): ScrubOutcome {
  const step = reduceScrub(state, event, hit);
  let index: number | null | undefined;
  let tick = false;
  let yielded = false;
  for (const e of step.effects) {
    if (e.kind === "index") index = e.index;
    else if (e.kind === "release") index = null;
    else if (e.kind === "haptic") tick = true;
    else yielded = true;
  }
  const tap = event.type === "up" && state.kind === "pressing";
  return {
    state: step.state,
    ...(index === undefined ? {} : { index }),
    tick,
    yield: yielded,
    tap,
  };
}

/** What the scrub driver calls out to: the haptic port and the view's setters. */
export interface ScrubPorts {
  readonly hit: (x: number) => number | null;
  /** The haptic port (`haptics.ts` `playHaptic` in the app, a spy in tests). */
  readonly play: (kind: "tick") => void;
  readonly onIndex: (index: number | null) => void;
  readonly onTap: () => void;
  readonly onYield: () => void;
}

export interface ScrubDriver {
  send(event: ScrubEvent): void;
  /** Still owning the gesture (pressing or scrubbing): the list must not take it. */
  holding(): boolean;
  scrubbing(): boolean;
}

/**
 * The scrub's state holder, React-free: the component forwards the responder's
 * events (and one HOLD_MS timer) here and renders what `onIndex` reports.
 * `ports` is read at every event, so a new layout (rotation) is picked up.
 */
export function createScrubDriver(ports: () => ScrubPorts): ScrubDriver {
  let state: ScrubState = SCRUB_IDLE;
  return {
    send(event) {
      const p = ports();
      const out = scrubOutcome(state, event, p.hit);
      state = out.state;
      if (out.index !== undefined) p.onIndex(out.index);
      if (out.tick) p.play("tick");
      if (out.yield) p.onYield();
      if (out.tap) p.onTap();
    },
    holding: () => state.kind === "pressing" || state.kind === "scrubbing",
    scrubbing: () => state.kind === "scrubbing",
  };
}

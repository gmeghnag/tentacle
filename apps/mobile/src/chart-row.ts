/**
 * A chart tool row on the phone (docs/feat/model-charts.md slice C6): the
 * decisions `ui/chart/ChartView.tsx` and the transcript branch need, pure and
 * React-free (AGENTS §7 "logic lives in pure modules").
 *
 * Owner rule (2026-11-16): a `chart` call does NOT render as a tool row — the
 * chart itself takes the row's place, with only its title as a caption. A spec
 * that does not re-validate (a pod can forge `rawInput`), and a failed or
 * refused call, keep the generic tool row.
 */
import { CHART_CAPS, type ChartSpec, seriesColor } from "@tentacle/core";
import { type ArtifactMeta, artifactKindOf } from "@tentacle/protocol";
import {
  type ChartLayout,
  type LabelMode,
  type LayoutText,
  type Paint,
  chartLayout,
  chartSpecOf,
} from "./chart-layout.ts";
import { type ChartTokens, type Palette, chartTokensFor, darkPalette } from "./theme.ts";

/** The tool's name (`packages/tools/src/chart.ts`). */
export const CHART_TOOL = "chart";

export type ChartScheme = "light" | "dark";

/** The fields of a transcript tool row the decision reads. */
export interface ChartToolRow {
  readonly name: string;
  readonly args: string;
  readonly status: string;
}

/** The validated spec when this tool row draws as a chart; `null` → the generic row. */
export function chartRowSpec(tool: ChartToolRow): ChartSpec | null {
  return drawsAsChart(tool) ? chartSpecOf(tool.args) : null;
}

/** The name/status half of the decision (the spec's validity is the other half). */
function drawsAsChart(tool: ChartToolRow): boolean {
  return tool.name === CHART_TOOL && tool.status !== "error" && tool.status !== "denied";
}

export function chartScheme(palette: Palette): ChartScheme {
  return palette === darkPalette ? "dark" : "light";
}

export interface ChartRowView {
  readonly layout: ChartLayout;
  /** The re-validated spec (full screen's toggles, KPIs, table Δ and CSV read it). */
  readonly spec: ChartSpec;
  readonly title: string;
  readonly subtitle?: string;
  readonly scheme: ChartScheme;
  readonly tokens: ChartTokens;
}

export interface ChartRowOptions {
  readonly width: number;
  readonly fontScale: number;
  readonly locale: string;
  readonly palette: Palette;
  /** Full screen (C7): the plot's height; the inline row lets the layout choose. */
  readonly height?: number;
  /** Full screen (C7): the series the reader switched off. */
  readonly hidden?: ReadonlySet<number>;
  /**
   * Where a line/area chart names its series (docs/feat/mobile-chart-labels.md
   * D7): the reader's setting. Absent → `"inside"`, today's default.
   */
  readonly labels?: LabelMode;
}

/**
 * Layouts already computed, by arguments + width + type scale + locale: a row
 * re-renders on every transcript update, and a 1 000-point spec is not free.
 * Bounded; the oldest entry goes first.
 */
const cache = new Map<string, { spec: ChartSpec; layout: ChartLayout }>();
const CACHE_MAX = 32;

/** Everything the chart row draws, or `null` (not a chart, invalid, no width yet). */
export function chartRowView(tool: ChartToolRow, options: ChartRowOptions): ChartRowView | null {
  if (!(options.width > 0) || !drawsAsChart(tool)) return null;
  const hidden = [...(options.hidden ?? [])].sort((a, b) => a - b).join(",");
  const labels: LabelMode = options.labels ?? "inside";
  const key = `${options.width}|${options.height ?? ""}|${hidden}|${options.fontScale}|${options.locale}|${labels}|${tool.args}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    const spec = chartSpecOf(tool.args);
    const layout =
      spec === null
        ? null
        : chartLayout(spec, {
            width: options.width,
            fontScale: options.fontScale,
            locale: options.locale,
            labels,
            ...(options.height === undefined ? {} : { height: options.height }),
            ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
          });
    if (spec === null || layout === null) return null;
    hit = { spec, layout };
    cache.set(key, hit);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return {
    layout: hit.layout,
    spec: hit.spec,
    title: hit.spec.title,
    ...(hit.spec.subtitle === undefined ? {} : { subtitle: hit.spec.subtitle }),
    scheme: chartScheme(options.palette),
    tokens: chartTokensFor(options.palette),
  };
}

/**
 * The gallery's thumbnail decision (docs/feat/model-charts.md C8): does this
 * artifact get a drawn tile? Only a `chart` artifact, and only one whose bytes
 * can hold a spec at all (`CHART_CAPS.bytes`, the same cap the validator
 * enforces) — so the tile never fetches bytes it could not draw.
 */
export function wantsChartThumbnail(meta: ArtifactMeta): boolean {
  return artifactKindOf(meta) === "chart" && meta.size <= CHART_CAPS.bytes;
}

/**
 * A chart ARTIFACT as the tile's view, or `null` — the gallery's cheap thumbnail.
 *
 * The bytes are the spec JSON the tool presented (`canonicalChartJson`), and they
 * go through the SAME `chartRowView` the transcript uses, so they are
 * re-validated here: a pod-forged or newer-than-this-build spec lays out
 * nothing (AGENTS §7), and the tile falls back to the card's glyph.
 */
export function chartThumbView(
  meta: ArtifactMeta,
  bytes: Uint8Array,
  options: ChartRowOptions,
): ChartRowView | null {
  if (artifactKindOf(meta) !== "chart") return null;
  return chartRowView(
    { name: CHART_TOOL, args: new TextDecoder().decode(bytes), status: "ok" },
    options,
  );
}

/** A layout colour: a palette slot in this mode, or a chart token. */
export function paintColor(paint: Paint, scheme: ChartScheme, tokens: ChartTokens): string {
  return "series" in paint ? seriesColor(paint.series, scheme) : tokens[paint.token];
}

/** A text's colour by its role: line-end names in their series' colour, ticks muted. */
export function textColor(text: LayoutText, scheme: ChartScheme, tokens: ChartTokens): string {
  if (text.strong === true) return tokens.label;
  switch (text.role) {
    case "direct":
      return text.series === undefined ? tokens.label : seriesColor(text.series, scheme);
    case "guide":
    case "x":
    case "percent":
    case "centerSub":
      return tokens.secondary;
    default:
      return tokens.label;
  }
}

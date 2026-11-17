/**
 * The phone's diagram theme (docs/feat/model-diagrams.md D5/D6): mermaid's
 * `themeVariables` for the `base` theme, per scheme, derived ONLY from the chart
 * tokens and the palette (P8, Owner Q5a — "the app owns colours and the mono
 * font").
 *
 * Why `base` and not `default`: mermaid's own themes pick their own colours.
 * `base` + explicit variables is the only way the diagram can sit on the
 * conversation background with no card, in both schemes, in the app's mono font.
 *
 * Pure: the variables are data (the renderer gets them through
 * `injectJavaScript`), so what the phone asks for is assertable without a WebView.
 */
import { seriesColor } from "@tentacle/core";
import { type ChartScheme, chartScheme } from "./chart-row.ts";
import { type ChartTokens, MONO, type Palette, chartTokensFor } from "./theme.ts";

/** Mermaid's `themeVariables` as the driver receives them: a flat string map. */
export type DiagramThemeVariables = Readonly<Record<string, string>>;

/** The theme the renderer is asked for: the base name, its variables, the cache key part. */
export interface DiagramTheme {
  /** Mermaid's theme name, always `"base"` (its other themes own the colours). */
  readonly theme: "base";
  readonly variables: DiagramThemeVariables;
  /** What the render's cache key adds: `base|dark`. A theme flip re-renders. */
  readonly key: string;
}

/** The body size the app's mono scale reads at (mermaid wants a string, with units). */
const FONT_SIZE = "13px";

/**
 * The pairs mermaid's `base` theme actually paints, mapped onto what we have:
 * a diagram sits ON the page (no card, no border fill), its lines/labels use the
 * chart's guide/label roles, and its accents are chart palette slots 1 and 2 —
 * never a new colour, and never a pure black in the dark scheme.
 */
export function diagramThemeVariables(palette: Palette): DiagramThemeVariables {
  const scheme: ChartScheme = chartScheme(palette);
  const t: ChartTokens = chartTokensFor(palette);
  const accent = seriesColor(0, scheme);
  const secondary = seriesColor(1, scheme);
  return {
    fontFamily: MONO,
    fontSize: FONT_SIZE,
    // The ground: the page the diagram is drawn on, so the SVG reads as part of
    // the reply and needs no card (the chart's own rule).
    background: palette.page,
    primaryColor: palette.page,
    mainBkg: palette.page,
    secondaryColor: palette.page,
    tertiaryColor: palette.page,
    // Text and lines.
    primaryTextColor: t.label,
    secondaryTextColor: t.secondary,
    tertiaryTextColor: t.secondary,
    textColor: t.label,
    lineColor: t.guideStrong,
    titleColor: t.label,
    // Nodes and their borders: outline in the page, the edge in the guide tone —
    // the "outline" look the owner picked (B's soft fill is the setting, D6).
    primaryBorderColor: t.guideStrong,
    secondaryBorderColor: t.guide,
    tertiaryBorderColor: t.guide,
    nodeBorder: t.guideStrong,
    nodeTextColor: t.label,
    // Flowchart clusters (subgraphs): a dim titled frame, slightly off the page.
    clusterBkg: t.surface,
    clusterBorder: t.guide,
    // Sequence lifelines and messages: the accents, the same two slots a chart's
    // first two series would use.
    actorBkg: palette.page,
    actorBorder: accent,
    actorTextColor: t.label,
    actorLineColor: t.guideStrong,
    signalColor: t.label,
    signalTextColor: t.label,
    labelBoxBkgColor: palette.page,
    labelBoxBorderColor: accent,
    labelTextColor: t.label,
    loopTextColor: t.secondary,
    noteBkgColor: t.track,
    noteBorderColor: t.guide,
    noteTextColor: t.label,
    // `alt`/`opt` blocks (the secondary accent marks them apart from the rest).
    activationBkgColor: t.seriesSoft,
    activationBorderColor: secondary,
    sequenceNumberColor: palette.page,
  };
}

/** Everything the renderer needs to draw in this mode (`base` + its variables). */
export function diagramTheme(palette: Palette): DiagramTheme {
  return {
    theme: "base",
    variables: diagramThemeVariables(palette),
    key: diagramThemeKey(palette),
  };
}

/** The scheme half of a render's cache key (D5's `diagramCacheKey` adds hash + scale). */
export function diagramThemeKey(palette: Palette): string {
  return `base|${chartScheme(palette)}`;
}

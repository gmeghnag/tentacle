/**
 * The chart full screen (docs/feat/model-charts.md D6, full screen B, slice
 * C7): a landscape-capable modal with the series toggles (colours never move),
 * a `Tabella` toggle, Share (CSV), the KPI strip (last · mean · max) and the
 * scrubbable plot. `ChartFullScreenView` is a dumb renderer (the render test
 * walks it); `ChartFullScreen` only holds the state.
 */
import { type JSX, useState } from "react";
import {
  type GestureResponderHandlers,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type ChartUiWords,
  type Kpi,
  type SeriesChip,
  chartA11yActions,
  chartA11yEffect,
  chartCsv,
  chartUiWords,
  fullScreenKpis,
  fullScreenPlotSize,
  highlightLayout,
  seriesChips,
  tableView,
  toggleHighlight,
  toggleSeries,
} from "../../chart-interact.ts";
import type { LabelMode } from "../../chart-layout-kit.ts";
import type { ScrubView } from "../../chart-layout.ts";
import {
  type ChartRowView,
  type ChartToolRow,
  chartRowSpec,
  chartRowView,
  paintColor,
} from "../../chart-row.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius, typography } from "../../theme.ts";
import { ChartTable } from "./ChartTable.tsx";
import { ChartHero, ChartLegend, ChartPlot } from "./ChartView.tsx";
import { useChartScrub } from "./useChartScrub.ts";

/** Portrait and landscape: the app sets no `orientation` (P9). */
export const FULL_SCREEN_ORIENTATIONS = ["portrait", "landscape"] as const;

export interface ChartFullScreenViewProps {
  readonly view: ChartRowView;
  readonly testID: string;
  /** The series highlighted by a legend tap (D3), for the item's `selected`. */
  readonly highlight?: number | null;
  readonly onHighlight?: (series: number) => void;
  readonly words: ChartUiWords;
  readonly chips: readonly SeriesChip[];
  readonly kpis: readonly Kpi[];
  readonly mode: "chart" | "table";
  readonly scrub: ScrubView | null;
  readonly plotHandlers?: GestureResponderHandlers;
  readonly reduceMotion: boolean;
  readonly locale: string;
  readonly palette: Palette;
  readonly insets: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly tableHeight: number;
  readonly onClose: () => void;
  readonly onToggle: (series: number) => void;
  readonly onMode: (mode: "chart" | "table") => void;
  readonly onShare: () => void;
}

export function ChartFullScreenView(p: ChartFullScreenViewProps): JSX.Element {
  const { view, testID, words, palette } = p;
  const { tokens, scheme } = view;
  const chipColor = (k: number) => {
    const path = view.layout.paths.find((q) => q.series === k && q.role !== "track");
    return paintColor(path?.paint ?? { series: k }, scheme, tokens);
  };
  return (
    <Modal
      visible
      testID={testID}
      animationType={p.reduceMotion ? "none" : "fade"}
      presentationStyle="fullScreen"
      supportedOrientations={[...FULL_SCREEN_ORIENTATIONS]}
      onRequestClose={p.onClose}
    >
      <View
        style={[
          styles.page,
          {
            backgroundColor: palette.page,
            paddingTop: p.insets.top + 6,
            paddingBottom: p.insets.bottom,
            paddingLeft: p.insets.left + 16,
            paddingRight: p.insets.right + 16,
          },
        ]}
      >
        {" "}
        <View style={styles.header}>
          <Pressable
            testID={`${testID}-close`}
            accessibilityRole="button"
            accessibilityLabel={words.close}
            hitSlop={10}
            onPress={p.onClose}
          >
            <Text style={[styles.icon, { color: tokens.label }]}>✕</Text>
          </Pressable>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.headline, styles.title, { color: tokens.label }]}
          >
            {view.title}
          </Text>
          {p.chips.map((c) => (
            <Pressable
              key={`chip${c.series}`}
              testID={`${testID}-chip-${c.series}`}
              accessibilityRole="switch"
              accessibilityState={{ checked: c.on }}
              accessibilityLabel={c.a11y}
              onPress={() => p.onToggle(c.series)}
              style={[styles.chip, { borderColor: tokens.guideStrong, opacity: c.on ? 1 : 0.45 }]}
            >
              <View
                style={[styles.dot, { backgroundColor: c.on ? chipColor(c.series) : tokens.track }]}
              />
              <Text
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[styles.chipText, { color: tokens.label }]}
              >
                {c.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            testID={`${testID}-table-toggle`}
            accessibilityRole="switch"
            accessibilityState={{ checked: p.mode === "table" }}
            accessibilityLabel={words.table}
            onPress={() => p.onMode(p.mode === "table" ? "chart" : "table")}
            style={[
              styles.chip,
              { borderColor: tokens.guideStrong },
              p.mode === "table" ? { backgroundColor: tokens.track } : null,
            ]}
          >
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.chipText, { color: tokens.label }]}
            >
              {words.table}
            </Text>
          </Pressable>
          <Pressable
            testID={`${testID}-share`}
            accessibilityRole="button"
            accessibilityLabel={words.share}
            hitSlop={10}
            onPress={p.onShare}
          >
            <Text style={[styles.icon, { color: tokens.label }]}>⇪</Text>
          </Pressable>
        </View>
        {p.scrub !== null ? (
          <ChartHero hero={p.scrub.hero} tokens={tokens} testID={`${testID}-scrub`} />
        ) : p.kpis.length === 0 ? null : (
          <View testID={`${testID}-kpis`} style={styles.kpis}>
            {p.kpis.map((k) => (
              <View key={k.key} style={styles.kpi}>
                <Text
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[styles.kpiKey, { color: tokens.secondary }]}
                >
                  {k.key}
                </Text>
                <Text
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[styles.kpiValue, { color: tokens.label }]}
                >
                  {k.value}
                </Text>
                {k.delta === undefined ? null : (
                  <Text
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    style={[styles.kpiKey, { color: k.delta.sign < 0 ? tokens.down : tokens.up }]}
                  >
                    {k.delta.text}
                  </Text>
                )}
                {k.sub === undefined ? null : (
                  <Text
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    style={[styles.kpiKey, { color: tokens.secondary }]}
                  >
                    {k.sub}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
        {p.mode === "table" || view.layout.legend === null ? null : (
          <ChartLegend
            view={view}
            testID={testID}
            {...(p.onHighlight === undefined ? {} : { onHighlight: p.onHighlight })}
            highlight={p.highlight ?? null}
          />
        )}
        {p.mode === "table" ? (
          <ChartTable
            table={tableView(view.spec, view.layout.table, p.locale)}
            tokens={tokens}
            testID={`${testID}-table`}
            maxHeight={p.tableHeight}
            summary={view.layout.summary}
            actions={chartA11yActions("table", p.locale)}
            onAction={(name) => {
              if (chartA11yEffect(name) === "showChart") p.onMode("chart");
            }}
          />
        ) : (
          <View
            testID={`${testID}-plot`}
            accessible
            accessibilityRole="image"
            accessibilityLabel={view.layout.summary}
            {...p.plotHandlers}
          >
            <ChartPlot view={view} testID={testID} scrub={p.scrub} />
          </View>
        )}
      </View>
    </Modal>
  );
}

export interface ChartFullScreenProps {
  readonly tool: ChartToolRow;
  readonly palette: Palette;
  readonly locale: string;
  readonly reduceMotion: boolean;
  readonly testID: string;
  readonly onClose: () => void;
  /** `"legend"` → the labels live in the legend above, which is where a tap highlights (D3). */
  readonly labels?: LabelMode;
}

/** The state: hidden series, the highlighted one, table mode, the scrub. Laid out at the window's size. */
export function ChartFullScreen(props: ChartFullScreenProps): JSX.Element | null {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Full screen lays out exactly like the row it came from: the SCREEN owns the
  // setting's subscription (`active-settings`' pattern) and hands the mode down,
  // so this holds no listener and stays walkable by the render test.
  const labels = props.labels ?? "inside";
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [highlight, setHighlight] = useState<number | null>(null);
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const spec = chartRowSpec(props.tool);
  const kpis = spec === null ? [] : fullScreenKpis(spec, hidden, props.locale);
  const size = fullScreenPlotSize(window, insets, kpis.length > 0);
  const base = chartRowView(props.tool, {
    width: size.width,
    height: size.height,
    hidden,
    fontScale: window.fontScale,
    locale: props.locale,
    palette: props.palette,
    labels,
  });
  // D3: a highlight is a projection of the layout — only where a legend exists
  // to produce one, and never a series the reader has just hidden.
  const shown =
    base === null || highlight === null || base.layout.legend === null
      ? base
      : { ...base, layout: highlightLayout(base.layout, base.spec, highlight, props.locale) };
  const { scrub, handlers } = useChartScrub(shown?.layout ?? null, () => {});
  if (shown === null || base === null || spec === null) return null;
  const view = shown;
  const words = chartUiWords(props.locale);
  return (
    <ChartFullScreenView
      view={view}
      testID={props.testID}
      words={words}
      chips={seriesChips(spec, hidden, props.locale)}
      kpis={kpis}
      mode={mode}
      scrub={scrub}
      plotHandlers={handlers}
      reduceMotion={props.reduceMotion}
      locale={props.locale}
      palette={props.palette}
      insets={insets}
      tableHeight={size.height}
      highlight={highlight}
      {...(base.layout.legend === null
        ? {}
        : { onHighlight: (k: number) => setHighlight((h) => toggleHighlight(h, k)) })}
      onClose={props.onClose}
      onToggle={(k) => {
        setHidden((h) => toggleSeries(h, k, spec.datasets.length));
        // Hiding the highlighted series clears the highlight: it would otherwise
        // keep the hero on a line that is no longer drawn.
        setHighlight((h) => (h === k ? null : h));
      }}
      onMode={setMode}
      onShare={() => {
        Share.share({ title: spec.title, message: chartCsv(spec) }).catch(() => undefined);
      }}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, flexWrap: "wrap" },
  title: { flex: 1, fontFamily: MONO },
  icon: { fontSize: 18, lineHeight: 22, paddingHorizontal: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontFamily: MONO, fontSize: 13, lineHeight: 18 },
  kpis: { flexDirection: "row", gap: 32 },
  kpi: { gap: 1 },
  kpiKey: { fontFamily: MONO, fontSize: 10, lineHeight: 13, letterSpacing: 0.6 },
  kpiValue: {
    fontFamily: MONO,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
});

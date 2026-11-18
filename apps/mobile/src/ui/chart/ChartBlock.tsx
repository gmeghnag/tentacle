/**
 * The inline chart's state (docs/feat/model-charts.md D6, slice C7): the scrub,
 * the in-place `Grafico | Tabella` toggle (table A), full screen on a tap or
 * VoiceOver's "activate", and the once-per-call appear animation. It holds
 * state only; `ChartView` draws, `chart-interact.ts` decides.
 */
import { type JSX, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  type ChartA11yAction,
  chartUiWords,
  claimAppear,
  highlightLayout,
  toggleHighlight,
} from "../../chart-interact.ts";
import type { LabelMode } from "../../chart-layout-kit.ts";
import type { ChartRowView, ChartToolRow } from "../../chart-row.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius } from "../../theme.ts";
import { ChartAppear, useReduceMotion } from "./ChartAppear.tsx";
import { ChartFullScreen } from "./ChartFullScreen.tsx";
import { ChartView } from "./ChartView.tsx";
import { useChartScrub } from "./useChartScrub.ts";

/** Call ids that already appeared (or were first seen settled) in this app run. */
const APPEARED = new Set<string>();

export interface ChartBlockProps {
  readonly view: ChartRowView;
  readonly tool: ChartToolRow & { readonly id: string };
  readonly palette: Palette;
  readonly locale: string;
  readonly testID: string;
  /** The Charts setting in force (D7), so full screen lays out the same way. */
  readonly labels?: LabelMode;
}

export function ChartBlock({
  view,
  tool,
  palette,
  locale,
  testID,
  labels,
}: ChartBlockProps): JSX.Element {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [full, setFull] = useState(false);
  // A (docs/feat/mobile-chart-labels.md D3): the series the reader tapped in the
  // legend. `null` at rest; a second tap on the same item goes back to rest.
  const [highlight, setHighlight] = useState<number | null>(null);
  const [animate] = useState(() => claimAppear(APPEARED, tool.id, tool.status));
  // Only A's legend can be tapped, so a highlight is only ever a projection of a
  // legend layout (C has no item to tap; the scrub is its interaction).
  const shown =
    highlight === null || view.layout.legend === null
      ? view
      : { ...view, layout: highlightLayout(view.layout, view.spec, highlight, locale) };
  // The scrub reads the SHOWN layout, so a scrubbed hero is `k`'s too (D6) and the
  // rest of the plot stays muted while a finger is down.
  const { scrub, handlers } = useChartScrub(shown.layout, () => setFull(true));
  // Unknown yet (null) counts as reduced: no transition is the safe default.
  const reduceMotion = useReduceMotion();
  const words = chartUiWords(locale);
  const onAction = (action: ChartA11yAction) => {
    if (action === "activate") setFull(true);
    else setMode(action === "showTable" ? "table" : "chart");
  };
  const segment = (m: "chart" | "table", label: string) => (
    <Pressable
      testID={`${testID}-seg-${m}`}
      accessibilityRole="button"
      accessibilityState={{ selected: mode === m }}
      onPress={() => setMode(m)}
      style={[styles.segment, mode === m ? { backgroundColor: view.tokens.track } : null]}
    >
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[
          styles.segmentText,
          { color: mode === m ? view.tokens.label : view.tokens.secondary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View>
      <ChartView
        view={shown}
        testID={testID}
        scrub={scrub}
        mode={mode}
        onAction={onAction}
        plotHandlers={handlers}
        locale={locale}
        {...(view.layout.legend === null
          ? {}
          : { onHighlight: (k: number) => setHighlight((h) => toggleHighlight(h, k)), highlight })}
        wrapPlot={(plot) => (
          <ChartAppear kind={view.layout.kind} animate={animate} width={view.layout.width}>
            {plot}
          </ChartAppear>
        )}
      />
      <View style={[styles.segments, { borderColor: view.tokens.guideStrong }]}>
        {segment("chart", words.chart)}
        {segment("table", words.table)}
      </View>
      {full ? (
        <ChartFullScreen
          tool={tool}
          palette={palette}
          locale={locale}
          reduceMotion={reduceMotion !== false}
          testID={`${testID}-full`}
          {...(labels === undefined ? {} : { labels })}
          onClose={() => setFull(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  segments: {
    flexDirection: "row",
    alignSelf: "flex-start",
    marginTop: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    padding: 2,
  },
  segment: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  segmentText: { fontFamily: MONO, fontSize: 12, lineHeight: 16 },
});

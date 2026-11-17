/**
 * The inline chart (docs/feat/model-charts.md D6 + *iPhone visual language
 * (rev 2)*, slice C6): a DUMB renderer of `chartRowView` — caption, hero and
 * the `<Svg>` of the pure layout. Straight on the conversation background: no
 * card, no frame (owner rule). Chart typography is monospace (owner, rev 2).
 *
 * Hook-free on purpose: every decision is in `chart-row.ts` / `chart-layout.ts` /
 * `chart-interact.ts`, and the render test walks this function directly. The
 * state (scrub, table toggle, full screen, appear) lives in `ChartBlock.tsx`;
 * this file draws whatever it is handed (C7).
 */
import type { JSX, ReactNode } from "react";
import { type GestureResponderHandlers, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { Hero } from "../../chart-hero.ts";
import {
  type ChartA11yAction,
  chartA11yActions,
  chartA11yEffect,
  tableView,
} from "../../chart-interact.ts";
import type { ChartLayout, LayoutDot, LayoutPath, ScrubView } from "../../chart-layout.ts";
import { type ChartRowView, type ChartScheme, paintColor, textColor } from "../../chart-row.ts";
import { type ChartTokens, DENSE_FONT_SCALE, MONO, radius, typography } from "../../theme.ts";
import { ChartTable } from "./ChartTable.tsx";

export interface ChartViewProps {
  readonly view: ChartRowView;
  readonly testID: string;
  /** Where the finger is (C7); the hero reads its values. */
  readonly scrub?: ScrubView | null;
  /** `table` draws the data table in the plot's place (table A). */
  readonly mode?: "chart" | "table";
  /** A VoiceOver custom action, by name (`chart-interact.ts`). */
  readonly onAction?: (action: ChartA11yAction) => void;
  /** The scrub's responder handlers, on the plot only. */
  readonly plotHandlers?: GestureResponderHandlers;
  /** Wraps the plot (the appear animation, `ChartAppear.tsx`). */
  readonly wrapPlot?: (plot: JSX.Element) => ReactNode;
  readonly locale?: string;
}

export function ChartView({
  view,
  testID,
  scrub = null,
  mode = "chart",
  onAction,
  plotHandlers,
  wrapPlot,
  locale = "it-IT",
}: ChartViewProps): JSX.Element {
  const { layout, tokens } = view;
  const plot = <ChartPlot view={view} testID={testID} scrub={scrub} />;
  return (
    <View
      testID={testID}
      style={styles.root}
      // One element reads the summary — in CHART mode only. In table mode the
      // table must be reachable row by row (its rows are their own elements),
      // so the root stops being an accessibility element there.
      accessible={mode === "chart"}
      accessibilityRole={mode === "chart" ? "image" : undefined}
      accessibilityLabel={layout.summary}
      accessibilityActions={mode === "table" ? undefined : chartA11yActions(mode, locale)}
      onAccessibilityAction={(e) => {
        const action = chartA11yEffect(e.nativeEvent.actionName);
        if (action !== null) onAction?.(action);
      }}
    >
      <Text
        testID={`${testID}-title`}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.headline, { color: tokens.label }]}
      >
        {view.title}
      </Text>
      {view.subtitle === undefined ? null : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, { color: tokens.secondary }]}
        >
          {view.subtitle}
        </Text>
      )}
      <ChartHero hero={scrub?.hero ?? layout.hero} tokens={tokens} testID={testID} />
      {mode === "table" ? (
        <ChartTable
          table={tableView(view.spec, layout.table, locale)}
          tokens={tokens}
          testID={`${testID}-table`}
          summary={layout.summary}
          actions={chartA11yActions("table", locale)}
          onAction={(name) => {
            const action = chartA11yEffect(name);
            if (action !== null) onAction?.(action);
          }}
        />
      ) : (
        <View testID={`${testID}-plot`} {...plotHandlers}>
          {wrapPlot === undefined ? plot : wrapPlot(plot)}
        </View>
      )}
      {mode === "table" ? null : <ChartLegend view={view} />}
    </View>
  );
}

/** The hero row (number, unit, delta pill, chip) and its context line. */
export function ChartHero({
  hero,
  tokens,
  testID,
}: {
  readonly hero: Hero;
  readonly tokens: ChartTokens;
  readonly testID: string;
}): JSX.Element {
  const delta = hero.delta;
  const deltaColor =
    delta === undefined || delta.sign === 0
      ? tokens.secondary
      : delta.sign > 0
        ? tokens.up
        : tokens.down;
  return (
    <>
      <View style={styles.heroRow}>
        <Text
          testID={`${testID}-hero`}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[styles.hero, { color: tokens.label }]}
        >
          {hero.unitBefore && hero.unit !== "" ? `${hero.unit}${hero.num}` : hero.num}
          {!hero.unitBefore && hero.unit !== "" ? (
            <Text style={[styles.unit, { color: tokens.secondary }]}>{` ${hero.unit}`}</Text>
          ) : null}
        </Text>
        {delta === undefined ? null : (
          <View style={[styles.pill, { backgroundColor: tokens.track }]}>
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.pillText, { color: deltaColor }]}
            >
              {delta.text}
            </Text>
          </View>
        )}
        {hero.chip === undefined ? null : (
          <View style={[styles.pill, { backgroundColor: tokens.track }]}>
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.pillText, { color: tokens.secondary }]}
            >
              {hero.chip}
            </Text>
          </View>
        )}
      </View>
      {hero.context === "" ? null : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, styles.mono, { color: tokens.secondary }]}
        >
          {hero.context}
        </Text>
      )}
    </>
  );
}

/** The `<Svg>` of the layout, plus the scrub's rule, dots and dim veil. */
export function ChartPlot({
  view,
  testID,
  scrub,
}: {
  readonly view: ChartRowView;
  readonly testID: string;
  readonly scrub: ScrubView | null;
}): JSX.Element {
  const { layout, scheme, tokens } = view;
  const color = (p: LayoutPath | LayoutDot) => paintColor(p.paint, scheme, tokens);
  // One gradient per series (a fill broken by nulls reuses its series' one).
  const gradientId = (p: LayoutPath) => `${testID}-g${p.role}${p.series}`;
  const keyOf = (p: LayoutPath) => `${p.role}${p.series}:${p.index ?? ""}:${p.d}`;
  return (
    <Svg width={layout.width} height={layout.height}>
      <Defs>
        {layout.paths.map((p, i, paths) =>
          p.gradient === undefined ||
          paths.findIndex((q) => gradientId(q) === gradientId(p)) !== i ? null : (
            <LinearGradient key={gradientId(p)} id={gradientId(p)} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color(p)} stopOpacity={p.gradient.from} />
              <Stop offset="1" stopColor={color(p)} stopOpacity={p.gradient.to} />
            </LinearGradient>
          ),
        )}
      </Defs>
      <G>
        {layout.guides.map((g) => (
          <Line
            key={`guide-${g.y}`}
            x1={g.x1}
            y1={g.y}
            x2={g.x2}
            y2={g.y}
            stroke={g.style === "dotted" ? tokens.guide : tokens.guideStrong}
            strokeWidth={1}
            strokeDasharray={g.style === "dotted" ? "1 3" : undefined}
            strokeLinecap="round"
          />
        ))}
        {layout.paths.map((p) =>
          p.strokeWidth !== undefined ? (
            <Path
              key={keyOf(p)}
              d={p.d}
              fill="none"
              stroke={color(p)}
              strokeWidth={p.strokeWidth}
              strokeDasharray={p.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={p.opacity}
            />
          ) : (
            <Path
              key={keyOf(p)}
              d={p.d}
              fill={p.gradient === undefined ? color(p) : `url(#${gradientId(p)})`}
              opacity={p.opacity}
            />
          ),
        )}
        {layout.dots.map((d, i) => (
          // By index: the list is static per layout, and equal points are legal.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <G key={`dot:${i}`}>
            {d.halo === undefined ? null : (
              <Circle cx={d.x} cy={d.y} r={d.halo.r} fill={color(d)} opacity={d.halo.opacity} />
            )}
            {d.ring === undefined ? null : (
              <Circle cx={d.x} cy={d.y} r={d.r + d.ring} fill={tokens.surface} />
            )}
            <Circle
              cx={d.x}
              cy={d.y}
              r={d.r}
              fill={d.hollow === true ? tokens.surface : color(d)}
              stroke={d.hollow === true ? color(d) : undefined}
              strokeWidth={d.hollow === true ? 1.5 : undefined}
              opacity={d.opacity}
            />
          </G>
        ))}
        {layout.texts.map((t) => (
          <SvgText
            key={`${t.role}:${t.x}:${t.y}:${t.text}`}
            x={t.x}
            y={t.y}
            fontSize={t.size}
            fontFamily={MONO}
            fontWeight={t.strong === true ? "600" : "400"}
            textAnchor={t.anchor}
            fill={textColor(t, scheme, tokens)}
          >
            {t.text}
          </SvgText>
        ))}
      </G>
      {scrub === null ? null : (
        <ScrubMarks layout={layout} scrub={scrub} view={view} testID={testID} />
      )}
    </Svg>
  );
}

/** Stocks-style scrub (A): the curve right of the finger veiled, a rule, a dot per series. */
function ScrubMarks({
  layout,
  scrub,
  view,
  testID,
}: {
  readonly layout: ChartLayout;
  readonly scrub: ScrubView;
  readonly view: ChartRowView;
  readonly testID: string;
}): JSX.Element {
  const { tokens, scheme } = view;
  const { plot } = layout;
  return (
    <G>
      {scrub.dimFromX === null ? null : (
        <Rect
          testID={`${testID}-dim`}
          x={scrub.dimFromX}
          y={plot.top}
          width={Math.max(0, plot.right - scrub.dimFromX)}
          height={Math.max(0, plot.bottom - plot.top)}
          fill={tokens.surface}
          opacity={0.7}
        />
      )}
      <Line
        testID={`${testID}-rule`}
        x1={scrub.x}
        y1={plot.top}
        x2={scrub.x}
        y2={plot.bottom}
        stroke={tokens.guideStrong}
        strokeWidth={1}
      />
      {scrub.dots.map((d) => (
        <G key={`scrub:${d.series}`}>
          {d.halo === undefined ? null : (
            <Circle
              cx={d.x}
              cy={d.y}
              r={d.halo.r}
              fill={dotColor(d, scheme, tokens)}
              opacity={d.halo.opacity}
            />
          )}
          <Circle cx={d.x} cy={d.y} r={d.r + (d.ring ?? 0)} fill={tokens.surface} />
          <Circle
            cx={d.x}
            cy={d.y}
            r={d.r}
            fill={dotColor(d, scheme, tokens)}
            opacity={d.opacity}
          />
        </G>
      ))}
    </G>
  );
}

const dotColor = (d: LayoutDot, scheme: ChartScheme, tokens: ChartTokens) =>
  paintColor(d.paint, scheme, tokens);

/** The fallback legend row (when direct labels cannot fit). */
function ChartLegend({ view }: { readonly view: ChartRowView }): JSX.Element | null {
  const { layout, scheme, tokens } = view;
  return (
    <>
      {layout.legend === null ? null : (
        <View style={styles.legend}>
          {layout.legend.map((item) => (
            <View key={`l${item.series}`} style={styles.legendItem}>
              <View
                style={[styles.swatch, { backgroundColor: paintColor(item.paint, scheme, tokens) }]}
              />
              <Text
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.caption, styles.mono, { color: tokens.secondary }]}
              >
                {item.label}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: "stretch", gap: 2 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  hero: {
    fontFamily: MONO,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  unit: { fontFamily: MONO, fontSize: 17, fontWeight: "400" },
  pill: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontFamily: MONO, fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  mono: { fontFamily: MONO },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
});

/**
 * The inline chart (docs/feat/model-charts.md D6 + *iPhone visual language
 * (rev 2)*, slice C6): a DUMB renderer of `chartRowView` — caption, hero and
 * the `<Svg>` of the pure layout. Straight on the conversation background: no
 * card, no frame (owner rule). Chart typography is monospace (owner, rev 2).
 *
 * Hook-free on purpose: every decision is in `chart-row.ts` / `chart-layout.ts`,
 * and the render test walks this function directly. Full screen, scrub, table
 * and the appear animation are slice C7.
 */
import type { JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { LayoutDot, LayoutPath } from "../../chart-layout.ts";
import { type ChartRowView, paintColor, textColor } from "../../chart-row.ts";
import { DENSE_FONT_SCALE, MONO, radius, typography } from "../../theme.ts";

export interface ChartViewProps {
  readonly view: ChartRowView;
  readonly testID: string;
}

export function ChartView({ view, testID }: ChartViewProps): JSX.Element {
  const { layout, scheme, tokens } = view;
  const color = (p: LayoutPath | LayoutDot) => paintColor(p.paint, scheme, tokens);
  // One gradient per series (a fill broken by nulls reuses its series' one).
  const gradientId = (p: LayoutPath) => `${testID}-g${p.role}${p.series}`;
  const keyOf = (p: LayoutPath) => `${p.role}${p.series}:${p.index ?? ""}:${p.d}`;
  const hero = layout.hero;
  const delta = hero.delta;
  const deltaColor =
    delta === undefined || delta.sign === 0
      ? tokens.secondary
      : delta.sign > 0
        ? tokens.up
        : tokens.down;
  return (
    <View
      testID={testID}
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel={layout.summary}
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
      </Svg>
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
    </View>
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

/**
 * The gallery's chart TILE (docs/feat/model-charts.md slice C8): a dumb renderer
 * of `chartThumbView`'s layout — the PLOT only, no caption, no axis text.
 *
 * A 44 pt tile cannot hold a title, a hero or a tick: the row above it already
 * says the title, and the full-screen chart is one tap away. What is here is
 * the shape (so a person recognises the chart at a glance), the series colours
 * (the same palette as everywhere) and one accessibility label (the layout's own
 * summary), never a decision (AGENTS §7).
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { G, Line, Path } from "react-native-svg";
import type { LayoutDot, LayoutPath } from "../../chart-layout.ts";
import { type ChartRowView, paintColor } from "../../chart-row.ts";
import { SeriesGlyph } from "./SeriesGlyph.tsx";

export interface ChartThumbnailProps {
  readonly view: ChartRowView;
  readonly testID: string;
}

export function ChartThumbnail({ view, testID }: ChartThumbnailProps): JSX.Element {
  const { layout, scheme, tokens } = view;
  const color = (p: LayoutPath | LayoutDot) => paintColor(p.paint, scheme, tokens);
  const keyOf = (p: LayoutPath) => `${p.role}${p.series}:${p.index ?? ""}:${p.d}`;
  return (
    <View
      testID={testID}
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel={layout.summary}
    >
      <Svg width={layout.width} height={layout.height}>
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
            p.strokeWidth === undefined ? (
              // A filled shape (a bar, a sector, an area) is drawn flat, never
              // with its gradient: at 44 pt a gradient reads as a smudge.
              <Path key={keyOf(p)} d={p.d} fill={color(p)} opacity={p.opacity} />
            ) : (
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
            ),
          )}
          {layout.dots.map((d) => (
            <G key={`dot${d.series}:${d.x}:${d.y}`}>
              <SeriesGlyph
                shape={d.shape ?? "circle"}
                x={d.x}
                y={d.y}
                r={d.r}
                fill={d.hollow === true ? "none" : color(d)}
                {...(d.hollow === true ? { outline: color(d) } : {})}
                opacity={d.opacity}
              />
            </G>
          ))}
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
});

/**
 * The gallery's chart TILE (docs/feat/model-charts.md slice C8,
 * docs/feat/mobile-gallery-polish.md): a dumb renderer of `chartThumbAt`'s
 * drawing — the chart's MARKS only (no legend, no caption, no axis text, no
 * guide), scaled into the tile through the view box `chart-thumb.ts` proved
 * holds every mark, and clipped to the tile all the same.
 *
 * What is here is the shape (so a person recognises the chart at a glance), the
 * series colours (the same palette as everywhere) and one accessibility label
 * (the layout's own summary), never a decision (AGENTS §7).
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import type { LayoutDot, LayoutPath } from "../../chart-layout.ts";
import { paintColor } from "../../chart-row.ts";
import { type ChartThumbView, viewBoxAttr } from "../../chart-thumb.ts";
import { SeriesGlyph } from "./SeriesGlyph.tsx";

export interface ChartThumbnailProps {
  readonly thumb: ChartThumbView;
  readonly testID: string;
}

export function ChartThumbnail({ thumb, testID }: ChartThumbnailProps): JSX.Element {
  const { layout, scheme, tokens } = thumb.view;
  const color = (p: LayoutPath | LayoutDot) => paintColor(p.paint, scheme, tokens);
  const keyOf = (p: LayoutPath) => `${p.role}${p.series}:${p.index ?? ""}:${p.d}`;
  return (
    <View
      testID={testID}
      style={[styles.root, { width: thumb.width, height: thumb.height }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={layout.summary}
    >
      <Svg
        width={thumb.width}
        height={thumb.height}
        viewBox={viewBoxAttr(thumb.viewBox)}
        preserveAspectRatio="xMidYMid meet"
      >
        <G>
          {thumb.paths.map((p) =>
            p.strokeWidth === undefined ? (
              // A filled shape (a bar, a sector, an area) is drawn flat, never
              // with its gradient: at tile size a gradient reads as a smudge.
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
          {thumb.dots.map((d) => (
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
  // `overflow: hidden`: the view box already holds every mark; the clip is the
  // tile's own guarantee that nothing it draws can reach the rows below.
  root: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});

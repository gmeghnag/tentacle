/**
 * A series' marker glyph (docs/feat/mobile-chart-labels.md D5): the mockup's
 * solid ● / ■ / ▲, one per series slot, so colour is never the only channel
 * that ties a label, a legend item or an end dot to its line.
 *
 * A dumb mapping and nothing else: the shape is decided in
 * `chart-layout-axis.ts` (`markShape`), it arrives as `LayoutDot.shape` /
 * `LayoutText.shape` / `LegendItem.shape`, and this file draws it.
 */
import type { JSX } from "react";
import { Circle, Path, Rect } from "react-native-svg";
import type { DotShape } from "../../chart-layout-kit.ts";

export interface SeriesGlyphProps {
  readonly shape: DotShape;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** The marker's body; a hollow marker passes the page colour here. */
  readonly fill: string;
  /** A hollow marker's outline, in the series' colour. */
  readonly outline?: string;
  readonly opacity?: number;
}

export function SeriesGlyph({
  shape,
  x,
  y,
  r,
  fill,
  outline,
  opacity,
}: SeriesGlyphProps): JSX.Element {
  const paint = {
    fill,
    ...(outline === undefined ? {} : { stroke: outline, strokeWidth: 1.5 }),
    ...(opacity === undefined ? {} : { opacity }),
  };
  if (shape === "square") {
    return <Rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={r * 0.25} {...paint} />;
  }
  if (shape === "triangle") {
    const half = r * 0.95;
    return (
      <Path
        d={`M${x},${y - r}L${x + half},${y + r * 0.75}L${x - half},${y + r * 0.75}Z`}
        {...paint}
      />
    );
  }
  return <Circle cx={x} cy={y} r={r} {...paint} />;
}

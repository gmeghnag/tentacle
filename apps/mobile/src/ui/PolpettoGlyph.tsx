/**
 * Polpetto's silhouette as a 9x9 grid of cells, one ink (docs/fix/mobile-ask-surfaces.md
 * D4). The mask is `polpetto-glyph.ts`'s; this only draws it. Render only.
 */
import type { JSX } from "react";
import { View } from "react-native";
import { polpettoMask } from "../polpetto-glyph.ts";

const MASK = polpettoMask();

export function PolpettoGlyph({
  color,
  size = 18,
}: {
  readonly color: string;
  readonly size?: number;
}): JSX.Element {
  const cell = size / MASK.length;
  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {MASK.map((row, y) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid's position is its identity
        <View key={y} style={{ flexDirection: "row", height: cell }}>
          {row.map((on, x) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid's position is its identity
              key={x}
              style={{ width: cell, height: cell, backgroundColor: on ? color : "transparent" }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

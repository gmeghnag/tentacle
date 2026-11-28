/**
 * The transcript's `CellRendererComponent`: the stock cell wrapper plus a record
 * of each cell's top/height in CONTENT coordinates (its `onLayout` y), which the
 * sticky step row (`output-sticky.ts`) needs. No render, no state: it writes a map.
 */
import type { JSX } from "react";
import { View, type ViewProps } from "react-native";
import type { ListItem } from "../../tool-steps.ts";

export interface CellRect {
  readonly top: number;
  readonly height: number;
}

type CellProps = ViewProps & {
  readonly item?: ListItem;
  readonly cellKey?: string;
  readonly index?: number;
};

export function measuredCell(rects: Map<string, CellRect>): (props: CellProps) => JSX.Element {
  return function MeasuredCell({ item, cellKey: _k, index: _i, onLayout, ...rest }: CellProps) {
    return (
      <View
        {...rest}
        onLayout={(event) => {
          if (item !== undefined) {
            const { y, height } = event.nativeEvent.layout;
            rects.set(item.key, { top: y, height });
          }
          onLayout?.(event);
        }}
      />
    );
  };
}

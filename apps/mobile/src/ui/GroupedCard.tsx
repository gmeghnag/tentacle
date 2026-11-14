/**
 * The 26 pt inset grouped card (docs/feat/mobile-ui-polish.md Design 2). Children
 * are `Row`s; the card clips them and draws nothing else. Render only.
 */
import type { JSX, ReactNode } from "react";
import { View } from "react-native";
import { type Palette, radius, space } from "../theme.ts";

export interface GroupedCardProps {
  readonly palette: Palette;
  readonly children: ReactNode;
  readonly testID?: string;
  /** Surface override (a sheet's card is `fill`). */
  readonly surface?: string;
}

export function GroupedCard({ palette, children, testID, surface }: GroupedCardProps): JSX.Element {
  return (
    <View
      testID={testID}
      style={{
        marginHorizontal: space.inset,
        borderRadius: radius.card,
        overflow: "hidden",
        backgroundColor: surface ?? palette.card,
      }}
    >
      {children}
    </View>
  );
}

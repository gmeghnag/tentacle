/**
 * A grouped list's section header (docs/feat/mobile-ui-polish.md Design 2):
 * uppercase 13 pt `sec`, inset to the card's text. Render only.
 */
import type { JSX } from "react";
import { Text } from "react-native";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";

export function SectionHeader({
  palette,
  title,
  testID,
}: {
  readonly palette: Palette;
  readonly title: string;
  readonly testID?: string;
}): JSX.Element {
  return (
    <Text
      testID={testID}
      accessibilityRole="header"
      maxFontSizeMultiplier={DENSE_FONT_SCALE}
      style={[
        typography.section,
        {
          color: palette.sec,
          textTransform: "uppercase",
          paddingHorizontal: space.inset + space.cardInner,
          paddingBottom: 7,
        },
      ]}
    >
      {title}
    </Text>
  );
}

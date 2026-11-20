/**
 * The small status pill (docs/feat/mobile-ui-polish.md Design 2): `tint` bg,
 * `accent` text, optional leading dot — "1 running". `neutral` is the grey
 * "Idle" variant. Replaces the filled accent badges. Render only.
 */
import type { JSX } from "react";
import { View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, radius, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export function Pill({
  palette,
  text,
  dot = false,
  tone = "accent",
  testID,
}: {
  readonly palette: Palette;
  readonly text: string;
  readonly dot?: boolean;
  readonly tone?: "accent" | "neutral" | "warn";
  readonly testID?: string;
}): JSX.Element {
  const bg = tone === "accent" ? palette.tint : tone === "warn" ? palette.warnBg : palette.fill;
  const fg = tone === "accent" ? palette.accent : tone === "warn" ? palette.warnText : palette.sec;
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 9,
        minHeight: 22,
        borderRadius: radius.pill,
        backgroundColor: bg,
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} /> : null}
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.caption, { color: fg, fontWeight: "600" }]}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * The strip above the composer while the browser acts alone or shows secrets
 * (docs/feat/browser-inspect.md B6b, owner Q4-B): square, full width, a glyph
 * and the words (never a colour alone), and `Change ›` to the Browser page.
 * Render only (AGENTS §7): whether it shows and what it says is
 * `browser-view.ts`'s `riskStripItems`.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface RiskStripProps {
  readonly palette: Palette;
  readonly items: readonly string[];
  readonly onChange: () => void;
}

export function RiskStrip({ palette, items, onChange }: RiskStripProps): JSX.Element {
  return (
    <View testID="risk-strip" style={[styles.strip, { backgroundColor: palette.warnBg }]}>
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, styles.words, { color: palette.warnText }]}
      >
        ▲ {items.join(" · ")}
      </Text>
      <Pressable
        testID="risk-strip-change"
        accessibilityRole="button"
        accessibilityLabel="Change the browser switches"
        hitSlop={10}
        onPress={onChange}
      >
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, styles.change, { color: palette.warnText }]}
        >
          Change ›
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.inset,
    paddingVertical: 8,
  },
  words: { flex: 1 },
  change: { fontWeight: "600" },
});

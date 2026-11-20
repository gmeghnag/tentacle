/**
 * The header's Activity pill (docs/feat/mobile-chrome.md Design 5, F1): a spinner
 * while something runs, then the count (or "n new" for unread reports), on
 * `tint` with `accent` text. Whether it is drawn and what it says is decided in
 * `activity.ts`; this file owns only the look.
 */
import type { JSX } from "react";
import { ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { DENSE_FONT_SCALE, type Palette, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface ActivityBadgeProps {
  readonly palette: Palette;
  readonly label: string;
  readonly running: boolean;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly testID?: string;
}

export function ActivityBadge({
  palette,
  label,
  running,
  accessibilityLabel,
  onPress,
  testID,
}: ActivityBadgeProps): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens running sub-agents and jobs"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: palette.tint },
        pressed ? { opacity: 0.5 } : undefined,
      ]}
    >
      {running ? <ActivityIndicator size="small" color={palette.accent} /> : null}
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        numberOfLines={1}
        style={[typography.footnote, styles.label, { color: palette.accent }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
  },
  label: { fontWeight: "600" },
});

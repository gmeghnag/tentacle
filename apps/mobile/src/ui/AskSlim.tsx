/**
 * The one-row ask (docs/fix/mobile-ask-surfaces.md D4): the peek detent's form and
 * the banner under the header. Never draws Allow/Deny — the command is not seen
 * from here, so nothing is answered from this row. Render only.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { type Palette, radius, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

export interface AskSlimProps {
  readonly palette: Palette;
  readonly title: string;
  readonly originShort: string;
  /** Asks queued behind this one (0: none). */
  readonly more: number;
  /** The row's action word (`Review`, `Open`). */
  readonly actionLabel: string;
  readonly onPress: () => void;
  readonly testID: string;
}

export function AskSlim({
  palette,
  title,
  originShort,
  more,
  actionLabel,
  onPress,
  testID,
}: AskSlimProps): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${originShort}. ${actionLabel}`}
      onPress={onPress}
      style={[styles.row, { backgroundColor: palette.tint }]}
    >
      <Icon name="hand.raised" color={palette.accent} size={18} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[typography.subhead, { color: palette.label }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[typography.footnote, { color: palette.sec }]}>
          {more > 0 ? `${originShort} · +${more}` : originShort}
        </Text>
      </View>
      <Text style={[typography.subhead, { color: palette.accent }]}>{actionLabel}</Text>
      <Icon name="chevron.up" color={palette.accent} size={12} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.tile,
  },
  text: { flex: 1 },
});

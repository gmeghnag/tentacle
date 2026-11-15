/**
 * A tool call's row (mockup `Conversation`): 48 pt, 14 radius, a hairline
 * border — status icon · name (15/600) · mono target (one line) · trailing ·
 * chevron. A running call sits on `tint` with a spinner. Every value comes from
 * `tool-summary.ts` (`toolSummary` / `toolMeta`); this file owns only the look.
 */
import type { JSX } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, radius, typography } from "../theme.ts";
import type { ToolTone } from "../tool-summary.ts";
import { Icon } from "./Icon.tsx";

export interface ToolRowProps {
  readonly palette: Palette;
  readonly label: string;
  readonly subtitle: string;
  readonly trailing: string;
  readonly tone: ToolTone;
  /** Has something to expand (output, a reply): draws the chevron. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly onPress: () => void;
  /** On the label: `tool-<callId>-<status>` (the flows' contract). */
  readonly labelTestID: string;
}

function StatusIcon({ tone, palette }: { tone: ToolTone; palette: Palette }): JSX.Element {
  switch (tone) {
    case "ok":
      return <Icon name="checkmark.circle" color={palette.green} size={18} />;
    case "error":
      return <Icon name="exclamationmark.triangle" color={palette.red} size={17} />;
    case "running":
      return <ActivityIndicator size="small" color={palette.accent} />;
    default:
      return <Icon name="clock" color={palette.sec} size={17} />;
  }
}

export function ToolRow({
  palette,
  label,
  subtitle,
  trailing,
  tone,
  expandable,
  expanded,
  onPress,
  labelTestID,
}: ToolRowProps): JSX.Element {
  const running = tone === "running";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={expandable ? { expanded } : undefined}
      accessibilityLabel={`${label} ${subtitle} ${trailing}`.trim()}
      disabled={!expandable}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: running ? palette.tint : palette.sep,
          backgroundColor: running ? palette.tint : palette.page,
        },
        pressed ? { opacity: 0.6 } : undefined,
      ]}
    >
      <View style={styles.icon}>
        <StatusIcon tone={tone} palette={palette} />
      </View>
      <Text
        testID={labelTestID}
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.subheadStrong, styles.label, { color: palette.label }]}
      >
        {label}
      </Text>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.mono, styles.subtitle, { color: palette.sec }]}
      >
        {subtitle}
      </Text>
      {trailing === "" ? null : (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, { color: tone === "error" ? palette.red : palette.sec }]}
        >
          {trailing}
        </Text>
      )}
      {expandable ? (
        <Icon name={expanded ? "chevron.down" : "chevron.right"} color={palette.sec} size={13} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  icon: { width: 20, alignItems: "center" },
  label: { flexShrink: 0, maxWidth: "40%" },
  subtitle: { flex: 1 },
});

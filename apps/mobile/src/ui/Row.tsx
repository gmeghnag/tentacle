/**
 * One grouped-list row (docs/feat/mobile-ui-polish.md Design 2): optional 32 pt
 * icon tile, title (17), optional mono subtitle (13, `sec`), a trailing slot
 * (pill / text / switch) and a chevron. Min height, never a fixed one, so
 * Dynamic Type grows it. The hairline separator is inset 60 pt after a tile,
 * 16 pt otherwise, and is not drawn above the first row. Render only.
 */
import type { JSX, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MONO, type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

export interface RowProps {
  readonly palette: Palette;
  readonly title: string;
  readonly subtitle?: string;
  /** The subtitle is a path/command (mono) rather than prose. */
  readonly subtitleMono?: boolean;
  readonly icon?: IconName;
  /** A tile drawn dashed (an unreachable/cached entry). */
  readonly iconDashed?: boolean;
  readonly trailing?: ReactNode;
  readonly chevron?: boolean;
  /** Cached/offline: title and tile in `sec`. */
  readonly dimmed?: boolean;
  /** `destructive`: the title in `red`; `accent`: an action row ("Pair a computer"). */
  readonly tone?: "default" | "accent" | "destructive";
  readonly first?: boolean;
  readonly minHeight?: number;
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly titleWeight?: "400" | "600";
  /** Extra content under the title block (a status line with its own testID). */
  readonly children?: ReactNode;
}

export function Row({
  palette,
  title,
  subtitle,
  subtitleMono = false,
  icon,
  iconDashed = false,
  trailing,
  chevron = false,
  dimmed = false,
  tone = "default",
  first = false,
  minHeight = SIZE.rowProject,
  onPress,
  onLongPress,
  testID,
  accessibilityLabel,
  accessibilityHint,
  titleWeight = "400",
  children,
}: RowProps): JSX.Element {
  const titleColor =
    tone === "destructive"
      ? palette.red
      : tone === "accent"
        ? palette.accent
        : dimmed
          ? palette.sec
          : palette.label;
  const tileColor = dimmed ? palette.sec : palette.accent;
  const separatorInset = icon === undefined ? space.separatorPlain : space.separatorAfterTile;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress === undefined ? undefined : "button"}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={onPress === undefined && onLongPress === undefined}
      style={({ pressed }) => [
        styles.row,
        { minHeight, backgroundColor: pressed ? palette.fill : "transparent" },
      ]}
    >
      {first ? null : (
        <View style={[styles.separator, { left: separatorInset, backgroundColor: palette.sep }]} />
      )}
      {icon === undefined ? null : (
        <View
          style={[
            styles.tile,
            iconDashed
              ? { borderWidth: 1.5, borderStyle: "dashed", borderColor: palette.dash }
              : { backgroundColor: palette.tint },
          ]}
        >
          <Icon name={icon} color={tileColor} size={18} />
        </View>
      )}
      <View style={styles.text}>
        <Text
          numberOfLines={2}
          style={[typography.body, { color: titleColor, fontWeight: titleWeight }]}
        >
          {title}
        </Text>
        {subtitle === undefined || subtitle === "" ? null : (
          <Text
            numberOfLines={2}
            style={[
              subtitleMono ? typography.mono : typography.footnote,
              { color: palette.sec },
              subtitleMono ? { fontFamily: MONO } : null,
            ]}
          >
            {subtitle}
          </Text>
        )}
        {children}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron.right" color={palette.sep} size={14} weight="bold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: space.cardInner,
    paddingVertical: 10,
  },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth },
  tile: {
    width: SIZE.iconTile,
    height: SIZE.iconTile,
    borderRadius: radius.iconTile,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, gap: 2 },
});

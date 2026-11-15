/**
 * The header's bare icon button (docs/feat/mobile-chrome.md Design 2, A1): a
 * 44 pt `Pressable` — the touch target is unchanged — with a bare `Icon` on top
 * of it: no fill, no border, no shadow, no blur. Pressed is 0.5 opacity.
 *
 * `GlassButton` survives for the FAB and the over-camera chrome only; every
 * header button in the app is this one, so the chrome reads with ONE weight
 * (thin glyphs, `light` by default). A text button (`Cancel` on Pair) is the same
 * seam with `label` instead of `icon`, so the app has one header-button look.
 * Render only (AGENTS §7).
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

export interface HeaderIconProps {
  readonly palette: Palette;
  /** Required: an icon-only button is otherwise silent to VoiceOver. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  /** The glyph to draw. Ignored when `label` is given. */
  readonly icon?: IconName;
  /** A text button (`Cancel`) instead of a glyph. */
  readonly label?: string;
  /** `accent` for a primary action (Computers' "+"): the glyph in the accent. */
  readonly tone?: "label" | "accent";
  /** The glyph box, in points. A1's header glyphs are 22 (`light`). */
  readonly size?: number;
  readonly weight?: "thin" | "light" | "regular" | "semibold" | "bold";
  readonly testID?: string;
  readonly onLongPress?: () => void;
  readonly disabled?: boolean;
}

export function HeaderIcon({
  palette,
  accessibilityLabel,
  onPress,
  icon = "ellipsis",
  label,
  tone = "label",
  size = 22,
  weight = "light",
  testID,
  onLongPress,
  disabled = false,
}: HeaderIconProps): JSX.Element {
  const color = tone === "accent" ? palette.accent : palette.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => [styles.base, { opacity: disabled ? 0.35 : pressed ? 0.5 : 1 }]}
    >
      {label === undefined ? (
        <Icon name={icon} color={color} size={size} weight={weight} />
      ) : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={1}
          style={[typography.headline, { color }]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: SIZE.touch,
    minHeight: SIZE.touch,
    alignItems: "center",
    justifyContent: "center",
  },
});

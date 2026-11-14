/**
 * The mockups' round glass button (docs/feat/mobile-ui-polish.md Design 2): 44 pt
 * (56 pt `fab`), the `glass` fill with a 1 px `glassBorder` and a soft shadow.
 * The translucent colour is the blur fallback the owner named (Q4) — `expo-blur`
 * is a native add-on not installed yet (see `Icon.tsx`). Render only.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { type Palette, size as SIZE, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

export interface GlassButtonProps {
  readonly palette: Palette;
  /** Required: an icon-only button is otherwise silent to VoiceOver. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly icon?: IconName;
  /** A text button (`Cancel`) instead of an icon. */
  readonly label?: string;
  /** `accent`: the icon/text in the accent colour (the "+" of Computers). */
  readonly tone?: "label" | "accent";
  readonly variant?: "icon" | "fab";
  /** Over the camera: always the dark glass. */
  readonly onDark?: boolean;
  readonly testID?: string;
  readonly onLongPress?: () => void;
}

export function GlassButton({
  palette,
  accessibilityLabel,
  onPress,
  icon,
  label,
  tone = "label",
  variant = "icon",
  onDark = false,
  testID,
  onLongPress,
}: GlassButtonProps): JSX.Element {
  const diameter = variant === "fab" ? SIZE.fab : SIZE.touch;
  const color = onDark ? "#FFFFFF" : tone === "accent" ? palette.accent : palette.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        {
          height: diameter,
          minWidth: diameter,
          borderRadius: diameter / 2,
          paddingHorizontal: label === undefined ? 0 : 16,
          backgroundColor: onDark ? "rgba(44,44,46,0.72)" : palette.glass,
          borderColor: onDark ? "rgba(255,255,255,0.16)" : palette.glassBorder,
          shadowOpacity: onDark ? 0 : palette.shadowOpacity,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      {label === undefined ? (
        <Icon name={icon ?? "ellipsis"} color={color} size={variant === "fab" ? 24 : 20} />
      ) : (
        <Text maxFontSizeMultiplier={1.4} style={[typography.headline, { color }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 20,
  },
});

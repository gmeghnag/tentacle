/**
 * The mockups' 50 pt (54 pt on Lock) capsule button (docs/feat/mobile-ui-polish.md
 * Design 2, `Sheet` buttons): `primary` on `accentFill`, `secondary` on `tint`,
 * `destructive` = `fill` + `red`, `neutral` = `fill` + `label`. Render only.
 */
import type { JSX, ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

export type PillKind = "primary" | "secondary" | "destructive" | "neutral";

export interface PillButtonProps {
  readonly palette: Palette;
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: PillKind;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly height?: number;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
}

export function PillButton({
  palette,
  label,
  onPress,
  kind = "primary",
  icon,
  disabled = false,
  busy = false,
  height = SIZE.bigButton,
  testID,
  accessibilityLabel,
}: PillButtonProps): JSX.Element {
  const bg = disabled
    ? palette.fill
    : kind === "primary"
      ? palette.accentFill
      : kind === "secondary"
        ? palette.tint
        : palette.fill;
  const fg = disabled
    ? palette.sec
    : kind === "primary"
      ? palette.onAccent
      : kind === "secondary"
        ? palette.accent
        : kind === "destructive"
          ? palette.red
          : palette.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: height,
        borderRadius: height / 2,
        backgroundColor: bg,
        paddingHorizontal: 20,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed && !disabled ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {busy ? <ActivityIndicator color={fg} /> : null}
        {icon === undefined || busy ? null : <Icon name={icon} color={fg} size={18} />}
        <Text maxFontSizeMultiplier={DENSE_FONT_SCALE} style={[typography.headline, { color: fg }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

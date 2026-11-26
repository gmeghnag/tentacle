/**
 * The mockups' capsule button (docs/feat/mobile-ui-polish.md Design 2, `Sheet`
 * buttons): `primary` on `accentFill`, `secondary` on `tint`, `destructive` =
 * `fill` + `red`, `neutral` = `fill` + `label`, `quiet` = `fill` + `sec`.
 * `regular` is 50 pt (54 pt on Lock); `compact` is AskCard's `size.capsule`, no
 * icon, dimmed as a whole in its own colours
 * (docs/fix/mobile-workflows-landing-v2.md D2). Render only.
 */
import type { JSX, ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Text } from "./Text.tsx";

export type PillKind = "primary" | "secondary" | "destructive" | "neutral" | "quiet";

export interface PillButtonProps {
  readonly palette: Palette;
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: PillKind;
  readonly size?: "regular" | "compact";
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
  size = "regular",
  icon,
  disabled = false,
  busy = false,
  height,
  testID,
  accessibilityLabel,
}: PillButtonProps): JSX.Element {
  const compact = size === "compact";
  const tall = height ?? (compact ? SIZE.capsule : SIZE.bigButton);
  // The regular disabled look replaces the kind's colours; compact keeps them.
  const greyed = disabled && !compact;
  const bg = greyed
    ? palette.fill
    : kind === "primary"
      ? palette.accentFill
      : kind === "secondary"
        ? palette.tint
        : palette.fill;
  const fg = greyed
    ? palette.sec
    : kind === "primary"
      ? palette.onAccent
      : kind === "secondary"
        ? palette.accent
        : kind === "destructive"
          ? palette.red
          : kind === "quiet"
            ? palette.sec
            : palette.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: tall,
        borderRadius: tall / 2,
        backgroundColor: bg,
        paddingHorizontal: compact ? 18 : 20,
        alignItems: "center",
        justifyContent: "center",
        opacity: compact && disabled ? 0.4 : pressed && !disabled ? 0.7 : 1,
      })}
    >
      {/* Disabled = `fill` + `sec` at reduced strength (visual review 1, P1): at
          full strength a grey label on `fill` read as a live neutral button. */}
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 8, opacity: greyed ? 0.5 : 1 }}
      >
        {busy ? <ActivityIndicator color={fg} /> : null}
        {icon === undefined || busy || compact ? null : <Icon name={icon} color={fg} size={18} />}
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[compact ? typography.subheadStrong : typography.headline, { color: fg }]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

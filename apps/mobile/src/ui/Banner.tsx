/**
 * The 18 pt banner (docs/feat/mobile-ui-polish.md Design 2): icon + bold line +
 * body, in the warning colours (offline, errors) or the accent tint (info).
 * Optional trailing action (Retry). Render only.
 */
import type { JSX } from "react";
import { Pressable, View } from "react-native";
import { type Palette, radius, space, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Text } from "./Text.tsx";

export interface BannerProps {
  readonly palette: Palette;
  readonly title?: string;
  readonly body: string;
  readonly tone?: "warn" | "info" | "error";
  readonly icon?: IconName;
  readonly testID?: string;
  /** The body Text's own testID (a flow asserting the message). */
  readonly bodyTestID?: string;
  readonly action?: {
    readonly label: string;
    readonly onPress: () => void;
    readonly testID?: string;
  };
  /** Drop the screen inset (a banner inside a padded container). */
  readonly flush?: boolean;
}

export function Banner({
  palette,
  title,
  body,
  tone = "warn",
  icon,
  testID,
  bodyTestID,
  action,
  flush = false,
}: BannerProps): JSX.Element {
  const bg = tone === "info" ? palette.tint : tone === "error" ? palette.card : palette.warnBg;
  const fg = tone === "info" ? palette.label : tone === "error" ? palette.label : palette.warnText;
  const iconColor =
    tone === "info" ? palette.accent : tone === "error" ? palette.red : palette.warnText;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        marginHorizontal: flush ? 0 : space.inset,
        borderRadius: radius.banner,
        backgroundColor: bg,
        padding: 14,
        flexDirection: "row",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <Icon
        name={icon ?? (tone === "info" ? "checkmark.circle" : "exclamationmark.triangle")}
        color={iconColor}
        size={20}
      />
      <View style={{ flex: 1, gap: 2 }}>
        {title === undefined ? null : (
          <Text style={[typography.subheadStrong, { color: fg }]}>{title}</Text>
        )}
        <Text testID={bodyTestID} style={[typography.subhead, { color: fg }]}>
          {body}
        </Text>
        {action === undefined ? null : (
          <Pressable
            testID={action.testID}
            accessibilityRole="button"
            onPress={action.onPress}
            hitSlop={10}
            style={{ alignSelf: "flex-start", paddingTop: 6 }}
          >
            <Text style={[typography.subheadStrong, { color: palette.accent }]}>
              {action.label}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

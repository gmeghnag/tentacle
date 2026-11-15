/**
 * Every list's empty / loading state (docs/feat/mobile-ui-polish.md Design 2):
 * centred `sec` text with an optional icon and action; `loading` is the native
 * `ActivityIndicator`. Render only.
 */
import type { JSX, ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type Palette, space, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

export function EmptyState({
  palette,
  title,
  body,
  icon,
  loading = false,
  action,
  testID,
}: {
  readonly palette: Palette;
  readonly title?: string;
  readonly body?: ReactNode;
  readonly icon?: IconName;
  readonly loading?: boolean;
  readonly action?: ReactNode;
  readonly testID?: string;
}): JSX.Element {
  return (
    <View
      testID={testID}
      style={{ alignItems: "center", justifyContent: "center", gap: 10, padding: space.inset * 2 }}
    >
      {loading ? <ActivityIndicator color={palette.sec} /> : null}
      {icon === undefined || loading ? null : <Icon name={icon} color={palette.sec} size={34} />}
      {title === undefined ? null : (
        <Text style={[typography.headline, { color: palette.label, textAlign: "center" }]}>
          {title}
        </Text>
      )}
      {body === undefined ? null : (
        <Text style={[typography.subhead, { color: palette.sec, textAlign: "center" }]}>
          {body}
        </Text>
      )}
      {action}
    </View>
  );
}

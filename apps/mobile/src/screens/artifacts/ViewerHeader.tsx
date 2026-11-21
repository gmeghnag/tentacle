/**
 * The artifact viewers' header (docs/feat/model-artifacts.md D9): ✕, the title
 * over the card's type-and-size line, a `v2 ▾` version picker when there is
 * more than one version, and Share. Render only: what the picker offers and
 * what Share sends are the caller's (S9 wires them).
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Palette, space, typography } from "../../theme.ts";
import { HeaderIcon } from "../../ui/HeaderIcon.tsx";
import { Text } from "../../ui/Text.tsx";

export interface ViewerHeaderProps {
  readonly palette: Palette;
  readonly title: string;
  readonly subtitle: string;
  readonly onClose: () => void;
  /** The version shown and how many exist: the picker shows only when > 1. */
  readonly version: number;
  readonly versions: number;
  readonly onPickVersion?: () => void;
  /** Absent → no Share button (nothing cached to share yet). */
  readonly onShare?: () => void;
}

export function ViewerHeader(props: ViewerHeaderProps): JSX.Element {
  const { palette } = props;
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="artifact-viewer-header"
      style={[styles.bar, { paddingTop: insets.top, borderBottomColor: palette.sep }]}
    >
      <HeaderIcon
        palette={palette}
        icon="xmark"
        accessibilityLabel="Close"
        onPress={props.onClose}
        testID="artifact-viewer-close"
      />
      <View style={styles.titles}>
        <Text numberOfLines={1} style={[typography.headline, { color: palette.label }]}>
          {props.title}
        </Text>
        <Text numberOfLines={1} style={[typography.footnote, { color: palette.sec }]}>
          {props.subtitle}
        </Text>
      </View>
      {props.versions > 1 && props.onPickVersion !== undefined ? (
        <HeaderIcon
          palette={palette}
          label={`v${props.version} ▾`}
          accessibilityLabel={`Version ${props.version} of ${props.versions}`}
          onPress={props.onPickVersion}
          testID="artifact-viewer-version"
        />
      ) : null}
      {props.onShare !== undefined ? (
        <HeaderIcon
          palette={palette}
          label="Share"
          accessibilityLabel="Share"
          onPress={props.onShare}
          testID="artifact-viewer-share"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.inset / 2,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titles: { flex: 1, alignItems: "center", paddingHorizontal: 8 },
});

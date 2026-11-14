/**
 * The screen's own header (docs/feat/mobile-ui-polish.md Design 2/4): the native
 * nav bar is hidden (`headerShown: false`) and this row sits under the safe-area
 * top — glass buttons left and right, then either a LARGE title that scrolls
 * with the list (list screens: put `ScreenHeader` inside the ScrollView) or a
 * compact centred title + status line (chat screens). Swipe-back is the native
 * stack's, untouched. Render only.
 */
import type { JSX, ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, space, typography } from "../theme.ts";

export interface ScreenHeaderProps {
  readonly palette: Palette;
  readonly title: string;
  /** `large`: list screens (34 pt title below the buttons); `compact`: chat. */
  readonly variant?: "large" | "compact";
  /** Under a large title (mono path) or a compact one (status line). */
  readonly subtitle?: ReactNode;
  readonly left?: ReactNode;
  readonly right?: ReactNode;
  /** Add the safe-area top inset (false inside a sheet/modal that already has it). */
  readonly insetTop?: boolean;
  readonly titleTestID?: string;
}

export function ScreenHeader({
  palette,
  title,
  variant = "large",
  subtitle,
  left,
  right,
  insetTop = true,
  titleTestID,
}: ScreenHeaderProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const top = insetTop ? insets.top : 0;
  if (variant === "compact") {
    return (
      <View style={[styles.compactRow, { paddingTop: top, minHeight: top + SIZE.headerChat }]}>
        <View style={styles.side}>{left}</View>
        <View style={styles.compactTitle}>
          <Text
            testID={titleTestID}
            accessibilityRole="header"
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.headline, { color: palette.label }]}
          >
            {title}
          </Text>
          {subtitle}
        </View>
        <View style={[styles.side, styles.sideRight]}>{right}</View>
      </View>
    );
  }
  return (
    <View style={{ paddingTop: top }}>
      <View style={styles.buttons}>
        <View style={styles.cluster}>{left}</View>
        <View style={styles.cluster}>{right}</View>
      </View>
      <Text
        testID={titleTestID}
        accessibilityRole="header"
        numberOfLines={2}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.largeTitle, styles.largeTitle, { color: palette.label }]}
      >
        {title}
      </Text>
      {subtitle === undefined ? null : <View style={styles.largeSubtitle}>{subtitle}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: {
    minHeight: SIZE.headerList,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.inset,
  },
  cluster: { flexDirection: "row", gap: 10, alignItems: "center" },
  largeTitle: { paddingHorizontal: space.inset, paddingTop: 2 },
  largeSubtitle: { paddingHorizontal: space.inset, paddingTop: 2 },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.inset,
  },
  side: { width: 96, flexDirection: "row", gap: 10 },
  sideRight: { justifyContent: "flex-end" },
  compactTitle: { flex: 1, alignItems: "center" },
});

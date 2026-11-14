/**
 * A sheet's CONTENT (docs/feat/mobile-ui-polish.md Design 2): 38 pt top radius,
 * the 36×5 grabber, `sheet` background, a 22 pt title and an optional subtitle.
 * The presentation stays native — a `Modal` (`pageSheet`) or an overlay owns the
 * slide and swipe-to-dismiss; this only draws what is inside. Render only.
 */
import type { JSX, ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";

export interface SheetProps {
  readonly palette: Palette;
  readonly title?: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly testID?: string;
  /** Add the bottom safe-area inset (an overlay sheet at the screen's bottom). */
  readonly insetBottom?: boolean;
  /** Scroll the content (a sheet with a text field stays usable above the keyboard). */
  readonly scroll?: boolean;
}

export function Sheet({
  palette,
  title,
  subtitle,
  children,
  testID,
  insetBottom = true,
  scroll = false,
}: SheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const body = (
    <>
      <View style={[styles.grabber, { backgroundColor: palette.sepSheet }]} />
      {title === undefined ? null : (
        <Text accessibilityRole="header" style={[typography.title2, { color: palette.label }]}>
          {title}
        </Text>
      )}
      {subtitle === undefined ? null : (
        <Text style={[typography.subhead, { color: palette.sec }]}>{subtitle}</Text>
      )}
      {children}
    </>
  );
  const container = [
    styles.sheet,
    {
      backgroundColor: palette.sheet,
      paddingBottom: (insetBottom ? insets.bottom : 0) + 20,
    },
  ];
  if (scroll) {
    return (
      <ScrollView
        testID={testID}
        style={{
          backgroundColor: palette.sheet,
          borderTopLeftRadius: radius.sheet,
          borderTopRightRadius: radius.sheet,
        }}
        contentContainerStyle={container}
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>
    );
  }
  return (
    <View testID={testID} style={container}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: space.inset + 4,
    paddingTop: 8,
    gap: 12,
  },
  grabber: {
    alignSelf: "center",
    width: SIZE.grabberWidth,
    height: SIZE.grabberHeight,
    borderRadius: SIZE.grabberHeight / 2,
    marginBottom: 10,
  },
});

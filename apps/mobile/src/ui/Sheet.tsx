/**
 * A sheet's CONTENT (docs/feat/mobile-ui-polish.md Design 2, restyled by
 * docs/feat/mobile-chrome.md Design 4): the 36×5 grabber, an optional 22 pt
 * title + subtitle, an optional 18 pt close glyph, and the `scroll`/`floating`
 * variants. The presentation stays native — a `Modal` (`pageSheet`) or an
 * overlay owns the slide and swipe-to-dismiss; this only draws what is inside.
 *
 * Two surfaces, from the mockups (`.tentacle/tmp/mobile-chrome/mockups/index.html`):
 *  - a FULL sheet is the ground a section band sits on (`infoE2`, line 390: the
 *    sheet's ground moves one step down to the grouped ground, `bg` in both
 *    palettes, so its `bandOnSheet` bands read one step above it and two sections
 *    never merge). In light that is `#F2F2F7` with white bands, in dark `#1F1F1E`
 *    with `#2A2A28` bands.
 *  - a FLOATING sheet is a card over a scrim (the `Pair` compare sheet, line 348),
 *    so it keeps its own `sheet` surface: it is not a band's ground.
 *
 * Render only.
 */
import type { JSX, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";

export interface SheetProps {
  readonly palette: Palette;
  readonly title?: string;
  /** A string, or a sentence with inline runs (`InlineMono`). */
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly testID?: string;
  /** Add the bottom safe-area inset (an overlay sheet at the screen's bottom). */
  readonly insetBottom?: boolean;
  /** Scroll the content (a sheet with a text field stays usable above the keyboard). */
  readonly scroll?: boolean;
  /**
   * The mockups' floating card (`Pair`): 8 pt from the sides and the bottom,
   * every corner `radius.sheet`, 30 pt under the content. The scrim is the
   * screen's, and the surface stays `sheet` (a card, not a band's ground).
   */
  readonly floating?: boolean;
  /** Centre the title and subtitle (`Pair` compare). */
  readonly centred?: boolean;
  /** Draw the 18 pt close glyph in the corner (Design 4). */
  readonly onClose?: () => void;
  /**
   * The close glyph's own testID. Defaults to `${testID}-close`; a screen that
   * already ships a flow tapping its close control keeps that id.
   */
  readonly closeTestID?: string;
}

export function Sheet({
  palette,
  title,
  subtitle,
  children,
  testID,
  insetBottom = true,
  scroll = false,
  floating = false,
  centred = false,
  onClose,
  closeTestID,
}: SheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const align = centred ? styles.centred : null;
  // A full sheet is the banded ground; a floating card keeps its own surface.
  const ground = floating ? palette.sheet : palette.bg;
  // The close glyph, drawn in the corner. In the SCROLL variant it is hoisted out
  // of the scroller (`fixedClose` below): a sheet long enough to scroll (Session
  // info) must never scroll its own way out of reach.
  const closeGlyph =
    onClose === undefined ? null : (
      <Pressable
        testID={closeTestID ?? (testID === undefined ? "sheet-close" : `${testID}-close`)}
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={8}
        style={styles.close}
      >
        <Icon name="xmark" color={palette.sec} size={18} />
      </Pressable>
    );
  const head = (
    <>
      <View style={[styles.grabber, { backgroundColor: palette.sepSheet }]} />
      {scroll ? null : closeGlyph}
      {title === undefined ? null : (
        <Text
          accessibilityRole="header"
          style={[typography.title2, align, { color: palette.label }]}
        >
          {title}
        </Text>
      )}
      {subtitle === undefined ? null : (
        <Text style={[typography.subhead, align, { color: palette.sec }]}>{subtitle}</Text>
      )}
      {children}
    </>
  );
  const container = [
    styles.sheet,
    floating ? styles.floating : null,
    {
      backgroundColor: ground,
      paddingBottom: floating ? 30 : (insetBottom ? insets.bottom : 0) + 20,
    },
  ];
  if (scroll) {
    return (
      <View style={[styles.scrollBody, { backgroundColor: ground }]}>
        <ScrollView
          testID={testID}
          style={{
            backgroundColor: ground,
            borderTopLeftRadius: radius.sheet,
            borderTopRightRadius: radius.sheet,
          }}
          contentContainerStyle={container}
          keyboardShouldPersistTaps="handled"
        >
          {head}
        </ScrollView>
        {closeGlyph}
      </View>
    );
  }
  return (
    <View testID={testID} style={container}>
      {head}
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
  // The scroll variant's frame: the sheet IS the ground, and the close glyph is
  // pinned to it rather than to the content that scrolls.
  scrollBody: { flex: 1 },
  floating: {
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: radius.sheet,
  },
  centred: { textAlign: "center" },
  close: { position: "absolute", top: 8, right: space.inset + 4, padding: 4 },
  grabber: {
    alignSelf: "center",
    width: SIZE.grabberWidth,
    height: SIZE.grabberHeight,
    borderRadius: SIZE.grabberHeight / 2,
    marginBottom: 10,
  },
});

/**
 * A sheet's CONTENT (docs/feat/mobile-ui-polish.md Design 2, restyled by
 * docs/feat/mobile-chrome.md Design 4): an optional 22 pt title + subtitle, an
 * optional 18 pt close glyph, and the `scroll`/`floating` variants. The
 * presentation is native — since docs/feat/mobile-native-sheets.md a stack
 * `formSheet` route (`Sheet native`), or a `Modal`/overlay for the two surfaces
 * still drawn in JS — and it owns the slide and the swipe-to-dismiss; this only
 * draws what is inside.
 *
 * Two surfaces, from the mockups (`.tentacle/tmp/mobile-chrome/mockups/index.html`):
 *  - a FULL sheet is the ground a section band sits on (`infoE2`, line 390: the
 *    sheet's ground moves one step down to the grouped ground, `bg` in both
 *    palettes, so its `bandOnSheet` bands read one step above it and two sections
 *    never merge). In light that is `#F2F2F7` with white bands, in dark `#1E1F21`
 *    with `#28292C` bands.
 *  - a FLOATING sheet is a card over a scrim (the `Pair` compare sheet, line 348),
 *    so it keeps its own `sheet` surface: it is not a band's ground.
 *
 * `native` (D4) is the formSheet variant: UIKit draws the grabber and the corner
 * radius, so the content draws neither, and — the load-bearing part — the route
 * root must be exactly TWO direct children, a head View with
 * `collapsable={false}` and ONE `ScrollView`. RNS resizes a formSheet's
 * ScrollView to the whole sheet unless it finds that shape, and the list is then
 * drawn OVER the head (the spike's F0, Step 0). One scroller is also what makes a
 * scroll reach the sheet's edge and expand medium → large (F8): a nested pair
 * scrolls the inner list instead and the sheet stays put.
 *
 * Render only.
 */
import type { ComponentRef, JSX, ReactElement, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

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
   * Drawn by UIKit instead: no drawn grabber and no drawn top radius (D4). The
   * `scroll` variant then renders the two children an RNS formSheet requires.
   */
  readonly native?: boolean;
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
  /**
   * The `scroll` variant's ONE scroller: its testID (a flow's `…-scroll`), its
   * ref (the reveal's target, H4a) and its `refreshControl` (Tools' pull). The
   * scroller is this component's — the caller names it, never wraps it.
   */
  readonly scrollTestID?: string;
  readonly scrollRef?: (node: ComponentRef<typeof ScrollView> | null) => void;
  readonly refreshControl?: ReactElement;
}

export function Sheet({
  palette,
  title,
  subtitle,
  children,
  testID,
  insetBottom = true,
  scroll = false,
  native = false,
  floating = false,
  centred = false,
  onClose,
  closeTestID,
  scrollTestID,
  scrollRef,
  refreshControl,
}: SheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const align = centred ? styles.centred : null;
  // A full sheet is the banded ground; a floating card keeps its own surface.
  const ground = floating ? palette.sheet : palette.bg;
  // The close glyph, drawn in the corner. In the SCROLL variant it is hoisted out
  // of the scroller (the `head` below): a sheet long enough to scroll (Session
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
  // UIKit draws the formSheet's grabber (`sheetGrabberVisible`): a second one,
  // drawn by the content, is two grabbers on one sheet (D4).
  const grabber = native ? null : (
    <View style={[styles.grabber, { backgroundColor: palette.sepSheet }]} />
  );
  const container = [
    styles.sheet,
    floating ? styles.floating : null,
    {
      backgroundColor: ground,
      // UIKit's corner is the sheet's own: a drawn one leaves a seam (D4).
      borderTopLeftRadius: native ? 0 : radius.sheet,
      borderTopRightRadius: native ? 0 : radius.sheet,
      paddingBottom: floating ? 30 : (insetBottom ? insets.bottom : 0) + 20,
    },
  ];
  if (scroll) {
    // The head (grabber, close, title, subtitle) is OUTSIDE the scroller and the
    // content is inside it: one scroller (F8), and the person's title never
    // scrolls away while they read the list under it.
    const head = (
      <View
        testID={testID}
        // F0: RNS only leaves the ScrollView alone when this head is a
        // non-collapsed direct child of the route root.
        {...(native ? { collapsable: false } : {})}
        style={[styles.head, { backgroundColor: ground }]}
      >
        {grabber}
        {closeGlyph}
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
      </View>
    );
    const scroller = (
      <ScrollView
        {...(scrollTestID === undefined ? {} : { testID: scrollTestID })}
        {...(scrollRef === undefined ? {} : { ref: scrollRef })}
        {...(refreshControl === undefined ? {} : { refreshControl })}
        style={{ backgroundColor: ground }}
        contentContainerStyle={[container, styles.scrollContent]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    );
    if (native) {
      // Exactly two direct children (F0): the pinned head and the ONE scroller.
      return (
        <>
          {head}
          {scroller}
        </>
      );
    }
    return (
      <View style={[styles.scrollBody, { backgroundColor: ground }]}>
        {head}
        {scroller}
      </View>
    );
  }
  return (
    <View testID={testID} style={container}>
      {grabber}
      {closeGlyph}
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
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: space.inset + 4,
    paddingTop: 8,
    gap: 12,
  },
  // The scroll variant's pinned head: the grabber, the close glyph, the title and
  // the subtitle, above the one scroller (never inside it).
  head: {
    paddingHorizontal: space.inset + 4,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  // The scroll variant's frame (the NATIVE shape is two direct children, F0, so
  // it draws no wrapper at all). `gap: 0` because the head carries its own
  // bottom inset: a gap here appends a second section rhythm over the sheet's.
  scrollBody: { flex: 1, gap: 0 },
  // The ONE scroller's content (F8) adds no gap of its own: what scrolls here is
  // a BAND list, and `BandSection` brings `space.sectionTop` above every section
  // — a wrapper gap would double that rhythm, differently per screen.
  scrollContent: { gap: 0 },
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

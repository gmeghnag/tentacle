/**
 * The E2 section band (docs/feat/mobile-chrome.md Design 4): a small uppercase
 * label, then ONE full-width surface holding the section's `Row`s, then an
 * optional footnote (one note, or `notes` — one block each). It replaced the old
 * `SectionHeader` + `GroupedCard` pair (both deleted in S4 of
 * docs/feat/mobile-chrome.md).
 *
 * The shape, taken from the mockup's `infoE2` (`index.html:386-402`):
 *  - the label is 12 pt, `sec`, uppercase, tracked, inset to the row's own 20 pt
 *    gutter so it aligns with the labels under it, `sectionTop` above and 6 pt
 *    below. A band may also stand ALONE (`title` omitted): its caller already
 *    draws the heading (a computer's own name + status line on the Computers
 *    screen, the list's trailing "Load more" row). It still takes
 *    `space.sectionTop` above it, so every band sits at the same distance from
 *    what precedes it.
 *  - the band is FULL-width (no side margin, unlike the old 26 pt card), square
 *    (`radius.card` is 0 since S1), with a hairline on its top AND bottom edge so
 *    two sections never merge into one another;
 *  - the band always reads one step above what it sits on: `band` on the page's
 *    grouped ground, and `bandOnSheet` on a sheet whose own ground is `bg`
 *    (`onSheet`), which is why the two surfaces are palette tokens, not a rule.
 *
 * Render only (AGENTS §7): no branching beyond choosing the two surfaces.
 */
import type { JSX, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface BandSectionProps {
  readonly palette: Palette;
  /**
   * The section's label: short, a noun phrase ("Session", "App lock"). Omitted
   * when the band stands alone and its heading is drawn by the caller.
   */
  readonly title?: string;
  readonly children: ReactNode;
  /**
   * ONE note under the band (13 pt `sec`): what the rows cannot say. One
   * PARAGRAPH — plain text, or copy with inline runs in it (`InlineMono`), which
   * is why it must stay a single `<Text>`. For SEVERAL notes use `notes`.
   */
  readonly footnote?: ReactNode;
  /**
   * SEVERAL notes under the band: one BLOCK each, stacked. Never pass these as one
   * `footnote` — a `<Text>` inside that `<Text>` is laid out INLINE by React
   * Native, so two paragraphs run together into a single line and a `testID` on
   * the inner one matches no view at all (S4 review finding 1). Each element
   * carries its own `key`; `BandNote` is the block to render.
   */
  readonly notes?: readonly ReactNode[];
  /** Inside a sheet: both surfaces move up one step (`bandOnSheet`, `bg`). */
  readonly onSheet?: boolean;
  readonly testID?: string;
}

export function BandSection({
  palette,
  title,
  children,
  footnote,
  notes,
  onSheet = false,
  testID,
}: BandSectionProps): JSX.Element {
  const ground = onSheet ? palette.bandOnSheet : palette.band;
  const edge = onSheet ? palette.sepSheet : palette.sep;
  const hasNotes = notes !== undefined && notes.length > 0;
  return (
    <View testID={testID} style={styles.section}>
      {title === undefined ? null : (
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[styles.label, { color: palette.sec }]}
        >
          {title}
        </Text>
      )}
      <View style={[styles.band, { backgroundColor: ground, borderColor: edge }]}>{children}</View>
      {footnote === undefined && !hasNotes ? null : (
        // The notes are BLOCKS: a column, so two of them stack instead of running
        // together (a `<Text>` parent would join them inline).
        <View style={[styles.footnotes, { paddingHorizontal: space.rowX }]}>
          {footnote === undefined ? null : (
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.note, { color: palette.sec }]}
            >
              {footnote}
            </Text>
          )}
          {hasNotes ? notes : null}
        </View>
      )}
    </View>
  );
}

/**
 * ONE note under a band: a paragraph of its own. `BandSection`'s `notes` slot is a
 * `View`, so this is a sibling `<Text>` of the others — never a run nested in one
 * (S4 review finding 1: a nested `<Text>` lays out inline and its `testID` matches
 * no view on iOS). The inset belongs to the container, so every note shares it.
 */
export function BandNote({
  palette,
  testID,
  children,
}: {
  readonly palette: Palette;
  readonly testID?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Text
      {...(testID === undefined ? {} : { testID })}
      maxFontSizeMultiplier={DENSE_FONT_SCALE}
      style={[styles.note, { color: palette.sec }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.sectionTop },
  label: {
    ...typography.caption,
    // 12 pt small caps: the mockup's `q()` — `text-transform: uppercase` with
    // `.02em` tracking. RN's `letterSpacing` is in points, so 12 pt × 0.02 = 0.24.
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.24,
    textTransform: "uppercase",
    paddingHorizontal: space.rowX,
    paddingBottom: 6,
  },
  band: {
    // Full width, square: the band IS the section's surface, edge to edge.
    borderRadius: radius.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  footnotes: {
    // A column: `gap` is what separates two paragraphs, as the old
    // `section: { gap: 8 }` did before the notes moved into the band's slot.
    // Without it the blocks stack shoulder to shoulder and read as two lines of
    // one list, not as two paragraphs.
    paddingTop: 8,
    gap: 8,
  },
  note: {
    ...typography.footnote,
  },
});

/**
 * The screen's own header (docs/feat/mobile-ui-polish.md Design 2/4): the native
 * nav bar is hidden (`headerShown: false`) and this row sits under the safe-area
 * top — bare thin glyph buttons left and right, then either a LARGE title that
 * scrolls with the list (list screens: put `ScreenHeader` inside the ScrollView)
 * or a compact centred title + status line (chat screens) closed by one hairline
 * (docs/feat/mobile-chrome.md A1). Swipe-back is the native stack's, untouched.
 * Render only.
 */
import type { JSX, ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, space, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

export interface ScreenHeaderProps {
  readonly palette: Palette;
  readonly title: string;
  /** `large`: list screens (34 pt title below the buttons); `compact`: chat. */
  readonly variant?: "large" | "compact";
  /**
   * Under a large title (mono path) or a compact one (status line).
   *
   * A screen may pass an ELEMENT or a plain STRING: a string is wrapped in a
   * `Text` here, because React Native draws a raw string with no `<Text>` around
   * it as nothing at all (e2e fix round 2 — `"nothing written yet"` was
   * invisible on the Review screen for exactly this). Do not render `{subtitle}`
   * directly; go through `subtitleNode` below.
   */
  readonly subtitle?: ReactNode;
  readonly left?: ReactNode;
  readonly right?: ReactNode;
  /** Add the safe-area top inset (false inside a sheet/modal that already has it). */
  readonly insetTop?: boolean;
  readonly titleTestID?: string;
  /**
   * The title is tappable (docs/feat/mobile-session-info.md Owner decision 5: tap
   * it to rename). Only the compact variant offers it — a list's large title is
   * the screen's own name, not something a person names.
   */
  readonly onTitlePress?: () => void;
  /**
   * What VoiceOver calls the title's tap, and what the tap does. Defaulted to the
   * chat's Rename: the editor's title opens the workflow's Settings instead
   * (docs/feat/workflow-editor.md D8), and a header that said "Rename" over it
   * would be a lie a screen reader cannot see past.
   */
  readonly titlePressLabel?: string;
  readonly titlePressHint?: string;
  /** Compact only: drawn BEFORE the title (the chat's state dot). */
  readonly titleLead?: ReactNode;
  /** Compact only: the title in the secondary colour (an ended session). */
  readonly titleDim?: boolean;
  /** Compact only: what VoiceOver reads for the title (the dot is visual only). */
  readonly titleLabel?: string;
}

/** The compact caption's look: the mockup's `wf-hsub` (caption type, secondary). */
const captionStyle = (palette: Palette) => [typography.caption, { color: palette.sec }];

/**
 * A caption as an ELEMENT, whichever way a screen passed it.
 *
 * A `subtitle` is a `ReactNode` slot, so a screen may hand it a string — and
 * React Native draws a raw string with no `<Text>` around it as NOTHING (an
 * `RCTRawText`; the JSX around it swallows the warning). That is how Review's
 * "nothing written yet" reached the device invisible while every unit test
 * passed on the string (e2e fix round 2, docs/feat/workflow-editor.md). The
 * slot accepts both shapes, so the header wraps: no screen has to remember.
 */
function subtitleNode(subtitle: ReactNode, palette: Palette): ReactNode {
  return typeof subtitle === "string" ? (
    <Text maxFontSizeMultiplier={DENSE_FONT_SCALE} numberOfLines={1} style={captionStyle(palette)}>
      {subtitle}
    </Text>
  ) : (
    subtitle
  );
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
  onTitlePress,
  titlePressLabel = "Rename",
  titlePressHint = "Opens a field to rename this session",
  titleLead,
  titleDim = false,
  titleLabel,
}: ScreenHeaderProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const top = insetTop ? insets.top : 0;
  if (variant === "compact") {
    const spoken = titleLabel ?? title;
    const text = (
      <Text
        testID={titleTestID}
        accessibilityRole="header"
        accessibilityLabel={spoken}
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[
          typography.headline,
          styles.compactHeading,
          { color: titleDim ? palette.sec : palette.label },
        ]}
      >
        {title}
      </Text>
    );
    const heading =
      titleLead === undefined || titleLead === null ? (
        text
      ) : (
        <View style={styles.titleLine}>
          {titleLead}
          {text}
        </View>
      );
    return (
      <View
        style={[
          styles.compactRow,
          {
            paddingTop: top,
            minHeight: top + SIZE.headerChat,
            // A1: the chat header closes with one hairline (`sepChat`), so the
            // transcript scrolls under a line rather than under nothing.
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.sepChat,
          },
        ]}
      >
        <View style={styles.side}>{left}</View>
        <View style={styles.compactTitle}>
          {onTitlePress === undefined ? (
            heading
          ) : (
            <Pressable
              testID={`${titleTestID ?? "header-title"}-tap`}
              accessibilityRole="button"
              accessibilityLabel={`${spoken}. ${titlePressLabel}`}
              accessibilityHint={titlePressHint}
              onPress={onTitlePress}
            >
              {heading}
            </Pressable>
          )}
          {subtitleNode(subtitle, palette)}
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
      {subtitle === undefined ? null : (
        <View style={styles.largeSubtitle}>{subtitleNode(subtitle, palette)}</View>
      )}
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
  // `minWidth`, not a fixed 96: A1's right cluster is the context ring + "…" (two
  // 44 pt targets), which is a few points wider — a fixed side would squeeze it.
  side: { minWidth: 96, flexDirection: "row", gap: 10, alignItems: "center" },
  sideRight: { justifyContent: "flex-end" },
  compactTitle: { flex: 1, alignItems: "center" },
  // The dot and the title, centred together; the title shrinks, the dot never.
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  compactHeading: { flexShrink: 1 },
});

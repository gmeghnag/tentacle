/**
 * One E2 band row (docs/feat/mobile-chrome.md Design 4): optional status dot /
 * icon tile, a label that never truncates, an optional description under it, and
 * a value / trailing control on the right.
 *
 * The shape is the mockup's `infoE2` (`index.html:386-402`) and the rules are
 * Design 4's:
 *  - FULL-width inside the band, a 20 pt gutter (`space.rowX`), `size.rowList`
 *    tall but never a fixed height (Dynamic Type grows it);
 *  - a 0.5 pt hairline BETWEEN rows, inset to the gutter, and none after the last
 *    one — the last row draws no bottom edge and the band's own edge closes the
 *    section (so the separator is drawn at each row's TOP, `first` suppressing it);
 *    the hairline is `sep` on the grouped ground and `sepSheet` on a sheet
 *    (`onSheet`, which every band in Session info passes);
 *  - the label NEVER truncates: it wraps at large sizes and is never line-capped,
 *    because a truncated setting name is a bug, not a look. "Never truncated" is
 *    not "never shrinks": the label column FILLS the row (`flex: 1`) so a long
 *    title grows the row's HEIGHT. A column that refuses to shrink would push a
 *    trailing chevron/switch past the row's edge (fix round 1, finding 1). The
 *    value takes the remaining width, right-aligned, with the ellipsis its KIND
 *    calls for (`row-value.ts`: a path keeps its tail, a model both ends);
 *  - at the largest Dynamic Type sizes the value drops UNDER the label
 *    (`rowLayout(fontScale)`, F10) and a trailing switch anchors to the top
 *    instead of floating in the middle of a wrapped paragraph;
 *  - the status dot sits BEFORE the label (Design 4: not under it).
 *
 * Render only (AGENTS §7): the two decisions above come from `row-value.ts`.
 */
import type { JSX, ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import {
  type RowTrailing,
  type RowValueKind,
  rowAccessibility,
  rowLayout,
  rowTrailing,
  valueEllipsis,
} from "../row-value.ts";
import {
  DENSE_FONT_SCALE,
  MONO,
  type Palette,
  size as SIZE,
  radius,
  space,
  typography,
} from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { StatusDot, type StatusTone } from "./StatusDot.tsx";
import { Text } from "./Text.tsx";

export interface RowProps {
  readonly palette: Palette;
  readonly title: string;
  /** A description under the label (Design 4: "Auto-accept") — never truncated. */
  readonly subtitle?: string;
  /** The subtitle is a path/command (mono) rather than prose. */
  readonly subtitleMono?: boolean;
  /** The trailing value (a `sec` figure, a state word): right-aligned, ellipsised. */
  readonly value?: string;
  /** What the value IS, which decides which end its ellipsis eats (Design 4). */
  readonly valueKind?: RowValueKind;
  /** The value is a monospace figure (a model id, a path). */
  readonly valueMono?: boolean;
  /** A status dot before the label (Design 4 moves it out of the title column). */
  readonly dot?: StatusTone;
  /** Anything else drawn before the label (a warning glyph beside the dot). */
  readonly leading?: ReactNode;
  readonly icon?: IconName;
  /** A tile drawn dashed (an unreachable/cached entry). */
  readonly iconDashed?: boolean;
  readonly trailing?: ReactNode;
  /**
   * What the trailing element is (fix round 1): a `control` (a switch, Delete, a
   * Stop) is its own VoiceOver element, a `value` (a state word, a reason, a
   * read-only value) is read WITH the row. Defaults to `control` — swallowing an
   * actionable control is the worse failure. An absent trailing is `none`
   * whatever this says, so a caller may pass its own edge kind unconditionally
   * (`session-commands.ts`'s `commandEdge`).
   */
  readonly trailingKind?: RowTrailing;
  readonly chevron?: boolean;
  /** Cached/offline: label and tile in `sec`. */
  readonly dimmed?: boolean;
  /** `destructive`: the label in `red`; `accent`: an action row ("Pair a computer"). */
  readonly tone?: "default" | "accent" | "destructive";
  /** The first row of its band: no hairline above it (the band's edge closes it). */
  readonly first?: boolean;
  /** On a sheet's band: the hairline is `sepSheet`, matching the band's own edges. */
  readonly onSheet?: boolean;
  readonly minHeight?: number;
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly titleWeight?: "400" | "600";
  /** Extra content under the label block (a status line with its own testID). */
  readonly children?: ReactNode;
}

export function Row({
  palette,
  title,
  subtitle,
  subtitleMono = false,
  value,
  valueKind = "text",
  valueMono = false,
  dot,
  leading,
  icon,
  iconDashed = false,
  trailing,
  trailingKind,
  chevron = false,
  dimmed = false,
  tone = "default",
  first = false,
  onSheet = false,
  minHeight = SIZE.rowList,
  onPress,
  onLongPress,
  testID,
  accessibilityLabel,
  accessibilityHint,
  titleWeight = "400",
  children,
}: RowProps): JSX.Element {
  // Dynamic Type: past the cap the value drops under the label (F10); a row with
  // a description under its label top-aligns its control at any size.
  const { fontScale } = useWindowDimensions();
  const hasValue = value !== undefined && value !== "";
  const layout = rowLayout(fontScale, {
    description: subtitle !== undefined && subtitle !== "",
    hasValue,
  });
  const titleColor =
    tone === "destructive"
      ? palette.red
      : tone === "accent"
        ? palette.accent
        : dimmed
          ? palette.sec
          : palette.label;
  const tileColor = dimmed ? palette.sec : palette.accent;
  // ONE value element, placed by the pure decision: beside the label, or (at the
  // largest Dynamic Type sizes) under it, inside the label's own column.
  const valueText =
    hasValue === false ? null : (
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        numberOfLines={1}
        ellipsizeMode={valueEllipsis(valueKind)}
        style={[
          layout.valueFullWidth ? styles.valueBelow : styles.valueBeside,
          valueMono ? typography.mono : typography.subhead,
          { color: palette.sec, textAlign: layout.valueAlign },
          valueMono ? { fontFamily: MONO } : null,
        ]}
      >
        {value ?? ""}
      </Text>
    );
  // A trailing control is always its OWN element; the row's action, if any, then
  // rides on the label column (`rowAccessibility`). What the trailing element IS
  // comes from the caller: a `ReactNode` cannot be classified from here.
  const a11y = rowAccessibility({
    pressable: onPress !== undefined || onLongPress !== undefined,
    trailing: rowTrailing(trailing, trailingKind),
  });
  return (
    <Pressable
      testID={testID}
      accessible={a11y.group}
      accessibilityRole={onPress === undefined ? undefined : "button"}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={onPress === undefined && onLongPress === undefined}
      style={({ pressed }) => [
        styles.row,
        { minHeight, backgroundColor: pressed ? palette.fill : "transparent" },
        { alignItems: layout.controlAlign === "top" ? "flex-start" : "center" },
      ]}
    >
      {/* Between rows only: the band's own edges close the section. */}
      {first ? null : (
        <View
          style={[
            styles.separator,
            { left: space.rowX, backgroundColor: onSheet ? palette.sepSheet : palette.sep },
          ]}
        />
      )}
      {dot === undefined ? null : <StatusDot palette={palette} tone={dot} size={7} />}
      {leading}
      {icon === undefined ? null : (
        <View
          style={[
            styles.tile,
            iconDashed
              ? { borderWidth: 1.5, borderStyle: "dashed", borderColor: palette.dash }
              : { backgroundColor: palette.tint },
          ]}
        >
          <Icon name={icon} color={tileColor} size={18} />
        </View>
      )}
      <View
        {...(a11y.textButton
          ? {
              accessible: true,
              accessibilityRole: "button" as const,
              accessibilityLabel: accessibilityLabel ?? title,
              ...(accessibilityHint === undefined ? {} : { accessibilityHint }),
              ...(onPress === undefined ? {} : { onAccessibilityTap: onPress }),
            }
          : {})}
        style={[
          styles.text,
          // Where `rowLayout` puts the label's width: the whole row when nothing
          // shares the line, a 70% cap beside a value, 100% when stacked.
          layout.labelSizing === "fill" ? styles.textFill : null,
          layout.labelSizing === "capped" ? styles.textCapped : null,
          layout.labelSizing === "stacked" ? styles.textStacked : null,
        ]}
      >
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.body, { color: titleColor, fontWeight: titleWeight }]}
        >
          {title}
        </Text>
        {subtitle === undefined || subtitle === "" ? null : (
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[
              subtitleMono ? typography.mono : typography.footnote,
              { color: palette.sec },
              subtitleMono ? { fontFamily: MONO } : null,
            ]}
          >
            {subtitle}
          </Text>
        )}
        {children}
        {/* Stacked: the value is the label column's second line (F10). */}
        {layout.valueFullWidth ? valueText : null}
      </View>
      {layout.valueFullWidth ? null : valueText}
      {trailing}
      {chevron ? <Icon name="chevron.right" color={palette.sep} size={14} weight="bold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: space.rowX,
    paddingVertical: 12,
  },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth },
  tile: {
    width: SIZE.iconTile,
    height: SIZE.iconTile,
    borderRadius: radius.iconTile,
    alignItems: "center",
    justifyContent: "center",
  },
  // The label never truncates (Design 4): it wraps. It may SHRINK, though — a
  // column that refuses to would push the row's trailing control out of the row.
  text: { flexShrink: 1, minWidth: 0, gap: 2 },
  // Nothing shares the line: the label takes the width and wraps inside it.
  textFill: { flex: 1 },
  // Beside a value the label keeps at most 70% of the row, so the value's own
  // ellipsis has room.
  textCapped: { flexShrink: 1, maxWidth: "70%" },
  // Stacked, the label column owns the whole row so the value can sit under it.
  textStacked: { flex: 1, maxWidth: "100%" },
  valueBeside: { flex: 1, minWidth: 0 },
  // Under the label it owns the second line, still right-aligned (F10).
  valueBelow: { alignSelf: "stretch", paddingTop: 2 },
});

/**
 * One Activity row (docs/feat/mobile-activity-panel.md Design 3): a leading glyph
 * by kind, the title (mono when it is a command), the live step, the meta line,
 * and the trailing control — a thin ■ that needs two taps for a running row, an
 * "Open ›" for an unread report, a "›" for a wake.
 *
 * Render only (AGENTS §7): the strings are `activity.ts`'s, WHICH row is armed is
 * `activity-panel.ts`'s (`stopArmed`), and the tap itself is the screen's. The
 * glyph choice is presentation and lives here — the view-model gains nothing.
 */
import type { JSX } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import type { ActivityRowView } from "../activity.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, size as SIZE, space, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Text } from "./Text.tsx";

/** The leading glyph of a kind: the spinning arc is drawn, the others are symbols. */
function glyphName(row: ActivityRowView): IconName {
  switch (row.kind) {
    case "job":
      return "terminal";
    case "scheduled":
      return "clock";
    default:
      return "doc.on.doc";
  }
}

export interface ActivityRowProps {
  readonly palette: Palette;
  readonly row: ActivityRowView;
  /** The first row of its band: no hairline above it. */
  readonly first: boolean;
  /** The inline Stop's two-tap arm holds THIS row (`activity-panel.ts` `stopArmed`). */
  readonly armed: boolean;
  /** The last row Stop's refusal, shown under the meta until the next update. */
  readonly notice?: string;
  readonly onPress: () => void;
  /** Present only on a running row (a child or a job): the ■ / "■ Stop". */
  readonly onStop?: () => void;
}

export function ActivityRow({
  palette,
  row,
  first,
  armed,
  notice,
  onPress,
  onStop,
}: ActivityRowProps): JSX.Element {
  const mono = row.mono;
  return (
    <Pressable
      testID={`activity-row-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.meta}`}
      accessibilityHint={row.kind === "scheduled" ? "Opens scheduled wakes" : "Opens its detail"}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? palette.fill : "transparent" },
      ]}
    >
      {first ? null : (
        <View style={[styles.separator, { left: space.rowX, backgroundColor: palette.sepSheet }]} />
      )}
      <View style={styles.glyph}>
        {row.kind === "subagent" ? (
          <ActivityIndicator size="small" color={palette.accent} />
        ) : (
          <Icon
            name={glyphName(row)}
            color={row.kind === "finished" ? palette.sec : palette.accent}
            size={18}
          />
        )}
        {row.kind === "finished" && row.unread ? (
          <View
            testID={`activity-dot-${row.id}`}
            style={[styles.dot, { backgroundColor: palette.accent }]}
          />
        ) : null}
      </View>
      <View style={styles.text}>
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={2}
          style={[
            typography.subhead,
            { color: palette.label, fontWeight: row.unread ? "600" : "400" },
            mono ? { fontFamily: MONO } : null,
          ]}
        >
          {row.title}
        </Text>
        {row.step === undefined ? null : (
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            numberOfLines={1}
            style={[typography.mono, { color: palette.sec }]}
          >
            {row.step}
          </Text>
        )}
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={1}
          style={[typography.caption, { color: palette.sec }]}
        >
          {row.meta}
        </Text>
        {notice === undefined ? null : (
          <Text
            testID={`activity-row-notice-${row.id}`}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, { color: palette.orange }]}
          >
            {notice}
          </Text>
        )}
      </View>
      {onStop === undefined ? null : (
        <Pressable
          testID={`activity-row-stop-${row.id}`}
          accessibilityRole="button"
          accessibilityLabel={armed ? `Stop ${row.id}` : `Stop ${row.id}, tap again to confirm`}
          onPress={onStop}
          hitSlop={10}
          style={({ pressed }) => [
            armed ? styles.stopPill : styles.stopTap,
            armed
              ? { borderColor: palette.red, backgroundColor: palette.delBg }
              : { opacity: pressed ? 0.4 : 1 },
          ]}
        >
          {armed ? (
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              numberOfLines={1}
              style={[typography.caption, { color: palette.red, fontWeight: "600" }]}
            >
              {"■ Stop"}
            </Text>
          ) : (
            <Icon name="stop.fill" color={palette.sec} size={12} />
          )}
        </Pressable>
      )}
      {row.kind === "finished" ? (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={1}
          style={[typography.caption, { color: row.unread ? palette.accent : palette.sec }]}
        >
          {row.unread ? "Open ›" : "›"}
        </Text>
      ) : null}
      {row.kind === "scheduled" ? (
        <Icon name="chevron.right" color={palette.sep} size={14} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: SIZE.rowList,
    paddingHorizontal: space.rowX,
    paddingVertical: 10,
  },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth },
  glyph: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  // The unread report's filled dot sits on the glyph's corner (the mockup's
  // "doc + dot"); it is not a second leading column, so the title never shifts.
  dot: { position: "absolute", top: -2, right: -3, width: 7, height: 7, borderRadius: 4 },
  text: { flex: 1, gap: 2 },
  stopTap: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  stopPill: {
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignItems: "center",
    justifyContent: "center",
  },
});

/**
 * One background shell job's detail in the Activity sheet
 * (docs/feat/mobile-chrome.md Design 5, slice S9): the command, its output tail
 * (`jobOutput`, the last 200 lines, pull to refresh) in plain mono (F16), how it
 * ended once it did (F19), and Stop (the screen confirms, F17).
 *
 * Render only (AGENTS §7): every string is `subagent-detail.ts`'s
 * `jobDetailView`; the notice and the in-flight flag are the controller's.
 */
import type { JSX } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { JobAction } from "../session-screen-controller.ts";
import type { JobDetailView } from "../subagent-detail.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

export interface JobDetailProps {
  readonly palette: Palette;
  readonly view: JobDetailView;
  readonly action: JobAction | null;
  readonly onRefresh: () => void;
  /** Stop, AFTER the screen's confirmation. */
  readonly onStop: () => void;
  readonly onBack: () => void;
}

export function JobDetail({
  palette,
  view,
  action,
  onRefresh,
  onStop,
  onBack,
}: JobDetailProps): JSX.Element {
  const busy = action?.busy === true;
  const notice = action?.notice ?? view.notice;
  return (
    <View testID={`activity-job-${view.id}`} style={styles.root}>
      <Pressable
        testID="activity-detail-back"
        accessibilityRole="button"
        accessibilityLabel="Back to Activity"
        hitSlop={8}
        onPress={onBack}
        style={styles.back}
      >
        <Icon name="chevron.left" color={palette.accent} size={17} weight="light" />
        <Text style={[typography.subhead, { color: palette.accent }]}>Activity</Text>
      </Pressable>
      <Text style={[typography.mono, { color: palette.label }]}>{view.title}</Text>
      <Text
        testID="activity-job-meta"
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, { color: palette.sec }]}
      >
        {view.meta}
      </Text>
      <View style={styles.head}>
        <Text style={[typography.caption, styles.label, { color: palette.sec }]}>OUTPUT</Text>
        {view.stop ? (
          <Pressable
            testID="activity-job-stop"
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={8}
            onPress={onStop}
          >
            <Text style={[typography.subhead, { color: palette.red, opacity: busy ? 0.4 : 1 }]}>
              Stop
            </Text>
          </Pressable>
        ) : null}
      </View>
      {notice === null ? null : (
        <Text testID="activity-job-notice" style={[typography.footnote, { color: palette.orange }]}>
          {notice}
        </Text>
      )}
      <ScrollView
        testID="activity-job-output"
        style={[styles.output, { backgroundColor: palette.codeOnSheet }]}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={onRefresh} />}
      >
        {view.truncated ? (
          <Text style={[typography.footnote, { color: palette.sec }]}>
            … earlier output dropped
          </Text>
        ) : null}
        {view.lines.map((line, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional, never reordered
            key={i}
            selectable
            style={[typography.mono, { color: palette.label }]}
          >
            {line === "" ? " " : line}
          </Text>
        ))}
        {view.ended === null ? null : (
          <Text testID="activity-job-ended" style={[typography.footnote, { color: palette.sec }]}>
            {view.ended}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.rowX, gap: 6 },
  back: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8 },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: space.sectionTop,
  },
  label: { letterSpacing: 0.24 },
  output: { flex: 1, borderRadius: 10 },
  body: { padding: 12, gap: 2 },
});

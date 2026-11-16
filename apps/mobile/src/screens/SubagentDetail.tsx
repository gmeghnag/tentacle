/**
 * A FINISHED sub-agent's report (docs/feat/mobile-chrome.md Design 5, slice S8 —
 * the report half; the running half, its steps, message and Stop, is S9). The
 * report is the conversation's own note, drawn by the transcript's markdown
 * renderer (links go through the screen's confirmation — F16); Copy puts its
 * text on the clipboard. Render only: every string comes from `activity.ts`.
 */
import * as Clipboard from "expo-clipboard";
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChildReport } from "../activity-memory.ts";
import type { ActivityRowView } from "../activity.ts";
import { parse } from "../markdown.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "./transcript/Markdown.tsx";

export interface SubagentDetailProps {
  readonly palette: Palette;
  readonly row: ActivityRowView;
  /** `null`: the report has not reached the conversation yet. */
  readonly report: ChildReport | null;
  readonly onLink: (href: string) => void;
  readonly onBack: () => void;
}

export function SubagentDetail({
  palette,
  row,
  report,
  onLink,
  onBack,
}: SubagentDetailProps): JSX.Element {
  return (
    <View testID={`activity-detail-${row.id}`} style={styles.root}>
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
      <Text style={[typography.headline, { color: palette.label }]}>{row.title}</Text>
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, { color: palette.sec }]}
      >
        {row.meta}
      </Text>
      <View style={styles.head}>
        <Text style={[typography.caption, styles.label, { color: palette.sec }]}>REPORT</Text>
        {report === null ? null : (
          <Pressable
            testID="activity-report-copy"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => void Clipboard.setStringAsync(report.text)}
          >
            <Text style={[typography.footnote, { color: palette.accent }]}>Copy</Text>
          </Pressable>
        )}
      </View>
      <ScrollView testID="activity-report" contentContainerStyle={styles.body}>
        {report === null ? (
          <Text style={[typography.footnote, { color: palette.sec }]}>
            The report reaches the conversation when the agent picks it up.
          </Text>
        ) : (
          <Markdown parsed={parse(report.text)} palette={palette} onLink={onLink} />
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
  body: { paddingVertical: 8, gap: 8 },
});

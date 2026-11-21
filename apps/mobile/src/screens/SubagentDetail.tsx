/**
 * One sub-agent's detail in the Activity sheet (docs/feat/mobile-chrome.md
 * Design 5). RUNNING (S9): its latest steps (the newest with a spinner, "… n
 * earlier"), the person's messages with their "read" mark, a "Message sa-N…"
 * field and Stop (the screen confirms, F17). FINISHED (S8, + Show in chat in S9):
 * its report through the transcript's markdown renderer (links go through the
 * screen's confirmation — F16), Copy and Show in chat.
 *
 * Render only (AGENTS §7): every string and which actions show are
 * `subagent-detail.ts`'s; the field's text and the notice are the controller's.
 */
import * as Clipboard from "expo-clipboard";
import type { JSX } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { ChildReport } from "../activity-memory.ts";
import { parse } from "../markdown.ts";
import type { ChildAction } from "../session-screen-controller.ts";
import type { SubagentDetailView } from "../subagent-detail.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Text, TextInput } from "../ui/Text.tsx";
import { Markdown } from "./transcript/Markdown.tsx";

export interface SubagentDetailProps {
  readonly palette: Palette;
  readonly view: SubagentDetailView;
  /** `null`: running, or the report has not reached the conversation yet. */
  readonly report: ChildReport | null;
  /** The message field and the last action's notice (`null` before the controller opened it). */
  readonly action: ChildAction | null;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
  /** Stop, AFTER the screen's confirmation. */
  readonly onStop: () => void;
  /** Absent: the report's row is not in the list (Show in chat is not offered). */
  readonly onShow?: () => void;
  readonly onLink: (href: string) => void;
  readonly onBack: () => void;
}

function Label({ palette, text }: { readonly palette: Palette; readonly text: string }) {
  return <Text style={[typography.caption, styles.label, { color: palette.sec }]}>{text}</Text>;
}

function Link({
  palette,
  text,
  testID,
  onPress,
  tone = "accent",
  disabled = false,
}: {
  readonly palette: Palette;
  readonly text: string;
  readonly testID: string;
  readonly onPress: () => void;
  readonly tone?: "accent" | "red";
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
    >
      <Text
        style={[
          typography.subhead,
          { color: tone === "red" ? palette.red : palette.accent, opacity: disabled ? 0.4 : 1 },
        ]}
      >
        {text}
      </Text>
    </Pressable>
  );
}

export function SubagentDetail({
  palette,
  view,
  report,
  action,
  onDraft,
  onSend,
  onStop,
  onShow,
  onLink,
  onBack,
}: SubagentDetailProps): JSX.Element {
  const busy = action?.busy === true;
  const draft = action?.draft ?? "";
  return (
    <View testID={`activity-detail-${view.id}`} style={styles.root}>
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
      <Text style={[typography.headline, { color: palette.label }]}>{view.title}</Text>
      <Text
        testID="activity-detail-meta"
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, { color: palette.sec }]}
      >
        {view.meta}
      </Text>
      {view.running ? (
        <ScrollView testID="activity-steps" contentContainerStyle={styles.body}>
          <View style={styles.head}>
            <Label palette={palette} text="LATEST STEPS" />
            {view.actions.stop ? (
              <Link
                palette={palette}
                testID="activity-stop"
                text="Stop"
                tone="red"
                disabled={busy}
                onPress={onStop}
              />
            ) : null}
          </View>
          {view.earlier === null ? null : (
            <Text style={[typography.footnote, { color: palette.sec }]}>{view.earlier}</Text>
          )}
          {view.steps.map((step) => (
            <View key={step.key} style={styles.step}>
              {step.latest ? (
                <ActivityIndicator size="small" color={palette.accent} />
              ) : (
                <Icon name="checkmark" color={palette.sec} size={13} weight="light" />
              )}
              <Text
                numberOfLines={2}
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.mono, styles.grow, { color: palette.label }]}
              >
                {step.text}
              </Text>
            </View>
          ))}
          <Sent palette={palette} view={view} />
        </ScrollView>
      ) : (
        <>
          <View style={styles.head}>
            <Label palette={palette} text="REPORT" />
            <View style={styles.links}>
              {view.actions.show && onShow !== undefined ? (
                <Link
                  palette={palette}
                  testID="activity-report-show"
                  text="Show in chat"
                  onPress={onShow}
                />
              ) : null}
              {view.actions.copy && report !== null ? (
                <Link
                  palette={palette}
                  testID="activity-report-copy"
                  text="Copy"
                  onPress={() => void Clipboard.setStringAsync(report.text)}
                />
              ) : null}
            </View>
          </View>
          <ScrollView testID="activity-report" contentContainerStyle={styles.body}>
            {report === null ? (
              <Text style={[typography.footnote, { color: palette.sec }]}>
                The report reaches the conversation when the agent picks it up.
              </Text>
            ) : (
              <Markdown parsed={parse(report.text)} palette={palette} onLink={onLink} />
            )}
            <Sent palette={palette} view={view} />
          </ScrollView>
        </>
      )}
      {action?.notice === null || action?.notice === undefined ? null : (
        <Text
          testID="activity-detail-notice"
          style={[typography.footnote, { color: palette.orange }]}
        >
          {action.notice}
        </Text>
      )}
      {view.actions.message ? (
        <View style={styles.compose}>
          <TextInput
            testID="activity-message-input"
            accessibilityLabel={view.placeholder}
            style={[
              typography.body,
              styles.field,
              { color: palette.label, backgroundColor: palette.fill },
            ]}
            value={draft}
            onChangeText={onDraft}
            placeholder={view.placeholder}
            placeholderTextColor={palette.sec}
            returnKeyType="send"
            onSubmitEditing={onSend}
            editable={!busy}
          />
          <Link
            palette={palette}
            testID="activity-message-send"
            text="Send"
            disabled={busy || draft.trim() === ""}
            onPress={onSend}
          />
        </View>
      ) : null}
    </View>
  );
}

function Sent({
  palette,
  view,
}: {
  readonly palette: Palette;
  readonly view: SubagentDetailView;
}): JSX.Element | null {
  if (view.sent.length === 0) {
    return null;
  }
  return (
    <View style={styles.sent}>
      <Label palette={palette} text="YOUR MESSAGES" />
      {view.sent.map((m) => (
        <View key={m.key} testID={`activity-sent-${m.key}`} style={styles.step}>
          <Text
            numberOfLines={2}
            style={[typography.subhead, styles.grow, { color: palette.label }]}
          >
            {m.text}
          </Text>
          <Text
            testID={`activity-mark-${m.key}`}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[
              typography.footnote,
              { color: m.mark === "read" ? palette.green : palette.sec },
            ]}
          >
            {m.mark}
          </Text>
        </View>
      ))}
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
  links: { flexDirection: "row", gap: 16 },
  label: { letterSpacing: 0.24 },
  body: { paddingVertical: 8, gap: 8 },
  step: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  sent: { gap: 6, paddingTop: space.sectionTop },
  compose: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  field: { flex: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
});

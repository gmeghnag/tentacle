/**
 * The permission sheet (docs/feat/mobile-session-view.md 12c): a native `Modal`
 * page sheet over the transcript, drawn from `permission-sheet.ts`'s state —
 * every decision (the age guard, the options, the reply, the returned words)
 * lives there (AGENTS §7).
 *
 * While the age guard holds, the options are drawn dimmed AND `disabled`, so a
 * stray tap does nothing whether it reaches JS or is swallowed by the platform.
 */
import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PermissionSheet, SheetOptionId, SheetState } from "../permission-sheet.ts";
import type { Palette } from "../theme.ts";

export interface PermissionSheetViewProps {
  readonly sheet: PermissionSheet;
  readonly state: SheetState;
  readonly palette: Palette;
}

export function PermissionSheetView({
  sheet,
  state,
  palette,
}: PermissionSheetViewProps): JSX.Element {
  // The age guard's release is the SHEET's own state change (it owns the clock and
  // the scheduler, `permission-sheet.ts`): the screen only draws `armed`. A timer
  // here was the bug flow 08 found — it re-rendered with a stale prop and the
  // options stayed dimmed and `disabled` for ever.
  const asking = state.kind === "asking" ? state : null;
  const returned = state.kind === "returned" ? state : null;
  return (
    <Modal
      visible={asking !== null || returned !== null}
      presentationStyle="pageSheet"
      animationType="slide"
      transparent={false}
      onRequestClose={() => sheet.dismiss()}
    >
      <View testID="perm-sheet" style={[styles.sheet, { backgroundColor: palette.background }]}>
        {asking === null ? null : (
          <>
            <Text style={[styles.title, { color: palette.label }]}>{asking.request.title}</Text>
            {asking.request.detail === undefined ? null : (
              <Text style={[styles.detail, { color: palette.secondaryLabel }]}>
                {asking.request.detail}
              </Text>
            )}
            {asking.agent === null ? null : (
              <Text style={[styles.detail, { color: palette.secondaryLabel }]}>
                {`asked by ${asking.agent.type}: ${asking.agent.description}`}
              </Text>
            )}
            <View style={styles.options}>
              {asking.options.map((option) => (
                <Pressable
                  key={option.optionId}
                  testID={`perm-${option.optionId}`}
                  accessibilityRole="button"
                  // The age guard's own decision, read at the tap (never a render
                  // snapshot): `answer` ignores what is too early (P10).
                  disabled={!asking.armed}
                  onPress={() => sheet.answer(option.optionId)}
                  style={[
                    styles.option,
                    { borderColor: palette.separator, backgroundColor: palette.card },
                    option.kind === "deny" ? { borderColor: palette.danger } : undefined,
                    asking.armed ? undefined : styles.dimmed,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionLabel,
                      { color: option.kind === "deny" ? palette.danger : palette.label },
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {asking.replyText === "" && asking.request.reply === undefined ? null : (
              <TextInput
                testID="perm-reply-input"
                style={[styles.reply, { color: palette.label, borderColor: palette.separator }]}
                placeholder="Tell it what to do instead"
                placeholderTextColor={palette.secondaryLabel}
                value={asking.replyText}
                onChangeText={(text) => sheet.setReplyText(text)}
                multiline
              />
            )}
            {asking.request.reply === undefined ? null : (
              <Pressable
                testID="perm-reply-send"
                accessibilityRole="button"
                disabled={!asking.armed}
                onPress={() => sheet.sendReply()}
                style={[
                  styles.option,
                  { borderColor: palette.accent, backgroundColor: palette.card },
                  asking.armed ? undefined : styles.dimmed,
                ]}
              >
                <Text style={[styles.optionLabel, { color: palette.accent }]}>Send</Text>
              </Pressable>
            )}
            {asking.armed ? null : (
              <Text testID="perm-arming" style={[styles.detail, { color: palette.secondaryLabel }]}>
                hold on…
              </Text>
            )}
          </>
        )}
        {returned === null ? null : (
          <>
            <Text testID="perm-returned" style={[styles.detail, { color: palette.danger }]}>
              {returned.notice}
            </Text>
            <Text style={[styles.reply, { color: palette.label, borderColor: palette.separator }]}>
              {returned.text}
            </Text>
            <Pressable
              testID="perm-returned-dismiss"
              accessibilityRole="button"
              onPress={() => sheet.clearReturned()}
              style={[
                styles.option,
                { borderColor: palette.separator, backgroundColor: palette.card },
              ]}
            >
              <Text style={[styles.optionLabel, { color: palette.label }]}>OK</Text>
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

/** The options this component draws (exported so a test can pin the id list). */
export const SHEET_OPTION_IDS: readonly SheetOptionId[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reply",
];

const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  detail: { fontSize: 14 },
  options: { gap: 8 },
  option: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 14 },
  optionLabel: { fontSize: 16 },
  dimmed: { opacity: 0.4 },
  reply: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    minHeight: 88,
    fontSize: 15,
  },
});

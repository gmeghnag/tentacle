/**
 * The permission sheet (mockup `Approval`, docs/feat/mobile-session-view.md
 * 12c): a native `Modal` page sheet over the transcript — native presentation
 * and swipe-to-dismiss kept — drawn from `permission-sheet.ts`'s state. Every
 * decision (the age guard, the options, the reply, the returned words, each
 * option's style and its label's code runs) lives there (AGENTS §7).
 *
 * While the age guard holds, the options are drawn dimmed AND `disabled`, so a
 * stray tap does nothing whether it reaches JS or is swallowed by the platform.
 *
 * testIDs (the flows' contract, unchanged): `perm-sheet`, `perm-<optionId>`,
 * `perm-reply-input`, `perm-reply-send`, `perm-arming`, `perm-returned`,
 * `perm-returned-dismiss`.
 */
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import {
  type OptionPill,
  type PermissionSheet,
  type SheetOptionId,
  type SheetState,
  labelRuns,
  optionStyle,
} from "../permission-sheet.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius, size, typography } from "../theme.ts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { Text, TextInput } from "../ui/Text.tsx";

export interface PermissionSheetViewProps {
  readonly sheet: PermissionSheet;
  readonly state: SheetState;
  readonly palette: Palette;
}

function pillColors(pill: OptionPill, palette: Palette): { bg: string; fg: string } {
  switch (pill) {
    case "primary":
      return { bg: palette.accentFill, fg: palette.onAccent };
    case "secondary":
      return { bg: palette.tint, fg: palette.accent };
    case "destructive":
      return { bg: palette.fill, fg: palette.red };
    default:
      return { bg: palette.fill, fg: palette.label };
  }
}

/** One 50 pt answer pill. `disabled` is REAL (the age guard), not just a look. */
function AnswerPill({
  palette,
  label,
  pill,
  icon,
  disabled,
  onPress,
  testID,
}: {
  readonly palette: Palette;
  readonly label: string;
  readonly pill: OptionPill;
  readonly icon: IconName | null;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}): JSX.Element {
  const colors = pillColors(pill, palette);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label.replaceAll("`", "")}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: colors.bg },
        disabled ? styles.dimmed : undefined,
        pressed ? { opacity: 0.7 } : undefined,
      ]}
    >
      {icon === null ? null : <Icon name={icon} color={colors.fg} size={17} />}
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.headline, styles.pillLabel, { color: colors.fg }]}
      >
        {labelRuns(label).map((run, at) => (
          <Text
            // A run's position in its label is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional label runs
            key={at}
            style={run.code ? styles.code : undefined}
          >
            {run.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  );
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
  // The session's shared auto-accept (docs/feat/session-auto-accept.md D6). Its
  // VALUE is read here and now: the controller re-emits on the link's own change
  // (a flip from the laptop arrives that way), so no timer lives in the screen.
  const link = sheet.autoAccept;
  return (
    <Modal
      visible={asking !== null || returned !== null}
      presentationStyle="pageSheet"
      animationType="slide"
      transparent={false}
      onRequestClose={() => sheet.dismiss()}
    >
      <ScrollView
        testID="perm-sheet"
        style={{ backgroundColor: palette.sheet }}
        contentContainerStyle={styles.sheet}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.grabber, { backgroundColor: palette.sepSheet }]} />
        {asking === null ? null : (
          <>
            <View style={styles.head}>
              <View style={[styles.tile, { backgroundColor: palette.tint }]}>
                <Icon name="hand.raised" color={palette.accent} size={22} />
              </View>
              <Text
                accessibilityRole="header"
                style={[typography.title2, styles.flex, { color: palette.label }]}
              >
                {asking.request.title}
              </Text>
            </View>
            {asking.request.detail === undefined ? null : (
              <View style={[styles.detailBox, { backgroundColor: palette.codeOnSheet }]}>
                <Text style={[typography.monoInline, { color: palette.label }]}>
                  {asking.request.detail}
                </Text>
              </View>
            )}
            {asking.agent === null ? null : (
              <Text style={[typography.subhead, { color: palette.sec }]}>
                {`Asked by ${asking.agent.type}: ${asking.agent.description}`}
              </Text>
            )}
            {asking.alsoAsked.length === 0 ? null : (
              <Text testID="perm-also-asked" style={[typography.footnote, { color: palette.sec }]}>
                {asking.alsoAsked.length === 1
                  ? `Also asked on ${asking.alsoAsked[0]} · the first answer wins`
                  : `Also asked on ${asking.alsoAsked[0]} (+${asking.alsoAsked.length - 1}) · the first answer wins`}
              </Text>
            )}
            <View style={styles.options}>
              {asking.options.map((option) => {
                const look = optionStyle(option.optionId);
                return (
                  <AnswerPill
                    key={option.optionId}
                    testID={`perm-${option.optionId}`}
                    palette={palette}
                    label={option.label}
                    pill={look.pill}
                    icon={look.icon}
                    // The age guard's own decision, read at the tap (never a render
                    // snapshot): `answer` ignores what is too early (P10).
                    disabled={!asking.armed}
                    onPress={() => sheet.answer(option.optionId)}
                  />
                );
              })}
            </View>
            {link === null ? null : (
              <View style={[styles.autoRow, { borderTopColor: palette.sepSheet }]}>
                <View style={styles.flex}>
                  <Text style={[typography.subhead, { color: palette.label }]}>Auto-accept</Text>
                  <Text style={[typography.footnote, { color: palette.sec }]}>
                    {link.shared()
                      ? "This session, on every device"
                      : "Not shared by this computer — update tentacle"}
                  </Text>
                </View>
                <Switch
                  testID="perm-auto-accept"
                  accessibilityLabel="Auto-accept for this session, on every device"
                  value={link.current()}
                  disabled={!link.shared()}
                  // The session's link: every device follows, and it is never a
                  // stored approval (each ask is answered `allow_once`).
                  onValueChange={(on) => {
                    void link.set(on)?.catch(() => {});
                  }}
                />
              </View>
            )}
            {asking.replyText === "" && asking.request.reply === undefined ? null : (
              <TextInput
                testID="perm-reply-input"
                style={[
                  typography.body,
                  styles.reply,
                  { color: palette.label, backgroundColor: palette.fill },
                ]}
                placeholder="Tell it what to do instead"
                placeholderTextColor={palette.sec}
                value={asking.replyText}
                onChangeText={(text) => sheet.setReplyText(text)}
                multiline
              />
            )}
            {asking.request.reply === undefined ? null : (
              <AnswerPill
                testID="perm-reply-send"
                palette={palette}
                label="Send reply"
                pill="secondary"
                icon={null}
                disabled={!asking.armed}
                onPress={() => sheet.sendReply()}
              />
            )}
            {asking.armed ? null : (
              <Text
                testID="perm-arming"
                style={[typography.footnote, styles.center, { color: palette.sec }]}
              >
                Hold on…
              </Text>
            )}
          </>
        )}
        {sheet.autoAccepted === null ? null : (
          <Text testID="perm-auto-accepted" style={[typography.footnote, { color: palette.sec }]}>
            {sheet.autoAccepted}
          </Text>
        )}
        {returned === null ? null : (
          <>
            <Text testID="perm-returned" style={[typography.headline, { color: palette.red }]}>
              {returned.notice}
            </Text>
            <View style={[styles.detailBox, { backgroundColor: palette.codeOnSheet }]}>
              <Text style={[typography.body, { color: palette.label }]}>{returned.text}</Text>
            </View>
            <AnswerPill
              testID="perm-returned-dismiss"
              palette={palette}
              label="OK"
              pill="neutral"
              icon={null}
              disabled={false}
              onPress={() => sheet.clearReturned()}
            />
          </>
        )}
      </ScrollView>
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
  autoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginTop: 4,
  },
  flex: { flex: 1 },
  center: { textAlign: "center" },
  sheet: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40, gap: 16 },
  grabber: {
    alignSelf: "center",
    width: size.grabberWidth,
    height: size.grabberHeight,
    borderRadius: size.grabberHeight / 2,
    marginBottom: 4,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  tile: {
    width: size.iconTileLarge,
    height: size.iconTileLarge,
    borderRadius: radius.iconTileLarge,
    alignItems: "center",
    justifyContent: "center",
  },
  detailBox: { borderRadius: radius.tile, padding: 14 },
  options: { gap: 10 },
  pill: {
    minHeight: size.bigButton,
    borderRadius: size.bigButton / 2,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  pillLabel: { textAlign: "center", flexShrink: 1 },
  code: { fontFamily: MONO },
  dimmed: { opacity: 0.4 },
  reply: { borderRadius: radius.tile, padding: 14, minHeight: 96 },
});

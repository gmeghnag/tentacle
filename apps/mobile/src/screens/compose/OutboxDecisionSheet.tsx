/**
 * The outbox decision sheet (docs/feat/mobile-compose.md 13d, D4): the four
 * answers a person has when the phone's item can no longer go out by itself —
 * **Send** (the same key: exactly once even if it did run), **Queue as steer**
 * (only while a turn runs), **Discard**, **Edit**.
 *
 * A native page sheet (`Modal`), like 12c's permission sheet, because decision 13
 * asks for native UI everywhere but the transcript and the input bar. What each
 * answer DOES is the controller's (`compose-controller.ts`) — this file only
 * offers them.
 *
 * testIDs: `outbox-decision`, `outbox-send`, `outbox-steer`, `outbox-discard`,
 * `outbox-edit`.
 */
import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { Palette } from "../../theme.ts";

export interface OutboxDecisionProps {
  /** The item whose text the sheet shows (null: the sheet is closed). */
  readonly item: { readonly text: string } | null;
  readonly palette: Palette;
  /** Why the sheet is open, in the app's own words (`decide`'s reason). */
  readonly why: string;
  /** Whether a turn runs (Queue as steer needs one — an enqueue binds to it). */
  readonly steerable: boolean;
  onSend: () => void;
  onSteer: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onClose: () => void;
}

export function OutboxDecisionSheet({
  item,
  palette,
  why,
  steerable,
  onSend,
  onSteer,
  onDiscard,
  onEdit,
  onClose,
}: OutboxDecisionProps): JSX.Element {
  const open = item !== null;
  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View
        testID="outbox-decision"
        style={[styles.sheet, { backgroundColor: palette.groupedBackground }]}
      >
        <Text style={[styles.title, { color: palette.label }]}>This message did not go out</Text>
        <Text style={[styles.why, { color: palette.secondaryLabel }]}>{why}</Text>
        {item === null ? null : (
          <Text style={[styles.text, { color: palette.label }]} numberOfLines={6}>
            {item.text}
          </Text>
        )}
        <Answer testID="outbox-send" label="Send" palette={palette} onPress={onSend} primary />
        {steerable ? (
          <Answer
            testID="outbox-steer"
            label="Queue as steer"
            palette={palette}
            onPress={onSteer}
          />
        ) : null}
        <Answer testID="outbox-edit" label="Edit" palette={palette} onPress={onEdit} />
        <Answer
          testID="outbox-discard"
          label="Discard"
          palette={palette}
          onPress={onDiscard}
          destructive
        />
        <Answer testID="outbox-close" label="Not now" palette={palette} onPress={onClose} />
      </View>
    </Modal>
  );
}

function Answer({
  testID,
  label,
  palette,
  onPress,
  primary,
  destructive,
}: {
  readonly testID: string;
  readonly label: string;
  readonly palette: Palette;
  readonly onPress: () => void;
  readonly primary?: boolean;
  readonly destructive?: boolean;
}): JSX.Element {
  const colour =
    destructive === true ? palette.danger : primary === true ? palette.accent : palette.label;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.answer, { borderTopColor: palette.separator }]}
    >
      <Text style={[styles.answerLabel, { color: colour }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingTop: 32, paddingHorizontal: 20 },
  title: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
  why: { fontSize: 13, marginBottom: 12 },
  text: { fontSize: 15, marginBottom: 16 },
  answer: { paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth },
  answerLabel: { fontSize: 16, fontWeight: "500" },
});

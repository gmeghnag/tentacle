/**
 * The outbox decision sheet (docs/feat/mobile-compose.md 13d, D4): the four
 * answers a person has when the phone's item can no longer go out by itself —
 * **Send** (the same key: exactly once even if it did run), **Queue as steer**
 * (only while a turn runs), **Discard**, **Edit**.
 *
 * A native page sheet (`Modal`, `pageSheet`: native slide and swipe-to-dismiss),
 * like 12c's permission sheet; its content is the shared `Sheet` with 50 pt pill
 * answers (mockup `Offline` → `Sheet`, docs/feat/mobile-ui-polish.md Slice 5).
 * What each answer DOES is the controller's (`compose-controller.ts`) — this
 * file only offers them.
 *
 * testIDs: `outbox-decision`, `outbox-send`, `outbox-steer`, `outbox-discard`,
 * `outbox-edit`, `outbox-close`.
 */
import type { JSX } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { type Palette, radius, typography } from "../../theme.ts";
import { PillButton } from "../../ui/PillButton.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Text } from "../../ui/Text.tsx";

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
    <Modal
      visible={open}
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={onClose}
    >
      <Sheet
        testID="outbox-decision"
        palette={palette}
        title="This message did not go out"
        subtitle={why}
        scroll
      >
        {item === null ? null : (
          <View style={[styles.quote, { borderColor: palette.dash }]}>
            <Text style={[typography.bubble, { color: palette.label }]} numberOfLines={6}>
              {item.text}
            </Text>
          </View>
        )}
        <View style={styles.answers}>
          <PillButton
            testID="outbox-send"
            label="Send"
            icon="arrow.up"
            kind="primary"
            palette={palette}
            onPress={onSend}
          />
          {steerable ? (
            <PillButton
              testID="outbox-steer"
              label="Queue as steer"
              icon="clock"
              kind="secondary"
              palette={palette}
              onPress={onSteer}
            />
          ) : null}
          <PillButton
            testID="outbox-edit"
            label="Edit"
            icon="square.and.pencil"
            kind="neutral"
            palette={palette}
            onPress={onEdit}
          />
          <PillButton
            testID="outbox-discard"
            label="Discard"
            icon="trash"
            kind="destructive"
            palette={palette}
            onPress={onDiscard}
          />
          <PillButton
            testID="outbox-close"
            label="Not now"
            kind="neutral"
            palette={palette}
            onPress={onClose}
          />
        </View>
      </Sheet>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // The message as the person wrote it: the same dashed bubble as its outbox row.
  quote: {
    alignSelf: "flex-end",
    maxWidth: "90%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.bubble,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  answers: { gap: 10, marginTop: 8 },
});

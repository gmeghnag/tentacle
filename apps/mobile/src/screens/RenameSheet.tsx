/**
 * The rename field (docs/feat/mobile-session-info.md, Owner decision 5): an iOS
 * alert with a text field, drawn in-app for the same reason `ActionSheet` is — RN's
 * new architecture exposes no native alert button to XCUITest, so a flow could
 * neither type into it nor prove its wording (plan P9).
 *
 * RENDER ONLY (AGENTS §7): `session-rename.ts` decides what the text means (empty
 * or unchanged is a no-op, a long title is refused) and what a failure says.
 */
import type { JSX } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import type { RenameState } from "../session-rename.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../theme.ts";
import { Text, TextInput } from "../ui/Text.tsx";

export interface RenameSheetProps {
  readonly palette: Palette;
  /** `null`: the field is closed (nothing is drawn). */
  readonly state: RenameState | null;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

export function RenameSheet({
  palette,
  state,
  onChange,
  onSave,
  onCancel,
}: RenameSheetProps): JSX.Element {
  return (
    <Modal visible={state !== null} transparent animationType="fade" onRequestClose={onCancel}>
      {/* A Modal is its own native window: the screen's KeyboardAvoidingView does
          not reach it, so the card is centred in the space ABOVE the keyboard
          only by this one (docs/fix/mobile-chat-glitches.md, bug 1). */}
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          accessibilityLabel="Dismiss"
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
          onPress={onCancel}
        />
        <View
          testID="session-rename-sheet"
          style={[styles.card, { backgroundColor: palette.sheet }]}
        >
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.title3, styles.center, { color: palette.label }]}
          >
            Rename session
          </Text>
          <TextInput
            testID="session-rename-input"
            accessibilityLabel="Session name"
            autoFocus
            style={[
              typography.body,
              styles.field,
              { color: palette.label, backgroundColor: palette.fill },
            ]}
            value={state?.text ?? ""}
            onChangeText={onChange}
            placeholder="Session name"
            placeholderTextColor={palette.sec}
            returnKeyType="done"
            onSubmitEditing={onSave}
            editable={state?.saving !== true}
          />
          {state?.error === null || state?.error === undefined ? null : (
            <Text
              testID="session-rename-error"
              style={[typography.footnote, styles.center, { color: palette.orange }]}
            >
              {state.error}
            </Text>
          )}
          <View style={[styles.buttons, { borderTopColor: palette.sepSheet }]}>
            <Pressable
              testID="session-rename-cancel"
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: pressed ? palette.fill : "transparent" },
              ]}
            >
              <Text style={[typography.body, { color: palette.accent }]}>Cancel</Text>
            </Pressable>
            <View style={[styles.divider, { backgroundColor: palette.sepSheet }]} />
            <Pressable
              testID="session-rename-save"
              accessibilityRole="button"
              onPress={onSave}
              disabled={state?.saving === true}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: pressed ? palette.fill : "transparent" },
              ]}
            >
              <Text
                style={[
                  typography.body,
                  {
                    fontWeight: "600",
                    color: state?.saving === true ? palette.sec : palette.accent,
                  },
                ]}
              >
                {state?.saving === true ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.inset + 8 },
  // `paddingTop`: the iOS alert's title inset — the title sat flush on the edge.
  card: {
    width: "100%",
    maxWidth: 340,
    borderRadius: radius.dialog,
    overflow: "hidden",
    gap: 12,
    paddingTop: 20,
  },
  center: { textAlign: "center" },
  field: { marginHorizontal: 16, marginTop: 4, borderRadius: radius.tile, padding: 12 },
  buttons: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4 },
  button: { flex: 1, minHeight: 46, alignItems: "center", justifyContent: "center" },
  divider: { width: StyleSheet.hairlineWidth },
});

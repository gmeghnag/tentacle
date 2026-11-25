/**
 * "Select text" (docs/feat/mobile-copy-text.md D4): a message's text in a
 * READ-ONLY multiline `TextInput`, so any part of it can be selected and copied
 * with UIKit's own handles — the one thing `<Text selectable>` cannot do on iOS
 * (`RCTParagraphComponentView.mm:344,386,399` copies the whole paragraph and
 * adds no handles; a `UITextView` never overrides `selectable`, so a read-only
 * input keeps handles, double-tap-a-word and the Copy/Look Up menu).
 *
 * It shows exactly the string the long-press copied (`messageText`), so "what
 * you select is what you paste", and "Copy all" runs the same copy path.
 *
 * Drawn in-app (a `Modal`, like `RenameSheet`) rather than as a native sheet
 * route: it is opened from the copy pill, which already lives on this screen.
 * Render only.
 */
import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { type Palette, radius, size, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Text, TextInput } from "../ui/Text.tsx";

export interface SelectTextSheetProps {
  readonly palette: Palette;
  /** `null`: the sheet is closed (nothing is drawn). */
  readonly text: string | null;
  readonly onClose: () => void;
  /** The same copy the long-press runs (the screen's handler); the sheet closes first so the pill is seen. */
  readonly onCopyAll: (text: string) => void;
}

export function SelectTextSheet({
  palette,
  text,
  onClose,
  onCopyAll,
}: SelectTextSheetProps): JSX.Element {
  return (
    <Modal visible={text !== null} transparent animationType="slide" onRequestClose={onClose}>
      {/* The scrim dismisses; the sheet itself is `ui/Sheet.tsx`'s content. */}
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Dismiss"
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
          onPress={onClose}
        />
        <View style={styles.bottom}>
          <Sheet palette={palette} title="Select text" testID="select-text-sheet" onClose={onClose}>
            <TextInput
              testID="select-text-body"
              value={text ?? ""}
              // Read-only, NOT disabled: `editable={false}` keeps the view
              // selectable (handles, Look Up, Copy); `disabled` would grey it and
              // swallow the very touches that make a selection.
              editable={false}
              multiline
              scrollEnabled
              autoCorrect={false}
              spellCheck={false}
              style={[styles.body, { color: palette.label }]}
            />
            <View style={styles.actions}>
              <Pressable
                testID="select-text-copy-all"
                accessibilityRole="button"
                accessibilityLabel="Copy all"
                // Close FIRST: the pill is drawn on the screen, under this
                // Modal, so "Copied" / "Couldn't copy" is only seen once the
                // sheet is gone (left open, a failure would be silent).
                onPress={() => {
                  onClose();
                  onCopyAll(text ?? "");
                }}
                hitSlop={8}
                style={[styles.copyAll, { backgroundColor: palette.fill }]}
              >
                <Icon name="doc.on.doc" color={palette.accent} size={13} />
                <Text style={[typography.footnote, { color: palette.accent }]}>Copy all</Text>
              </Pressable>
            </View>
          </Sheet>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  bottom: { width: "100%" },
  // The body IS the message: transcript type in a bounded scroller, so a ~200 KB
  // answer stays usable instead of pushing the sheet off the screen.
  body: {
    ...typography.transcript,
    maxHeight: 420,
    minHeight: 120,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", paddingTop: 4 },
  copyAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.inset,
    height: size.touch - 8,
    borderRadius: radius.pill,
  },
});

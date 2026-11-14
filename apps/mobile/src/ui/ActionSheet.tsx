/**
 * An iOS-style action sheet drawn in-app (docs/feat/mobile-ui-polish.md Owner
 * Q5): a dimmed backdrop, a grouped card of actions (optional title/message), and
 * a separate Cancel card, at the bottom above the home indicator.
 *
 * Why not `ActionSheetIOS` / `Alert`: RN's new architecture exposes no native
 * alert or action-sheet button to XCUITest, so a Maestro flow could neither tap
 * Remove nor prove its wording (plan P9; the reason the Remove confirmation was
 * already an in-app card). Every button here carries a testID. Render only.
 */
import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";

export interface SheetAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly testID?: string;
}

export interface ActionSheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly actions: readonly SheetAction[];
  readonly onCancel: () => void;
  readonly cancelTestID?: string;
  readonly testID?: string;
}

export function ActionSheet({
  palette,
  visible,
  title,
  message,
  actions,
  onCancel,
  cancelTestID,
  testID,
}: ActionSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Dismiss"
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={onCancel}
        />
        <View
          testID={testID}
          style={[styles.stack, { paddingBottom: Math.max(insets.bottom, 8) + 8 }]}
        >
          <View style={[styles.group, { backgroundColor: palette.sheet }]}>
            {title === undefined && message === undefined ? null : (
              <View style={styles.head}>
                {title === undefined ? null : (
                  <Text
                    style={[
                      typography.footnote,
                      styles.center,
                      { color: palette.sec, fontWeight: "600" },
                    ]}
                  >
                    {title}
                  </Text>
                )}
                {message === undefined ? null : (
                  <Text style={[typography.footnote, styles.center, { color: palette.sec }]}>
                    {message}
                  </Text>
                )}
              </View>
            )}
            {actions.map((action, index) => (
              <Pressable
                key={action.label}
                testID={action.testID}
                accessibilityRole="button"
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.action,
                  {
                    backgroundColor: pressed ? palette.fill : "transparent",
                    borderTopColor: palette.sepSheet,
                    borderTopWidth:
                      index === 0 && title === undefined && message === undefined
                        ? 0
                        : StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text
                  style={[
                    typography.body,
                    {
                      fontSize: 20,
                      color: action.destructive === true ? palette.red : palette.accent,
                    },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            testID={cancelTestID}
            accessibilityRole="button"
            onPress={onCancel}
            style={({ pressed }) => [
              styles.group,
              styles.action,
              { backgroundColor: pressed ? palette.fill : palette.sheet },
            ]}
          >
            <Text
              style={[typography.body, { fontSize: 20, fontWeight: "600", color: palette.accent }]}
            >
              Cancel
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { backgroundColor: "rgba(0,0,0,0.35)" },
  stack: { paddingHorizontal: space.inset / 2, gap: 8 },
  group: { borderRadius: radius.tile, overflow: "hidden" },
  head: { paddingHorizontal: space.inset, paddingVertical: 14, gap: 4 },
  center: { textAlign: "center" },
  action: { minHeight: SIZE.touch + 13, alignItems: "center", justifyContent: "center" },
});

/**
 * The chat's composer (mockup `Conversation` / `Compose`): a glass capsule
 * (≥ 48 pt) with the photo button and a 17 pt field, beside a round 48 pt
 * action — send `arrow.up` on `accentFill`, queue the same arrow (accent while a
 * turn runs), Stop a `label` disc with a `page` square, disabled `fill`/`sec`.
 * WHAT the action does is `composerAction`'s; this file only draws `button`.
 *
 * testIDs (the flows' contract, unchanged): `composer-input`, `composer-photo`,
 * `composer-send` / `composer-stop` / `composer-send-later`, `composer-filled`.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { type Palette, size, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";

export type ComposerButton = "send" | "queue" | "send-later" | "stop" | "disabled";

export interface ComposerProps {
  readonly palette: Palette;
  readonly draft: string;
  readonly editable: boolean;
  readonly placeholder: string;
  readonly button: ComposerButton;
  readonly onChange: (text: string) => void;
  readonly onReturn: () => void;
  readonly onPress: () => void;
  readonly onPhoto: () => void;
  /** Below the bar: the home indicator when the keyboard is closed (B1). */
  readonly bottomPadding: number;
}

const LABEL: Readonly<Record<ComposerButton, string>> = {
  send: "Send",
  queue: "Add to queue",
  "send-later": "Send when back online",
  stop: "Stop",
  disabled: "Send",
};

function testIdOf(button: ComposerButton): string {
  return button === "stop"
    ? "composer-stop"
    : button === "send-later"
      ? "composer-send-later"
      : "composer-send";
}

export function Composer({
  palette,
  draft,
  editable,
  placeholder,
  button,
  onChange,
  onReturn,
  onPress,
  onPhoto,
  bottomPadding,
}: ComposerProps): JSX.Element {
  const stop = button === "stop";
  const disabled = button === "disabled";
  const actionBg = stop ? palette.label : disabled ? palette.fill : palette.accentFill;
  return (
    <View style={[styles.bar, { paddingBottom: bottomPadding }]}>
      <View
        style={[
          styles.capsule,
          {
            backgroundColor: palette.glass,
            borderColor: palette.glassBorder,
            shadowOpacity: palette.shadowOpacity,
          },
        ]}
      >
        <Pressable
          testID="composer-photo"
          accessibilityRole="button"
          accessibilityLabel="Add a photo"
          disabled={!editable}
          onPress={onPhoto}
          hitSlop={6}
          style={styles.photo}
        >
          <Icon name="photo" color={editable ? palette.accent : palette.sec} size={20} />
        </Pressable>
        <TextInput
          testID="composer-input"
          style={[typography.body, styles.input, { color: palette.label }]}
          value={draft}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={palette.sec}
          editable={editable}
          multiline
          // B2 (owner Q1): Return SENDS — the key reads "Send"; a newline only by
          // pasting. What it does is `returnKeyAction`'s (never a Stop).
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={onReturn}
          accessibilityLabel="Message"
        />
        {/* Maestro cannot read the field's text (P9): this is how a flow proves
          the field is NOT empty (a hand-back, a Take, an Edit). */}
        {draft === "" ? null : (
          <Text testID="composer-filled" style={styles.hidden}>
            {""}
          </Text>
        )}
      </View>
      <Pressable
        testID={testIdOf(button)}
        accessibilityRole="button"
        accessibilityLabel={LABEL[button]}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.action,
          { backgroundColor: actionBg },
          pressed ? { opacity: 0.7 } : undefined,
        ]}
      >
        {stop ? (
          <View style={[styles.stopSquare, { backgroundColor: palette.page }]} />
        ) : button === "send-later" ? (
          <Icon name="clock" color={palette.onAccent} size={20} />
        ) : (
          <Icon
            name="arrow.up"
            color={disabled ? palette.sec : palette.onAccent}
            size={20}
            weight="bold"
          />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  capsule: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    minHeight: size.composer,
    borderRadius: size.composer / 2,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 20,
  },
  photo: {
    width: 36,
    height: size.composer - 2,
    alignItems: "center",
    justifyContent: "center",
  },
  input: { flex: 1, maxHeight: 132, paddingTop: 13, paddingBottom: 12, paddingRight: 10 },
  action: {
    width: size.composer,
    height: size.composer,
    borderRadius: size.composer / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquare: { width: 15, height: 15, borderRadius: 3 },
  // `composer-filled` is an OBSERVABLE, not decoration: zero-size keeps the row
  // where it was (P9's contract needs the id only).
  hidden: { width: 0, height: 0, fontSize: 0 },
});

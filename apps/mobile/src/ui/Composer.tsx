/**
 * The chat's composer (docs/feat/mobile-queued-compose.md D4, owner Q3): ONE
 * field — `fill`, a 1 pt separator stroke, a 22 pt radius — with the `TextInput`
 * on top and a 36 pt row under it: `+` on the left (the attach sheet), then the
 * `⇥ Send now` pill while Send now is offered, the mic, and the send slot at the
 * right. The slot's GLYPH is `sendSlot`'s (`composer.ts`), a total map of
 * `composerAction` — WHAT a tap does is the truth table's, this file only draws
 * `slot`.
 *
 * The old shape was a glass capsule with the photo button and the mic beside a
 * round button outside it; the mockup puts everything in one field, and the sheet
 * (`+`) is where a photo, a camera shot and a PDF already live (`openAttach`).
 *
 * testIDs (the flows' contract, unchanged): `composer-input`, `composer-photo`
 * (the `+`), `composer-send` / `composer-stop` / `composer-send-later` (the one
 * slot), `composer-mic` / `composer-mic-listening`, `composer-send-now` (now
 * INSIDE the field), `composer-filled`.
 */
import { type ComponentRef, type JSX, useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { SendSlot } from "../composer.ts";
import type { MicButton } from "../dictation.ts";
import { type Palette, radius, shadow, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text, TextInput } from "./Text.tsx";

export type ComposerButton = "send" | "queue" | "send-later" | "stop" | "disabled";

export interface ComposerProps {
  readonly palette: Palette;
  readonly draft: string;
  readonly editable: boolean;
  readonly placeholder: string;
  readonly button: ComposerButton;
  /** The slot's face (`sendSlot`): ↑, a dimmed ↑, ■, or a clock. */
  readonly slot: SendSlot;
  readonly onChange: (text: string) => void;
  readonly onReturn: () => void;
  readonly onPress: () => void;
  /** The `+`: the attach sheet (photo, camera, PDF — 13c/D7). */
  readonly onPhoto: () => void;
  /** **Send now** offered (`sendNowOffered`, D3): the pill in the field. */
  readonly sendNow: boolean;
  readonly onSendNow: () => void;
  /** Below the bar: the home indicator when the keyboard is closed (B1). */
  readonly bottomPadding: number;
  /** The dictation button (`micButtonOf`, docs/feat/mobile-voice.md Design §5). */
  readonly mic: MicButton;
  readonly onMic: () => void;
  /** The mic level 0..1 while listening (the waveform's opacity). */
  readonly level: number;
  /**
   * The field's `key`: a new value REMOUNTS it, so an emptied multiline field
   * measures its height from scratch instead of keeping the sent text's
   * (docs/fix/mobile-chat-glitches.md, item 6).
   */
  readonly fieldKey: number;
  /** Take focus once the field is editable (a session just created, mobile-chrome S7). */
  readonly focus?: boolean;
  /** Each new value (> 0) focuses the field again: the hub's Steer (docs/feat/mobile-hub.md H3). */
  readonly focusKey?: number;
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
  slot,
  onChange,
  onReturn,
  onPress,
  onPhoto,
  sendNow,
  onSendNow,
  bottomPadding,
  mic,
  onMic,
  level,
  fieldKey,
  focus = false,
  focusKey = 0,
}: ComposerProps): JSX.Element {
  // Focused when it first becomes editable (the attach answered), never again:
  // the person's own taps decide after that.
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focus && editable && !focused.current) {
      focused.current = true;
      input.current?.focus();
    }
  }, [focus, editable]);
  useEffect(() => {
    if (focusKey > 0) {
      input.current?.focus();
    }
  }, [focusKey]);
  const disabled = button === "disabled";
  const listening = mic === "listening";
  return (
    <View style={[styles.bar, { paddingBottom: bottomPadding }]}>
      <View
        style={[
          styles.field,
          {
            backgroundColor: palette.fill,
            borderColor: listening ? palette.accent : palette.sep,
            shadowOpacity: palette.shadowOpacity,
          },
        ]}
      >
        <TextInput
          key={fieldKey}
          testID="composer-input"
          ref={input}
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
        {/* The 36 pt row: `+`, then (right) Send now, the mic and the slot. */}
        <View style={styles.row}>
          <Pressable
            testID="composer-photo"
            accessibilityRole="button"
            accessibilityLabel="Add a photo or a file"
            disabled={!editable}
            onPress={onPhoto}
            hitSlop={6}
            style={styles.round}
          >
            <Icon name="plus" color={editable ? palette.label : palette.sec} size={19} />
          </Pressable>
          <View style={styles.flex} />
          {sendNow ? (
            <Pressable
              testID="composer-send-now"
              accessibilityRole="button"
              accessibilityLabel="Send now: stop the current step and send these"
              hitSlop={6}
              onPress={onSendNow}
              style={({ pressed }) => [
                styles.sendNow,
                { backgroundColor: palette.tint },
                pressed ? { opacity: 0.6 } : undefined,
              ]}
            >
              <Icon name="bolt.fill" color={palette.accent} size={13} />
              <Text style={[typography.caption, { color: palette.accent }]}>Send now</Text>
            </Pressable>
          ) : null}
          {mic === "hidden" ? null : (
            <Pressable
              testID={listening ? "composer-mic-listening" : "composer-mic"}
              accessibilityRole="button"
              accessibilityLabel={listening ? "Stop dictation" : "Dictate"}
              disabled={!editable}
              onPress={onMic}
              hitSlop={6}
              style={styles.round}
            >
              {listening ? (
                <View style={{ opacity: 0.4 + 0.6 * level }}>
                  <Icon name="waveform" color={palette.accent} size={19} />
                </View>
              ) : (
                <Icon
                  name="mic"
                  color={editable && mic === "idle" ? palette.accent : palette.sec}
                  size={19}
                />
              )}
            </Pressable>
          )}
          <Pressable
            testID={testIdOf(button)}
            accessibilityRole="button"
            accessibilityLabel={LABEL[button]}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
              styles.slot,
              {
                backgroundColor:
                  slot === "stop"
                    ? palette.label
                    : slot === "up-dim"
                      ? palette.fill
                      : slot === "clock"
                        ? palette.fill
                        : palette.accentFill,
              },
              pressed ? { opacity: 0.7 } : undefined,
            ]}
          >
            {slot === "stop" ? (
              <View style={[styles.stopSquare, { backgroundColor: palette.page }]} />
            ) : slot === "clock" ? (
              <Icon name="clock" color={palette.label} size={17} />
            ) : (
              <Icon
                name="arrow.up"
                color={slot === "up-dim" ? palette.sec : palette.onAccent}
                size={18}
                weight="bold"
              />
            )}
          </Pressable>
        </View>
        {/* Maestro cannot read the field's text (P9): this is how a flow proves
          the field is NOT empty (a hand-back, a Take, an Edit). */}
        {draft === "" ? null : (
          <Text testID="composer-filled" style={styles.hidden}>
            {" "}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 12, paddingTop: 8 },
  field: {
    borderWidth: 1,
    borderRadius: radius.composer,
    paddingTop: 4,
    paddingBottom: 6,
    paddingHorizontal: 6,
    ...shadow.glass,
  },
  input: { maxHeight: 132, paddingTop: 8, paddingBottom: 4, paddingHorizontal: 10 },
  row: { flexDirection: "row", alignItems: "center", height: 36, gap: 4, paddingHorizontal: 2 },
  flex: { flex: 1 },
  round: { width: 32, height: 36, alignItems: "center", justifyContent: "center" },
  sendNow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
  },
  slot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquare: { width: 14, height: 14, borderRadius: 3 },
  // `composer-filled` is an OBSERVABLE, not decoration: zero-size keeps the row
  // where it was (P9's contract needs the id only).
  // 1×1 and absolute, not 0×0: iOS 26 drops an empty-frame element from the
  // accessibility tree (slice 6 walk: `turn-idle`, same style, vanished).
  hidden: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    fontSize: 1,
    color: "transparent",
  },
});

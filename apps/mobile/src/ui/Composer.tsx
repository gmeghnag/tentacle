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
 * The round buttons (docs/feat/mobile-composer-buttons.md, owner B + S2): the
 * `+` and the mic sit in the same 32 pt circle of the accent at 10 % / 14 %
 * (`accentSoft`) inside a 44×44 pressable. Recording = a stronger circle
 * (`accentSoftStrong`), a filled 11 pt ■, a pulsing halo and the timer;
 * transcribing = a spinning arc and "…" — never told by colour alone (the owner
 * is colour-blind), and Reduce Motion holds both still. The send slot when ready
 * is a 36 pt `accentSoftStrong` circle with an accent ↑; empty, a bare ↑ in `sec`
 * at 50 %. The field's border is ALWAYS `sep`, recording included. The caption
 * and which face to show are the view-model's (`voiceComposerView`).
 *
 * testIDs (the flows' contract): `composer-input`, `composer-photo` (the `+`),
 * `composer-send` / `composer-stop` / `composer-send-later` (the one slot),
 * `composer-mic` / `composer-mic-listening` / `composer-mic-finalizing`,
 * `composer-mic-caption`, `composer-send-now` (INSIDE the field), `composer-filled`.
 */
import { type ComponentRef, type JSX, useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import type { SendSlot } from "../composer.ts";
import type { MicButton } from "../dictation.ts";
import { COMPOSER_HALO_MS, COMPOSER_TRANSCRIBE_TURN_MS } from "../motion.ts";
import { type Palette, radius, shadow, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text, TextInput } from "./Text.tsx";
import { useReduceMotion } from "./chart/ChartAppear.tsx";

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
  /** Beside the mic: "0:07" while recording, "…" while transcribing (`voiceComposerView`). */
  readonly micCaption?: string | undefined;
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

const MIC_ID: Readonly<Record<Exclude<MicButton, "hidden">, string>> = {
  idle: "composer-mic",
  preparing: "composer-mic",
  listening: "composer-mic-listening",
  finalizing: "composer-mic-finalizing",
};

const MIC_LABEL: Readonly<Record<Exclude<MicButton, "hidden">, string>> = {
  idle: "Dictate",
  preparing: "Dictate",
  listening: "Stop dictation",
  finalizing: "Transcribing",
};

/** The halo grows 32 → 42 pt (mockup B), over `COMPOSER_HALO_MS`. */
const HALO_SCALE = 42 / 32;

/** Recording: an accent ring that grows and fades; Reduce Motion holds it still. */
function Halo({ color }: { readonly color: string }): JSX.Element {
  const reduce = useReduceMotion() !== false;
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      return;
    }
    t.setValue(0);
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: COMPOSER_HALO_MS,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const motion = reduce
    ? { opacity: 0.18, transform: [{ scale: 1.2 }] }
    : {
        opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0] }),
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, HALO_SCALE] }) }],
      };
  return (
    <Animated.View pointerEvents="none" style={[styles.halo, { backgroundColor: color }, motion]} />
  );
}

/** Transcribing: a quarter-open arc that turns; Reduce Motion holds it still. */
function Spinner({ color }: { readonly color: string }): JSX.Element {
  const reduce = useReduceMotion() !== false;
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      return;
    }
    t.setValue(0);
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: COMPOSER_TRANSCRIBE_TURN_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const rotate = reduce
    ? "0deg"
    : t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[
        styles.arc,
        {
          borderTopColor: color,
          borderRightColor: color,
          borderBottomColor: color,
          transform: [{ rotate }],
        },
      ]}
    />
  );
}

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
  micCaption,
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
  const finalizing = mic === "finalizing";
  return (
    <View style={[styles.bar, { paddingBottom: bottomPadding }]}>
      <View
        style={[
          styles.field,
          {
            backgroundColor: palette.fill,
            // Always `sep`, recording included (owner 20/11).
            borderColor: palette.sep,
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
            style={styles.hit}
          >
            <View style={[styles.circle, { backgroundColor: palette.accentSoft }]}>
              <Icon
                name="plus"
                color={editable ? palette.accent : palette.sec}
                size={20}
                weight="light"
              />
            </View>
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
          {mic === "hidden" || micCaption === undefined ? null : (
            <Text
              testID="composer-mic-caption"
              style={[typography.caption, styles.caption, { color: palette.sec }]}
            >
              {micCaption}
            </Text>
          )}
          {mic === "hidden" ? null : (
            <Pressable
              testID={MIC_ID[mic]}
              accessibilityRole="button"
              accessibilityLabel={MIC_LABEL[mic]}
              accessibilityState={{ disabled: !editable || finalizing }}
              // A tap while transcribing does nothing (`dictationReduce`): say so.
              disabled={!editable || finalizing}
              onPress={onMic}
              style={styles.hit}
            >
              <View
                style={[
                  styles.circle,
                  { backgroundColor: listening ? palette.accentSoftStrong : palette.accentSoft },
                ]}
              >
                {listening ? (
                  <>
                    <Halo color={palette.accent} />
                    <View style={[styles.recSquare, { backgroundColor: palette.accent }]} />
                  </>
                ) : finalizing ? (
                  <Spinner color={palette.sec} />
                ) : (
                  <Icon
                    name="mic"
                    color={editable && mic === "idle" ? palette.accent : palette.sec}
                    size={22}
                    weight="light"
                  />
                )}
              </View>
            </Pressable>
          )}
          <Pressable
            testID={testIdOf(button)}
            accessibilityRole="button"
            accessibilityLabel={LABEL[button]}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            // The 36 pt circle + 4 pt each side = a 44 pt target.
            hitSlop={4}
            style={({ pressed }) => [
              styles.slot,
              {
                // S2: ready = the soft strong circle; empty = no circle at all.
                backgroundColor:
                  slot === "stop"
                    ? palette.label
                    : slot === "up-dim"
                      ? "transparent"
                      : slot === "clock"
                        ? palette.fill
                        : palette.accentSoftStrong,
              },
              pressed ? { opacity: 0.7 } : undefined,
            ]}
          >
            {slot === "stop" ? (
              <View style={[styles.stopSquare, { backgroundColor: palette.page }]} />
            ) : slot === "clock" ? (
              <Icon name="clock" color={palette.label} size={17} />
            ) : (
              <View style={slot === "up-dim" ? styles.dim : undefined}>
                <Icon
                  name="arrow.up"
                  color={slot === "up-dim" ? palette.sec : palette.accent}
                  size={18}
                  weight="bold"
                />
              </View>
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
  // A 44×44 target in the 36 pt row: it overhangs 4 pt above and below.
  hit: {
    width: 44,
    height: 44,
    marginVertical: -4,
    alignItems: "center",
    justifyContent: "center",
  },
  circle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  halo: { position: "absolute", width: 32, height: 32, borderRadius: 16 },
  recSquare: { width: 11, height: 11, borderRadius: 2.5 },
  arc: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.3,
    borderLeftColor: "transparent",
  },
  caption: { minWidth: 26, textAlign: "right", fontVariant: ["tabular-nums"] },
  dim: { opacity: 0.5 },
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

/**
 * The "Button opacity" band (docs/feat/mobile-hub-opacity.md Design 4, mockup
 * variant B): a continuous 30–100 % slider with a live preview of the floating
 * button over chat text.
 *
 * Render + drag plumbing only (AGENTS §7): the track→percentage maths, the floor,
 * the clamp and the VoiceOver step are `hub-opacity.ts`'s. The drag keeps a LOCAL
 * value so the label and the preview move with the finger; ONE write reaches the
 * Keychain, on release — a write per move would be a write per frame.
 */
import type { JSX } from "react";
import { useRef, useState } from "react";
import { type AccessibilityActionEvent, PanResponder, StyleSheet, Text, View } from "react-native";
import {
  OPACITY_DEFAULT,
  OPACITY_MAX,
  OPACITY_MIN,
  clampOpacity,
  opacityAt,
  shownOpacity,
  stepOpacity,
} from "../hub-opacity.ts";
import { DENSE_FONT_SCALE, type Palette, shadow, space, typography } from "../theme.ts";
import { BandSection } from "./BandSection.tsx";

/** The preview's circle: the real button's 54 pt (`FLOAT_SIZE`). */
const PREVIEW_SIZE = 54;
const TRACK_HEIGHT = 22;
const THUMB = 22;

export interface HubOpacityBandProps {
  readonly palette: Palette;
  /** The committed setting, as a percentage; absent → the 100 % default. */
  readonly opacity: number | undefined;
  /** False over a newer build's record: the slider is disabled and says why. */
  readonly writable: boolean;
  /** Called ONCE per gesture, on release. */
  readonly onChange: (opacity: number) => void;
}

export function HubOpacityBand({
  palette,
  opacity,
  writable,
  onChange,
}: HubOpacityBandProps): JSX.Element {
  const value = clampOpacity(opacity ?? OPACITY_DEFAULT);
  // The finger's own value while it drags: the label and the preview follow it,
  // the record does not (one write, on release). `null` outside a gesture, so
  // `shown` follows the stored value again (a VoiceOver step must move).
  const [dragging, setDragging] = useState<number | null>(null);
  // The finger's live value, mirrored outside React: an updater must not write
  // (StrictMode may call it twice, which would be two Keychain writes).
  const dragged = useRef<number | null>(null);
  const shown = shownOpacity(dragging, value);
  const width = useRef(0);
  const ratio = (shown - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN);
  const canDrag = useRef(writable);
  canDrag.current = writable;
  // The committed value as of the last render, so a gesture that ends where it
  // started writes nothing.
  const committedValue = useRef(value);
  committedValue.current = value;
  const latest = useRef<{
    at: (x: number) => number;
    dragTo: (x: number) => void;
    commit: () => void;
    onChange: (opacity: number) => void;
  }>({
    at: (x: number) => opacityAt(x, width.current),
    dragTo: () => undefined,
    commit: () => undefined,
    onChange,
  });

  /** The finger's value at this move: the label and the preview, no write. */
  const dragTo = (x: number) => {
    const next = latest.current.at(x);
    dragged.current = next;
    setDragging(next);
  };

  /**
   * The gesture's END: drop the local value (so `shown` follows the stored one
   * again — a VoiceOver step after a drag must move, not re-write the same
   * number) and make ONE write, only when the value actually moved.
   */
  const commit = () => {
    const local = dragged.current;
    dragged.current = null;
    setDragging(null);
    if (local !== null && local !== committedValue.current) {
      latest.current.onChange(local);
    }
  };

  latest.current = {
    at: (x: number) => opacityAt(x, width.current),
    dragTo,
    commit,
    onChange,
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => canDrag.current,
      onMoveShouldSetPanResponder: () => canDrag.current,
      // Through `latest`: the responder is built ONCE, so a direct call would keep
      // the first render's closure forever. `locationX` is the TRACK's own x: the
      // rail, the fill and the thumb are `pointerEvents="none"`, so they never
      // become the touch's target (a hit on the thumb read 0–22, not the spot).
      onPanResponderGrant: (event) => latest.current.dragTo(event.nativeEvent.locationX),
      onPanResponderMove: (event) => latest.current.dragTo(event.nativeEvent.locationX),
      onPanResponderRelease: () => latest.current.commit(),
      onPanResponderTerminate: () => latest.current.commit(),
    }),
  ).current;
  // VoiceOver's `adjustable`: one 5 % step per increment / decrement.
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (!writable || (name !== "increment" && name !== "decrement")) {
      return;
    }
    onChange(stepOpacity(shown, name === "increment" ? 1 : -1));
  };

  return (
    <BandSection
      palette={palette}
      title="Button opacity"
      footnote={
        writable
          ? "Solid while you touch it, and the working arc always stays solid."
          : "Set by a newer version of tentacle — this version cannot change it."
      }
    >
      <View style={styles.band}>
        <View style={styles.labelRow}>
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.body, { color: palette.label }]}
          >
            Opacity
          </Text>
          <Text
            testID="hub-opacity-value"
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, styles.value, { color: palette.sec }]}
          >
            {`${shown}%`}
          </Text>
        </View>
        <View
          testID="hub-opacity-slider"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Button opacity"
          accessibilityValue={{ min: OPACITY_MIN, max: OPACITY_MAX, now: shown, text: `${shown}%` }}
          accessibilityState={{ disabled: !writable }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={onAccessibilityAction}
          onLayout={(event) => {
            width.current = event.nativeEvent.layout.width;
          }}
          style={[styles.track, writable ? {} : styles.disabled]}
          {...(writable ? pan.panHandlers : {})}
        >
          <View
            pointerEvents="none"
            style={[styles.rail, { backgroundColor: palette.switchOff }]}
          />
          <View
            pointerEvents="none"
            style={[
              styles.fill,
              { backgroundColor: palette.accentFill, width: `${Math.round(ratio * 100)}%` },
            ]}
          />
          <View
            pointerEvents="none"
            style={[
              styles.thumb,
              { backgroundColor: palette.page, left: `${Math.round(ratio * 100)}%` },
            ]}
          />
        </View>
        <View style={styles.ends}>
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, styles.end, { color: palette.sec }]}
          >
            {`${OPACITY_MIN}%`}
          </Text>
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, styles.end, { color: palette.sec }]}
          >
            {`${OPACITY_MAX}%`}
          </Text>
        </View>
      </View>
      {/* The preview: the button at this level over two lines of chat text, with
          the working arc — which is always solid, so the user sees why. */}
      <View
        testID="hub-opacity-preview"
        style={[styles.preview, { backgroundColor: palette.page }]}
      >
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          numberOfLines={2}
          style={[typography.footnote, styles.sample, { color: palette.label }]}
        >
          The relay answers, but the first ping arrives after the 5 s the test allows when the suite
          runs in parallel.
        </Text>
        <View style={[styles.circle, { opacity: shown / 100 }]}>
          <View
            style={[
              StyleSheet.absoluteFill,
              styles.clip,
              { backgroundColor: palette.glass, borderColor: palette.glassBorder },
            ]}
          />
          <View style={styles.grid}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={[styles.dot, { backgroundColor: palette.accent }]} />
            ))}
          </View>
        </View>
        <View style={[styles.previewArc, { borderTopColor: palette.accent }]} />
      </View>
    </BandSection>
  );
}

const styles = StyleSheet.create({
  band: { paddingHorizontal: space.rowX, paddingTop: 10, paddingBottom: 12 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  value: { fontVariant: ["tabular-nums"] },
  track: { height: TRACK_HEIGHT, justifyContent: "center" },
  disabled: { opacity: 0.4 },
  rail: { position: "absolute", left: 0, right: 0, height: 2, borderRadius: 1 },
  fill: { position: "absolute", left: 0, height: 2, borderRadius: 1 },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    marginLeft: -THUMB / 2,
    ...shadow.glass,
  },
  ends: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  end: { fontVariant: ["tabular-nums"] },
  preview: {
    height: 74,
    justifyContent: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.08)",
  },
  sample: { paddingLeft: space.rowX, paddingRight: PREVIEW_SIZE + 40 },
  circle: {
    position: "absolute",
    right: 20,
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: PREVIEW_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  clip: { borderRadius: PREVIEW_SIZE / 2, overflow: "hidden", borderWidth: 1 },
  // The arc is OUTSIDE the circle's opacity layer, so it stays solid: the same
  // split the real button makes (docs/feat/mobile-hub-opacity.md).
  previewArc: {
    position: "absolute",
    right: 20,
    top: 10,
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: PREVIEW_SIZE / 2,
    borderWidth: 2,
    borderColor: "transparent",
  },
  grid: { width: 14, height: 14, flexDirection: "row", flexWrap: "wrap", gap: 4 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});

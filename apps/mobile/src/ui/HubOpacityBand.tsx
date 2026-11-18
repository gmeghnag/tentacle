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
  PREVIEW_SAMPLE,
  clampOpacity,
  opacityAt,
  settledReleased,
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
  // The finger's own value while it drags, AND the value it released afterwards:
  // the label and the preview follow it, the record does not (one write, on
  // release). It is NOT cleared at release — the write is one async Keychain
  // round-trip (`set` awaits `store.write` before it publishes), so clearing it
  // there would show the old stored number for that whole round-trip and then
  // jump (review round 4, finding 2). It is cleared once the record has caught
  // up with it, below — `null` then, so a VoiceOver step after a drag moves.
  const [dragging, setDragging] = useState<number | null>(null);
  // The finger's live value, mirrored outside React: an updater must not write
  // (StrictMode may call it twice, which would be two Keychain writes).
  const dragged = useRef<number | null>(null);
  // The record has caught up with the released value (or the write failed and
  // published it anyway): let `shown` follow the stored value again. During
  // render, not in an effect, so the frame that shows the new record shows it
  // (an effect would paint one more frame of the released value). The rule itself
  // is `settledReleased` (`hub-opacity.ts`), where it is unit-tested.
  const settled = settledReleased(dragging, value);
  if (settled !== dragging) {
    setDragging(settled);
  }
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
   * The gesture's END: make ONE write, only when the value actually moved.
   *
   * The released value is KEPT (`dragging` stays set) until the stored prop
   * equals it: the write is one async round-trip, and the store publishes only
   * after it, so dropping the value here would flash the old stored one and then
   * jump. A write that FAILS still publishes the pick (F22), so the value settles
   * either way; a refused one (`ActivitySettingsPreserved`) throws before it
   * publishes, and then the hold simply stays — the slider is disabled in that
   * case (`writable` false), so nothing re-arms the value.
   */
  const commit = () => {
    const local = dragged.current;
    dragged.current = null;
    if (local !== null) {
      setDragging(local);
    }
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
  // VoiceOver's `adjustable`: one 5 % step per increment / decrement. It drops any
  // held released value first: a step is authoritative, so `shown` must follow the
  // record again as soon as this step's write lands.
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (!writable || (name !== "increment" && name !== "decrement")) {
      return;
    }
    setDragging(null);
    dragged.current = null;
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
              // The accent fill, not the page: on the page colour the thumb was
              // white on the white light band (docs/fix/mobile-qa-1117.md, bug 1).
              // `shadow.glass` has no opacity of its own: iOS draws none without it.
              {
                backgroundColor: palette.accentFill,
                shadowOpacity: palette.shadowOpacity,
                left: `${Math.round(ratio * 100)}%`,
              },
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
          {PREVIEW_SAMPLE}
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

/**
 * The chat header's 20 pt context ring (docs/feat/mobile-chrome.md Design 2, A1):
 * the same fraction the flat bar used to draw, as a thin circle so the header
 * keeps one line of height.
 *
 * Drawn with plain `View`s on purpose — NO `react-native-svg`, so the restyle
 * needs no native rebuild and no new dependency. Each half of the ring is one
 * clipped 180° window (`overflow: hidden`) over a full-size box whose visible
 * border arc (`borderTop` + `borderLeft`) is half the ring; the pure
 * `ringHalfRotation` (chat-header.ts) says how far each half is rotated, so the
 * two arcs always join into one sweep (AGENTS §7: the geometry is decided and
 * tested in the pure module, this file only maps it to styles).
 *
 * The reading is VoiceOver-able (F11): the ring says `Context 34%`, and the whole
 * 44 pt target opens Session info.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ringArcs, ringHalfRotation, ringLabel } from "../chat-header.ts";
import { type Palette, size as SIZE } from "../theme.ts";

export interface ContextRingProps {
  readonly palette: Palette;
  /** The context's share of the window, 0–100 (`state.view.headerContext.percent`). */
  readonly percent: number;
  readonly onPress?: () => void;
  readonly testID?: string;
}

/** The ring's diameter (Design 2) and its stroke. */
const RING = 20;
const STROKE = 1.8;

export function ContextRing({ palette, percent, onPress, testID }: ContextRingProps): JSX.Element {
  const arcs = ringArcs(percent);
  const rotation = ringHalfRotation(arcs);
  const tone = arcs.tone === "orange" ? palette.orange : palette.accent;
  const label = ringLabel(percent);
  const ring = (
    <View style={styles.ring}>
      {/* The track: one full circle in the separator colour. */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderWidth: STROKE, borderColor: palette.sep, borderRadius: RING / 2 },
        ]}
      />
      <HalfRing rotation={rotation.right} tone={tone} side="right" />
      <HalfRing rotation={rotation.left} tone={tone} side="left" />
    </View>
  );
  if (onPress === undefined) {
    return (
      <View
        testID={testID}
        style={styles.touch}
        accessible
        accessibilityLabel={label}
        accessibilityRole="progressbar"
      >
        {ring}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens this session's info"
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [styles.touch, { opacity: pressed ? 0.5 : 1 }]}
    >
      {ring}
    </Pressable>
  );
}

/**
 * One half of the ring: a half-plane window (`overflow: hidden`) over a
 * full-size box whose arc is rotated about the RING's centre — the box is
 * shifted by half a ring inside the window on each side, so its centre stays the
 * ring's. The window is what clips, so a half can only paint its own side.
 */
function HalfRing({
  rotation,
  tone,
  side,
}: {
  readonly rotation: number;
  readonly tone: string;
  readonly side: "left" | "right";
}): JSX.Element {
  return (
    <View
      pointerEvents="none"
      style={[styles.window, side === "left" ? styles.windowLeft : styles.windowRight]}
    >
      <View
        style={[
          styles.arc,
          side === "left" ? styles.arcLeft : styles.arcRight,
          {
            borderTopColor: tone,
            borderLeftColor: tone,
            transform: [{ rotate: `${rotation}deg` }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  touch: {
    minWidth: SIZE.touch,
    minHeight: SIZE.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: { width: RING, height: RING },
  window: { position: "absolute", top: 0, width: RING / 2, height: RING, overflow: "hidden" },
  windowRight: { left: RING / 2 },
  windowLeft: { left: 0 },
  arc: {
    width: RING,
    height: RING,
    borderWidth: STROKE,
    borderColor: "transparent",
    borderRadius: RING / 2,
  },
  // Inside the right window the box starts one half to the LEFT, so its centre
  // lands on the ring's; inside the left window it starts at 0 (same result).
  arcRight: { left: -RING / 2 },
  arcLeft: { left: 0 },
});

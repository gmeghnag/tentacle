/**
 * A partial ring drawn with plain `View`s — no `react-native-svg`, so it needs no
 * native rebuild (the `ContextRing` constraint, now shared): each half of the
 * ring is a clipped 180° window (`overflow: hidden`) over a full-size box whose
 * visible border arc (`borderTop` + `borderLeft`) is half the ring; the pure
 * `ringHalfRotation` (chat-header.ts) says how far each half is rotated, so the
 * two arcs always join into one sweep (AGENTS §7: the geometry is decided and
 * tested in the pure module, this file only maps it to styles).
 *
 * Extracted from `ui/ContextRing.tsx` by docs/feat/mobile-hub-badges.md
 * Design 8, so the header's context ring and a fan item's count rim are ONE
 * renderer: the hub was about to grow a second copy of this geometry.
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { ringArcs, ringHalfRotation } from "../chat-header.ts";

export interface RingArcProps {
  /** The ring's outer diameter (pt). */
  readonly diameter: number;
  /** Its stroke width (pt). */
  readonly stroke: number;
  /** How much of the circle is drawn, 0–1 (values outside are clamped). */
  readonly fraction: number;
  /** The arc's colour (a palette value, already resolved by the caller). */
  readonly tone: string;
  /** A full circle behind the arc, in this colour; omitted → no track. */
  readonly track?: string | undefined;
  readonly testID?: string | undefined;
}

export function RingArc({
  diameter,
  stroke,
  fraction,
  tone,
  track,
  testID,
}: RingArcProps): JSX.Element {
  // The pure module speaks percent; the sweep rule is its own (`ringArcs`).
  const arcs = ringArcs(fraction * 100);
  const rotation = ringHalfRotation(arcs);
  return (
    <View testID={testID} pointerEvents="none" style={{ width: diameter, height: diameter }}>
      {track === undefined ? null : (
        <View
          style={[
            StyleSheet.absoluteFill,
            { borderWidth: stroke, borderColor: track, borderRadius: diameter / 2 },
          ]}
        />
      )}
      <HalfArc
        rotation={rotation.right}
        tone={tone}
        side="right"
        diameter={diameter}
        stroke={stroke}
      />
      <HalfArc
        rotation={rotation.left}
        tone={tone}
        side="left"
        diameter={diameter}
        stroke={stroke}
      />
    </View>
  );
}

/**
 * One half of the ring: a half-plane window (`overflow: hidden`) over a
 * full-size box whose arc is rotated about the RING's centre — the box is
 * shifted by half a ring inside the window on each side, so its centre stays the
 * ring's. The window is what clips, so a half can only paint its own side.
 */
function HalfArc({
  rotation,
  tone,
  side,
  diameter,
  stroke,
}: {
  readonly rotation: number;
  readonly tone: string;
  readonly side: "left" | "right";
  readonly diameter: number;
  readonly stroke: number;
}): JSX.Element {
  const half = diameter / 2;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.window,
        { width: half, height: diameter },
        side === "left" ? styles.windowLeft : { left: half },
      ]}
    >
      <View
        style={[
          styles.arc,
          // Inside the right window the box starts one half to the LEFT, so its
          // centre lands on the ring's; inside the left window it starts at 0.
          { width: diameter, height: diameter, borderRadius: half, borderWidth: stroke },
          side === "left" ? { left: 0 } : { left: -half },
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
  window: { position: "absolute", top: 0, overflow: "hidden" },
  windowLeft: { left: 0 },
  arc: { borderColor: "transparent" },
});

/**
 * The chat header's 20 pt context ring (docs/feat/mobile-chrome.md Design 2, A1):
 * the same fraction the flat bar used to draw, as a thin circle so the header
 * keeps one line of height.
 *
 * The geometry is `ui/RingArc.tsx`'s (plain `View`s, no `react-native-svg`, so no
 * native rebuild) — shared with a fan item's count rim since
 * docs/feat/mobile-hub-badges.md Design 8. What stays here is the reading: which
 * tone the fraction gets (`ringArcs`) and the VoiceOver label (F11: `Context 34%`,
 * and the whole 44 pt target opens Session info).
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ringArcs, ringLabel } from "../chat-header.ts";
import { type Palette, size as SIZE } from "../theme.ts";
import { RingArc } from "./RingArc.tsx";

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
  const tone = arcs.tone === "orange" ? palette.orange : palette.accent;
  const label = ringLabel(percent);
  const ring = (
    <View style={styles.ring}>
      <RingArc
        diameter={RING}
        stroke={STROKE}
        fraction={(Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0) / 100}
        tone={tone}
        track={palette.sep}
      />
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

const styles = StyleSheet.create({
  touch: {
    minWidth: SIZE.touch,
    minHeight: SIZE.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: { width: RING, height: RING },
});

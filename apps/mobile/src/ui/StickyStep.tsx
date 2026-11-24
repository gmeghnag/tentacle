/**
 * The sticky step row over an open long output (docs/feat/mobile-shell-output-scroll.md,
 * owner "b"): the command, the position «line X of N» and «Collapse». Absolute at
 * the top of the transcript; `offsetY` slides it up while the block's end (or the
 * next block) pushes it away. Presentation only — `output-sticky.ts` decides.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { StickyState } from "../output-sticky.ts";
import { MONO, type Palette, typography } from "../theme.ts";
import { Text } from "./Text.tsx";

/** The row's height: `output-sticky.ts` blocks use the same number. */
export const STICKY_HEAD_H = 44;

export interface StickyStepProps {
  readonly state: StickyState;
  readonly label: string;
  readonly palette: Palette;
  readonly onCollapse: () => void;
}

export function StickyStep({ state, label, palette, onCollapse }: StickyStepProps): JSX.Element {
  return (
    <View
      testID="sticky-step"
      style={[
        styles.row,
        {
          backgroundColor: palette.page,
          borderBottomColor: palette.sep,
          transform: [{ translateY: state.offsetY }],
        },
      ]}
    >
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.label, { color: palette.label }]}>
          {label}
        </Text>
        <Text style={[typography.footnote, { color: palette.sec }]}>
          {`line ${state.line} of ${state.total}`}
        </Text>
      </View>
      <Pressable
        testID="sticky-step-collapse"
        accessibilityRole="button"
        accessibilityLabel="Collapse output"
        hitSlop={8}
        onPress={onCollapse}
      >
        <Text style={[typography.footnote, { color: palette.accent }]}>Collapse</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: STICKY_HEAD_H,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1 },
  label: { fontSize: 12, lineHeight: 17, fontFamily: MONO },
});

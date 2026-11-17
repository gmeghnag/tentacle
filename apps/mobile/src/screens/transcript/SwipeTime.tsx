/**
 * Swipe a row left to reveal its arrival time (docs/fix/mobile-open-at-end.md,
 * slice B). A DUMB renderer over `row-swipe.ts`'s pure rules: which gesture the
 * row claims, how far it travels and what the label says are all decided there
 * (AGENTS §7); this file owns the `Animated.Value`, the `PanResponder` wiring and
 * the look.
 *
 * Why it is safe over a virtualised list, a scroll and a native back-swipe:
 * - the responder is **move-only** (`onMoveShouldSetPanResponder`, never
 *   `onStart…`): a tap — a tool row's expand, a text selection, the speak button
 *   — never grants us the gesture;
 * - `claimsPan` refuses everything but a clearly horizontal LEFT movement, so a
 *   vertical scroll keeps the responder and the RIGHTWARD back-swipe (the
 *   native-stack pop) is never ours;
 * - `onPanResponderTerminationRequest` says YES: if the list takes the gesture
 *   (a scroll that starts first, a cell being recycled), we spring back rather
 *   than hold a stuck offset;
 * - the row's layout is untouched: `translateX` is a transform and the label is
 *   absolutely positioned INSIDE the frame at its right edge (`right: 0`), so
 *   neither extends the content height (`follow.ts`'s `contentGrew` never fires
 *   from a swipe) nor changes a row's cell size. The row is OPAQUE and drawn over
 *   the label, so the time only shows where the row has given up its strip
 *   (Review round 1, HIGH 2: at `right: -REVEAL` the label sat outside the
 *   full-width cell — past the ScrollView's edge, clipped — and the row uncovered
 *   an empty strip instead).
 *
 * The label has no `Date`/`Intl` of its own: `timeLabel(item.at)` is computed by
 * the caller (which already reads the row), so this component stays a renderer.
 */
import { type JSX, useMemo, useRef } from "react";
import { Animated, PanResponder, StyleSheet, Text, View } from "react-native";
import { REVEAL, claimsPan, revealOffset } from "../../row-swipe.ts";
import { type Palette, typography } from "../../theme.ts";
import type { Row } from "../../transcript-rows.ts";

export interface SwipeTimeProps {
  readonly row: Row;
  readonly palette: Palette;
  /** The label to reveal: `timeLabel(row.at)`, or null (no time → the row never moves). */
  readonly label: string | null;
  readonly children: JSX.Element;
}

export function SwipeTime({ palette, label, children }: SwipeTimeProps): JSX.Element {
  const translateX = useRef(new Animated.Value(0)).current;
  /**
   * The label as the responder reads it: a `PanResponder` is created once (its
   * handlers must stay stable across renders), so it reads the LATEST label from
   * here rather than from the closure it was built in.
   */
  const latest = useRef<{ hasTime: boolean }>({ hasTime: label !== null });
  latest.current = { hasTime: label !== null };

  const pan = useMemo(() => {
    /** Back to rest: on release, on termination, and after a completed swipe. */
    const settle = (): void => {
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        bounciness: 0,
      }).start();
    };
    return PanResponder.create({
      // MOVE-only: a touch that never travels is the row's own (taps, selection).
      onMoveShouldSetPanResponder: (_event, g) =>
        claimsPan({ dx: g.dx, dy: g.dy }, latest.current.hasTime),
      onPanResponderMove: (_event, g) => {
        translateX.setValue(revealOffset(g.dx));
      },
      // A native scroll (or anything else) may take the gesture: we let it, and
      // come back to rest. Refusing here is what leaves a row stuck off-axis.
      onPanResponderTerminationRequest: () => true,
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    });
  }, [translateX]);

  return (
    <View style={styles.frame}>
      {/* Absolutely positioned INSIDE the frame at its right edge, and a SIBLING
          BEFORE the translating view: it can never change the row's height (so
          the follow machinery sees no growth), and the opaque row covers it until
          the swipe gives up that strip. */}
      <View pointerEvents="none" style={styles.label}>
        <Text
          maxFontSizeMultiplier={1}
          numberOfLines={1}
          style={[typography.mono, { color: palette.sec }]}
        >
          {label ?? ""}
        </Text>
      </View>
      <Animated.View
        style={[{ backgroundColor: palette.page }, { transform: [{ translateX }] }]}
        {...pan.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Clipped: the row translating left must not draw past its own cell. */
  frame: { overflow: "hidden" },
  label: {
    position: "absolute",
    right: 0,
    width: REVEAL,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});

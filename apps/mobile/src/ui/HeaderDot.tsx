/**
 * The chat header's 6 pt state dot, before the title
 * (docs/feat/mobile-header-status.md). WHAT it looks like is `dotLook`'s
 * (`chat-header.ts`); this only draws it: filled or a ring, and a native-driver
 * opacity pulse that holds steady under Reduce Motion. Render only.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { type HeaderDot as Dot, dotLook } from "../chat-header.ts";
import { HEADER_DOT_HALF_MS, HEADER_DOT_LOW_OPACITY } from "../motion.ts";
import type { Palette } from "../theme.ts";
import { toneColor } from "./StatusDot.tsx";

const SIZE = 6;

export function HeaderDot({
  palette,
  dot,
}: {
  readonly palette: Palette;
  readonly dot: Dot;
}): JSX.Element {
  const look = dotLook(dot);
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduce(on));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  const opacity = useRef(new Animated.Value(1)).current;
  const pulse = look.pulse && !reduce;
  useEffect(() => {
    if (!pulse) {
      opacity.setValue(1);
      return;
    }
    const half = {
      duration: HEADER_DOT_HALF_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    };
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: HEADER_DOT_LOW_OPACITY, ...half }),
        Animated.timing(opacity, { toValue: 1, ...half }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, opacity]);
  const color = toneColor(palette, look.tone);
  return (
    <Animated.View
      testID={`session-header-dot-${dot}`}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        opacity,
        ...(look.hollow ? { borderWidth: 1.25, borderColor: color } : { backgroundColor: color }),
      }}
    />
  );
}

/**
 * The floating Activity button (docs/feat/mobile-chrome.md Design 6, F2 opt-in):
 * a 54 pt glass circle with the spinner and the count, resting on an edge of the
 * band between the header and the composer. Render + gesture plumbing only:
 * where it rests, what is a tap, when it shows and how it moves are
 * `floating-button.ts`'s. `PanResponder` (core RN, no gesture library) feeds raw
 * points in; the position is reported only on drop, never per frame.
 */
import { BlurView } from "expo-blur";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  PanResponder,
  StyleSheet,
  Text,
} from "react-native";
import {
  FLOAT_SIZE,
  type FloatBounds,
  type FloatPosition,
  a11y,
  isTap,
  motion,
  place,
  snap,
} from "../floating-button.ts";
import { DENSE_FONT_SCALE, type Palette, shadow, typography } from "../theme.ts";

/** VoiceOver and Reduce Motion, read live (F23): toggling either converges without a restart. */
export function useAccessibilityFlags(): { voiceOver: boolean; reduceMotion: boolean } {
  const [voiceOver, setVoiceOver] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => live && setVoiceOver(on));
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduceMotion(on));
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setVoiceOver);
    const reduce = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      live = false;
      reader.remove();
      reduce.remove();
    };
  }, []);
  return { voiceOver, reduceMotion };
}

export interface FloatingActivityProps {
  readonly palette: Palette;
  /** The band's measured size (null until measured). */
  readonly bounds: FloatBounds | null;
  readonly position: FloatPosition | undefined;
  /** `floating-button.ts` `visible`: fades out (and stops taking touches) when false. */
  readonly shown: boolean;
  readonly label: string;
  readonly running: boolean;
  readonly accessibilityLabel: string;
  readonly voiceOver: boolean;
  readonly reduceMotion: boolean;
  readonly onPress: () => void;
  readonly onDrop: (position: FloatPosition) => void;
}

export function FloatingActivity(props: FloatingActivityProps): JSX.Element | null {
  const { palette, bounds, position, shown, label, running, voiceOver, reduceMotion } = props;
  const at = bounds === null ? null : place(position, bounds);
  const xy = useRef(new Animated.ValueXY(at ?? { x: 0, y: 0 })).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // While a finger holds it or the snap runs, a re-placement must not yank it.
  const moving = useRef(false);
  // The PanResponder is created once; it reads the latest props through this.
  const latest = useRef(props);
  latest.current = props;

  // Re-placed when the stored spot or the band changes (keyboard, rotation).
  const atX = at?.x;
  const atY = at?.y;
  useEffect(() => {
    if (atX !== undefined && atY !== undefined && !moving.current) {
      xy.setValue({ x: atX, y: atY });
    }
  }, [atX, atY, xy]);

  // Fades in/out (150 ms); once faded OUT it unmounts, so neither VoiceOver nor
  // a test finds an invisible button.
  const fadeMs = motion(reduceMotion).fadeMs;
  const [rendered, setRendered] = useState(shown);
  useEffect(() => {
    if (shown) {
      setRendered(true);
    }
    Animated.timing(opacity, {
      toValue: shown ? 1 : 0,
      duration: fadeMs,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !shown) {
        setRendered(false);
      }
    });
  }, [shown, fadeMs, opacity]);

  const pan = useMemo(() => {
    let start = { x: 0, y: 0 };
    let t0 = 0;
    const back = () => {
      xy.setValue(start);
      moving.current = false;
    };
    return PanResponder.create({
      // F21: a touch that STARTS on the button is the button's (the back-swipe
      // keeps every other edge touch). VoiceOver: not draggable (F23).
      onStartShouldSetPanResponder: () => a11y(latest.current.voiceOver).draggable,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const p = latest.current;
        const from = p.bounds === null ? null : place(p.position, p.bounds);
        start = from ?? { x: 0, y: 0 };
        t0 = Date.now();
        moving.current = true;
      },
      onPanResponderMove: (_event, g) => {
        xy.setValue({ x: start.x + g.dx, y: start.y + g.dy });
      },
      onPanResponderRelease: (_event, g) => {
        const p = latest.current;
        if (isTap({ dx: g.dx, dy: g.dy, ms: Date.now() - t0 })) {
          back();
          p.onPress();
          return;
        }
        const centre = { x: start.x + g.dx + FLOAT_SIZE / 2, y: start.y + g.dy + FLOAT_SIZE / 2 };
        const dropped = p.bounds === null ? null : snap(centre, p.bounds);
        const target = dropped === null || p.bounds === null ? null : place(dropped, p.bounds);
        if (dropped === null || target === null) {
          back();
          return;
        }
        if (motion(p.reduceMotion).spring) {
          Animated.spring(xy, { toValue: target, useNativeDriver: false }).start(() => {
            moving.current = false;
          });
        } else {
          xy.setValue(target);
          opacity.setValue(0);
          Animated.timing(opacity, {
            toValue: 1,
            duration: motion(true).fadeMs,
            useNativeDriver: false,
          }).start();
          moving.current = false;
        }
        p.onDrop(dropped);
      },
      onPanResponderTerminate: back,
    });
  }, [xy, opacity]);

  if (at === null || !rendered) {
    return null;
  }
  return (
    <Animated.View
      testID="floating-activity"
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={a11y(voiceOver).hint}
      onAccessibilityTap={props.onPress}
      pointerEvents={shown ? "auto" : "none"}
      style={[
        styles.circle,
        {
          borderColor: palette.glassBorder,
          shadowOpacity: palette.shadowOpacity,
          opacity,
          transform: xy.getTranslateTransform(),
        },
      ]}
      {...(a11y(voiceOver).draggable ? pan.panHandlers : {})}
    >
      <BlurView
        pointerEvents="none"
        intensity={60}
        tint="systemUltraThinMaterial"
        style={[StyleSheet.absoluteFill, styles.clip]}
      />
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.clip, { backgroundColor: palette.glass }]}
      />
      {running ? <ActivityIndicator size="small" color={palette.accent} /> : null}
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        numberOfLines={1}
        style={[typography.footnote, styles.label, { color: palette.accent }]}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  circle: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    borderRadius: FLOAT_SIZE / 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.glass,
  },
  clip: { borderRadius: FLOAT_SIZE / 2, overflow: "hidden" },
  label: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});

/**
 * The inline chart's appear animation (docs/feat/model-charts.md rev 2 item 8,
 * slice C7). It maps `appearPlan` (pure, `chart-interact.ts`) to ONE
 * `Animated.View` around the plot: a left-to-right wipe for lines, a spring
 * from the baseline for bars, a pop for the donut, and with Reduce Motion an
 * opacity fade only. The plan is fixed once Reduce Motion is known, so a row
 * never switches animation mid-way; a row that does not animate renders still.
 */
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";
import { type AppearPlan, SPRING, appearPlan, chartMotion } from "../../chart-interact.ts";
import type { LayoutKind } from "../../chart-layout.ts";

/** Reduce Motion, read live; `null` until the first read answers. */
export function useReduceMotion(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (on) => live && setReduce(on),
      () => live && setReduce(false),
    );
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

export interface ChartAppearProps {
  readonly kind: LayoutKind;
  /** `claimAppear`'s answer for this row (history and seen rows: false). */
  readonly animate: boolean;
  readonly width: number;
  readonly children: ReactNode;
}

export function ChartAppear({ kind, animate, width, children }: ChartAppearProps): JSX.Element {
  const reduce = useReduceMotion();
  // undefined = waiting for Reduce Motion; null = still.
  const [plan, setPlan] = useState<AppearPlan | null | undefined>(animate ? undefined : null);
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (plan === undefined && reduce !== null) {
      setPlan(appearPlan(chartMotion(kind, { animate: true, reduceMotion: reduce })));
    }
  }, [plan, reduce, kind]);
  useEffect(() => {
    if (plan === undefined || plan === null) return;
    const steps: Animated.CompositeAnimation[] = [];
    if (plan.scale !== undefined) {
      steps.push(
        Animated.spring(progress, { toValue: 1, ...SPRING, useNativeDriver: plan.native }),
      );
    }
    if (plan.wipe !== undefined) {
      steps.push(
        Animated.timing(progress, {
          toValue: 1,
          duration: plan.wipe.ms,
          easing: Easing.bezier(0.25, 0.8, 0.25, 1),
          useNativeDriver: plan.native,
        }),
      );
    }
    if (plan.opacity !== undefined) {
      steps.push(
        Animated.timing(opacity, {
          toValue: 1,
          duration: plan.opacity.ms,
          delay: plan.opacity.delay,
          useNativeDriver: plan.native,
        }),
      );
    }
    const run = Animated.parallel(steps);
    run.start();
    return () => run.stop();
  }, [plan, progress, opacity]);
  if (plan === null) return <>{children}</>;
  if (plan === undefined) return <View style={{ opacity: 0 }}>{children}</View>;
  const scale = plan.scale;
  const scaled =
    scale === undefined
      ? {}
      : {
          transformOrigin: scale.origin,
          transform: [
            {
              [scale.axis === "x" ? "scaleX" : scale.axis === "y" ? "scaleY" : "scale"]:
                progress.interpolate({ inputRange: [0, 1], outputRange: [scale.from, 1] }),
            },
          ],
        };
  const wiped =
    plan.wipe === undefined
      ? {}
      : {
          overflow: "hidden" as const,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: [0, width] }),
        };
  const faded = plan.opacity === undefined ? {} : { opacity };
  return <Animated.View style={[scaled, wiped, faded]}>{children}</Animated.View>;
}

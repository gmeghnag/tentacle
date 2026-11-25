/**
 * The floating hub button's animation plans (docs/feat/mobile-hub-native-driver.md):
 * the config each `Animated` call in `ui/FloatingActivity.tsx` is given, so the
 * timing rules live here and the component only starts them.
 *
 * Every plan is on the NATIVE driver. The button animates only opacity and a
 * translate transform — both native-capable — and its position is never fed by
 * an `Animated.event` (the press machine's `dragTo` sets it, `hub-session.ts`),
 * so nothing has to stay on the JS driver. On the native driver the fade, the
 * rest-level fade and the drop spring run on the UI thread: a JS thread busy
 * with a streaming turn cannot stutter them. Note RN's rule: all the values on
 * one view go native together (a view's props node is native or not), which is
 * why the fade and the position must move in the same change.
 */
import { motion } from "./floating-button.ts";
import type { Point } from "./hub-fan.ts";
import { HUB_GLOW_IN_MS, HUB_GLOW_OUT_MS } from "./motion.ts";

export interface TimingPlan {
  readonly toValue: number;
  readonly duration: number;
  readonly useNativeDriver: true;
}

/** The show/hide fade of the whole button (150 ms; kept under Reduce Motion). */
export function fadePlan(shown: boolean, reduceMotion: boolean): TimingPlan {
  return { toValue: shown ? 1 : 0, duration: motion(reduceMotion).fadeMs, useNativeDriver: true };
}

/**
 * The body's rest level (`hub-opacity.ts`): up to solid is instant (feedback at
 * once), back down to the setting takes the fade.
 */
export function levelPlan(body: number, reduceMotion: boolean): TimingPlan {
  return {
    toValue: body,
    duration: body === 1 ? 0 : motion(reduceMotion).fadeMs,
    useNativeDriver: true,
  };
}

export type DropPlan =
  | {
      readonly kind: "spring";
      readonly spring: { readonly toValue: Point; readonly useNativeDriver: true };
    }
  | {
      /** Reduce Motion (F23): placed at once, then faded in from `fadeFrom`. */
      readonly kind: "place";
      readonly at: Point;
      readonly fadeFrom: number;
      readonly fade: TimingPlan;
    };

/** The one-shot glow of news arriving (mobile-hub-badges Design 5, owner Q1 C). */
export interface GlowPlan {
  /** Opacity steps, played in order: peak, then back to nothing. */
  readonly fade: readonly { readonly toValue: number; readonly duration: number }[];
  /** The glow's scale at its peak. */
  readonly scale: number;
  readonly native: true;
}

/**
 * How the button's glow plays: 0 → 0.9 over 220 ms, then back to 0 over 480 ms
 * (≈ 700 ms in all), so it is SEEN once and leaves nothing behind — the whole
 * point of Q1 C over the dot it replaces. Reduce Motion keeps the fade (its width
 * is what carries the news) and drops the growth: `scale` 1, i.e. no motion.
 */
export function glowPlan(reduceMotion: boolean): GlowPlan {
  return {
    fade: [
      { toValue: 0.9, duration: HUB_GLOW_IN_MS },
      { toValue: 0, duration: HUB_GLOW_OUT_MS },
    ],
    scale: reduceMotion ? 1 : GLOW_SCALE,
    native: true,
  };
}

/** How much the glow grows at its peak (Design 5: 1 → 1.18). */
export const GLOW_SCALE = 1.18;

/** Where a dropped button goes: a spring, or (Reduce Motion) a placement + a fade. */ export function dropPlan(
  target: Point,
  reduceMotion: boolean,
): DropPlan {
  if (motion(reduceMotion).spring) {
    return { kind: "spring", spring: { toValue: target, useNativeDriver: true } };
  }
  return { kind: "place", at: target, fadeFrom: 0, fade: fadePlan(true, true) };
}

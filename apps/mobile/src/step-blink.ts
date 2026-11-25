/**
 * A RUNNING tool step's node (docs/fix/mobile-running-row.md; owner 21/11,
 * feat/shell-intent-line mockup section C): the TUI's blinking bullet — the done
 * dot's place and size, in accent, fully ON then fully OFF on the TUI's rhythm
 * (`STEP_BLINK_HALF_MS` = `packages/tui/src/blink.ts` `BLINK_HALF_MS`), every
 * running step on ONE shared clock so they blink together, like the TUI's one
 * phase. Reduce Motion: the same dot, steady. Not by hue alone (owner
 * colour-blind): the blink and the trailing (live clock vs `✓ 1.2 s`) say it.
 *
 * Pure, React-free (AGENTS §7): `ui/StepNode.tsx` feeds the curve to
 * `Animated.Value.interpolate` on the native driver.
 */
import { STEP_BLINK_HALF_MS } from "./motion.ts";
import type { Curve } from "./thinking-motion.ts";

/** One loop of the shared blink clock: ON half, then OFF half. */
export const STEP_BLINK_LOOP_MS = 2 * STEP_BLINK_HALF_MS;

/**
 * The dot's opacity over one loop (input 0..1): 1 for the first half, 0 for the
 * second — a step, not a fade (the TUI conceals its `●` outright). The 1/1000
 * ramp keeps the input strictly increasing for the native interpolator.
 */
export const STEP_BLINK_CURVE: Curve = {
  inputRange: [0, 0.499, 0.5, 1],
  outputRange: [1, 1, 0, 0],
};

/** What a running step's node looks like: always the accent dot; it blinks unless Reduce Motion. */
export function runningDotLook(reduceMotion: boolean): {
  readonly shape: "dot";
  readonly fill: "accent";
  readonly blink: boolean;
} {
  return { shape: "dot", fill: "accent", blink: !reduceMotion };
}

/**
 * The REASONING node (docs/fix/mobile-step-rail.md, owner decision 4): the same
 * dot in the same place as a tool's, so the thread has ONE shape and reasoning
 * reads by SHAPE, not by a glyph.
 *
 * - `thinking-live` (still thinking): a FILLED dot in the app accent — the
 *   running tool's own token and its own blink clock (never a second timer).
 *   Reduce Motion ⇒ the same dot, steady.
 * - `thought-done` (`Thought · 2 s`): a RING, outline only, in `thought` — a dim
 *   "disabled" grey (a theme token, light and dark), so a finished thought steps
 *   back behind the actions.
 */
export function thoughtLook(live: boolean): {
  readonly node: "thinking-live" | "thought-done";
  readonly fill: "accent" | null;
  readonly ring: "thought" | null;
} {
  return live
    ? { node: "thinking-live", fill: "accent", ring: null }
    : { node: "thought-done", fill: null, ring: "thought" };
}

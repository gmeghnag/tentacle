/**
 * How see-through the floating hub button is (docs/feat/mobile-hub-opacity.md).
 * A pure, React-free module (AGENTS §7): `ui/FloatingActivity.tsx` applies what
 * this returns and decides nothing itself.
 *
 * The owner's rules (mockup variant B, 2026-11-17):
 *  - at rest the BODY renders at the setting; the floor is 30 %, so the button is
 *    never invisible;
 *  - it goes to 100 % while it is touched (a finger down already counts: a press
 *    emits no effect on down, `hub-gesture.ts:108`), while the fan is open, and
 *    while iOS Reduce Transparency is on;
 *  - the running-turn arc stays at 100 % at any setting. Below 75 % it gets
 *    thicker (2 → 3 pt) and gains a halo in the page colour, so it still reads
 *    over a faint body.
 *
 * Why the intersection: RN multiplies a parent's opacity into its children, so
 * the arc lives OUTSIDE the body layer and only follows the show/hide fade. Its
 * effective opacity is `fade × 1` and the body's is `fade × level` — which is why
 * this result has no arc opacity at all.
 */
import type { GestureState } from "./hub-gesture.ts";

/** The slider's floor: below this the button would be invisible (owner Q). */
export const OPACITY_MIN = 30;
export const OPACITY_MAX = 100;
/** Today's look: nothing changes until the user moves the slider (owner Q2). */
export const OPACITY_DEFAULT = 100;

/** Below this the arc thickens and gains a halo (mockup: `low = o < 0.75`). */
const ARC_FAINT_BELOW = 0.75;
const ARC_WIDTH = 2;
const ARC_WIDTH_FAINT = 3;
/** One VoiceOver adjustable step, in percentage points. */
const STEP = 5;

/**
 * A stored or dragged value as the setting really is: a whole percentage inside
 * the floor and the ceiling. Never NaN (a junk value reads as the floor).
 */
export function clampOpacity(n: number): number {
  if (!Number.isFinite(n) || n <= OPACITY_MIN) {
    return n === Number.POSITIVE_INFINITY ? OPACITY_MAX : OPACITY_MIN;
  }
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(n)));
}

export interface HubArc {
  /** The arc's border width in points. */
  readonly width: number;
  /** A page-coloured halo behind it, so a faint body cannot swallow it. */
  readonly halo: boolean;
}

export interface HubOpacity {
  /** The body layer's opacity: the setting at rest, 1 while engaged. */
  readonly body: number;
  /** The running-turn arc, always at full opacity (it follows the outer fade only). */
  readonly arc: HubArc;
}

export function hubOpacity(input: {
  readonly setting: number | undefined;
  /** The press machine's state (`hub-gesture.ts:52-69`), read via `driver.state()`. */
  readonly gesture: GestureState["kind"];
  readonly fanOpen: boolean;
  readonly reduceTransparency: boolean;
}): HubOpacity {
  const engaged = input.gesture !== "idle" || input.fanOpen || input.reduceTransparency;
  const body = engaged ? 1 : clampOpacity(input.setting ?? OPACITY_DEFAULT) / 100;
  const faint = body < ARC_FAINT_BELOW;
  return { body, arc: { width: faint ? ARC_WIDTH_FAINT : ARC_WIDTH, halo: faint } };
}

/**
 * A touch on the slider's track → a percentage. A zero (or negative) width is the
 * floor rather than a division by zero, and an overshoot past either end clamps.
 */
export function opacityAt(x: number, width: number): number {
  if (!(width > 0)) {
    return OPACITY_MIN;
  }
  return clampOpacity(OPACITY_MIN + (x / width) * (OPACITY_MAX - OPACITY_MIN));
}

/** VoiceOver's `adjustable`: one step up (+1) or down (−1), clamped. */
export function stepOpacity(v: number, dir: 1 | -1): number {
  return clampOpacity(clampOpacity(v) + dir * STEP);
}

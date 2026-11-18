/**
 * How see-through the floating hub button is (docs/feat/mobile-hub-opacity.md).
 * A pure, React-free module (AGENTS §7): `ui/FloatingActivity.tsx` applies what
 * this returns and decides nothing itself.
 *
 * The owner's rules (mockup variant B, 2026-11-17):
 *  - at rest the BODY renders at the setting; the floor is 20 %, so the button is
 *    never invisible. The setting is one of FIVE steps, 20 · 40 · 60 · 80 · 100
 *    (docs/feat/mobile-hub-defaults.md, owner 2026-11-18: was continuous 30–100);
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
export const OPACITY_MIN = 20;
export const OPACITY_MAX = 100;
/** The distance between two steps, in percentage points: also one VoiceOver step. */
export const OPACITY_STEP = 20;
/** Every value the setting can take: 20 · 40 · 60 · 80 · 100. */
export const OPACITY_STEPS: readonly number[] = [20, 40, 60, 80, 100];
/**
 * A record that HAS no opacity (a pick made before the slider existed, or before
 * the user moved it): solid, as it always was (owner Q2 of mobile-hub-opacity).
 * A phone with NO record gets `OPACITY_FIRST_RUN` instead, through
 * `DEFAULT_ACTIVITY_SETTINGS` (docs/feat/mobile-hub-defaults.md).
 */
export const OPACITY_DEFAULT = 100;
/** A fresh install's level (owner 2026-11-18): see `DEFAULT_ACTIVITY_SETTINGS`. */
export const OPACITY_FIRST_RUN = 80;

/**
 * The preview's sample: two lines of an ordinary reply under the button, so the
 * person judges the level against chat text (docs/fix/mobile-qa-1117.md, bug 1:
 * the first build showed a developer's note about a test suite instead).
 */
export const PREVIEW_SAMPLE =
  "Done — the summary is ready. Two files changed, and both of them could use a quick read.";

/** Below this the arc thickens and gains a halo (mockup: `low = o < 0.75`). */
const ARC_FAINT_BELOW = 0.75;
const ARC_WIDTH = 2;
const ARC_WIDTH_FAINT = 3;
/**
 * A stored or dragged value as the setting really is: the NEAREST of the five
 * steps, a tie going UP (30 → 40, 50 → 60, 10 → 20), clamped to the floor and
 * the ceiling. Never NaN (a junk value reads as the floor). An off-step record —
 * written by the continuous slider of mobile-hub-opacity, e.g. 35 — is snapped
 * on READ; it is not rewritten until the user changes the setting.
 */
export function snapOpacity(n: number): number {
  if (Number.isNaN(n)) {
    return OPACITY_MIN;
  }
  const step = Math.floor((n + OPACITY_STEP / 2) / OPACITY_STEP) * OPACITY_STEP;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, step));
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
  const body = engaged ? 1 : snapOpacity(input.setting ?? OPACITY_DEFAULT) / 100;
  const faint = body < ARC_FAINT_BELOW;
  return { body, arc: { width: faint ? ARC_WIDTH_FAINT : ARC_WIDTH, halo: faint } };
}

/**
 * A touch on the slider's track → a percentage. A zero (or negative) width is the
 * floor rather than a division by zero, and an overshoot past either end clamps.
 *
 * `x` is measured from the TRACK: the rail, the fill and the thumb are all
 * `pointerEvents="none"` (`HubOpacityBand.tsx`), so the track is the touch's
 * target and `locationX` is never measured inside the 22 pt thumb.
 */
export function opacityAt(x: number, width: number): number {
  if (!(width > 0)) {
    return OPACITY_MIN;
  }
  return snapOpacity(OPACITY_MIN + (x / width) * (OPACITY_MAX - OPACITY_MIN));
}

/**
 * What the slider shows, and what a VoiceOver step starts from: the finger's own
 * value while a gesture is live, and — after it ends — the value it released,
 * for as long as the record has not caught up with it. That hold is the whole
 * point: the write is one async Keychain round-trip
 * (`activity-settings-store.ts`, `set`: `await store.write` then `publish`), so
 * dropping the local value at release would show the OLD stored number for the
 * length of that round-trip and then jump. Callers pass the released value only
 * until `value === released` (or forever, if the write fails — a failed write
 * still publishes the pick, F22), and `null` once it is settled, so a VoiceOver
 * step after a drag moves again. The stored value is clamped here too, so a raw
 * record never leaks out.
 */
export function shownOpacity(released: number | null, stored: number | undefined): number {
  if (released !== null) {
    return snapOpacity(released);
  }
  return snapOpacity(stored ?? OPACITY_DEFAULT);
}

/**
 * The slider's `released` slot after a render: the held value while the record
 * has not caught up with it yet, and `null` once it has — so `shownOpacity`
 * follows the stored value again (a VoiceOver step, another surface's change).
 *
 * The write is one async Keychain round-trip (`activity-settings-store.ts`,
 * `set` awaits `store.write` then `publish`), so the stored prop lags the
 * finger by that round-trip; clearing the hold at release (round 4's bug) showed
 * the OLD number for its length and then jumped. The hold ends on both settle
 * paths: a successful write publishes the value, and a FAILED one publishes the
 * pick anyway (F22), so the two match either way.
 */
export function settledReleased(
  released: number | null,
  stored: number | undefined,
): number | null {
  return released === null || snapOpacity(stored ?? OPACITY_DEFAULT) !== snapOpacity(released)
    ? released
    : null;
}

/** VoiceOver's `adjustable`: one step up (+1) or down (−1), clamped. */
export function stepOpacity(v: number, dir: 1 | -1): number {
  return snapOpacity(snapOpacity(v) + dir * OPACITY_STEP);
}

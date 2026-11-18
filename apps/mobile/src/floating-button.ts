/**
 * The floating Activity button's rules (docs/feat/mobile-chrome.md Design 6,
 * S10): pure, no React. `ui/FloatingActivity.tsx` feeds it raw points and
 * renders what it returns.
 *
 * Geometry is in the coordinates of the BAND the button lives in: the view
 * between the header and the composer (`SessionScreen`'s list host). Its
 * measured `{width, height}` is the bounds, so the keyboard (which shrinks the
 * band) and the composer's growth are inputs, never guesses (F20).
 */
import { classifyPress } from "./hub-gesture.ts";

/** The button's diameter (pt). */
export const FLOAT_SIZE = 54;
/** How far inside the screen edge it rests: clear of the back-swipe's first pixels (F21). */
export const EDGE_INSET = 10;
/** The gap kept to the header above and the composer below. */
export const BAND_MARGIN = 8;
/**
 * The column the button OCCUPIES at its edge (its inset plus its diameter).
 * Anything tappable at the transcript's foot — the pending bubbles and their
 * inline Edit · Send now · Cancel (`screens/compose/PendingBubble.tsx`) — keeps
 * this clear at BOTH edges, so an action stays reachable whichever side the hub
 * rests on (QA bug 1: the pending row ran to the screen edge and Cancel sat
 * exactly under the hub, where a tap opened the fan instead).
 */
export const HUB_COLUMN = EDGE_INSET + FLOAT_SIZE;
/** The fade when it appears / disappears, and Reduce Motion's placement. */
export const FADE_MS = 150;

export type ActivityButtonMode = "header" | "floating";
export type Edge = "left" | "right";

/** What is stored: an edge and where along the band (0 = top, 1 = bottom). */
export interface FloatPosition {
  readonly edge: Edge;
  readonly yFraction: number;
}

/** The band's measured size. */
export interface FloatBounds {
  readonly width: number;
  readonly height: number;
}

/** Where the button's CENTRE may go vertically, or null when the band is too short (F20). */
function centreRange(bounds: FloatBounds): { min: number; max: number } | null {
  if (!(bounds.height >= FLOAT_SIZE * 2) || !(bounds.width >= FLOAT_SIZE * 2)) {
    return null;
  }
  return {
    min: BAND_MARGIN + FLOAT_SIZE / 2,
    max: bounds.height - BAND_MARGIN - FLOAT_SIZE / 2,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

/** Does the band fit the button at all (F20: < 2 × size → hidden). */
export function fits(bounds: FloatBounds): boolean {
  return centreRange(bounds) !== null;
}

/**
 * Where a drop lands: the nearest vertical edge by the button's centre (exactly
 * on the midline → right), y clamped to the band and stored as its fraction.
 */
export function snap(drop: { x: number; y: number }, bounds: FloatBounds): FloatPosition | null {
  const range = centreRange(bounds);
  if (range === null) {
    return null;
  }
  const edge: Edge = drop.x < bounds.width / 2 ? "left" : "right";
  // The clamp to the band is the fraction's (a non-finite drop → the bottom).
  return { edge, yFraction: clamp01((drop.y - range.min) / (range.max - range.min)) };
}

/**
 * The button's top-left for a stored position in the CURRENT band (a rotation,
 * the keyboard, a different phone re-project it). No position → right edge,
 * bottom of the band.
 */
export function place(
  stored: FloatPosition | undefined,
  bounds: FloatBounds,
): { x: number; y: number } | null {
  const range = centreRange(bounds);
  if (range === null) {
    return null;
  }
  const edge = stored?.edge ?? "right";
  const fraction = clamp01(stored?.yFraction ?? 1);
  const centre = range.min + fraction * (range.max - range.min);
  return {
    x: edge === "left" ? EDGE_INSET : bounds.width - EDGE_INSET - FLOAT_SIZE,
    y: centre - FLOAT_SIZE / 2,
  };
}

/**
 * A tap opens Activity; anything else is a drag or the hub's long-press (never
 * both). The thresholds are the hub machine's (`hub-gesture.ts`: 10 pt / 400 ms).
 */
export function isTap(path: { dx: number; dy: number; ms: number }): boolean {
  return classifyPress(path) === "tap";
}

/**
 * The hub (docs/feat/mobile-hub.md Design 6): drawn whenever "floating" is on —
 * at zero activity too, so its actions stay reachable — and hidden only while
 * the drawer or a sheet covers it, or while the band is too short (F20).
 */
export function visible(input: {
  readonly mode: ActivityButtonMode;
  readonly covered: boolean;
  readonly fits: boolean;
}): boolean {
  return input.mode === "floating" && !input.covered && input.fits;
}

/** Reduce Motion: an immediate placement + a fade, no spring/overshoot (F23). */
export function motion(reduceMotion: boolean): {
  readonly spring: boolean;
  readonly fadeMs: number;
} {
  return { spring: !reduceMotion, fadeMs: FADE_MS };
}

/** VoiceOver: fixed at its edge, not draggable, activate = open (F23). */
export function a11y(voiceOver: boolean): { readonly draggable: boolean; readonly hint: string } {
  return { draggable: !voiceOver, hint: "Opens running sub-agents and jobs" };
}

/**
 * Whether the header pill is drawn: always in "header"; in "floating" only while
 * VoiceOver runs, so the control is where VoiceOver expects it (F23).
 */
export function headerPill(input: {
  readonly mode: ActivityButtonMode;
  readonly voiceOver: boolean;
}): boolean {
  return input.mode === "header" || input.voiceOver;
}

/**
 * The transcript's foot clearance (QA bug 1): how far the pending bubbles and
 * their inline actions must stay from the screen's edges so a tap never lands on
 * the floating hub. The button can rest at EITHER edge (`snap`), so both are
 * reserved — an action under the fan is a tap that opens Activity instead of
 * cancelling a message, which is the bug. With no floating button drawn (the
 * header mode, a covered sheet, a band too short) there is nothing to clear.
 */
export function footClearance(drawn: boolean): number {
  return drawn ? HUB_COLUMN : 0;
}

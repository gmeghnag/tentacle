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
/** The fade when it appears / disappears, and Reduce Motion's placement. */
export const FADE_MS = 150;

export type ActivityButtonMode = "header" | "floating";
/**
 * The three resting places (docs/feat/mobile-hub-center.md, owner 1): the left
 * edge, the CENTRE of the band, and the right edge. The type keeps its name —
 * every importer would change for no behaviour.
 */
export type Edge = "left" | "center" | "right";

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

/**
 * The CENTRE x of each resting place in this band: inset + a half button at the
 * edges, the band's own middle at the centre. One source of truth, so `snap`'s
 * boundaries and `place` can never disagree (docs/feat/mobile-hub-center.md D1).
 */
function restX(edge: Edge, width: number): number {
  switch (edge) {
    case "left":
      return EDGE_INSET + FLOAT_SIZE / 2;
    case "center":
      return width / 2;
    case "right":
      return width - EDGE_INSET - FLOAT_SIZE / 2;
  }
}

/** Does the band fit the button at all (F20: < 2 × size → hidden). */
export function fits(bounds: FloatBounds): boolean {
  return centreRange(bounds) !== null;
}

/**
 * Where a drop lands: the NEAREST of the three resting places by the button's
 * centre (owner 1, orchestrator O1). The boundaries are the midpoints between
 * resting centres — the rule that used to be the single midline — and a drop
 * exactly on one goes to the CENTRE. A non-finite x still goes right. y is
 * clamped to the band and stored as its fraction, as before.
 */
export function snap(drop: { x: number; y: number }, bounds: FloatBounds): FloatPosition | null {
  const range = centreRange(bounds);
  if (range === null) {
    return null;
  }
  const left = restX("left", bounds.width);
  const middle = restX("center", bounds.width);
  const right = restX("right", bounds.width);
  const edge: Edge = !Number.isFinite(drop.x)
    ? "right"
    : drop.x < (left + middle) / 2
      ? "left"
      : drop.x <= (middle + right) / 2
        ? "center"
        : "right";
  // The clamp to the band is the fraction's (a non-finite drop → the bottom).
  return { edge, yFraction: clamp01((drop.y - range.min) / (range.max - range.min)) };
}

/**
 * The button's top-left for a stored position in the CURRENT band (a rotation,
 * the keyboard, a different phone re-project it). No position → right edge,
 * bottom of the band. The centre re-projects to the band's middle, so it stays
 * centred on every width.
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
    x: restX(edge, bounds.width) - FLOAT_SIZE / 2,
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

/** The transcript's own bottom padding when nothing floats over its end. */
export const LIST_END_PADDING = 16;

/**
 * The transcript's bottom padding (fix/mobile-qa-1119 row 17; the SETTING is
 * owner 6 of docs/feat/mobile-hub-center.md): with the hub resting in the band's
 * LOWER half, the list's end clears the hub's top edge, so the last row is
 * readable at rest instead of running under the button. A hub in the upper half
 * (or none, or a band too short to place one) leaves the plain padding: a
 * scrolled-to-end list never ends there.
 *
 * `enabled` is REQUIRED, so a caller cannot forget the setting: false is the
 * owner's "the chat runs under the button", the plain padding before any
 * geometry.
 */
export function listEndPadding(input: {
  readonly mode: ActivityButtonMode;
  readonly position: FloatPosition | undefined;
  readonly bounds: FloatBounds | null;
  readonly enabled: boolean;
}): number {
  if (!input.enabled || input.mode !== "floating" || input.bounds === null) {
    return LIST_END_PADDING;
  }
  const at = place(input.position, input.bounds);
  if (at === null) {
    return LIST_END_PADDING;
  }
  const covered = input.bounds.height - at.y;
  if (covered > input.bounds.height / 2) {
    return LIST_END_PADDING;
  }
  return Math.max(LIST_END_PADDING, covered + BAND_MARGIN);
}

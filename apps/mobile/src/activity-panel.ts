/**
 * The Activity panel's motion and gates (docs/feat/mobile-activity-panel.md
 * Design 1/4), pure and React-free (AGENTS §7): the two detents a low-detent
 * bottom sheet has, what a released drag does, whether the panel opens at all,
 * when it closes itself, and the two-tap Stop's arm.
 *
 * The component (`screens/ActivitySheet.tsx`) only measures, animates and draws
 * what these return — the numbers are testable here, not on a simulator.
 */
import type { ActivityView } from "./activity.ts";
import type { ActivityFocus } from "./subagent-detail.ts";

/**
 * A bottom sheet's heights, in pt of VISIBLE sheet, measured from the screen's
 * bottom. `low` fits the content; `tall` is as high as the sheet may go.
 */
export interface PanelDetents {
  readonly low: number;
  readonly tall: number;
  /** The content does not fit at `tall`: the list scrolls inside the sheet. */
  readonly scrollable: boolean;
}

export interface PanelMetrics {
  /** The content's measured height (rows + group labels), without the header. */
  readonly contentHeight: number;
  readonly screenHeight: number;
  readonly topInset: number;
  readonly bottomInset: number;
}

/**
 * The smallest a one-row sheet may be (the mockup's "1 row ≈ 140 pt"): a low
 * detent below this reads as a card, not as a sheet with a grabber and a header.
 */
export const PANEL_MIN_LOW = 140;
/** The tall detent keeps this much of the screen above it (the status bar's ground). */
export const PANEL_TOP_GAP = 44;
/**
 * The sheet's own chrome (grabber + the "Activity · N" header), added to the
 * content's height for `low`. The screen does not measure it: it is fixed.
 */
export const PANEL_HEADER = 62;
/**
 * The low detent never takes more than this share of the screen: past it the
 * sheet would already cover the conversation, so the content stays reachable by
 * the drag up to `tall` (and by scrolling there) — which is the only way the
 * tall detent can ever differ from the low one.
 */
export const PANEL_LOW_CAP = 0.5;
/** A downward (or upward) release velocity, pt/ms, that decides the detent by itself. */
export const PANEL_FLICK = 0.6;
/** Below this share of `low`, a slow downward drag closes instead of settling back. */
export const PANEL_CLOSE_RATIO = 0.6;
/** How long the inline Stop stays armed before tap 2 becomes a fresh tap 1. */
export const STOP_ARM_MS = 3000;

/** Where a released drag leaves the sheet. */
export type PanelRest = "close" | "low" | "tall";

/**
 * The two detents. `low` fits the content (never under `PANEL_MIN_LOW`, never
 * over `tall`, and never over `PANEL_LOW_CAP` of the screen); the tall detent
 * exists only when the content does not fit at `low` — `tall > low` then, and
 * `tall === low` when a drag up has nowhere to go.
 */
export function panelDetents(m: PanelMetrics): PanelDetents {
  const tall = Math.max(
    PANEL_MIN_LOW,
    Math.round(m.screenHeight - Math.max(m.topInset, PANEL_TOP_GAP) - PANEL_TOP_GAP),
  );
  const fits = Math.round(m.contentHeight + PANEL_HEADER + m.bottomInset);
  const cap = Math.round(m.screenHeight * PANEL_LOW_CAP);
  const low = Math.min(Math.max(fits, PANEL_MIN_LOW), Math.min(tall, Math.max(cap, PANEL_MIN_LOW)));
  const scrollable = fits > low;
  // A content that fits at `low` has nowhere to be dragged to: no second detent.
  return { low, tall: scrollable ? tall : low, scrollable };
}

/** The height while a drag is in flight: clamped to `[0, tall]` — never above the screen. */
export function panelDrag(shown: number, dy: number, detents: PanelDetents): number {
  return Math.min(Math.max(shown - dy, 0), detents.tall);
}

/**
 * What a release does. Velocity first (B's "no resistance": any downward flick
 * closes, from EITHER detent, with no rubber-band hold), then the nearest
 * detent, then the close band under `PANEL_CLOSE_RATIO × low`.
 */
export function panelRelease(shown: number, vy: number, detents: PanelDetents): PanelRest {
  if (vy > PANEL_FLICK) {
    return "close";
  }
  if (vy < -PANEL_FLICK && detents.tall > detents.low) {
    return shown > (detents.low + detents.tall) / 2 ? "low" : "tall";
  }
  if (shown < detents.low * PANEL_CLOSE_RATIO) {
    return "close";
  }
  return Math.abs(shown - detents.tall) < Math.abs(shown - detents.low) ? "tall" : "low";
}

/**
 * Whether a re-measured content moves the open sheet. Only a sheet resting at
 * `low` follows the content it fits (a row ending or arriving shrinks/grows the
 * sheet); one the person dragged up to the tall detent stays where it was put,
 * and a first measure (`lastLow === 0`) settles no motion.
 */
export function panelFollowsContent(shown: number, lastLow: number, low: number): boolean {
  return lastLow !== 0 && lastLow !== low && Math.abs(shown - lastLow) < 1;
}

/**
 * Whether a tap opens the panel: never on an empty list (the hub already says
 * "Nothing running"), but a detail asked for by id (a transcript agent card)
 * still opens — "empty" is about the list, not the request.
 */
export function panelOpensFor(view: ActivityView, focus: ActivityFocus): boolean {
  return focus !== null || view.empty === null;
}

/**
 * Whether the open panel closes itself because the list just went empty. Only
 * on the LIST: a detail open on a child that ends flips to its report
 * (`sheetDetail`), and closing it out from under the reader would lose it.
 */
export function panelAutoClose(view: ActivityView, focus: ActivityFocus): boolean {
  return focus === null && view.empty !== null;
}

/** The detent the panel opens at: a detail (its message field + keyboard) needs room. */
export function panelDetentFor(focus: ActivityFocus): "low" | "tall" {
  return focus === null ? "low" : "tall";
}

/**
 * An inline Stop's arm: the one row that is armed, and when it armed. Keyed by
 * the row's id, so an arm never lands on a different row.
 */
export interface StopArm {
  readonly id: string | null;
  readonly at: number;
}

export const STOP_IDLE: StopArm = { id: null, at: 0 };

export interface StopTap {
  readonly state: StopArm;
  /** True on the SECOND tap of the armed row, within `STOP_ARM_MS`: fire the kill. */
  readonly fire: boolean;
}

/**
 * One tap on a row's ■. The first arms it; the second — the same id, within
 * `STOP_ARM_MS` — fires and disarms. A tap on ANOTHER row arms that one; a tap
 * after the window is a fresh first tap (never a fire).
 */
export function stopTap(state: StopArm, id: string, now: number): StopTap {
  if (state.id === id && now - state.at < STOP_ARM_MS) {
    return { state: STOP_IDLE, fire: true };
  }
  return { state: { id, at: now }, fire: false };
}

/** Is `id`'s ■ drawn as the red-outlined "Stop" pill right now? */
export function stopArmed(state: StopArm, id: string, now: number): boolean {
  return state.id === id && now - state.at < STOP_ARM_MS;
}

/**
 * Drop an arm whose row left the view between the two taps: the next view has
 * no such row, so a re-arriving one must not inherit a half-confirmed Stop.
 */
export function pruneArm(state: StopArm, ids: readonly string[]): StopArm {
  return state.id === null || ids.includes(state.id) ? state : STOP_IDLE;
}

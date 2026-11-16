/**
 * The hub button's gesture machine (docs/feat/mobile-hub.md Design 1): tap,
 * drag and long-press → fan, as ONE pure reducer. `ui/FloatingActivity.tsx`
 * feeds it the responder's raw points and a single 400 ms timer, and performs
 * the effects it returns; it decides nothing itself.
 *
 * | the finger                                   | result                         |
 * |----------------------------------------------|--------------------------------|
 * | up before LONG_MS, travel < SLOP             | tap (Activity)                 |
 * | travel ≥ SLOP before LONG_MS                 | drag (reposition), never a fan |
 * | held LONG_MS, travel < SLOP                  | fan opens (haptic firm)        |
 * | fan open, up on an item                      | commit (haptic commit)         |
 * | fan open, moved ≥ SLOP, up on no item        | close (cancel, silent)         |
 * | fan open, up having moved < SLOP since open  | sticky: a tap commits / closes |
 * | system cancel                                | idle, silent                   |
 *
 * Travel is measured from the down point (before the open) or from the finger's
 * point at the open (after it), as the farthest it got, so a wobble that comes
 * back still counts.
 */
import { type FanLayout, type Point, pickItem } from "./hub-fan.ts";

/** Movement (pt) that makes a press a drag, and the fan's sticky/cancel line: UIKit's `allowableMovement`. */
export const SLOP = 10;
/** Hold time (ms) that opens the fan. */
export const LONG_MS = 400;

export type PressKind = "tap" | "drag" | "long";

/** A finished press summarised by where it ended and how long it lasted. */
export function classifyPress(path: {
  readonly dx: number;
  readonly dy: number;
  readonly ms: number;
}): PressKind {
  if (!(Math.hypot(path.dx, path.dy) < SLOP)) {
    return "drag";
  }
  return path.ms < LONG_MS ? "tap" : "long";
}

/** The three hub haptics; `haptic-rules.ts` plays them. Cancel, sticky and drag are silent. */
export type HubCue = "firm" | "tick" | "commit";

/** What the fan shows, snapshotted at the open: the layout and the item ids in its order. */
export interface HubMenu {
  readonly layout: FanLayout;
  readonly ids: readonly string[];
}

export type GestureState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pressing";
      readonly down: Point;
      readonly t0: number;
      readonly last: Point;
    }
  | { readonly kind: "dragging"; readonly down: Point }
  | {
      readonly kind: "fanTracking";
      readonly menu: HubMenu;
      /** The finger's point when the fan opened: sticky vs cancel is measured from here. */
      readonly openAt: Point;
      /** Got ≥ SLOP from `openAt` at some point. */
      readonly moved: boolean;
      readonly hi: number | null;
    }
  | { readonly kind: "fanSticky"; readonly menu: HubMenu };

export type GestureEvent =
  | { readonly type: "down"; readonly p: Point; readonly t: number }
  | { readonly type: "move"; readonly p: Point; readonly t: number }
  | { readonly type: "timer"; readonly t: number }
  | { readonly type: "up"; readonly p: Point; readonly t: number }
  | { readonly type: "cancel" }
  | { readonly type: "tapOverlay"; readonly p: Point };

export type GestureEffect =
  | { readonly kind: "haptic"; readonly cue: HubCue }
  | { readonly kind: "open"; readonly layout: FanLayout }
  | { readonly kind: "highlight"; readonly index: number | null }
  | { readonly kind: "commit"; readonly id: string }
  | { readonly kind: "close" }
  | { readonly kind: "tap" }
  /** The button follows the finger: `delta` from the down point. */
  | { readonly kind: "dragTo"; readonly delta: Point }
  /** The drag ended here (`delta` from the down point): snap it. */
  | { readonly kind: "drop"; readonly delta: Point }
  /** The drag was cancelled by the system: put the button back. */
  | { readonly kind: "dragCancel" };

export interface Step {
  readonly state: GestureState;
  readonly effects: readonly GestureEffect[];
}

export const IDLE: GestureState = { kind: "idle" };

/**
 * One event in, the next state and the effects out. `solve` builds the fan for
 * the CURRENT world (bounds, actions); it is called only when the fan opens.
 */
export function reduce(state: GestureState, event: GestureEvent, solve: () => HubMenu): Step {
  switch (state.kind) {
    case "idle":
      return event.type === "down"
        ? { state: { kind: "pressing", down: event.p, t0: event.t, last: event.p }, effects: [] }
        : stay(state);
    case "pressing":
      return pressing(state, event, solve);
    case "dragging":
      return dragging(state, event);
    case "fanTracking":
      return tracking(state, event);
    case "fanSticky":
      return sticky(state, event);
  }
}

const stay = (state: GestureState): Step => ({ state, effects: [] });
const CLOSE: Step = { state: IDLE, effects: [{ kind: "close" }] };

function delta(from: Point, to: Point): Point {
  return { x: to.x - from.x, y: to.y - from.y };
}

function far(from: Point, to: Point): boolean {
  return !(Math.hypot(to.x - from.x, to.y - from.y) < SLOP);
}

/** The fan opens: the lift haptic + the layout. A menu layout hands over to the ActionSheet. */
function open(at: Point, solve: () => HubMenu, then: "tracking" | "sticky"): Step {
  const menu = solve();
  if (menu.ids.length === 0) {
    return { state: IDLE, effects: [] };
  }
  const effects: GestureEffect[] = [
    { kind: "haptic", cue: "firm" },
    { kind: "open", layout: menu.layout },
  ];
  if (menu.layout.kind !== "fan") {
    return { state: IDLE, effects };
  }
  const state: GestureState =
    then === "sticky"
      ? { kind: "fanSticky", menu }
      : { kind: "fanTracking", menu, openAt: at, moved: false, hi: null };
  return { state, effects };
}

function commit(menu: HubMenu, index: number): Step {
  const id = menu.ids[index];
  if (id === undefined) {
    return CLOSE;
  }
  return {
    state: IDLE,
    effects: [{ kind: "haptic", cue: "commit" }, { kind: "commit", id }, { kind: "close" }],
  };
}

function pressing(
  state: Extract<GestureState, { kind: "pressing" }>,
  event: GestureEvent,
  solve: () => HubMenu,
): Step {
  switch (event.type) {
    case "move":
      if (far(state.down, event.p)) {
        return {
          state: { kind: "dragging", down: state.down },
          effects: [{ kind: "dragTo", delta: delta(state.down, event.p) }],
        };
      }
      return { state: { ...state, last: event.p }, effects: [] };
    case "timer":
      // A timer of an earlier press (not cleared in time) is too early for this one.
      return event.t - state.t0 >= LONG_MS ? open(state.last, solve, "tracking") : stay(state);
    case "up": {
      const d = delta(state.down, event.p);
      const kind = classifyPress({ dx: d.x, dy: d.y, ms: event.t - state.t0 });
      if (kind === "tap") {
        return { state: IDLE, effects: [{ kind: "tap" }] };
      }
      if (kind === "drag") {
        return { state: IDLE, effects: [{ kind: "drop", delta: d }] };
      }
      // Held long enough but the timer was late: open where the finger let go.
      return open(event.p, solve, "sticky");
    }
    case "cancel":
      return { state: IDLE, effects: [] };
    default:
      return stay(state);
  }
}

function dragging(state: Extract<GestureState, { kind: "dragging" }>, event: GestureEvent): Step {
  switch (event.type) {
    case "move":
      return { state, effects: [{ kind: "dragTo", delta: delta(state.down, event.p) }] };
    case "up":
      return { state: IDLE, effects: [{ kind: "drop", delta: delta(state.down, event.p) }] };
    case "cancel":
      return { state: IDLE, effects: [{ kind: "dragCancel" }] };
    default:
      return stay(state);
  }
}

function tracking(
  state: Extract<GestureState, { kind: "fanTracking" }>,
  event: GestureEvent,
): Step {
  switch (event.type) {
    case "move": {
      const moved = state.moved || far(state.openAt, event.p);
      const hi = pickItem(state.menu.layout, event.p, state.hi);
      const next: GestureState = { ...state, moved, hi };
      if (hi === state.hi) {
        return { state: next, effects: [] };
      }
      const effects: GestureEffect[] = [{ kind: "highlight", index: hi }];
      // Silence when the highlight clears: no item, no tick.
      if (hi !== null) {
        effects.push({ kind: "haptic", cue: "tick" });
      }
      return { state: next, effects };
    }
    case "up": {
      const hi = pickItem(state.menu.layout, event.p, state.hi);
      if (hi !== null) {
        return commit(state.menu, hi);
      }
      if (state.moved || far(state.openAt, event.p)) {
        return CLOSE;
      }
      return { state: { kind: "fanSticky", menu: state.menu }, effects: [] };
    }
    case "cancel":
      return CLOSE;
    default:
      return stay(state);
  }
}

function sticky(state: Extract<GestureState, { kind: "fanSticky" }>, event: GestureEvent): Step {
  switch (event.type) {
    case "tapOverlay": {
      const hit = pickItem(state.menu.layout, event.p, null, { sticky: true });
      return hit === null ? CLOSE : commit(state.menu, hit);
    }
    // A new touch on the button closes the fan; its own release then meets idle.
    case "down":
    case "cancel":
      return CLOSE;
    default:
      return stay(state);
  }
}

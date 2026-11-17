/**
 * The chart's press-and-hold scrub machine (docs/feat/model-charts.md D6,
 * `chart-scrub.ts`). One pure reducer: `ui/chart/ChartView.tsx` (C6/C7) feeds
 * it the responder's raw points and a single HOLD_MS timer, and performs the
 * effects it returns (the hero re-reads `heroOf(spec, index)`; `tick` goes to
 * `haptic-rules.ts`). It decides nothing itself.
 *
 * | the finger                                     | result                       |
 * |------------------------------------------------|------------------------------|
 * | travel ≥ SLOP before HOLD_MS                   | yield: the list scrolls      |
 * | held HOLD_MS, travel < SLOP                    | scrub at the finger + `tick` |
 * | scrubbing, moves to another index              | `index` + one `tick`         |
 * | scrubbing, moves within the same index         | nothing                      |
 * | up / system cancel                             | `release`, idle              |
 *
 * A pan before the hold is the conversation's scroll, never a scrub: the chart
 * sits in a vertical list, and a finger that starts moving at once means "scroll".
 */

export const HOLD_MS = 250;
/** Movement (pt) that makes a press a pan: UIKit's `allowableMovement`. */
export const SLOP = 10;

export interface ScrubPoint {
  readonly x: number;
  readonly y: number;
}

export type ScrubState =
  | { readonly kind: "idle" }
  | { readonly kind: "pressing"; readonly down: ScrubPoint; readonly t0: number }
  /** The press became a pan: the list owns it until the finger lifts. */
  | { readonly kind: "yielded" }
  | { readonly kind: "scrubbing"; readonly index: number };

export type ScrubEvent =
  | { readonly type: "down"; readonly p: ScrubPoint; readonly t: number }
  | { readonly type: "move"; readonly p: ScrubPoint; readonly t: number }
  | { readonly type: "timer"; readonly t: number }
  | { readonly type: "up" }
  | { readonly type: "cancel" };

export type ScrubEffect =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "haptic"; readonly cue: "tick" }
  /** Hand the gesture back to the scroll view. */
  | { readonly kind: "yield" }
  /** Back to rest: the hero returns to `heroOf(spec)`. */
  | { readonly kind: "release" };

export interface ScrubStep {
  readonly state: ScrubState;
  readonly effects: readonly ScrubEffect[];
}

export const SCRUB_IDLE: ScrubState = { kind: "idle" };

const stay = (state: ScrubState): ScrubStep => ({ state, effects: [] });

function far(a: ScrubPoint, b: ScrubPoint): boolean {
  return !(Math.hypot(b.x - a.x, b.y - a.y) < SLOP);
}

/** Enter (or move within) the scrub at `x`: an index effect + a tick only on change. */
function scrubTo(prev: number | null, x: number, hit: (x: number) => number | null): ScrubStep {
  const index = hit(x);
  if (index === null) {
    return prev === null
      ? { state: SCRUB_IDLE, effects: [] }
      : stay({ kind: "scrubbing", index: prev });
  }
  if (index === prev) return stay({ kind: "scrubbing", index });
  return {
    state: { kind: "scrubbing", index },
    effects: [
      { kind: "index", index },
      { kind: "haptic", cue: "tick" },
    ],
  };
}

/**
 * One event in, the next state and the effects out. `hit` is the layout's
 * x → index (`ChartLayout.hit`), read at the hold and at every move.
 */
export function reduceScrub(
  state: ScrubState,
  event: ScrubEvent,
  hit: (x: number) => number | null,
): ScrubStep {
  if (event.type === "cancel" || event.type === "up") {
    if (state.kind === "scrubbing") return { state: SCRUB_IDLE, effects: [{ kind: "release" }] };
    return stay(SCRUB_IDLE);
  }
  switch (state.kind) {
    case "idle":
      return event.type === "down"
        ? stay({ kind: "pressing", down: event.p, t0: event.t })
        : stay(state);
    case "pressing":
      if (event.type === "move") {
        if (far(state.down, event.p))
          return { state: { kind: "yielded" }, effects: [{ kind: "yield" }] };
        return stay(state);
      }
      if (event.type === "timer" && event.t - state.t0 >= HOLD_MS) {
        return scrubTo(null, state.down.x, hit);
      }
      return stay(state);
    case "yielded":
      return stay(state);
    case "scrubbing":
      return event.type === "move" ? scrubTo(state.index, event.p.x, hit) : stay(state);
  }
}

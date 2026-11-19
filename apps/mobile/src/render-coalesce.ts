/**
 * Render coalescing for a streaming turn (docs/fix/mobile-fan-jank-device.md):
 * the session screen is told of a new state at most ONCE per window while
 * text/reasoning deltas pour in, instead of once per delta.
 *
 * Why: every notification is a `setState` that re-renders the whole session
 * screen (its transcript list, the composer, the hub) on the JS thread. A model
 * streams tens of deltas a second; on a phone each render costs milliseconds,
 * so the JS thread spends the turn rendering and every touch — the hub's tap
 * included — waits behind it.
 *
 * The contract: nothing is ever LOST or REORDERED, because a notification
 * carries no data — the screen reads the controller's current state at fire
 * time. A deferred notification only arrives later (≤ one window). Any other
 * change (`now`) fires at once and absorbs a pending deferred one, so a turn's
 * end, a tool card, a permission ask are never delayed.
 *
 * Pure and React-free (AGENTS §7): the clock and the timer are injected.
 */

/** The window: ~10 renders a second while text streams — smooth to a reader. */
export const STREAM_RENDER_MS = 100;

export interface RenderCoalescerDeps {
  /** Tell the screen (reads the state fresh). */
  readonly fire: () => void;
  readonly clock: () => number;
  /** Arm a one-shot timer; the answer cancels it. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly windowMs?: number;
}

export interface RenderCoalescer {
  /** A streamed delta changed the state: tell the screen within one window. */
  soon(): void;
  /** Anything else changed the state: tell the screen now (absorbs a pending `soon`). */
  now(): void;
  /** Whether a deferred notification is waiting. */
  pending(): boolean;
  /** Drop a pending notification (the screen is going away). */
  dispose(): void;
}

export function createRenderCoalescer(deps: RenderCoalescerDeps): RenderCoalescer {
  const windowMs = deps.windowMs ?? STREAM_RENDER_MS;
  let lastFire: number | null = null;
  let cancel: (() => void) | null = null;
  const fireNow = (): void => {
    if (cancel !== null) {
      cancel();
      cancel = null;
    }
    lastFire = deps.clock();
    deps.fire();
  };
  return {
    soon() {
      if (cancel !== null) {
        return;
      }
      const t = deps.clock();
      const due = lastFire === null ? t : lastFire + windowMs;
      if (due <= t) {
        // A quiet stretch: the first delta shows at once (leading edge).
        fireNow();
        return;
      }
      cancel = deps.schedule(() => {
        cancel = null;
        fireNow();
      }, due - t);
    },
    now: fireNow,
    pending: () => cancel !== null,
    dispose() {
      if (cancel !== null) {
        cancel();
        cancel = null;
      }
    },
  };
}

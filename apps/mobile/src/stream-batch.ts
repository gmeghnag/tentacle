/**
 * Stream batching (12b): coalesce a turn's deltas into fewer state commits. The
 * feed wires it for a BACKLOG only (docs/feat/mobile-ui-fluidity-s6.md): once a
 * drain has folded for `SLICE_MS` without a wait (`createSlicer`), prose is held
 * and merged, and released by the budget, a type switch or a non-prose event —
 * never by time (the feed's window is infinite; `WINDOW_MS`, ~50 ms on an
 * injected clock, is the plan F23 default). A live stream folds each delta at
 * once.
 *
 * The contract the tests pin: the BATCHED final state equals the UNBATCHED fold
 * of the same events. So this module never decides what an event means — it only
 * decides WHEN the fold sees it, and `apply` stays the single place semantics
 * live. Prose (`text`/`reasoning`) merges into one delta per window; anything
 * else flushes what is pending first, so order is preserved exactly.
 */
import type { SessionEvent } from "@tentacle/client";

/** The default window: ~3 frames at 60 Hz — invisible to a reader, cheap for the JS thread. */
export const WINDOW_MS = 50;

/** The events this module may merge within one window (order-preserving). */
type Mergeable = Extract<SessionEvent, { type: "text" | "reasoning" }>;

function isMergeable(event: SessionEvent): event is Mergeable {
  return event.type === "text" || event.type === "reasoning";
}

/** A backlog is folded in slices of at most this much fold time (eval row 6). */
export const SLICE_MS = 8;
/** A gap this long between two events means the loop waited: a new task. */
export const GAP_MS = 2;

/**
 * Whether a drain has used its slice: the loop tells it when each event arrives
 * and when it is dealt with, on an INJECTED clock.
 */
export interface Slicer {
  /** An event arrived at `t`: a wait since the last `done` starts a new slice. */
  arrive(t: number): void;
  /** A fold finished at `t`: true when the slice has used its budget (yield now). */
  done(t: number): boolean;
  /** The loop yielded (or a deferred flush ran): the next event starts a slice. */
  reset(): void;
}

export function createSlicer(sliceMs: number = SLICE_MS, gapMs: number = GAP_MS): Slicer {
  /** When the running slice began; null before the first event of one. */
  let start: number | null = null;
  let lastDone = 0;
  return {
    arrive(t) {
      if (start === null || t - lastDone >= gapMs) {
        start = t;
      }
    },
    done(t) {
      lastDone = t;
      return start !== null && t - start >= sliceMs;
    },
    reset() {
      start = null;
    },
  };
}

export interface Batcher {
  /** Offer one event: returns the commits to fold NOW (possibly none). */
  push(event: SessionEvent, now: number): readonly SessionEvent[];
  /** Take everything held back (a turn's end, an unmount, a link drop). */
  flush(): readonly SessionEvent[];
  /** Whether anything is waiting. */
  pending(): boolean;
}

/**
 * A batcher over an INJECTED clock: `push` merges into the window that started
 * with its first event, and a push `now >= openedAt + windowMs` releases the
 * window first (so a slow stream still commits every window, never later).
 */
export function createBatcher(windowMs: number = WINDOW_MS): Batcher {
  let held: Mergeable | null = null;
  let openedAt = 0;

  const take = (): readonly SessionEvent[] => {
    if (held === null) {
      return [];
    }
    const event = held;
    held = null;
    return [event];
  };

  return {
    push(event, now) {
      if (!isMergeable(event)) {
        // Never reorder: what is held goes out first, then the event itself.
        return [...take(), event];
      }
      if (held === null) {
        held = event;
        openedAt = now;
        return [];
      }
      const windowOver = now >= openedAt + windowMs;
      if (windowOver || held.type !== event.type) {
        // A new window (overdue), or a different kind of prose: the held one is a
        // boundary the fold must see on its own (a reasoning→answer switch opens
        // a new row), so it goes out and this event opens the next window.
        const released = take();
        held = event;
        openedAt = now;
        return released;
      }
      held = { type: held.type, delta: held.delta + event.delta };
      return [];
    },
    flush: take,
    pending() {
      return held !== null;
    },
  };
}

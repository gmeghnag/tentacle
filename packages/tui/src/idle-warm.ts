/**
 * Idle background warm of the OTHER Ctrl+O layout (docs/fix/tui-expand-latency.md).
 *
 * `rowCache` keeps a collapsed and an expanded layout per tool item, but the
 * one not shown is only filled by its first toggle — O(transcript) on the render
 * thread (hundreds of ms on a very long session). Once the transcript has been
 * quiet for a moment, this fills the hidden slot in small time-budgeted chunks
 * so that first Ctrl+O is a cache hit. It only populates the cache (`warmRowsChunk`
 * is pure apart from that): it never changes what is rendered or committed.
 *
 * Pure and framework-free: the timers are injected, so the schedule, the
 * cancellation and the "when" decision are unit-tested without wall-clock waits.
 */
import { type RenderOptions, warmRowsChunk } from "./render-lines.ts";
import type { DisplayItem } from "./state.ts";

/**
 * Quiet time before a warm starts. Every transcript change (a stream flush, a
 * tool update, a new notice) restarts the wait, so a turn that is streaming or
 * a burst of activity never triggers it; 400 ms is long enough to sit out those
 * bursts and a key-repeat of Ctrl+O, short enough that the warm is done by the
 * time someone who stopped to read reaches for the toggle.
 */
export const IDLE_WARM_DELAY_MS = 400;
/** Work per chunk; the chunks yield with `setTimeout(0)` so input never waits long. */
export const IDLE_WARM_CHUNK_MS = 6;

export interface IdleWarmState {
  readonly items: readonly DisplayItem[];
  /** The layout options currently shown (the warm fills the opposite view). */
  readonly opts: RenderOptions;
  /** A turn is streaming / running (also covers a permission prompt). */
  readonly running: boolean;
  /** Something else is laying out already: a history warm in flight, a loading bar. */
  readonly busy: boolean;
}

/**
 * The layout options to warm, or null when nothing should be warmed: not while
 * a turn runs or another warm is in flight, and not when no item can lay out
 * differently (only `tool` items collapse, so without one the views are equal).
 */
export function otherViewOpts(state: IdleWarmState): RenderOptions | null {
  if (state.running || state.busy || !state.items.some((item) => item.kind === "tool")) {
    return null;
  }
  return { ...state.opts, expandAll: !state.opts.expandAll };
}

export interface WarmTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const realTimers: WarmTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface IdleWarmHooks {
  readonly timers?: WarmTimers;
  readonly delayMs?: number;
  readonly chunkMs?: number;
  /** Called once the whole transcript is warm (not when cancelled). */
  readonly onDone?: (chunks: number) => void;
}

/**
 * Schedule the warm for `state`; returns the cancel function. Call it (an
 * effect cleanup) on any change — new items, a resize, Ctrl+O — and schedule
 * anew: a cancelled warm does no further work. A no-op cancel when there is
 * nothing to warm.
 */
export function startIdleWarm(state: IdleWarmState, hooks: IdleWarmHooks = {}): () => void {
  const other = otherViewOpts(state);
  if (other === null) {
    return () => {};
  }
  const timers = hooks.timers ?? realTimers;
  const chunkMs = hooks.chunkMs ?? IDLE_WARM_CHUNK_MS;
  const items = state.items;
  let cancelled = false;
  let handle: unknown;
  let idx = 0;
  let chunks = 0;
  const step = (): void => {
    if (cancelled) {
      return;
    }
    idx = warmRowsChunk(items, other, idx, chunkMs);
    chunks += 1;
    if (idx >= items.length) {
      hooks.onDone?.(chunks);
      return;
    }
    handle = timers.set(step, 0);
  };
  handle = timers.set(step, hooks.delayMs ?? IDLE_WARM_DELAY_MS);
  return () => {
    cancelled = true;
    timers.clear(handle);
  };
}

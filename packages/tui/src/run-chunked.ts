/**
 * The one driver for time-budgeted background work in the TUI.
 *
 * Laying out a whole transcript is O(transcript) and would freeze the frame, so
 * three call sites used to hand-write the same loop: slice the work into small
 * chunks, yield with `setTimeout`, stop when a generation token (or a cancelled
 * flag) goes stale, and commit at the end. This module owns that schedule once;
 * the sites differ only in the `work` they hand it and in what they commit.
 *
 * Pure and framework-free: the timers are injected, so the budget, the order of
 * the work and the cancellation are unit-tested with no wall-clock waits.
 * `work` is `warmRowsChunk`-shaped — `(from, budgetMs) => next` — so the helper
 * adds no slicing of its own (that stays in the work).
 */
/** Work per chunk. Small enough that input never waits long between steps. */
export const CHUNK_BUDGET_MS = 6;

export interface ChunkTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const realTimers: ChunkTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RunChunkedOptions {
  /** Slice size forwarded verbatim to `work` (default `CHUNK_BUDGET_MS`). */
  readonly budgetMs?: number;
  /** A stale run stops before its next chunk and never commits. */
  readonly isStale?: () => boolean;
  readonly timers?: ChunkTimers;
  /**
   * Wait before the first chunk (the idle warm's quiet delay). Present ⇒ the
   * first chunk always goes through `timers.set`, even at `0` (as it did before
   * the helper); absent ⇒ it runs synchronously.
   */
  readonly delayMs?: number;
  /** After each chunk that is still running, with the index to resume from. */
  readonly onProgress?: (next: number) => void;
  /** The run reached the end and is not stale: the call site commits here. */
  readonly onDone?: () => void;
  /**
   * A throw from chunk 2 on (where the step runs in a timer). Supplying it is
   * the site's promise that it surfaces the error, so `done`'s rejection is
   * treated as handled — a site that never reads `done` (the resize and idle
   * warms) then raises no unhandled rejection. Omit it and an unread rejection
   * stays loud, as a timer's exception did before this helper.
   */
  readonly onError?: (error: unknown) => void;
}

export interface RunChunkedHandle {
  /** Stop the run: no further chunk, no commit. Idempotent. */
  readonly cancel: () => void;
  /**
   * `true` when the run finished on its own, `false` when stale or cancelled.
   * **Rejects** if `work` (or `onProgress`) throws from chunk 2 on: that step
   * runs in a timer, so the rejection is how a caller awaiting it
   * (`commitHistory`) sees the error. The FIRST chunk (no `delayMs`) still runs
   * in the caller's own stack, so its throw escapes to the caller instead, as
   * the old loops' first turn did. With `onError` supplied the rejection counts
   * as handled (`onError` is the surface); without it, an unread rejection is an
   * unhandled rejection — never a silent drop.
   */
  readonly done: Promise<boolean>;
}

/**
 * Step `work` until it returns `total` (or more), yielding between chunks.
 *
 * The stale check is the first thing every step does — and it is checked again
 * before `onDone` — so a superseded run does no further work and never commits.
 * A `total` of 0 is complete without calling `work`.
 */
export function runChunked(
  total: number,
  work: (from: number, budgetMs: number) => number,
  opts: RunChunkedOptions = {},
): RunChunkedHandle {
  const timers = opts.timers ?? realTimers;
  const budgetMs = opts.budgetMs ?? CHUNK_BUDGET_MS;
  let from = 0;
  let stopped = false;
  let handle: unknown;
  let settled = false;
  let resolveDone: (ran: boolean) => void = () => {};
  let rejectDone: (error: unknown) => void = () => {};
  const done = new Promise<boolean>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const settle = (ran: boolean): void => {
    if (!settled) {
      settled = true;
      resolveDone(ran);
    }
  };
  const fail = (error: unknown): void => {
    if (!settled) {
      settled = true;
      rejectDone(error);
      if (opts.onError) {
        // The site chose its own surface: handle the rejection here so a site
        // that never reads `done` does not leak an unhandled rejection.
        void done.catch(() => {});
        opts.onError(error);
      }
    }
  };
  const stop = (): void => {
    stopped = true;
    timers.clear(handle);
  };
  const stale = (): boolean => opts.isStale?.() === true;
  /**
   * One chunk. `synchronous` is true only for the first chunk of a run with no
   * `delayMs`: it runs in the caller's own stack, so a throw there escapes to the
   * caller (as the old loops' first turn did). From chunk 2 on the throw happens
   * in a timer, where escaping would only lose it — it rejects `done` instead,
   * which is what `commitHistory`'s `await` used to see.
   */
  const step = (synchronous: boolean): void => {
    if (stopped) {
      settle(false);
      return;
    }
    if (stale()) {
      stop(); // before any work: a run superseded before its first step does nothing
      settle(false);
      return;
    }
    try {
      if (from < total) {
        from = work(from, budgetMs);
      }
      if (stopped || stale()) {
        stop(); // superseded (or cancelled) while the chunk ran: no progress, no commit
        settle(false);
        return;
      }
      opts.onProgress?.(from); // after the chunk that just ran, as the old loops did
    } catch (error) {
      stop();
      if (synchronous) {
        throw error; // in the caller's stack: it must see the error itself
      }
      fail(error); // in a timer: hand it to whoever awaits `done`
      return;
    }
    if (from >= total) {
      settle(true);
      opts.onDone?.();
      return;
    }
    handle = timers.set(() => step(false), 0);
  };
  if (opts.delayMs === undefined) {
    step(true);
  } else {
    // Present ⇒ always through the timer, even `0`, so a site that asks for a
    // delay keeps its schedule (the idle warm's first tick used to be a timer).
    handle = timers.set(() => step(false), opts.delayMs);
  }
  return {
    cancel: () => {
      stop();
      settle(false);
    },
    done,
  };
}

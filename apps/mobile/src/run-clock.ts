/**
 * The run screen's clock (docs/fix/mobile-workflow-run-jank.md): a live run's
 * elapsed time moves on its own, not only when the run's feed does. Pure and
 * injected (AGENTS §7); the summary strip is its one user.
 *
 * Every wake-up is aimed at the next whole second counted from `startedAt`, one
 * timeout at a time, so a late firing is not carried into the next one and no
 * label is skipped or shown twice.
 */
import { STEP_ELAPSED_TICK_MS } from "./motion.ts";

export interface RunClockDeps {
  now(): number;
  /** Run `fn` once after `ms`; the return value cancels it. */
  schedule(fn: () => void, ms: number): () => void;
}

/**
 * Emits `now` at once and then on each of the run's seconds, until stopped. An
 * ended run has a final duration: nothing is emitted or scheduled.
 */
export function startRunClock(
  run: { readonly startedAt: number; readonly endedAt?: number },
  deps: RunClockDeps,
  onTick: (now: number) => void,
): () => void {
  if (run.endedAt !== undefined) {
    return () => {};
  }
  let stopped = false;
  let cancel: (() => void) | null = null;
  const tick = (): void => {
    if (stopped) {
      return;
    }
    const now = deps.now();
    onTick(now);
    // The positive remainder: a phone clock behind the daemon's makes
    // `now - startedAt` negative, and the delay must stay in (0, tick].
    const into =
      (((now - run.startedAt) % STEP_ELAPSED_TICK_MS) + STEP_ELAPSED_TICK_MS) %
      STEP_ELAPSED_TICK_MS;
    cancel = deps.schedule(tick, STEP_ELAPSED_TICK_MS - into);
  };
  tick();
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
}

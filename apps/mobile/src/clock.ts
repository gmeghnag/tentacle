/**
 * The owned clocks' pure half (docs/feat/mobile-ui-fluidity-s2.md): the label
 * formats, the elapsed value and the ONE sampler behind the JS fallback. Pure and
 * React-free (AGENTS §7). A label is DERIVED from the event's own stamp and the
 * time now, never stored, so a remount reads the same value.
 *
 * The native view (`modules/tentacle-clock/ios/ClockCore`) mirrors `formatClock`
 * byte for byte; both are pinned by `test/fixtures/clock-format-v1.json`.
 */

/**
 * `thinking`: the Thinking row's steady-width clock (`0 s`, `1 min 05 s`,
 * `1 h 02 min`). `step`: a running step's (`""` under 1 s, `2 min 5 s`).
 */
export type ClockFormat = "thinking" | "step";

export function formatClock(format: ClockFormat, ms: number): string {
  const whole = Math.floor(ms / 1000);
  if (format === "step") {
    if (whole < 1) {
      return "";
    }
    return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
  }
  const seconds = Math.max(0, whole);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ${padded(seconds % 60)} s`;
  }
  return `${Math.floor(seconds / 3600)} h ${padded(Math.floor((seconds % 3600) / 60))} min`;
}

function padded(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Never negative: a stamp from a clock ahead of this one reads `0`. */
export function elapsedSince(since: number, now: number): number {
  return Math.max(0, now - since);
}

export interface ClockSamplerDeps {
  now(): number;
  /** Run `fn` once after `ms`; the return value cancels it. */
  schedule(fn: () => void, ms: number): () => void;
}

export interface ClockSampler {
  /** `useSyncExternalStore`'s shape: stable, returns the unsubscribe. */
  readonly subscribe: (fn: () => void) => () => void;
  readonly now: () => number;
}

/**
 * ONE scheduled callback while anyone subscribes, none otherwise. Every wake is
 * aimed at the next `periodMs` boundary of `now()` (as `run-clock.ts`), so a
 * late one is not carried into the next.
 */
export function createClockSampler(deps: ClockSamplerDeps, periodMs: number): ClockSampler {
  const listeners = new Set<{ readonly fn: () => void }>();
  let cancel: (() => void) | null = null;
  const arm = (): void => {
    if (cancel !== null || listeners.size === 0) {
      return;
    }
    const into = ((deps.now() % periodMs) + periodMs) % periodMs;
    cancel = deps.schedule(() => {
      cancel = null;
      arm();
      for (const listener of [...listeners]) {
        listener.fn();
      }
    }, periodMs - into);
  };
  return {
    subscribe: (fn) => {
      const listener = { fn };
      listeners.add(listener);
      arm();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) {
          cancel?.();
          cancel = null;
        }
      };
    },
    now: () => deps.now(),
  };
}

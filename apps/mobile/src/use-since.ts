/**
 * `useSince` (docs/feat/mobile-ui-fluidity-s2.md): the label of the time elapsed
 * since an event's own stamp, over the app's ONE sampler. Wiring only — the rules
 * are `clock.ts`'s. The visible figures of an iOS build are the native
 * `ClockText`; this drives the fallback label and the spoken one.
 */
import { useSyncExternalStore } from "react";
import { createClockSampler, elapsedSince } from "./clock.ts";
import { CLOCK_SAMPLE_MS } from "./motion.ts";

const SAMPLER = createClockSampler(
  {
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  },
  CLOCK_SAMPLE_MS,
);

/** Stable, as `subscribe` must be: a label with no origin never changes. */
const NEVER = (): (() => void) => () => {};

/**
 * `render(elapsed ms)`, re-rendering the caller only when that STRING changes.
 * `since` absent → `render(null)`, and no subscription.
 */
export function useSince(since: number | undefined, render: (ms: number | null) => string): string {
  const snapshot = (): string =>
    render(since === undefined ? null : elapsedSince(since, SAMPLER.now()));
  return useSyncExternalStore(since === undefined ? NEVER : SAMPLER.subscribe, snapshot, snapshot);
}

/**
 * Slice 2 of docs/feat/session-hop-ux: the hop's ONE live progress line.
 *
 * A hop builds its target with no TTY (it must never write raw while Ink owns the
 * screen, AGENTS §7), so `statusLineFor` (`engine-runtime.ts`) has no spinner, and
 * the engine falls back to its PIPED contract: one `log` line per phase and per
 * 10% of the binary transfer, plus the resolver's verbose path — ~13 transcript
 * notices for one attach (Repro 2 in the task doc). The interactive contract
 * already exists in the same functions (`status.set`, the transfer's `onStatus`);
 * what was missing is a way to SELECT it without a TTY.
 *
 * This module is that way, and nothing else: a `StatusLine`-shaped sink (`set` /
 * `finish`) the engine cannot tell from its own. It emits through the hop's status
 * row, THROTTLED — the transfer reports ~130 times for 8 MB, and an Ink re-render
 * per tick would jank the very frame the hop is drawing into — with the LATEST
 * text always landing (a trailing timer) and identical text dropped.
 *
 * Pure: the clock and the scheduler are injected, so the throttle is tested without
 * waiting (AGENTS §9: no real timers in a unit test).
 */

/** The shortest gap between two emits: ~10 rows/s, faster than a reader needs. */
export const HOP_LIVE_LINE_MS = 100;

/** What the engine gets: its `StatusLine`'s two methods, and nothing else. */
export interface HopLiveLine {
  /** The whole line to show now (the engine's own words, one line). */
  set(text: string): void;
  /** Stop: the row is going away (every engine exit path calls this). */
  finish(): void;
}

export interface HopLiveLineDeps {
  /** Where the text goes: the hop's status row (the App's `onStatus`). */
  readonly emit: (text: string) => void;
  /** `Date.now` in production, a stepped clock in a test. */
  readonly now?: () => number;
  /** The trailing timer's scheduler; returns its cancel. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** The gap between emits; a test shortens it. */
  readonly windowMs?: number;
}

/**
 * ONE line, updated in place. The rules, in the order they matter:
 *
 *   - the first text is emitted AT ONCE (a row that lags behind its own start
 *     reads as a hung hop);
 *   - inside a window, only the LATEST text is kept, and one trailing timer emits
 *     it — so the last phase always lands, and a flood of ticks cannot queue up;
 *   - text identical to what was last emitted is dropped (the transfer re-reports
 *     a whole percent several times);
 *   - `finish()` cancels the timer and LATCHES: a late tick reaches no listener
 *     after settle, and must not resurrect a row that was taken down.
 */
export function createHopLiveLine(deps: HopLiveLineDeps): HopLiveLine {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? HOP_LIVE_LINE_MS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  let emitted: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: string | null = null;
  let cancel: (() => void) | null = null;
  let closed = false;

  const flush = (): void => {
    cancel = null;
    const text = pending;
    pending = null;
    if (closed || text === null || text === emitted) {
      return;
    }
    emitted = text;
    lastAt = now();
    deps.emit(text);
  };

  return {
    set(text: string): void {
      if (closed || text === emitted || text === pending) {
        return;
      }
      const at = now();
      if (cancel === null && at - lastAt >= windowMs) {
        emitted = text;
        lastAt = at;
        deps.emit(text);
        return;
      }
      // Inside the window: keep only the latest, and arm ONE trailing timer.
      pending = text;
      cancel ??= schedule(flush, Math.max(0, windowMs - (at - lastAt)));
    },
    finish(): void {
      closed = true;
      pending = null;
      cancel?.();
      cancel = null;
    },
  };
}

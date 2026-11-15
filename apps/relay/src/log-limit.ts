/**
 * The relay's LOG FLOOD bound, as a pure module (fix/relay-hardening M4;
 * AGENTS §7 "logic lives in pure modules").
 *
 * Every refusal the relay makes writes one line, so a client that is being
 * refused writes as many lines as fast as it can be refused — a `hello` flood or
 * a dial flood fills the journal. That is bad twice over: the disk, and worse,
 * journald's OWN rate limit, which drops lines without choosing between them.
 * The lines it drops can be the `ready` of every daemon, i.e. exactly when an
 * incident is happening the journal stops being usable to diagnose it.
 *
 * So each KIND of line (its first word: `dial-refused`, `ready`, …) gets its own
 * fixed window of {@link DEFAULT_LOG_PER_WINDOW} lines per
 * {@link DEFAULT_LOG_WINDOW_MS}. Three properties make that safe:
 *
 *  - a kind is never STARVED by another kind's flood (per kind, not global);
 *  - the first lines of every window always pass, so the start of an incident —
 *    and any first-ever error — is always in the journal;
 *  - what was hidden is never silent: a window that ends with suppressed lines
 *    owes a `log-suppressed <kind> <n>`, which `flush()` reports once.
 *
 * A fixed window (not a sliding log) is the same honest cheap bound the rate
 * limits use: up to 2× a limit across a boundary — for a log bound, harmless.
 */

/** Lines of one kind admitted per window. */
export const DEFAULT_LOG_PER_WINDOW = 20;
/** The window's length: 10 s, so a steady 2 lines/s of every kind is journalled. */
export const DEFAULT_LOG_WINDOW_MS = 10_000;

interface KindWindow {
  /** Lines admitted in the window that started at `since`. */
  admitted: number;
  /** Lines suppressed since that window started (owed until it ends). */
  suppressed: number;
  since: number;
}

export interface LogLimiter {
  /**
   * May this line be written? `false` means it was counted instead — the caller
   * drops it and says nothing (the summary line reports the count once its
   * window has ended).
   */
  admit(line: string): boolean;
  /**
   * The summary lines owed for windows that have ENDED with suppressed lines, in
   * the order the kinds were first seen; each count is consumed once.
   */
  flush(): string[];
}

export interface LogLimiterOptions {
  /** Injected clock (tests own time; the server passes `Date.now`). */
  readonly now?: () => number;
  readonly perWindow?: number;
  readonly windowMs?: number;
}

/**
 * Create a log limiter. Time is injected (`now`) so a test drives the window
 * instead of waiting for it, exactly as the core's clock is injected (§9).
 */
export function createLogLimiter(options: LogLimiterOptions = {}): LogLimiter {
  const now = options.now ?? (() => Date.now());
  const perWindow = options.perWindow ?? DEFAULT_LOG_PER_WINDOW;
  const windowMs = options.windowMs ?? DEFAULT_LOG_WINDOW_MS;
  /** One live window per kind, in first-seen order (so `flush` is deterministic). */
  const kinds = new Map<string, KindWindow>();
  /** Suppressed lines whose window has ended and that no summary has reported yet. */
  const owed = new Map<string, number>();

  /** End a window that has run its course: what it hid becomes owed. */
  const settle = (kind: string, window: KindWindow, at: number): void => {
    if (at - window.since < windowMs) {
      return;
    }
    if (window.suppressed > 0) {
      owed.set(kind, (owed.get(kind) ?? 0) + window.suppressed);
    }
    window.admitted = 0;
    window.suppressed = 0;
    window.since = at;
  };

  return {
    admit(line: string): boolean {
      const kind = line.split(/\s+/, 1)[0] ?? "";
      const at = now();
      let window = kinds.get(kind);
      if (window === undefined) {
        window = { admitted: 0, suppressed: 0, since: at };
        kinds.set(kind, window);
      } else {
        settle(kind, window, at);
      }
      if (window.admitted < perWindow) {
        window.admitted += 1;
        return true;
      }
      window.suppressed += 1;
      return false;
    },
    flush(): string[] {
      const at = now();
      for (const [kind, window] of kinds) {
        // A running window may still admit, so only an ended one reports — and
        // it reports even if no further line of its kind arrived.
        settle(kind, window, at);
      }
      const lines: string[] = [];
      for (const kind of kinds.keys()) {
        const count = owed.get(kind) ?? 0;
        if (count > 0) {
          lines.push(`log-suppressed ${kind} ${count}`);
          owed.delete(kind);
        }
      }
      return lines;
    },
  };
}

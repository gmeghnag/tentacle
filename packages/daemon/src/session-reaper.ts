/**
 * What bounds a session that outlives its connections (docs/feat/session-ttl-limits.md).
 *
 * A session is IDLE when nothing is attached and no turn or compaction runs;
 * background jobs do not count (a forgotten dev server is exactly what this
 * frees). An idle session is closed once it has been idle for `idleTtlMs`. The
 * opt-in admin cap closes a detached session after `adminCapMs` even if it is
 * busy. An attached session is never closed, whatever the policy.
 *
 * `selectExpired` is the pure decision (no clock read, no I/O); the sweep that
 * acts on it is `SessionHost.reapExpired`, and `startReaper` only runs that
 * sweep on an interval.
 */

/** Default idle TTL: "I'll pick it up tomorrow" (owner decision, 2026-10-19). */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Default sweep period: the TTL is honoured to within one interval. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export interface ReapPolicy {
  /** Close a session idle for this long (ms, > 0). `null` = never idle-expires. */
  readonly idleTtlMs: number | null;
  /** Opt-in: close a session detached for this long even mid-turn (ms). Unset = never. */
  readonly adminCapMs?: number;
}

/**
 * A session's raw state (`HostedSession.liveness()`); every rule on it lives
 * in `selectExpired`. The stamps are taken when something that keeps the
 * session in use ENDS — a session can only become idle/detached at such a
 * moment and nothing ends while it is idle — so while idle (detached)
 * `lastActiveAt` (`lastDetachAt`) IS the time it became so.
 */
export interface SessionLiveness {
  readonly id: string;
  /** Clients attached now. */
  readonly attached: number;
  /** A turn or a compaction runs. */
  readonly busy: boolean;
  /** The latest end of an attachment or of the busy slot (or the creation). */
  readonly lastActiveAt: number;
  /** The latest end of an attachment (or the creation). */
  readonly lastDetachAt: number;
}

export type ReapReason = "idle_ttl" | "admin_cap";

export interface Expired {
  readonly id: string;
  readonly reason: ReapReason;
}

/** Which sessions expire at `now` under `policy`. `idle_ttl` wins when both apply. */
export function selectExpired(
  sessions: Iterable<SessionLiveness>,
  now: number,
  policy: ReapPolicy,
): Expired[] {
  const expired: Expired[] = [];
  for (const s of sessions) {
    const reason = expiry(s, now, policy);
    if (reason) {
      expired.push({ id: s.id, reason });
    }
  }
  return expired;
}

function expiry(s: SessionLiveness, now: number, policy: ReapPolicy): ReapReason | null {
  if (s.attached > 0) {
    return null;
  }
  if (policy.idleTtlMs !== null && !s.busy && now - s.lastActiveAt >= policy.idleTtlMs) {
    return "idle_ttl";
  }
  if (policy.adminCapMs !== undefined && now - s.lastDetachAt >= policy.adminCapMs) {
    return "admin_cap";
  }
  return null;
}

/** Floor for the derived sweep period. */
const MIN_SWEEP_INTERVAL_MS = 1000;

/**
 * The reaper's period: never coarser than the TTL or the cap (a short
 * `--session-ttl` is honoured to within one TTL, not one minute), never finer
 * than 1 s (a `1ms` TTL must not spin the event loop). `null` when there is
 * neither a TTL nor a cap (`never`, no cap): nothing to sweep for.
 */
export function sweepIntervalFor(idleTtlMs: number | null, adminCapMs?: number): number | null {
  const bound = idleTtlMs ?? adminCapMs;
  if (bound === undefined) {
    return null;
  }
  return Math.max(
    MIN_SWEEP_INTERVAL_MS,
    Math.min(DEFAULT_SWEEP_INTERVAL_MS, bound, adminCapMs ?? bound),
  );
}

/** What the loop sweeps: `SessionHost` in production. */
export interface Reapable {
  reapExpired(policy: ReapPolicy, onError?: (error: Error) => void): readonly Expired[];
}

export interface ReaperOptions {
  /** Default `DEFAULT_SWEEP_INTERVAL_MS`. */
  readonly sweepIntervalMs?: number;
  /**
   * Delay of the FIRST sweep (then every `sweepIntervalMs`). Lets a reaper that
   * replaces another (a period change) keep the old one's phase: the next
   * sweep is never later than it was due. Unset = a full interval.
   */
  readonly firstSweepInMs?: number;
  /** One line per reaped session. */
  readonly onAudit?: (line: string) => void;
  /** A failed close or sweep — reported, never fatal to the loop. */
  readonly onError?: (error: Error) => void;
  /** Injectable for tests (default: the globals). */
  readonly setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  readonly clearInterval?: (handle: { unref?(): void }) => void;
  /** The `firstSweepInMs` timer, injectable like the interval (default: the globals). */
  readonly setTimeout?: (fn: () => void, ms: number) => { unref?(): void };
  readonly clearTimeout?: (handle: { unref?(): void }) => void;
}

/**
 * Sweep `host` every `sweepIntervalMs`. The interval is `unref`'d: it never
 * keeps the process alive on its own. Returns `stop`. `policy` may be a
 * function, read at every sweep: the owner can change the policy without
 * restarting the timer (a restart would push the next sweep later).
 */
export function startReaper(
  host: Reapable,
  policy: ReapPolicy | (() => ReapPolicy),
  opts: ReaperOptions = {},
): () => void {
  const set = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear =
    opts.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const report = (error: unknown): void => {
    opts.onError?.(error instanceof Error ? error : new Error(String(error)));
  };
  const sweep = (): void => {
    try {
      const current = typeof policy === "function" ? policy() : policy;
      for (const { id, reason } of host.reapExpired(current, report)) {
        opts.onAudit?.(`session-reaped ${id} ${reason}`);
      }
    } catch (error) {
      report(error);
    }
  };
  const period = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const start = (): { unref?(): void } => {
    const interval = set(sweep, period);
    interval.unref?.();
    return interval;
  };
  if (opts.firstSweepInMs === undefined) {
    const handle = start();
    return () => clear(handle);
  }
  // The first sweep on its own delay, then the interval: stop clears whichever is live.
  let interval: { unref?(): void } | undefined;
  const setFirst = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearFirst =
    opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const first = setFirst(() => {
    sweep();
    interval = start();
  }, opts.firstSweepInMs);
  first.unref?.();
  return () => {
    clearFirst(first);
    if (interval) {
      clear(interval);
    }
  };
}

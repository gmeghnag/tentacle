/**
 * Bounded fixed-window counters (pure, time passed in). A full map REFUSES a new
 * key rather than evicting one: eviction would hand out a fresh limit.
 */
export interface RateRefusal {
  readonly ok: false;
  readonly error: "rate_limited" | "busy";
  readonly message: string;
  readonly retryAfterMs: number;
}

const limited = (retryAfterMs: number): RateRefusal => ({
  ok: false,
  error: "rate_limited",
  message: "rate limit reached; retry later",
  retryAfterMs,
});

const full = (retryAfterMs: number): RateRefusal => ({
  ok: false,
  error: "busy",
  message: "the host is busy; retry later",
  retryAfterMs,
});

abstract class Windows<T extends { since: number }> {
  protected readonly entries = new Map<string, T>();

  constructor(
    protected readonly limit: number,
    protected readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** The key's window, if it is still running. */
  protected live(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    return entry !== undefined && now - entry.since < this.windowMs ? entry : undefined;
  }

  /** A key not tracked yet needs room. */
  protected noRoom(key: string, now: number): RateRefusal | undefined {
    if (this.entries.has(key) || this.entries.size < this.max) {
      return undefined;
    }
    this.prune(now);
    return this.entries.size < this.max ? undefined : full(this.windowMs);
  }

  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.since >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }
}

/** `limit` events per key per window. `check` asks, `hit` counts. */
export class RateWindows extends Windows<{ since: number; count: number }> {
  check(key: string, now: number): RateRefusal | undefined {
    const entry = this.live(key, now);
    if (entry === undefined) {
      return this.noRoom(key, now);
    }
    return entry.count < this.limit ? undefined : limited(entry.since + this.windowMs - now);
  }

  hit(key: string, now: number): void {
    const entry = this.live(key, now);
    if (entry === undefined) {
      this.entries.set(key, { since: now, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  /** Check and, when admitted, count. */
  take(key: string, now: number): RateRefusal | undefined {
    const refused = this.check(key, now);
    if (refused === undefined) {
      this.hit(key, now);
    }
    return refused;
  }
}

/** `limit` DISTINCT values per key per window. */
export class DistinctWindows extends Windows<{ since: number; values: Set<string> }> {
  check(key: string, value: string, now: number): RateRefusal | undefined {
    const entry = this.live(key, now);
    if (entry === undefined) {
      return this.noRoom(key, now);
    }
    return entry.values.has(value) || entry.values.size < this.limit
      ? undefined
      : limited(entry.since + this.windowMs - now);
  }

  hit(key: string, value: string, now: number): void {
    const entry = this.live(key, now);
    if (entry === undefined) {
      this.entries.set(key, { since: now, values: new Set([value]) });
    } else {
      entry.values.add(value);
    }
  }
}

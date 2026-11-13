/**
 * Handshake rate limiting for the WebSocket ingress, as a PURE module (no
 * timers, no fs, no sockets) so its policy is unit-tested with an injected
 * clock (`AGENTS` §7: logic in pure modules; docs/feat/device-pairing.md 9b).
 *
 * Two independent limits, both checked BEFORE any crypto runs (F6, F15):
 *
 * - a per-address token bucket, so one host cannot make the daemon do repeated
 *   X25519 work or grind a pairing code;
 * - a GLOBAL cap on handshakes in flight, so many hosts at once are bounded
 *   too (a bucket alone is unbounded across addresses).
 *
 * A refusal is cheap and has no side effect; the daemon answers 429 and the
 * client retries. State is per daemon process (a restart resets it: an
 * attacker who can restart the daemon has the machine anyway).
 */

/** Admitted without waiting: a burst this big, then one more per `refillMs`. */
export const DEFAULT_HANDSHAKE_BURST = 8;
/** One token per this period, per address. */
export const DEFAULT_HANDSHAKE_REFILL_MS = 500;
/** Handshakes in flight at once, across ALL addresses. */
export const DEFAULT_MAX_CONCURRENT_HANDSHAKES = 32;
/**
 * Addresses whose bucket is remembered. Past it the stalest is dropped (its
 * next attempt starts over: a bounded cache, never an unbounded map — a
 * hostile peer must not grow the daemon's heap with one entry per source).
 */
export const DEFAULT_MAX_TRACKED_ADDRESSES = 4096;

export interface HandshakeLimitOptions {
  /** Injectable clock (tests own time; the daemon passes `Date.now`). */
  readonly now?: () => number;
  readonly burst?: number;
  readonly refillMs?: number;
  readonly maxConcurrent?: number;
  readonly maxTrackedAddresses?: number;
}

interface Bucket {
  /** Whole tokens available, fractional-free: refills in whole units. */
  tokens: number;
  /** When the bucket last earned a token (`now` at the last admission/refill). */
  at: number;
}

export class HandshakeLimiter {
  private readonly now: () => number;
  private readonly burst: number;
  private readonly refillMs: number;
  private readonly maxConcurrent: number;
  private readonly maxTracked: number;
  private readonly buckets = new Map<string, Bucket>();
  private running = 0;

  constructor(options: HandshakeLimitOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.burst = options.burst ?? DEFAULT_HANDSHAKE_BURST;
    this.refillMs = options.refillMs ?? DEFAULT_HANDSHAKE_REFILL_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_HANDSHAKES;
    this.maxTracked = options.maxTrackedAddresses ?? DEFAULT_MAX_TRACKED_ADDRESSES;
  }

  /** Handshakes currently in flight (begun and not ended). */
  get inFlight(): number {
    return this.running;
  }

  /** Addresses whose bucket is held (bounded by `maxTrackedAddresses`). */
  get tracked(): number {
    return this.buckets.size;
  }

  /**
   * May `address` start a handshake? Spends one token when it says yes. Does
   * NOT count it as in flight — call `begin` for that (this is the cheap read a
   * caller uses to answer 429 before upgrading).
   */
  admit(address: string): boolean {
    const bucket = this.bucketFor(address);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Start a handshake for `address`: the bucket AND the concurrent cap must
   * both allow it. On success the caller MUST pair it with `end()` on every
   * outcome (resolve, reject, socket closed) — an unbalanced `begin` would
   * leak the cap.
   */
  begin(address: string): boolean {
    if (this.running >= this.maxConcurrent) {
      // A refusal by the CAP is not the address's fault: its token stays
      // unspent, so a burst of unrelated peers cannot starve a real device.
      return false;
    }
    if (!this.admit(address)) {
      return false;
    }
    this.running += 1;
    return true;
  }

  /** One handshake finished (any outcome). Idempotent-safe against an extra call. */
  end(): void {
    if (this.running > 0) {
      this.running -= 1;
    }
  }

  private bucketFor(address: string): Bucket {
    const at = this.now();
    const existing = this.buckets.get(address);
    if (existing !== undefined) {
      const earned = this.refillMs > 0 ? Math.floor((at - existing.at) / this.refillMs) : 0;
      if (earned > 0) {
        existing.tokens = Math.min(this.burst, existing.tokens + earned);
        // Advance by the whole periods consumed, never to `at`: the remainder
        // is the start of the next token (no drift for a busy address).
        existing.at += earned * this.refillMs;
      }
      return existing;
    }
    // A new address starts full: a first connection must never be throttled.
    const bucket: Bucket = { tokens: this.burst - 0, at };
    this.buckets.set(address, bucket);
    this.evictIfNeeded();
    return bucket;
  }

  private evictIfNeeded(): void {
    if (this.buckets.size <= this.maxTracked) {
      return;
    }
    // Map preserves insertion order, and an existing bucket is not re-inserted
    // on use — so the first key is the one least recently CREATED, not used.
    // Bounded and cheap is the point; a dropped bucket only means "starts
    // full", which is a fairness reset, never a bypass (the global cap holds).
    const oldest = this.buckets.keys().next();
    if (!oldest.done) {
      this.buckets.delete(oldest.value);
    }
  }
}

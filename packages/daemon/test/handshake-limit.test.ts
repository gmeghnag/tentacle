import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDSHAKE_BURST,
  DEFAULT_HANDSHAKE_REFILL_MS,
  DEFAULT_MAX_CONCURRENT_HANDSHAKES,
  type HandshakeLimitOptions,
  HandshakeLimiter,
} from "../src/handshake-limit.ts";

/** A clock the test owns: `now()` is what the limiter reads, `advance` moves it. */
function clock(start = 1_000_000): { now(): number; advance(ms: number): void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

const options = (over: Partial<HandshakeLimitOptions> = {}): HandshakeLimitOptions => ({
  now: clock().now,
  ...over,
});

describe("the per-IP token bucket", () => {
  test("a burst is admitted, the one past it is refused, and a refill admits again", () => {
    const c = clock();
    const limiter = new HandshakeLimiter({ now: c.now, burst: 3, refillMs: 1000 });
    expect([1, 2, 3].map(() => limiter.admit("1.2.3.4"))).toEqual([true, true, true]);
    // 4th in the same instant: over the burst (a real limit, not off-by-one luck).
    expect(limiter.admit("1.2.3.4")).toBe(false);
    // Half a token's worth of time is not enough...
    c.advance(999);
    expect(limiter.admit("1.2.3.4")).toBe(false);
    // ...a full refill period is (one token per period).
    c.advance(1);
    expect(limiter.admit("1.2.3.4")).toBe(true);
    expect(limiter.admit("1.2.3.4")).toBe(false);
  });

  test("the bucket is per address: one noisy IP cannot spend another's budget", () => {
    const c = clock();
    const limiter = new HandshakeLimiter({ now: c.now, burst: 1, refillMs: 1000 });
    expect(limiter.admit("1.2.3.4")).toBe(true);
    expect(limiter.admit("1.2.3.4")).toBe(false);
    expect(limiter.admit("5.6.7.8")).toBe(true);
  });

  test("a long absence refills the bucket to its burst, never beyond", () => {
    const c = clock();
    const limiter = new HandshakeLimiter({ now: c.now, burst: 2, refillMs: 1000 });
    limiter.admit("1.2.3.4");
    limiter.admit("1.2.3.4");
    c.advance(60 * 60 * 1000);
    expect([1, 2, 3].map(() => limiter.admit("1.2.3.4"))).toEqual([true, true, false]);
  });

  test("an unknown address is a key of its own (the upgrade always has one)", () => {
    const limiter = new HandshakeLimiter(options({ burst: 1, refillMs: 1000 }));
    expect(limiter.admit("")).toBe(true);
    expect(limiter.admit("")).toBe(false);
  });
});

describe("the concurrent-handshake cap", () => {
  test("past the cap every address is refused until one handshake finishes", () => {
    const limiter = new HandshakeLimiter(options({ burst: 10, maxConcurrent: 2 }));
    expect(limiter.begin("1.1.1.1")).toBe(true);
    expect(limiter.begin("2.2.2.2")).toBe(true);
    // A third, from a FRESH address: the cap is global, not per IP (F6, F15).
    expect(limiter.begin("3.3.3.3")).toBe(false);
    limiter.end();
    expect(limiter.begin("3.3.3.3")).toBe(true);
  });

  test("begin spends a token too, and end is safe to over-call", () => {
    const limiter = new HandshakeLimiter(options({ burst: 1, maxConcurrent: 5 }));
    expect(limiter.begin("1.1.1.1")).toBe(true);
    expect(limiter.begin("1.1.1.1")).toBe(false); // out of tokens
    limiter.end();
    limiter.end();
    limiter.end();
    expect(limiter.inFlight).toBe(0);
    const fresh = new HandshakeLimiter(options({ burst: 1, maxConcurrent: 5 }));
    fresh.end(); // no begin at all: still 0, never negative
    expect(fresh.inFlight).toBe(0);
  });

  test("a capped-out begin does not spend the address's token", () => {
    // burst 1 so a spent token is OBSERVABLE: with 5 tokens, spending one on a
    // refusal still leaves 4 and the test would pass while the bug is there.
    const limiter = new HandshakeLimiter(options({ burst: 1, maxConcurrent: 1 }));
    expect(limiter.begin("1.1.1.1")).toBe(true);
    expect(limiter.begin("2.2.2.2")).toBe(false); // refused by the cap...
    expect(limiter.admit("2.2.2.2")).toBe(true); // ...not charged to its bucket
  });
});

describe("the buckets are bounded (a hostile peer cannot grow the map)", () => {
  test("more addresses than the cache holds evicts the stalest", () => {
    const c = clock();
    const limiter = new HandshakeLimiter({
      now: c.now,
      burst: 1,
      refillMs: 1000,
      maxTrackedAddresses: 2,
    });
    expect(limiter.admit("a")).toBe(true);
    c.advance(1);
    expect(limiter.admit("b")).toBe(true);
    expect(limiter.tracked).toBe(2);
    c.advance(1);
    expect(limiter.admit("c")).toBe(true);
    expect(limiter.tracked).toBe(2);
    // The one dropped is the OLDEST ("a" was 2 ms ago, "b" 1 ms): it starts over.
    expect(limiter.admit("b")).toBe(false);
    expect(limiter.admit("a")).toBe(true);
  });
});

describe("the defaults", () => {
  test("are the documented ones, and construct a working limiter with no options", () => {
    expect(DEFAULT_HANDSHAKE_BURST).toBeGreaterThan(0);
    expect(DEFAULT_HANDSHAKE_REFILL_MS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CONCURRENT_HANDSHAKES).toBeGreaterThan(0);
    const limiter = new HandshakeLimiter();
    expect(limiter.begin("1.1.1.1")).toBe(true);
    limiter.end();
  });

  test("an injected clock is REQUIRED to be honoured: no Date.now read behind it", () => {
    // The clock never moves, so 100 admissions in a row can refill nothing.
    const frozen = new HandshakeLimiter({ now: () => 42, burst: DEFAULT_HANDSHAKE_BURST });
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (admitted >= 0 && frozen.admit("1.1.1.1")) admitted++;
    expect(admitted).toBe(DEFAULT_HANDSHAKE_BURST);
  });
});

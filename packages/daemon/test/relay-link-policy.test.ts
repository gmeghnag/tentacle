/**
 * `relay-link-policy` — the daemon's relay link decisions with no socket in
 * sight (docs/feat/mobile-relay.md R4, AGENTS §7: logic in pure modules).
 *
 * Each test names the mutation that makes it fail (AGENTS §9). The clock and
 * randomness are injected, so time is asserted, not waited for.
 */
import { describe, expect, test } from "bun:test";
import {
  RELAY_BACKOFF_CAP_MS,
  RELAY_BACKOFF_INITIAL_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG_DEADLINE_MS,
  RELAY_REPLACED_HOLD_MS,
  RELAY_VERSION_HOLD_MS,
  backoffCounterFor,
  createRelayLiveness,
  nextAttempt,
  reasonForErrorCode,
  relayRetryAfter,
  relayWanted,
} from "../src/relay-link-policy.ts";

/** A seeded random returning a fixed value: `random()` drives the jitter directly. */
const fixed = (value: number) => ({ now: () => 0, random: () => value });

describe("backoff: exponential to a 60 s cap, full jitter", () => {
  test("the ceiling doubles per attempt and stops at the cap", () => {
    // `random()` at 0.999… asks for the largest jitter in the window, so the
    // assertion reads the CEILING itself rather than a jittered sample.
    const ceiling = (attempt: number) =>
      relayRetryAfter("closed", attempt, fixed(0.999_999)).delayMs;
    expect(ceiling(0)).toBe(RELAY_BACKOFF_INITIAL_MS);
    expect(ceiling(1)).toBe(2 * RELAY_BACKOFF_INITIAL_MS);
    expect(ceiling(2)).toBe(4 * RELAY_BACKOFF_INITIAL_MS);
    expect(ceiling(5)).toBe(32 * RELAY_BACKOFF_INITIAL_MS);
    // Attempt 6 would be 64 s: the cap holds it at 60 s (mutation: drop the
    // Math.min -> this returns 64 000 and the fleet reconnects slower than the
    // design promises, then ever slower).
    expect(ceiling(6)).toBe(RELAY_BACKOFF_CAP_MS);
    expect(ceiling(20)).toBe(RELAY_BACKOFF_CAP_MS);
  });

  test("the jitter is FULL: a different random gives a different, smaller wait", () => {
    // Full jitter means the wait is uniform in (0, ceiling], not "ceiling minus
    // a bit": with random() = 0 the wait is as small as the code allows, and
    // with random() near 1 it reaches the ceiling.
    const low = relayRetryAfter("closed", 3, fixed(0)).delayMs;
    const high = relayRetryAfter("closed", 3, fixed(0.999_999)).delayMs;
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0); // never a 0 ms tight loop (mutation: `*` not `min`)
    expect(high).toBe(8 * RELAY_BACKOFF_INITIAL_MS);
  });

  test("two daemons jittering apart do not arrive together (the F3 herd)", () => {
    const a = relayRetryAfter("closed", 2, fixed(0.1)).delayMs;
    const b = relayRetryAfter("closed", 2, fixed(0.9)).delayMs;
    expect(a).not.toBe(b);
  });

  test("a dropped socket is an ordinary retry with NO notice (a restart must not spam)", () => {
    expect(relayRetryAfter("closed", 0, fixed(0.5)).notice).toBeUndefined();
    expect(relayRetryAfter("timeout", 0, fixed(0.5)).notice).toBeUndefined();
    expect(relayRetryAfter("oversize", 0, fixed(0.5)).notice).toBeUndefined();
  });
});

describe("the two holds that are not backoff", () => {
  test("a version skew waits 1 h, with one notice naming the wait", () => {
    const retry = relayRetryAfter("version", 0, fixed(0.5));
    expect(retry.delayMs).toBe(RELAY_VERSION_HOLD_MS);
    expect(retry.delayMs).toBe(3_600_000);
    expect(retry.notice).toContain("version");
    // Not jittered: it is a decision, not a distribution.
    expect(relayRetryAfter("version", 0, fixed(0.999_999)).delayMs).toBe(RELAY_VERSION_HOLD_MS);
    // …and not affected by the attempt counter either.
    expect(relayRetryAfter("version", 7, fixed(0.5)).delayMs).toBe(RELAY_VERSION_HOLD_MS);
  });

  test("`replaced` waits 5 min and names the likely cause (a copied config dir)", () => {
    const retry = relayRetryAfter("replaced", 0, fixed(0.5));
    expect(retry.delayMs).toBe(RELAY_REPLACED_HOLD_MS);
    expect(retry.delayMs).toBe(300_000);
    expect(retry.notice).toContain("copied config dir");
    expect(relayRetryAfter("replaced", 3, fixed(0.9)).delayMs).toBe(RELAY_REPLACED_HOLD_MS);
  });

  test("an unusable relay URL never retries at all (it cannot fix itself)", () => {
    const retry = relayRetryAfter("unsupported-url", 0, fixed(0.5));
    expect(retry.delayMs).toBe(Number.POSITIVE_INFINITY);
    expect(retry.notice).toBeUndefined();
  });

  test("an unknown refusal code is an ordinary retry, not a special hold", () => {
    // AGENTS §7 forward compat: a newer relay's new code must behave like
    // `invalid` (review R1 finding 1), never like the 1 h version hold.
    expect(reasonForErrorCode("version")).toBe("version");
    expect(reasonForErrorCode("busy")).toBe("busy");
    expect(reasonForErrorCode("invalid")).toBe("invalid");
    expect(reasonForErrorCode("future-code")).toBe("invalid");
    expect(relayRetryAfter(reasonForErrorCode("future-code"), 0, fixed(0.5)).delayMs).toBeLessThan(
      RELAY_BACKOFF_CAP_MS + 1,
    );
  });
});

describe("the oversize counter is its own (F7's fallback, R4 review 1)", () => {
  test("an oversize strike reads a counter a `ready` cannot reset", () => {
    // The finding: `ready` resets the shared counter (correctly — an hour of
    // service must not earn a 60 s first retry), so a relay alternating `ready`
    // with one oversize frame kept every cycle at the FIRST step: the review
    // measured [991, 991, 991, 991, 991] ms, one allocation a second, forever.
    // Mutation: return `attempt` for every reason -> the second wait collapses
    // to the first step and the loop test in relay-link.test.ts fails.
    expect(backoffCounterFor("oversize", 0, 3)).toBe(3);
    expect(backoffCounterFor("closed", 2, 3)).toBe(2);
    expect(backoffCounterFor("timeout", 1, 9)).toBe(1);
    // The consequence, in the policy's own terms: the third strike waits longer
    // than the first, with `attempt` reset to 0 all along (every cycle's `ready`).
    const first = relayRetryAfter(
      "oversize",
      backoffCounterFor("oversize", 0, 0),
      fixed(0.999_999),
    );
    const third = relayRetryAfter(
      "oversize",
      backoffCounterFor("oversize", 0, 2),
      fixed(0.999_999),
    );
    expect(third.delayMs).toBeGreaterThan(first.delayMs);
  });
});

describe("the attempt counter", () => {
  test("grows on ordinary failures and resets for the decided holds", () => {
    expect(nextAttempt("closed", 0)).toBe(1);
    expect(nextAttempt("timeout", 4)).toBe(5);
    // A held reason is not part of a backoff progression: after its wait the
    // next ordinary failure starts from the bottom again.
    expect(nextAttempt("version", 4)).toBe(0);
    expect(nextAttempt("replaced", 4)).toBe(0);
    expect(nextAttempt("unsupported-url", 4)).toBe(0);
  });

  test("a usable connection resets it, so a long-lived link retries fast", () => {
    // The caller resets by passing 0 (it does so on an accepted `ready`); this
    // pins the value it must pass, so the reset cannot drift to "attempt".
    expect(nextAttempt("closed", 0)).toBe(1);
  });
});

describe("relayWanted — Owner Q1: never contact the relay for nothing", () => {
  test("no device and no pairing window means no dial", () => {
    expect(relayWanted(false, true)).toBe(false);
    expect(relayWanted(true, false)).toBe(false);
    expect(relayWanted(false, false)).toBe(false);
    expect(relayWanted(true, true)).toBe(true);
  });
});

describe("liveness — R0(c): a Bun client never notices a dead-but-open path", () => {
  test("a ping is due at the interval, and a missed pong expires the link", () => {
    const live = createRelayLiveness(0);
    // Mutation: drop `expired()` (or never arm it in `pingSent`) and the dead
    // path R0(c) measured stays "up" forever — every phone dial then 4404s.
    expect(live.pingDue(RELAY_PING_INTERVAL_MS - 1)).toBe(false);
    expect(live.pingDue(RELAY_PING_INTERVAL_MS)).toBe(true);
    live.pingSent(RELAY_PING_INTERVAL_MS);
    expect(live.expired(RELAY_PING_INTERVAL_MS + RELAY_PONG_DEADLINE_MS - 1)).toBe(false);
    expect(live.expired(RELAY_PING_INTERVAL_MS + RELAY_PONG_DEADLINE_MS)).toBe(true);
  });

  test("a pong clears the deadline; the next ping re-arms it", () => {
    const live = createRelayLiveness(0);
    live.pingSent(1_000);
    live.pongReceived();
    expect(live.expired(10_000_000)).toBe(false);
    // Arming again is what keeps a session alive: a `pong` is per ping.
    live.pingSent(20_000);
    expect(live.expired(20_000 + RELAY_PONG_DEADLINE_MS)).toBe(true);
  });

  test("no ping sent yet means no deadline (a fresh socket is not instantly dead)", () => {
    const live = createRelayLiveness(0);
    expect(live.expired(RELAY_PONG_DEADLINE_MS * 10)).toBe(false);
  });

  test("the intervals are injectable, so a test drives seconds instead of 25", () => {
    const live = createRelayLiveness(0, { pingMs: 10, pongMs: 5 });
    expect(live.pingDue(10)).toBe(true);
    live.pingSent(10);
    expect(live.expired(15)).toBe(true);
  });
});

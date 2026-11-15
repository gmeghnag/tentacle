import { describe, expect, test } from "bun:test";
import { clientIpOf, isLoopback, limiterKeyOf } from "../src/client-ip.ts";

/**
 * The relay's real client IP (fix/relay-hardening H3): behind Caddy every direct
 * peer is 127.0.0.1, so keying the limits on Bun's `requestIP` makes every
 * per-IP limit ONE global bucket. The property pinned here is *where the key
 * comes from*: the header is read ONLY from a loopback peer and ONLY when the
 * operator opted in (`--trust-proxy`), and the hop taken is the right-most
 * untrusted one — an attacker's own `X-Forwarded-For` can never move it.
 *
 * Mutations that must turn these red:
 *  - take the LEFT-most entry instead of the right-most → "1.1.1.1, 203.0.113.7"
 *  - drop the loopback-peer check → the non-loopback-peer case
 *  - keep walking left past a malformed hop → "203.0.113.7, garbage"
 */

const LOOPBACK = "127.0.0.1";

describe("clientIpOf — the header is trusted only from a loopback peer, only on request", () => {
  test("trust off: the peer, whatever the header says", () => {
    expect(clientIpOf({ peer: LOOPBACK, forwardedFor: "203.0.113.7", trustProxy: false })).toBe(
      LOOPBACK,
    );
  });

  test("trust on, loopback peer, one hop: the hop is the client", () => {
    expect(clientIpOf({ peer: LOOPBACK, forwardedFor: "203.0.113.7", trustProxy: true })).toBe(
      "203.0.113.7",
    );
  });

  test("trust on: the RIGHT-MOST hop wins (a client's own header is appended to, not obeyed)", () => {
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "1.1.1.1, 203.0.113.7", trustProxy: true }),
    ).toBe("203.0.113.7");
  });

  test("trust on: trusted (loopback) hops are skipped from the right", () => {
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "203.0.113.7, 127.0.0.1", trustProxy: true }),
    ).toBe("203.0.113.7");
    // Two proxies, the outer one on the same host: still the real client.
    expect(
      clientIpOf({ peer: "::1", forwardedFor: "203.0.113.7, 127.0.0.1, ::1", trustProxy: true }),
    ).toBe("203.0.113.7");
  });

  test("a NON-loopback peer's header is never read (spoofing refused)", () => {
    expect(
      clientIpOf({ peer: "198.51.100.1", forwardedFor: "203.0.113.7", trustProxy: true }),
    ).toBe("198.51.100.1");
  });

  test("a malformed right-most hop falls back to the peer, never further left", () => {
    // Entries further left are what the ATTACKER wrote; walking into them would
    // hand them a fresh bucket per request.
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "203.0.113.7, garbage", trustProxy: true }),
    ).toBe(LOOPBACK);
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "1.1.1.1, not-an-ip", trustProxy: true }),
    ).toBe(LOOPBACK);
  });

  test("absent or empty header: the peer (one shared bucket for host-local tools)", () => {
    for (const forwardedFor of [null, "", "   ", " , "]) {
      expect(clientIpOf({ peer: LOOPBACK, forwardedFor, trustProxy: true })).toBe(LOOPBACK);
    }
  });

  test("an IPv4-mapped IPv6 peer is unmapped, and so is a hop", () => {
    expect(clientIpOf({ peer: "::ffff:127.0.0.1", forwardedFor: null, trustProxy: true })).toBe(
      "127.0.0.1",
    );
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "::ffff:203.0.113.7", trustProxy: true }),
    ).toBe("203.0.113.7");
  });

  test("a bracketed IPv6 hop and an uppercase peer are normalised", () => {
    expect(
      clientIpOf({ peer: LOOPBACK, forwardedFor: "[2001:DB8:1:2::9]", trustProxy: true }),
    ).toBe("2001:db8:1:2::9");
    expect(clientIpOf({ peer: "::FFFF:127.0.0.1", forwardedFor: null, trustProxy: true })).toBe(
      "127.0.0.1",
    );
  });

  test("at most 16 hops are read (a header cannot cost unbounded work)", () => {
    const spam = Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`).join(", ");
    // The 16 right-most are kept, so the right-most one still answers.
    expect(clientIpOf({ peer: LOOPBACK, forwardedFor: spam, trustProxy: true })).toBe("10.0.0.40");
  });

  test("isLoopback knows the three shapes a local peer takes", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.13.9.2")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("142.132.169.22")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
    expect(isLoopback("")).toBe(false);
  });
});

describe("limiterKeyOf — an IPv6 client gets one /64, not 2^64 buckets (M3)", () => {
  test("IPv4 is its own key", () => {
    expect(limiterKeyOf("203.0.113.7")).toBe("203.0.113.7");
  });

  test("IPv6 collapses to its /64, however it is written", () => {
    const expected = "2001:db8:1:2::/64";
    expect(limiterKeyOf("2001:db8:1:2:3:4:5:6")).toBe(expected);
    expect(limiterKeyOf("2001:db8:1:2::9")).toBe(expected);
    expect(limiterKeyOf("2001:DB8:1:2:FFFF::1")).toBe(expected);
  });

  test("two addresses in one /64 share a key; different /64s do not", () => {
    expect(limiterKeyOf("2001:db8:1:2::1")).toBe(limiterKeyOf("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(limiterKeyOf("2001:db8:1:3::1")).not.toBe(limiterKeyOf("2001:db8:1:2::1"));
  });

  test("a non-address is passed through unchanged (never a guess, never a crash)", () => {
    expect(limiterKeyOf("")).toBe("");
    expect(limiterKeyOf("garbage")).toBe("garbage");
  });
});

/**
 * The addresses `tentacle pair` publishes (docs/feat/device-pairing.md 9d).
 *
 * One property per block, each naming its mutation:
 * - loopback contributes NOTHING (mutation: emit it → the QR carries an address
 *   no phone can ever reach, so pairing fails with no reason);
 * - `0.0.0.0`/`::` expand to each non-internal IPv4 (mutation: emit the literal
 *   `0.0.0.0`, which no client can dial);
 * - `tls` decides `wss` (mutation: always `ws` → a TLS daemon is undialable);
 * - `--address` is appended, deduped FIRST-wins (mutation: last-wins → the phone
 *   tries the wrong one first, and order is what it tries);
 * - an invalid or too-many `--address` is REFUSED, never dropped (mutation:
 *   filter them out → a typo silently vanishes from the QR).
 */
import { describe, expect, test } from "bun:test";
import type { DaemonRecord } from "@tentacle/daemon";
import {
  REACHABLE_HINT,
  isCarrierGradeNat,
  isLoopbackHost,
  pairAddresses,
} from "../src/pair-addresses.ts";

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: 1,
  host: "0.0.0.0",
  port: 4000,
  tls: false,
  cwd: "/w",
  startedAt: 1,
  ...over,
});

const LAN = [
  { address: "192.168.1.8", family: "IPv4", internal: false },
  { address: "100.101.7.6", family: "IPv4", internal: false },
  { address: "127.0.0.1", family: "IPv4", internal: true },
  { address: "::1", family: "IPv6", internal: true },
] as const;

const addresses = (input: Parameters<typeof pairAddresses>[0]) => {
  const result = pairAddresses(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.addresses;
};

describe("loopback", () => {
  test("every loopback form is recognised", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "localhost",
      "",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("a real bind is not loopback", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.8", "100.101.7.6", "fd00::1", "example.test"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("a loopback daemon contributes no address (a phone cannot reach it)", () => {
    expect(addresses({ records: [record({ host: "127.0.0.1" })], interfaces: LAN })).toEqual([]);
  });
});

describe("wildcard binds", () => {
  test("0.0.0.0 → each non-internal IPv4, in interface order", () => {
    expect(addresses({ records: [record()], interfaces: LAN })).toEqual([
      "ws://192.168.1.8:4000/e2e",
      "ws://100.101.7.6:4000/e2e",
    ]);
  });

  test(":: is the same every-interface bind (mutation: only 0.0.0.0 is expanded)", () => {
    expect(addresses({ records: [record({ host: "::" })], interfaces: LAN })).toEqual([
      "ws://192.168.1.8:4000/e2e",
      "ws://100.101.7.6:4000/e2e",
    ]);
  });

  test("the port is the daemon's own, so two daemons give two sets", () => {
    expect(
      addresses({
        records: [record({ port: 4000 }), record({ pid: 2, port: 5000 })],
        interfaces: [LAN[0]],
      }),
    ).toEqual(["ws://192.168.1.8:4000/e2e", "ws://192.168.1.8:5000/e2e"]);
  });
});

describe("explicit binds", () => {
  test("a specific address is itself only (not the other interfaces)", () => {
    expect(addresses({ records: [record({ host: "192.168.1.8" })], interfaces: LAN })).toEqual([
      "ws://192.168.1.8:4000/e2e",
    ]);
  });

  test("an IPv6 literal gets brackets (a bare one is not a URL)", () => {
    expect(addresses({ records: [record({ host: "fd00::1" })], interfaces: LAN })).toEqual([
      "ws://[fd00::1]:4000/e2e",
    ]);
  });

  test("tls decides wss (mutation: always ws → a TLS daemon is undialable)", () => {
    expect(
      addresses({ records: [record({ host: "192.168.1.8", tls: true })], interfaces: LAN }),
    ).toEqual(["wss://192.168.1.8:4000/e2e"]);
  });
});

describe("--address", () => {
  test("is appended after the daemons' own, in the order given", () => {
    expect(
      addresses({
        records: [record({ host: "192.168.1.8" })],
        interfaces: LAN,
        extra: ["ws://relay.test:8443/e2e", "wss://other.test/e2e"],
      }),
    ).toEqual(["ws://192.168.1.8:4000/e2e", "ws://relay.test:8443/e2e", "wss://other.test/e2e"]);
  });

  test("dedup keeps the FIRST occurrence (order is the phone's dial order)", () => {
    expect(
      addresses({
        records: [record({ host: "192.168.1.8" })],
        interfaces: LAN,
        extra: ["ws://192.168.1.8:4000/e2e", "ws://192.168.1.8:4000/e2e"],
      }),
    ).toEqual(["ws://192.168.1.8:4000/e2e"]);
  });

  test("an address a phone cannot dial is REFUSED, never dropped", () => {
    const result = pairAddresses({
      records: [],
      interfaces: LAN,
      extra: ["https://example.test/", "ws://ok.test/e2e"],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.reason === "invalid" ? result.invalid : []).toEqual([
      "https://example.test/",
    ]);
  });

  test("more than the QR may carry is a refusal, not a silent truncation", () => {
    const extra = Array.from({ length: 9 }, (_, i) => `ws://h${i}.test/e2e`);
    const result = pairAddresses({ records: [], interfaces: [], extra });
    expect(result.ok).toBe(false);
    expect(result.ok ? 0 : result.reason === "too_many" ? result.count : 0).toBe(9);
  });
});

describe("nothing reachable", () => {
  test("only loopback daemons and no --address → no addresses (pair refuses)", () => {
    expect(addresses({ records: [record({ host: "127.0.0.1" })], interfaces: LAN })).toEqual([]);
    expect(REACHABLE_HINT).toContain("serve --host 0.0.0.0");
  });

  test("a wildcard bind on a machine with no external interface → none either", () => {
    expect(
      addresses({
        records: [record()],
        interfaces: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
    ).toEqual([]);
  });
});

describe("Tailscale", () => {
  test("100.64/10 is CGNAT (the tailnet range), 100.63 and 100.128 are not", () => {
    expect(isCarrierGradeNat("100.64.0.1")).toBe(true);
    expect(isCarrierGradeNat("100.127.255.255")).toBe(true);
    expect(isCarrierGradeNat("100.63.0.1")).toBe(false);
    expect(isCarrierGradeNat("100.128.0.1")).toBe(false);
    expect(isCarrierGradeNat("192.168.1.8")).toBe(false);
  });

  test("a tailnet address is published alongside the LAN one (both reach a phone)", () => {
    expect(addresses({ records: [record()], interfaces: LAN })).toContain(
      "ws://100.101.7.6:4000/e2e",
    );
  });
});

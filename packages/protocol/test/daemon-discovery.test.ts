/**
 * `daemon/discover` + `daemon/discovery` (docs/feat/sibling-discovery.md):
 * the daemon-scoped snapshot of a computer's live `serve` siblings and their
 * current addresses. Additive on the wire (an older daemon answers
 * `MethodNotFound`; the notification is only sent to a client that asked for
 * it), so no PROTOCOL_VERSION bump.
 */
import { describe, expect, test } from "bun:test";
import {
  DaemonDiscoverParamsSchema,
  DaemonDiscoverySchema,
  MAX_DISCOVERED_DAEMONS,
  MAX_PAIRING_ADDRESSES,
  Method,
  Notification,
  NotificationSchemas,
  RequestSchemas,
  isMethodName,
  isNotificationName,
  isPairingAddress,
} from "../src/index.ts";

/** One well-formed daemon. */
const daemon = (over: Record<string, unknown> = {}) => ({
  cwd: "/Users/me/project",
  addresses: ["ws://192.168.1.5:4000/e2e"],
  startedAt: 1,
  ...over,
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  rev: 1,
  daemons: [daemon({ self: true })],
  ...over,
});

describe("daemon/discover is a registered request", () => {
  test("both names are in the registry (an older client never asks, so it never sees them)", () => {
    expect(Method.DaemonDiscover).toBe("daemon/discover");
    expect(Notification.DaemonDiscovery).toBe("daemon/discovery");
    expect(isMethodName("daemon/discover")).toBe(true);
    expect(isNotificationName("daemon/discovery")).toBe(true);
    expect(RequestSchemas[Method.DaemonDiscover].params).toBeDefined();
    expect(RequestSchemas[Method.DaemonDiscover].result).toBeDefined();
    expect(NotificationSchemas[Notification.DaemonDiscovery]).toBeDefined();
  });

  test("params are an empty object (a sibling list is a computer-wide read)", () => {
    expect(DaemonDiscoverParamsSchema.safeParse({}).success).toBe(true);
    // Not `.strict()`: an unknown field is stripped, never refused (v10 rules).
    const extra = DaemonDiscoverParamsSchema.safeParse({ bogus: 1 });
    expect(extra.success && "bogus" in extra.data).toBe(false);
  });
});

describe("DaemonDiscovery bounds", () => {
  test("a well-formed snapshot parses, `self` optional", () => {
    expect(DaemonDiscoverySchema.safeParse(snapshot()).success).toBe(true);
    expect(DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon()] })).success).toBe(true);
  });

  test("more than 32 daemons is refused", () => {
    const many = Array.from({ length: MAX_DISCOVERED_DAEMONS }, () => daemon());
    expect(MAX_DISCOVERED_DAEMONS).toBe(32);
    expect(DaemonDiscoverySchema.safeParse(snapshot({ daemons: many })).success).toBe(true);
    expect(
      DaemonDiscoverySchema.safeParse(snapshot({ daemons: [...many, daemon()] })).success,
    ).toBe(false);
  });

  test("more than 8 addresses on one daemon is refused", () => {
    expect(MAX_PAIRING_ADDRESSES).toBe(8);
    const eight = Array.from({ length: 8 }, (_, i) => `ws://10.0.0.${i}:4000/e2e`);
    expect(
      DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon({ addresses: eight })] }))
        .success,
    ).toBe(true);
    expect(
      DaemonDiscoverySchema.safeParse(
        snapshot({ daemons: [daemon({ addresses: [...eight, eight[0]] })] }),
      ).success,
    ).toBe(false);
  });

  test("an HTTP address, a bare port and a 513-char URL are refused", () => {
    const long = `ws://host:4000/${"a".repeat(513)}/e2e`;
    for (const bad of ["http://host:4000/e2e", "host:4000", long, "", "ws://host:4000"]) {
      expect(
        DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon({ addresses: [bad] })] }))
          .success,
      ).toBe(false);
    }
  });

  test("an empty `addresses` is ALLOWED: a loopback-only sibling is listed, unreachable (owner Q4)", () => {
    expect(
      DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon({ addresses: [] })] })).success,
    ).toBe(true);
  });

  test("a control character, an empty or an oversized `cwd` is refused", () => {
    for (const cwd of ["", "/pro\nject", `/${"a".repeat(4096)}`]) {
      expect(
        DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon({ cwd })] })).success,
      ).toBe(false);
    }
  });

  test("`rev` is a whole non-negative integer and `startedAt` a stamp", () => {
    for (const rev of [-1, 1.5]) {
      expect(DaemonDiscoverySchema.safeParse(snapshot({ rev })).success).toBe(false);
    }
    expect(
      DaemonDiscoverySchema.safeParse(snapshot({ daemons: [daemon({ startedAt: -1 })] })).success,
    ).toBe(false);
  });

  test("an unknown field is stripped on a daemon and on the snapshot", () => {
    const daemonExtra = DaemonDiscoverySchema.safeParse(
      snapshot({ daemons: [daemon({ bogus: 1 })] }),
    );
    expect(daemonExtra.success && "bogus" in (daemonExtra.data as never)).toBe(false);
    const snapshotExtra = DaemonDiscoverySchema.safeParse(snapshot({ bogus: 1 }));
    expect(snapshotExtra.success && "bogus" in (snapshotExtra.data as never)).toBe(false);
  });
});

describe("the address shape agrees with isPairingAddress", () => {
  test("on a fixed sample set (one predicate for the QR, one for the wire)", () => {
    const samples = [
      "ws://192.168.1.5:4000/e2e",
      "wss://mac.tailnet.ts.net/e2e",
      "ws://[::1]:4000/e2e",
      "ws://host:4000/e2e?x=1",
      "ws://host:4000/e2e/",
      "ws://host:4000",
      "ws://host:4000/other",
      "http://host:4000/e2e",
      "",
      "ws:///e2e",
      `ws://host:4000/${"a".repeat(500)}/e2e`,
    ];
    for (const sample of samples) {
      const bySchema = DaemonDiscoverySchema.safeParse(
        snapshot({ daemons: [daemon({ addresses: [sample] })] }),
      ).success;
      expect({ sample, bySchema }).toEqual({ sample, bySchema: isPairingAddress(sample) });
    }
  });
});

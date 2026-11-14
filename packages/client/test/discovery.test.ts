/**
 * Sibling discovery on the client (docs/feat/sibling-discovery.md).
 *
 * Two things, both real objects:
 * - the pure retention policy the app (task 11) uses: `foldDiscovery` drops a
 *   frame that arrives out of order and resets on a NEW `self.startedAt`, and
 *   `mergeAddresses` announces first then keeps known addresses as fallbacks
 *   for 30 days, never erasing one on an empty announcement (owner Q6);
 * - `RemoteClient.discover` over a real `Connection`: the snapshot, the
 *   notification, `MethodNotFound` → `undefined` (an older or pod daemon), and
 *   RE-SUBSCRIBING after a reconnect — otherwise a Wi-Fi blip silently ends
 *   discovery (mutation: skip the re-subscribe → that test fails).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { Connection, type DiscoverySource, SessionHost } from "@tentacle/daemon";
import {
  type DaemonDiscovery,
  type DiscoveredDaemon,
  JsonRpcErrorCode,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import {
  DISCOVERY_RETENTION_MS,
  type KnownProject,
  foldDiscovery,
  mergeAddresses,
} from "../src/discovery.ts";
import { RemoteClient } from "../src/remote-client.ts";

const daemon = (over: Partial<DiscoveredDaemon> = {}): DiscoveredDaemon => ({
  cwd: "/work/a",
  addresses: ["ws://10.0.0.5:4000/e2e"],
  startedAt: 1,
  ...over,
});

const snapshot = (rev: number, daemons: DiscoveredDaemon[]): DaemonDiscovery => ({ rev, daemons });

describe("foldDiscovery (rev guard, new-process reset)", () => {
  test("keeps the snapshot with the highest rev and drops a lower one (F12)", () => {
    const first = foldDiscovery(undefined, snapshot(3, [daemon()]), 1000);
    expect(first.snapshot?.rev).toBe(3);
    // A frame that overtook the response that subscribed it.
    expect(foldDiscovery(first, snapshot(2, [daemon({ cwd: "/old" })]), 1001).snapshot?.rev).toBe(
      3,
    );
    expect(foldDiscovery(first, snapshot(3, [daemon({ cwd: "/same" })]), 1001).snapshot?.rev).toBe(
      3,
    );
    const newer = foldDiscovery(first, snapshot(4, [daemon({ cwd: "/new" })]), 1002);
    expect(newer.snapshot?.rev).toBe(4);
    expect(newer.snapshot?.daemons[0]?.cwd).toBe("/new");
  });

  test("a NEW self.startedAt resets the guard: rev restarts with the daemon process (F7)", () => {
    const before = foldDiscovery(undefined, snapshot(9, [daemon({ self: true, startedAt: 1 })]), 0);
    const after = foldDiscovery(before, snapshot(1, [daemon({ self: true, startedAt: 2 })]), 10);
    // rev 1 < 9, but this is a DIFFERENT daemon process: accept it.
    expect(after.snapshot?.rev).toBe(1);
    expect(after.snapshot?.daemons[0]?.startedAt).toBe(2);
  });

  test("records when the snapshot last changed (the app's `live` stamp)", () => {
    const first = foldDiscovery(undefined, snapshot(1, [daemon()]), 500);
    expect(first.at).toBe(500);
    const same = foldDiscovery(first, snapshot(1, [daemon()]), 600);
    expect(same.at).toBe(500);
  });
});

describe("mergeAddresses (announced first, known kept 30 days, owner Q6)", () => {
  const known = (over: Partial<KnownProject> = {}): KnownProject => ({
    cwd: "/work/a",
    addresses: ["ws://pairing.local:4000/e2e"],
    lastSeenAt: 0,
    startedAt: 1,
    ...over,
  });

  test("announced addresses come first, then known ones as fallbacks", () => {
    const merged = mergeAddresses(
      [known()],
      snapshot(1, [daemon({ addresses: ["ws://10.0.0.5:4000/e2e"] })]),
      1000,
    );
    expect(merged.projects[0]?.addresses).toEqual([
      "ws://10.0.0.5:4000/e2e",
      "ws://pairing.local:4000/e2e",
    ]);
    expect(merged.projects[0]?.live).toBe(true);
  });

  test("an EMPTY announcement never erases a known address", () => {
    const merged = mergeAddresses([known()], snapshot(1, [daemon({ addresses: [] })]), 1000);
    expect(merged.projects[0]?.addresses).toEqual(["ws://pairing.local:4000/e2e"]);
  });

  test("a project missing from the snapshot is `live: false`, never deleted (decision 7)", () => {
    const merged = mergeAddresses([known()], snapshot(1, []), 1000);
    expect(merged.projects.map((p) => [p.cwd, p.live])).toEqual([["/work/a", false]]);
  });

  test("an invalid announced address is dropped, a known one is kept", () => {
    const merged = mergeAddresses(
      [known()],
      snapshot(1, [daemon({ addresses: ["http://nope/e2e", "ws://10.0.0.5:4000/e2e"] })]),
      1000,
    );
    expect(merged.projects[0]?.addresses).toEqual([
      "ws://10.0.0.5:4000/e2e",
      "ws://pairing.local:4000/e2e",
    ]);
  });

  test("a known address expires 30 days after it was last seen; an announced one refreshes it", () => {
    expect(DISCOVERY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const stale = known({ lastSeenAt: 0 });
    const at = DISCOVERY_RETENTION_MS + 1;
    // Not announced and past the window: gone.
    expect(mergeAddresses([stale], snapshot(1, []), at).projects[0]?.addresses).toEqual([]);
    // Announced again before the window closes: kept, and the clock restarts.
    const refreshed = mergeAddresses(
      [stale],
      snapshot(1, [daemon({ addresses: ["ws://10.0.0.5:4000/e2e"] })]),
      DISCOVERY_RETENTION_MS - 1,
    );
    expect(refreshed.projects[0]?.addresses).toEqual([
      "ws://10.0.0.5:4000/e2e",
      "ws://pairing.local:4000/e2e",
    ]);
    expect(refreshed.projects[0]?.lastSeenAt).toBe(DISCOVERY_RETENTION_MS - 1);
  });

  test("caps: 8 addresses per project, 32 projects (announced first, so a known one is the one cut)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `ws://10.0.0.${i}:4000/e2e`);
    const merged = mergeAddresses([known()], snapshot(1, [daemon({ addresses: many })]), 1000);
    expect(merged.projects[0]?.addresses.length).toBe(8);
    expect(merged.projects[0]?.addresses[0]).toBe(many[0] ?? "");
    // A fallback past the cap is not shown: the announced ones fit exactly.
    expect(merged.projects[0]?.addresses).not.toContain("ws://pairing.local:4000/e2e");
    const projects = Array.from({ length: 40 }, (_, i) =>
      daemon({ cwd: `/work/p${i}`, startedAt: i + 1 }),
    );
    expect(mergeAddresses([], snapshot(1, projects), 1000).projects.length).toBe(32);
  });

  test("the same project through two snapshots keeps its place (no reorder churn)", () => {
    const merged = mergeAddresses(
      [known({ cwd: "/work/b" }), known({ cwd: "/work/a" })],
      snapshot(1, [daemon({ cwd: "/work/a" })]),
      1000,
    );
    expect(merged.projects.map((p) => p.cwd).sort()).toEqual(["/work/a", "/work/b"]);
  });

  test("a fallback expires 30 days after IT was last seen, even while its project stays LIVE (Q6)", () => {
    // A project announced at every poll never stops being seen, so a single
    // per-project clock would keep an address nobody has announced for years
    // alive forever. Owner Q6's window is per ADDRESS: "a previously known one
    // is kept as a fallback for 30 days after it was last seen". This folds a
    // real CHAIN (each merge's output is the next one's input), which is what a
    // phone's store does; a one-shot merge cannot tell the two clocks apart
    // (mutation: fold the per-address stamp back onto the project's → the stale
    // address survives every announcement, fail).
    const old = known({ addresses: ["ws://old.local:4000/e2e"], lastSeenAt: 0 });
    const day = 24 * 60 * 60 * 1000;
    let projects: readonly KnownProject[] = [old];
    // Announced every 10 days with a FRESH address: the project is seen each
    // time (its clock moves), the old address is never announced again.
    for (const at of [10, 20, 40, 50].map((d) => d * day)) {
      const merged = mergeAddresses(
        projects,
        snapshot(1, [daemon({ addresses: ["ws://10.0.0.5:4000/e2e"] })]),
        at,
      );
      expect(merged.projects[0]?.live).toBe(true);
      expect(merged.projects[0]?.lastSeenAt).toBe(at);
      projects = merged.projects;
    }
    // Day 50: the project is as live as ever, the address is 50 days unseen.
    expect(projects[0]?.addresses).toEqual(["ws://10.0.0.5:4000/e2e"]);
    // A fallback INSIDE the window is still kept (the clock is per address, not
    // "drop every unannounced one").
    const young = mergeAddresses(
      [known({ addresses: ["ws://young.local:4000/e2e"], lastSeenAt: 0 })],
      snapshot(1, [daemon({ addresses: [] })]),
      DISCOVERY_RETENTION_MS - 1,
    );
    expect(young.projects[0]?.addresses).toEqual(["ws://young.local:4000/e2e"]);
  });
});

// --- RemoteClient over a real Connection ------------------------------------

/** A source a test drives by hand. */
function fakeSource(initial: DaemonDiscovery) {
  let current = initial;
  const listeners = new Set<(d: DaemonDiscovery) => void>();
  const source: DiscoverySource = {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    push(next: DaemonDiscovery) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

const hostWith = (source?: DiscoverySource): SessionHost =>
  new SessionHost({
    defaultCwd: "/tmp/client-discovery",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(source ? { discovery: source } : {}),
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("RemoteClient.discover", () => {
  test("resolves the snapshot, then delivers a change to the listener", async () => {
    const fake = fakeSource(snapshot(1, [daemon({ self: true })]));
    const [d, c] = createChannelPair();
    new Connection(d, hostWith(fake.source));
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const seen: DaemonDiscovery[] = [];
    const first = await client.discover((discovery) => seen.push(discovery));
    expect(first?.rev).toBe(1);
    fake.push(snapshot(2, [daemon({ cwd: "/work/b" })]));
    await tick();
    expect(seen.map((s) => s.rev)).toEqual([2]);
    client.close();
  });

  test("a daemon without discovery (a pod, an older build) resolves `undefined`", async () => {
    const [d, c] = createChannelPair();
    new Connection(d, hostWith());
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    expect(await client.discover(() => {})).toBeUndefined();
    client.close();
  });

  test("a REPLACED listener stops receiving; one listener at a time per client", async () => {
    const fake = fakeSource(snapshot(1, [daemon()]));
    const [d, c] = createChannelPair();
    new Connection(d, hostWith(fake.source));
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const first: number[] = [];
    const second: number[] = [];
    await client.discover((s) => first.push(s.rev));
    await client.discover((s) => second.push(s.rev));
    // One daemon-side subscription per discover call would double every frame
    // here; the client keeps ONE listener (the last one set).
    expect(fake.listeners.size).toBe(1);
    fake.push(snapshot(2, [daemon()]));
    await tick();
    expect({ first, second }).toEqual({ first: [], second: [2] });
    client.close();
  });

  test("a change made WHILE THE LINK WAS DOWN reaches the listener after the reconnect (F7)", async () => {
    // The subscription is per connection, so anything the daemon announced
    // between the drop and the re-handshake arrives only as the re-issued
    // `daemon/discover` RESULT. Folding it without telling the listener would
    // swallow it for good (it also becomes the `rev` guard, so no later frame
    // re-delivers it): the phone keeps a stale project list until the NEXT
    // change. Mutation: drop the listener call on a changed resync → `seen`
    // stays empty here.
    const fake = fakeSource(snapshot(1, [daemon({ self: true })]));
    const host = hostWith(fake.source);
    const channels: DuplexChannel[] = [];
    const makeChannel = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      channels.push(c);
      return c;
    };
    const first = makeChannel();
    const client = new RemoteClient(first, new PermissionBroker(), undefined, {
      channelFactory: async () => makeChannel(),
      random: () => 0,
    });
    await client.initialize();
    const seen: DaemonDiscovery[] = [];
    await client.discover((s) => seen.push(s));
    // The phone goes offline (a Wi-Fi blip)…
    first.close();
    // …and the daemon changes its answer before the client is back. The fake
    // source's listeners are the OLD connection's, which are being torn down,
    // so the new snapshot is visible only through the re-issued request.
    fake.push(snapshot(2, [daemon({ cwd: "/work/offline" })]));
    for (let i = 0; i < 200 && channels.length < 2; i++) await tick();
    expect(channels.length).toBeGreaterThan(1);
    for (let i = 0; i < 200 && seen.length === 0; i++) await tick();
    // The listener learned about the change made while it was offline.
    expect(seen.map((s) => s.rev)).toEqual([2]);
    client.close();
  });

  test("a RESYNC that changes nothing does not wake the listener (no spurious redraw)", async () => {
    const fake = fakeSource(snapshot(1, [daemon({ self: true })]));
    const host = hostWith(fake.source);
    const channels: DuplexChannel[] = [];
    const makeChannel = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      channels.push(c);
      return c;
    };
    const first = makeChannel();
    const client = new RemoteClient(first, new PermissionBroker(), undefined, {
      channelFactory: async () => makeChannel(),
      random: () => 0,
    });
    await client.initialize();
    const seen: DaemonDiscovery[] = [];
    await client.discover((s) => seen.push(s));
    first.close();
    for (let i = 0; i < 200 && channels.length < 2; i++) await tick();
    expect(channels.length).toBeGreaterThan(1);
    await tick();
    await tick();
    expect(seen).toEqual([]);
    client.close();
  });

  test("AFTER A RECONNECT a later change still reaches the listener (mutation: no re-subscribe)", async () => {
    const fake = fakeSource(snapshot(1, [daemon({ self: true })]));
    const host = hostWith(fake.source);
    // Two channels for the same daemon: the factory hands out a fresh one after
    // a drop, exactly as a reconnecting client does.
    const channels: DuplexChannel[] = [];
    const makeChannel = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      channels.push(c);
      return c;
    };
    const first = makeChannel();
    const client = new RemoteClient(first, new PermissionBroker(), undefined, {
      channelFactory: async () => makeChannel(),
      // Retry at once, as `connect`'s own reattach test does (`random: () => 0`).
      random: () => 0,
    });
    await client.initialize();
    const seen: number[] = [];
    await client.discover((s) => seen.push(s.rev));
    // Drop the link: the client re-dials and re-handshakes.
    first.close();
    for (let i = 0; i < 200 && channels.length < 2; i++) await tick();
    expect(channels.length).toBeGreaterThan(1);
    // The subscription is PER CONNECTION, so the daemon must have been asked
    // again on the new one: a change after the reconnect must arrive.
    fake.push(snapshot(2, [daemon({ cwd: "/work/b" })]));
    await tick();
    expect(seen).toContain(2);
    client.close();
  });
});

describe("MethodNotFound is the additive contract", () => {
  test("an older daemon's MethodNotFound → `undefined`, not a throw", async () => {
    // A raw daemon: answers initialize, refuses daemon/discover.
    const [d, c] = createChannelPair();
    d.setOnMessage((data) => {
      const frame = JSON.parse(data) as { id?: number; method?: string };
      if (frame.id === undefined) return;
      const body =
        frame.method === "initialize"
          ? {
              result: {
                protocolVersion: PROTOCOL_VERSION,
                agentCapabilities: { tools: true, permissions: true },
              },
            }
          : { error: { code: JsonRpcErrorCode.MethodNotFound, message: "unexpected method" } };
      d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
    });
    d.setOnClose(() => {});
    const client = new RemoteClient(c, new PermissionBroker());
    expect(await client.discover(() => {})).toBeUndefined();
    client.close();
  });

  test("isMethodNotFound: a plain error is NOT swallowed", async () => {
    const [d, c] = createChannelPair();
    d.setOnMessage((data) => {
      const frame = JSON.parse(data) as { id?: number; method?: string };
      if (frame.id === undefined) return;
      const body =
        frame.method === "initialize"
          ? {
              result: {
                protocolVersion: PROTOCOL_VERSION,
                agentCapabilities: { tools: true, permissions: true },
              },
            }
          : { error: { code: JsonRpcErrorCode.InternalError, message: "boom" } };
      d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
    });
    d.setOnClose(() => {});
    const client = new RemoteClient(c, new PermissionBroker());
    await expect(client.discover(() => {})).rejects.toBeInstanceOf(RpcError);
    client.close();
  });
});

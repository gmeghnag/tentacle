/**
 * `daemon/discover` on the connection (docs/feat/sibling-discovery.md).
 *
 * The additive property is the point: a connection that never called
 * `daemon/discover` receives ZERO `daemon/discovery` frames (an unsolicited
 * notification reaches an older client's `onError`, so sending it would not be
 * additive). Mutation: broadcast to every connection → that test fails.
 *
 * The rest pins the design's listed failure modes: subscribe BEFORE the
 * snapshot (F12 — no change may fall between the two), one subscription per
 * connection however many calls (F13), unsubscribe on `close()` (F11 — a
 * listener count of zero), `MethodNotFound` with no source (F9: a pod daemon),
 * and dispatch concurrency (AGENTS §7: a pending `session/prompt` must not delay
 * the discovery result).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  type DaemonDiscovery,
  DomainErrorCode,
  JsonRpcErrorCode,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import type { PairHandler } from "../src/pairing-handler.ts";
import { type DiscoverySource, SessionHost } from "../src/session-host.ts";

/** A source a test drives by hand. */
function fakeSource(initial: DaemonDiscovery) {
  let current = initial;
  const listeners = new Set<(d: DaemonDiscovery) => void>();
  const source: DiscoverySource = {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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

const snapshot = (rev: number, port: number): DaemonDiscovery => ({
  rev,
  daemons: [{ cwd: "/work/a", addresses: [`ws://10.0.0.5:${port}/e2e`], startedAt: 1, self: true }],
});

const hostWith = (source?: DiscoverySource): SessionHost =>
  new SessionHost({
    defaultCwd: "/tmp/discovery",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(source ? { discovery: source } : {}),
  });

/** A connected client whose inbound notifications are collected. */
async function connected(host: SessionHost) {
  const [d, c] = createChannelPair();
  const daemon = new Connection(d, host);
  const received: DaemonDiscovery[] = [];
  const client = new RpcPeer(c, {
    onNotification: (method, params) => {
      if (method === "daemon/discovery") received.push(params as DaemonDiscovery);
    },
    onRequest: async (method) => {
      throw new Error(`unexpected request ${method}`);
    },
  });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  return { client, received, channel: c, daemon };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("daemon/discover", () => {
  test("no source (a pod daemon) → MethodNotFound (F9)", async () => {
    const { client } = await connected(hostWith());
    let code: number | undefined;
    try {
      await client.request("daemon/discover", {});
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  test("result = the source's snapshot", async () => {
    const { source } = fakeSource(snapshot(1, 4000));
    const { client } = await connected(hostWith(source));
    const result = (await client.request("daemon/discover", {})) as DaemonDiscovery;
    expect(result).toEqual(snapshot(1, 4000));
  });

  test("a change reaches the subscriber as ONE daemon/discovery frame", async () => {
    const fake = fakeSource(snapshot(1, 4000));
    const { client, received } = await connected(hostWith(fake.source));
    await client.request("daemon/discover", {});
    fake.push(snapshot(2, 4001));
    await tick();
    expect(received).toEqual([snapshot(2, 4001)]);
  });

  test("a connection that never asked gets ZERO frames (the additivity property)", async () => {
    const fake = fakeSource(snapshot(1, 4000));
    const host = hostWith(fake.source);
    const subscriber = await connected(host);
    await subscriber.client.request("daemon/discover", {});
    // A second connection on the SAME host, which only initialises.
    const bystander = await connected(host);
    fake.push(snapshot(2, 4001));
    await tick();
    expect(subscriber.received).toEqual([snapshot(2, 4001)]);
    expect(bystander.received).toEqual([]);
  });

  test("subscribe happens BEFORE the snapshot: a change inside subscribe is not lost (F12)", async () => {
    // A source that CHANGES while being subscribed. The naive order (snapshot,
    // then subscribe) returns the OLD state here — and a client whose only copy
    // is that answer loses the change; the correct order returns the new state.
    const listeners = new Set<(d: DaemonDiscovery) => void>();
    let current = snapshot(1, 4000);
    const raced: DaemonDiscovery = snapshot(2, 4001);
    const source: DiscoverySource = {
      current: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        current = raced;
        for (const l of [...listeners]) l(raced);
        return () => listeners.delete(listener);
      },
    };
    const { client, received } = await connected(hostWith(source));
    const result = (await client.request("daemon/discover", {})) as DaemonDiscovery;
    await tick();
    // The RESULT is the state after the change (mutation: reverse the two
    // statements in `discover()` → rev 1, this fails), and the notification for
    // it also arrived.
    expect(result).toEqual(raced);
    expect(received).toEqual([raced]);
  });

  test("a second discover replaces the first subscription, never doubles it (F13)", async () => {
    const fake = fakeSource(snapshot(1, 4000));
    const { client, received } = await connected(hostWith(fake.source));
    await client.request("daemon/discover", {});
    await client.request("daemon/discover", {});
    expect(fake.listeners.size).toBe(1);
    fake.push(snapshot(2, 4001));
    await tick();
    expect(received).toHaveLength(1);
  });

  test("close() leaves zero listeners (F11: no leak)", async () => {
    const fake = fakeSource(snapshot(1, 4000));
    const host = hostWith(fake.source);
    const { client, daemon } = await connected(host);
    await client.request("daemon/discover", {});
    expect(fake.listeners.size).toBe(1);
    daemon.close();
    await tick();
    expect(fake.listeners.size).toBe(0);
  });

  test("a pending long prompt does not delay the discovery result (AGENTS §7)", async () => {
    const gate = Promise.withResolvers<void>();
    class Gated implements ModelProvider {
      readonly id = "gated";
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        await gate.promise;
        yield { type: "text", delta: "ok" };
        yield { type: "done" };
      }
    }
    const env: ExecutionEnvironment = {
      id: "noop",
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {},
    };
    const { source } = fakeSource(snapshot(1, 4000));
    const host = new SessionHost({
      defaultCwd: "/tmp/discovery-concurrent",
      createAgent: () => ({
        agent: new Agent({ model: new Gated(), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
      discovery: source,
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RpcPeer(c, { onNotification: () => {}, onRequest: async () => ({}) });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await client.request("session/open", { sessionId: "S", create: true });
    const prompt = client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await tick();
    // The turn is gated; this must still settle on its own.
    const result = (await client.request("daemon/discover", {})) as DaemonDiscovery;
    expect(result.daemons[0]?.self).toBe(true);
    gate.resolve();
    await prompt;
  });

  test("a notification for a change after the connection closed is harmless (P4)", async () => {
    const fake = fakeSource(snapshot(1, 4000));
    const { client, daemon } = await connected(hostWith(fake.source));
    await client.request("daemon/discover", {});
    daemon.close();
    await tick();
    // The listener is gone, so nothing is sent; a push must not throw either way.
    expect(() => fake.push(snapshot(2, 4001))).not.toThrow();
  });
});

describe("the principal gate still applies (F18)", () => {
  test("a pairing connection cannot discover", async () => {
    const { source, listeners } = fakeSource(snapshot(1, 4000));
    const host = hostWith(source);
    const [d, c] = createChannelPair();
    // No new gate here: the connection's own principal gate refuses everything
    // but `device/pair` (F16, 9c), whatever the method.
    new Connection(d, host, undefined, {
      principal: { kind: "pairing", pair: {} as unknown as PairHandler },
    });
    const client = new RpcPeer(c, { onNotification: () => {}, onRequest: async () => ({}) });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    let code: number | undefined;
    try {
      await client.request("daemon/discover", {});
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.Unauthorized);
    // And it was never subscribed: a refused call leaves nothing behind.
    expect(listeners.size).toBe(0);
  });
});

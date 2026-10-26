/**
 * `daemon/session_ttl` (docs/feat/session-ttl-control.md) over real daemon
 * objects: the client's round trip, an older daemon / pod (MethodNotFound), a
 * daemon replying garbage, and a dropped link.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import {
  Connection,
  SessionHost,
  type SessionHostOptions,
  type SessionTtlControl,
} from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

function hostWith(sessionTtl?: SessionTtlControl): SessionHost {
  const options: SessionHostOptions = {
    defaultCwd: "/tmp/session-ttl-client",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(sessionTtl ? { sessionTtl } : {}),
  };
  return new SessionHost(options);
}

function control(initial: number | null): SessionTtlControl {
  let value = initial;
  return {
    get: () => value,
    set: (ms) => {
      value = ms;
    },
  };
}

function connected(host: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  return new RemoteClient(c, new PermissionBroker());
}

/** A raw daemon: answers `initialize`, then `reply()` to anything else. */
function rawDaemon(reply: () => Record<string, unknown>): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string };
    if (frame.id === undefined) {
      return;
    }
    const body =
      frame.method === "initialize"
        ? {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            },
          }
        : reply();
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

describe("RemoteClient.sessionTtl", () => {
  test("reads, sets and clears (never); the result says it is not persisted", async () => {
    const client = connected(hostWith(control(86_400_000)));
    await client.initialize();
    expect(await client.sessionTtl()).toEqual({ idleTtlMs: 86_400_000, persisted: false });
    expect(await client.sessionTtl(5000)).toEqual({ idleTtlMs: 5000, persisted: false });
    expect(await client.sessionTtl("never")).toEqual({ idleTtlMs: "never", persisted: false });
    // A read after `never` keeps it: `undefined` is a read, not a clear.
    expect(await client.sessionTtl()).toEqual({ idleTtlMs: "never", persisted: false });
    client.close();
  });

  test("an invalid value is rejected with InvalidParams by the daemon", async () => {
    const client = connected(hostWith(control(1000)));
    await client.initialize();
    const error = await client.sessionTtl(0).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.InvalidParams).toBe(true);
    expect((await client.sessionTtl()).idleTtlMs).toBe(1000);
    client.close();
  });

  test("a daemon with no reaper (pod, worker) rejects with MethodNotFound", async () => {
    const client = connected(hostWith());
    await client.initialize();
    const error = await client.sessionTtl().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    client.close();
  });

  test("an older daemon (no such method) rejects with MethodNotFound", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({ error: { code: JsonRpcErrorCode.MethodNotFound, message: "nope" } })),
      new PermissionBroker(),
    );
    await client.initialize();
    const error = await client.sessionTtl(5000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    client.close();
  });

  test("a result that breaks the contract is rejected (persisted: true, ttl 0); the honest one is accepted", async () => {
    const bad = new RemoteClient(
      rawDaemon(() => ({ result: { idleTtlMs: 0, persisted: true } })),
      new PermissionBroker(),
    );
    await bad.initialize();
    await expect(bad.sessionTtl()).rejects.toThrow();
    bad.close();
    const good = new RemoteClient(
      rawDaemon(() => ({ result: { idleTtlMs: "never", persisted: false } })),
      new PermissionBroker(),
    );
    await good.initialize();
    expect(await good.sessionTtl()).toEqual({ idleTtlMs: "never", persisted: false });
    good.close();
  });

  test("link down (reconnecting): rejects at once, nothing sent", async () => {
    const [d, c] = createChannelPair();
    new Connection(d, hostWith(control(1000)));
    const sent: string[] = [];
    const tapped: DuplexChannel = {
      send: (data) => {
        sent.push(data);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    const client = new RemoteClient(tapped, new PermissionBroker(), undefined, {
      channelFactory: () => new Promise<DuplexChannel>(() => {}),
    });
    await client.initialize();
    d.close();
    await Bun.sleep(5);
    const before = sent.length;
    await expect(client.sessionTtl(5000)).rejects.toThrow("not connected");
    expect(sent.length).toBe(before);
    client.close();
  });
});

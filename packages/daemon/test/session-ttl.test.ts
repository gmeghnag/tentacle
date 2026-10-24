/**
 * `daemon/session_ttl` (docs/feat/session-ttl-control.md) on a `SessionHost`
 * over a channel pair and a raw `RpcPeer`: read, set, never, invalid values,
 * and a host without the control (a pod, the worker) answering MethodNotFound.
 */
import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost, type SessionTtlControl } from "../src/session-host.ts";

function control(initial: number | null): SessionTtlControl & { sets: (number | null)[] } {
  let value = initial;
  const sets: (number | null)[] = [];
  return {
    sets,
    get: () => value,
    set: (ms) => {
      sets.push(ms);
      value = ms;
    },
  };
}

async function peerTo(sessionTtl?: SessionTtlControl): Promise<RpcPeer> {
  const host = new SessionHost({
    defaultCwd: "/tmp/session-ttl",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(sessionTtl ? { sessionTtl } : {}),
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const peer = new RpcPeer(c, {});
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  return peer;
}

const codeOf = async (promise: Promise<unknown>): Promise<number | null> =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof RpcError ? e.code : -1),
  );

describe("daemon/session_ttl", () => {
  test("{} reads; a number sets and reports the value in force; the word never is never — never persisted", async () => {
    // Mutation: the Connection falls through to `default` (no case) → -32005, not these results.
    const ttl = control(86_400_000);
    const peer = await peerTo(ttl);
    expect(await peer.request("daemon/session_ttl", {})).toEqual({
      idleTtlMs: 86_400_000,
      persisted: false,
    });
    expect(ttl.sets).toEqual([]);
    expect(await peer.request("daemon/session_ttl", { idleTtlMs: 5000 })).toEqual({
      idleTtlMs: 5000,
      persisted: false,
    });
    expect(await peer.request("daemon/session_ttl", { idleTtlMs: "never" })).toEqual({
      idleTtlMs: "never",
      persisted: false,
    });
    expect(ttl.sets).toEqual([5000, null]);
    // Reading after `never` does not change it back.
    expect(await peer.request("daemon/session_ttl", {})).toEqual({
      idleTtlMs: "never",
      persisted: false,
    });
  });

  test("an invalid value is InvalidParams and changes nothing", async () => {
    const ttl = control(1000);
    const peer = await peerTo(ttl);
    // `null` is not "never" on the wire: a client that meant to read and sent `v ?? null` fails loudly.
    for (const bad of [0, -1, 1.5, "5s", "Never", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await codeOf(peer.request("daemon/session_ttl", { idleTtlMs: bad }))).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    }
    expect(ttl.sets).toEqual([]);
    expect(ttl.get()).toBe(1000);
  });

  test("a host without the control (pod, worker) answers MethodNotFound", async () => {
    const peer = await peerTo();
    expect(await codeOf(peer.request("daemon/session_ttl", {}))).toBe(
      JsonRpcErrorCode.MethodNotFound,
    );
    expect(await codeOf(peer.request("daemon/session_ttl", { idleTtlMs: 5000 }))).toBe(
      JsonRpcErrorCode.MethodNotFound,
    );
  });
});

/**
 * `device/push_register` / `device/push_unregister` from the app
 * (docs/feat/mobile-push.md Design 7, slice P9).
 *
 * The methods are the SAME `RemoteClient` ← `Connection` stack as everything
 * else (AGENTS §7, one session path): the phone registers over Noise like it
 * asks for a session list, so no new transport, no second dial. What P9 needs
 * from the client is the two calls — `RemoteClient.call` is private, so a
 * method on the client is the only honest way to send them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  Method,
  PROTOCOL_VERSION,
  type PushEnvironment,
} from "@tentacle/protocol";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const TOKEN = "a".repeat(64);
const KEY = "k".repeat(43);
const PARAMS = { token: TOKEN, env: "sandbox" as PushEnvironment, key: KEY };

/**
 * A raw daemon: answers `initialize`, then records every `device/push_*` and
 * replies with `reply()` (a JSON-RPC `result` or `error` member). No daemon-side
 * schema, so a `MethodNotFound` is exactly what an older daemon sends.
 */
function rawDaemon(reply: (method: string) => Record<string, unknown>): {
  readonly channel: DuplexChannel;
  readonly seen: { method: string; params: unknown }[];
} {
  const [d, c] = createChannelPair();
  const seen: { method: string; params: unknown }[] = [];
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string; params?: unknown };
    if (frame.id === undefined || frame.method === undefined) {
      return;
    }
    seen.push({ method: frame.method, params: frame.params });
    const body =
      frame.method === "initialize"
        ? {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            },
          }
        : reply(frame.method);
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return { channel: c, seen };
}

function clientOn(channel: DuplexChannel): RemoteClient {
  return new RemoteClient(channel, new PermissionBroker());
}

describe("device/push_register from the app", () => {
  test("pushRegister sends the three params and resolves the daemon's status", async () => {
    const daemon = rawDaemon(() => ({ result: { graceSeconds: 30, push: "on" } }));
    const client = clientOn(daemon.channel);
    const result = await client.pushRegister(PARAMS);
    expect(result).toEqual({ graceSeconds: 30, push: "on" });
    const sent = daemon.seen.find((frame) => frame.method === "device/push_register");
    // The token, environment and key go verbatim: the daemon validates them, and
    // a client that "helpfully" reshaped one would register the wrong token.
    expect(sent?.params).toEqual(PARAMS);
  });

  test("an older daemon's MethodNotFound REJECTS (the caller shows `daemon too old`)", async () => {
    const daemon = rawDaemon(() => ({
      error: { code: JsonRpcErrorCode.MethodNotFound, message: "no such method" },
    }));
    const client = clientOn(daemon.channel);
    const failed = client.pushRegister(PARAMS).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: number }).code === JsonRpcErrorCode.MethodNotFound
          ? "method-not-found"
          : "other",
    );
    expect(await failed).toBe("method-not-found");
  });

  test("pushUnregister sends `device/push_unregister` with no params of its own", async () => {
    const daemon = rawDaemon(() => ({ result: {} }));
    const client = clientOn(daemon.channel);
    await client.pushUnregister();
    const sent = daemon.seen.find((frame) => frame.method === "device/push_unregister");
    expect(sent?.params).toEqual({});
  });
});

describe("the same two calls against a REAL daemon", () => {
  test("the route exists: a `token` principal is refused `Unauthorized` (P7's gate)", async () => {
    // The wire-level shape is pinned above; this is the one end no fake proves —
    // that the REAL `Connection` route exists and the method name is exact. A
    // token principal must be refused there (only a paired device registers).
    const host = new SessionHost({
      defaultCwd: "/tmp/push-register-client",
      createAgent: () => {
        throw new Error("no session in these tests");
      },
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = clientOn(c);
    // `initialize` first: a real `Connection` answers every method with
    // `NotInitialized` until the handshake, which is not what this test is about.
    await client.initialize();
    const outcome = await client.pushRegister(PARAMS).then(
      () => "accepted",
      (error: unknown) => `refused:${String((error as { code?: number }).code)}`,
    );
    // Not `MethodNotFound`: the daemon KNOWS this method, and refuses this SOCKET.
    expect(outcome).toBe(`refused:${DomainErrorCode.Unauthorized}`);
  });
});

/** `Method` names, checked as data: the client sends the protocol's own strings. */
test("the client uses the protocol's method names, not its own spelling", () => {
  const source = readFileSync(new URL("../src/remote-client.ts", import.meta.url), "utf8");
  expect(source).toContain("Method.DevicePushRegister");
  expect(source).toContain("Method.DevicePushUnregister");
  expect(Method.DevicePushRegister).toBe("device/push_register");
  expect(Method.DevicePushUnregister).toBe("device/push_unregister");
});

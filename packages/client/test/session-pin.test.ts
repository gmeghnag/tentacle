/**
 * `RemoteClient.pinSession` (docs/feat/mobile-session-actions.md S1): a set
 * by id over `session/pin`, and the list keeps the daemon's `pinned` fields;
 * an older daemon (no method) rejects "too old".
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const CWD = "/tmp/session-pin-client";

function host(): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    createAgent: () => ({
      agent: new Agent({
        model: {
          id: "m",
          async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
            yield { type: "done" };
          },
        },
        tools: new ToolRegistry(),
        env: {} as ExecutionEnvironment,
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

function connected(daemon: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, daemon);
  return new RemoteClient(c, new PermissionBroker());
}

/** A daemon that knows `initialize` only: every other method is MethodNotFound. */
function oldDaemon(): DuplexChannel {
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
        : { error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" } };
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

describe("client pin", () => {
  test("pinSession sets by id (no open); the list carries the entry flag and the first-page array", async () => {
    const daemon = host();
    daemon.open({ sessionId: "S", create: true }, { send: () => {} });
    const client = connected(daemon);
    await client.initialize();
    expect(await client.pinSession("S", true)).toBe(true);
    const page = await client.sessionList();
    expect(page.sessions[0]?.pinned).toBe(true);
    expect(page.pinned?.map((s) => s.sessionId)).toEqual(["S"]);
    expect(await client.pinSession("S", false)).toBe(false);
    const after = await client.sessionList();
    expect(after.sessions[0]?.pinned).toBeUndefined();
    expect(after.pinned).toBeUndefined();
    client.close();
  });

  test("an older daemon → MethodNotFound with 'too old to pin sessions'", async () => {
    const client = new RemoteClient(oldDaemon(), new PermissionBroker());
    await client.initialize();
    const error = await client.pinSession("S", true).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(error instanceof Error && error.message).toMatch(/too old to pin sessions/);
    client.close();
  });
});

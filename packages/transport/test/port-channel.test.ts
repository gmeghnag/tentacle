import { describe, expect, test } from "bun:test";
import { RpcPeer } from "../src/peer.ts";
import { type MessageEndpoint, messagePortChannel } from "../src/port-channel.ts";

const INIT_PARAMS = { protocolVersion: 1, clientCapabilities: { streaming: true } };
const INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { tools: true, permissions: true },
  skills: [],
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
// A runtime MessagePort satisfies MessageEndpoint (addEventListener/start/close);
// Bun's MessagePort *type* omits addEventListener, so cast at the boundary.
const ep = (port: unknown): MessageEndpoint => port as MessageEndpoint;

describe("messagePortChannel", () => {
  test("delivers string frames across a MessageChannel", async () => {
    const { port1, port2 } = new MessageChannel();
    const a = messagePortChannel(ep(port1));
    const b = messagePortChannel(ep(port2));
    const got: string[] = [];
    b.setOnMessage((d) => got.push(d));
    a.send("hello");
    await tick();
    expect(got).toEqual(["hello"]);
    a.close();
    b.close();
  });

  test("ignores non-string messages (only RpcPeer frames flow)", async () => {
    const { port1, port2 } = new MessageChannel();
    const a = messagePortChannel(ep(port1));
    const b = messagePortChannel(ep(port2));
    const got: string[] = [];
    b.setOnMessage((d) => got.push(d));
    (port1 as unknown as { postMessage(x: unknown): void }).postMessage({ not: "a string" });
    a.send("ok");
    await tick();
    expect(got).toEqual(["ok"]);
    a.close();
    b.close();
  });

  test("carries a full RpcPeer request/response round-trip", async () => {
    const { port1, port2 } = new MessageChannel();
    const server = new RpcPeer(messagePortChannel(ep(port1)), {
      onRequest: async (method) => {
        expect(method).toBe("initialize");
        return INIT_RESULT;
      },
    });
    const client = new RpcPeer(messagePortChannel(ep(port2)));
    const result = await client.request("initialize", INIT_PARAMS);
    expect(result).toEqual(INIT_RESULT);
    server.close();
    client.close();
  });

  test("close() fires onClose once and stops further delivery", async () => {
    const { port1, port2 } = new MessageChannel();
    const a = messagePortChannel(ep(port1));
    const b = messagePortChannel(ep(port2));
    let closes = 0;
    b.setOnClose(() => closes++);
    const got: string[] = [];
    b.setOnMessage((d) => got.push(d));
    b.close();
    b.close(); // idempotent
    a.send("after-close");
    await tick();
    expect(closes).toBe(1);
    expect(got).toEqual([]);
    a.close();
  });
});

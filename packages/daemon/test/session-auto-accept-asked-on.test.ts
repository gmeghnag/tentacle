/**
 * docs/feat/session-auto-accept.md T6 / D7: "also asked on <computer>".
 * `ClientInfo.host` is sent ONLY to a daemon the client trusts; the daemon
 * stamps each ask's `askedOn` with the labels of the attachments it was raised
 * to; the phone drops one copy of its own label. Each test names its mutation.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  ClientInfoSchema,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  PermissionRequestUpdateSchema,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };

class Quiet implements ModelProvider {
  readonly id = "quiet";
  constructor(private readonly callTool: boolean) {}
  async *stream(): AsyncIterable<StreamEvent> {
    if (this.callTool) {
      yield {
        type: "tool_call",
        toolCall: { id: "c1", name: "run", arguments: JSON.stringify({}) },
      };
    }
    yield { type: "done" };
  }
}

const env = {} as ExecutionEnvironment;

/** A daemon whose one tool asks for permission, so an ask is raised on a prompt. */
function daemon() {
  const host = new SessionHost({
    defaultCwd: "/tmp/session-auto-accept-askedon",
    sharedAutoAccept: true,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const run = {
        name: "run",
        description: "run",
        inputSchema: z.object({}).passthrough(),
        permission: "ask" as const,
        execute: async () => ({ content: "ok" }),
      };
      const agent = new Agent({
        model: new Quiet(true),
        tools: new ToolRegistry().register(run),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const connect = async (clientInfo?: { name: string; version: string; host?: string }) => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      ...INIT,
      ...(clientInfo ? { clientInfo } : {}),
    });
    const asks = () =>
      updates
        .map((u) => u.update)
        .filter((u): u is PermissionRequestUpdate => u.type === "permission_request");
    return { client, updates, asks };
  };
  return { host, connect };
}

const flush = async (rounds = 60): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe("T6: whose ask is it — ClientInfo.host and askedOn", () => {
  test("the schema takes a bounded host and strips an unknown extra field", () => {
    expect(ClientInfoSchema.parse({ name: "tentacle", version: "1.0.0", host: "laptop" })).toEqual({
      name: "tentacle",
      version: "1.0.0",
      host: "laptop",
    });
    expect(ClientInfoSchema.parse({ name: "tentacle", version: "1.0.0" })).toEqual({
      name: "tentacle",
      version: "1.0.0",
    });
    // Bounded: the wire field is 64 characters.
    expect(
      ClientInfoSchema.safeParse({ name: "tentacle", version: "1.0.0", host: "x".repeat(65) })
        .success,
    ).toBe(false);
    expect(
      ClientInfoSchema.safeParse({ name: "tentacle", version: "1.0.0", host: "" }).success,
    ).toBe(false);
  });

  test("askedOn lists the attachments that declared a host, the same list for every recipient", async () => {
    // Mutation: read the RAISING connection's host instead of every attachment →
    // the second device's label is missing from the other one's list.
    const d = daemon();
    const laptop = await d.connect({ name: "tentacle", version: "1.0.0", host: "laptop" });
    const phone = await d.connect({ name: "tentacle", version: "1.0.0", host: "iPhone" });
    await laptop.client.request("session/open", { sessionId: "S", create: true });
    await phone.client.request("session/open", { sessionId: "S" });
    await laptop.client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await flush();
    const [laptopAsk] = laptop.asks();
    const [phoneAsk] = phone.asks();
    if (!laptopAsk || !phoneAsk) throw new Error("no ask");
    expect(laptopAsk.askedOn).toEqual(["laptop", "iPhone"]);
    expect(phoneAsk.askedOn).toEqual(["laptop", "iPhone"]);
    // The field is optional on the wire: an ask without one still parses.
    const { askedOn, ...bare } = laptopAsk;
    expect(askedOn).toBeDefined();
    expect(PermissionRequestUpdateSchema.safeParse(bare).success).toBe(true);
  });

  test("a client that declares NO host contributes nothing (a pod-side client never sends one)", async () => {
    // Mutation: default `host` to something → this list gains a phantom entry.
    const d = daemon();
    const silent = await d.connect({ name: "tentacle", version: "1.0.0" });
    await silent.client.request("session/open", { sessionId: "S", create: true });
    await silent.client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await flush();
    const [ask] = silent.asks();
    if (!ask) throw new Error("no ask");
    expect(ask.askedOn).toBeUndefined();
  });

  test("an older client that cannot show an ask is not a sibling it was raised to", async () => {
    const d = daemon();
    const laptop = await d.connect({ name: "tentacle", version: "1.0.0", host: "laptop" });
    // Declares a host but NO `permission_request`: it would take the fallback.
    const [dc, cc] = createChannelPair();
    new Connection(dc, d.host);
    const old = new RpcPeer(cc, {
      onRequest: async () => {
        throw new Error("no requests");
      },
    });
    await old.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, updates: ["turn_start"] },
      clientInfo: { name: "tentacle", version: "1.0.0", host: "old-laptop" },
    });
    await old.request("session/open", { sessionId: "S", create: true });
    await laptop.client.request("session/open", { sessionId: "S" });
    await laptop.client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await flush();
    const [ask] = laptop.asks();
    if (!ask) throw new Error("no ask");
    expect(ask.askedOn).toEqual(["laptop"]);
  });

  test("the auto_accept update's `by` prefers the declared host over the client name", async () => {
    const d = daemon();
    const laptop = await d.connect({ name: "tentacle", version: "1.0.0", host: "laptop" });
    await laptop.client.request("session/open", { sessionId: "S", create: true });
    await laptop.client.request("session/set_auto_accept", { sessionId: "S", on: true });
    const by = laptop.updates
      .map((u) => u.update)
      .filter((u) => u.type === "auto_accept")
      .map((u) => (u as { by?: string }).by);
    expect(by).toEqual(["laptop"]);
  });
});

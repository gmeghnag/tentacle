import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionUpdate,
  SetAutoAcceptResultSchema,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

// Auto-accept as the SESSION's state (docs/feat/session-auto-accept.md): the
// daemon holds it, broadcasts it to every attachment, seeds a created session
// and `serve` keeps it in its sidecar. Each test names the mutation that turns
// it red (AGENTS §9).

const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { streaming: true },
  clientInfo: { name: "tentacle", version: "1.0.0" },
};

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  }
}

const env = {} as ExecutionEnvironment;

/** A daemon with a `sharedAutoAccept` host (the worker / a trusted `serve`). */
function daemon(shared = true) {
  const host = new SessionHost({
    defaultCwd: "/tmp/session-auto-accept",
    ...(shared ? { sharedAutoAccept: true } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: new Quiet(),
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const connect = async (name = "tentacle") => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host);
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
      clientInfo: { name, version: "1.0.0" },
    });
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const set = (sessionId: string, on: boolean) =>
      client.request("session/set_auto_accept", { sessionId, on }) as Promise<unknown>;
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    return { connection, client, updates, open, set, of };
  };
  return { host, connect };
}

/** The `auto_accept` updates as `{ on, by }`, dropping the common `type`. */
const values = (
  updates: readonly { on: boolean; by?: string }[],
): Array<{ on: boolean; by?: string }> =>
  updates.map(({ on, by }) => ({ on, ...(by ? { by } : {}) }));

describe("session/set_auto_accept is the session's", () => {
  test("T2a one client sets it ON: every attachment gets the update, in order", async () => {
    // Mutation: drop the `emit` in `setAutoAccept` → both `of(...)` lists are empty.
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect("phone");
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });

    expect(SetAutoAcceptResultSchema.parse(await a.set("S", true))).toEqual({ on: true });
    expect(values(a.of("auto_accept"))).toEqual([{ on: true, by: "tentacle" }]);
    // The other attachment too: it is the SESSION's, not the setter's.
    expect(values(b.of("auto_accept"))).toEqual([{ on: true, by: "tentacle" }]);
  });

  test("T2b a third client attaching reads the snapshot in OpenResult", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.set("S", true);

    const c = await d.connect();
    expect((await c.open({ sessionId: "S" })).autoAccept).toBe(true);
    // A daemon that does not share it (a pod) never says: absent, not false.
    const pod = daemon(false);
    const p = await pod.connect();
    expect((await p.open({ sessionId: "S", create: true })).autoAccept).toBeUndefined();
    expect(await p.set("S", true)).toEqual({ on: true });
    expect((await p.open({ sessionId: "S" })).autoAccept).toBeUndefined();
  });

  test("T2c interleaved sets: one order, the last value wins, own echoes included", async () => {
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect("phone");
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });

    await a.set("S", true);
    await b.set("S", false);
    await a.set("S", true);
    const by = [{ on: true }, { on: false }, { on: true }];
    expect(values(a.of("auto_accept")).map(({ on }) => ({ on }))).toEqual(by);
    expect(values(b.of("auto_accept")).map(({ on }) => ({ on }))).toEqual(by);
    const fresh = await d.connect();
    expect((await fresh.open({ sessionId: "S" })).autoAccept).toBe(true);
  });

  test("T2d a set to the value it already has emits nothing and still answers", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    expect(await a.set("S", false)).toEqual({ on: false });
    expect(a.of("auto_accept")).toEqual([]);
    await a.set("S", true);
    await a.set("S", true);
    expect(a.of("auto_accept")).toHaveLength(1);
    expect(await a.set("S", true)).toEqual({ on: true });
  });

  test("T2e OpenParams.autoAccept seeds a CREATED session only", async () => {
    const d = daemon();
    const a = await d.connect();
    expect((await a.open({ sessionId: "S", create: true, autoAccept: true })).autoAccept).toBe(
      true,
    );
    // An ATTACH ignores it, exactly like `settings`.
    const b = await d.connect();
    await b.open({ sessionId: "S", autoAccept: false });
    expect(d.host.get("S")?.autoAccept).toBe(true);
    const fresh = await d.connect();
    expect((await fresh.open({ sessionId: "S" })).autoAccept).toBe(true);
  });

  test("T2f the setter's label comes from its initialize, never from the call", async () => {
    const d = daemon();
    const a = await d.connect("phone");
    await a.open({ sessionId: "S", create: true });
    // An extra param is stripped by the schema: the daemon stamps its own label.
    await a.client.request("session/set_auto_accept", { sessionId: "S", on: true, by: "a-pod" });
    expect(values(a.of("auto_accept"))).toEqual([{ on: true, by: "phone" }]);
  });

  test("T2g an unknown session is UnknownSession; `on` is a boolean", async () => {
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await expect(a.set("other", true)).rejects.toThrow();
    await expect(
      a.client.request("session/set_auto_accept", { sessionId: "S", on: "on" }),
    ).rejects.toThrow();
  });
});

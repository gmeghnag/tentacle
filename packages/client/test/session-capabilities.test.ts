import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
import type { RemoteSession } from "../src/remote-session.ts";

// The client half of `session/set_capability` (docs/feat/session-capabilities.md
// S3a): a RemoteSession adopts the daemon's snapshot at open, follows every
// change (own echoes and another client's, with `by`), and an older daemon's
// `MethodNotFound` clears the state so a surface hides its toggles (F7).

function daemon() {
  const host = new SessionHost({
    defaultCwd: "/tmp/session-capabilities-client",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: {
          id: "quiet",
          async *stream() {
            yield { type: "done" as const };
          },
        },
        tools: new ToolRegistry(),
        env: {} as ExecutionEnvironment,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const client = async (name: string) => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const rc = new RemoteClient(c, new PermissionBroker(), undefined, {
      clientInfo: { name, version: "1" },
    });
    await rc.initialize();
    return rc;
  };
  return { client };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

type Seen = { state: unknown; by?: string };
const follow = (session: RemoteSession): Seen[] => {
  const seen: Seen[] = [];
  session.onCapabilities((state, by) => {
    seen.push({ state, ...(by ? { by } : {}) });
  });
  return seen;
};

describe("RemoteSession capabilities", () => {
  test("snapshot at open; A's toggle reaches B with `by`; both converge on the echo", async () => {
    // Mutations: drop `noteCapabilities` in `applyOpenResult` → `capabilities()`
    // stays undefined after open; drop the `capabilities` branch of the update
    // dispatch → B never sees A's change.
    const d = daemon();
    const ca = await d.client("laptop");
    const cb = await d.client("phone");
    const a = ca.newSession(undefined, "S");
    const seenA = follow(a);
    await a.openSeeded();
    expect(a.capabilities()).toEqual({ disabledMcp: [], disabledSkills: [] });
    const b = cb.newSession(undefined, "S", undefined, { attach: {} });
    const seenB = follow(b);
    await b.open();
    expect(b.capabilities()).toEqual({ disabledMcp: [], disabledSkills: [] });

    const after = await a.setCapability("mcp", "echo", false);
    const off = { disabledMcp: ["echo"], disabledSkills: [] };
    expect(after).toEqual(off);
    expect(await waitFor(() => seenB.length === 2)).toBe(true);
    expect(seenB.at(-1)).toEqual({ state: off, by: "laptop" });
    expect(b.capabilities()).toEqual(off);
    // The setter's own echo too: its state comes from the daemon, not the answer.
    expect(await waitFor(() => seenA.length === 2)).toBe(true);
    expect(seenA.at(-1)).toEqual({ state: off, by: "laptop" });
    expect(a.capabilities()).toEqual(off);

    // A re-attach reads the snapshot (F5).
    const cc = await d.client("tablet");
    const c = cc.newSession(undefined, "S", undefined, { attach: {} });
    await c.open();
    expect(c.capabilities()).toEqual(off);
  });

  test("F7: an older daemon's MethodNotFound rejects AND clears the state (toggles hide)", async () => {
    // Mutation: drop the MethodNotFound branch in `setCapability` → `capabilities()`
    // keeps the stale snapshot.
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          // A snapshot so the state is defined before the refusal clears it.
          return {
            sessionId: "s1",
            epoch: "e",
            created: true,
            resync: false,
            capabilities: { disabledMcp: [], disabledSkills: [] },
          };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
      },
    });
    const rc = new RemoteClient(clientCh, new PermissionBroker());
    await rc.initialize();
    const session = rc.newSession(undefined, "s1");
    const seen = follow(session);
    await session.openSeeded();
    expect(session.capabilities()).toEqual({ disabledMcp: [], disabledSkills: [] });

    const err = await session.setCapability("skill", "k8s", false).catch((e: unknown) => e);
    expect(err instanceof RpcError && err.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    expect(session.capabilities()).toBeUndefined();
    expect(seen.at(-1)).toEqual({ state: undefined });
  });

  test("an older daemon's OpenResult without `capabilities` leaves the state undefined", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const rc = new RemoteClient(clientCh, new PermissionBroker());
    await rc.initialize();
    const session = rc.newSession(undefined, "s1");
    const seen = follow(session);
    await session.openSeeded();
    expect(session.capabilities()).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("a set before the session is open rejects without a call", async () => {
    const d = daemon();
    const rc = await d.client("laptop");
    const session = rc.newSession(undefined, "S");
    const err = await session.setCapability("mcp", "echo", false).catch((e: unknown) => e);
    expect(err instanceof Error && /not open/.test(err.message)).toBe(true);
  });
});

// Slice S3b: the switches a client carries into a session it (re)creates.
describe("the client carries the switches into a session it creates", () => {
  const OFF = { disabledMcp: ["echo"], disabledSkills: [] };
  const quietHost = () =>
    new SessionHost({
      defaultCwd: "/tmp/session-capabilities-client",
      createAgent: () => ({
        agent: new Agent({
          model: {
            id: "quiet",
            async *stream() {
              yield { type: "done" as const };
            },
          },
          tools: new ToolRegistry(),
          env: {} as ExecutionEnvironment,
        }),
        permissions: new PermissionBroker(),
      }),
    });
  const drain = async (gen: AsyncIterable<unknown>) => {
    for await (const _ of gen) {
      // consume
    }
  };

  test("R1 a daemon that lost the session (a worker restart) recreates it WITH its switches", async () => {
    // Mutation: drop `capabilities` from `recreate`'s open → the new daemon has everything on.
    let host = quietHost();
    let last: ReturnType<typeof createChannelPair>[1] | null = null;
    const dial = () => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      last = c;
      return c;
    };
    const rc = new RemoteClient(dial(), new PermissionBroker(), undefined, {
      channelFactory: async () => dial(),
      random: () => 0,
    });
    await rc.initialize();
    const session = rc.newSession(undefined, "S");
    await drain(session.send("first"));
    await session.setCapability("mcp", "echo", false);
    expect(session.capabilities()).toEqual(OFF);
    // A new daemon that never heard of S: the client recreates S from its copy.
    host = quietHost();
    (last as { close(): void } | null)?.close();
    expect(await waitFor(() => host.get("S") !== undefined)).toBe(true);
    expect(host.get("S")?.capabilities()).toEqual(OFF);
    rc.close();
  });

  test("R2 a resumed record's switches seed the create; a one-shot seed is consumed once", async () => {
    // Mutation: `takeSeedCapabilities` does not clear → the second new session is seeded too.
    const d = daemon();
    const rc = await d.client("laptop");
    const resumed = rc.newSession([{ role: "user", content: "q" }], "R", undefined, {
      capabilities: OFF,
    });
    await resumed.openSeeded();
    expect(resumed.capabilities()).toEqual(OFF);

    resumed.seedCapabilities();
    const next = rc.newSession(undefined, "N1");
    await next.openSeeded();
    expect(next.capabilities()).toEqual(OFF);
    const after = rc.newSession(undefined, "N2");
    await after.openSeeded();
    expect(after.capabilities()).toEqual({ disabledMcp: [], disabledSkills: [] });
  });
});

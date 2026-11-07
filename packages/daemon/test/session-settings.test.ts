/**
 * `session/open.settings` on the daemon side (docs/feat/config-carry.md): the
 * daemon is an opaque carrier. It hands them to the factory of a session this
 * open CREATES, and to the "a session created now" reads; a live id ignores them.
 */
import { describe, expect, test } from "bun:test";
import { Agent, EMPTY_SKILL_LISTING } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import type { OpenResult, SessionSettings } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type AgentContext, SessionHost } from "../src/session-host.ts";

const noopEnv = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

const model: ModelProvider = {
  id: "m",
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("must not generate");
  },
};

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };

function setup() {
  const contexts: AgentContext[] = [];
  const skillAsks: (SessionSettings | undefined)[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/w",
    newSessionSkills: async (settings) => {
      skillAsks.push(settings);
      return EMPTY_SKILL_LISTING;
    },
    createAgent: (_cwd, context) => {
      contexts.push(context);
      return {
        agent: new Agent({ model, tools: new ToolRegistry(), env: noopEnv }),
        permissions: new PermissionBroker(),
        ...(context.settings
          ? { settingsReport: { carried: context.settings, overridden: { dedupOutput: true } } }
          : {}),
      };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const client = new RpcPeer(clientCh, {});
  return { contexts, skillAsks, host, connection, client };
}

const open = async (client: RpcPeer, params: unknown) =>
  (await client.request("session/open", params)) as OpenResult;

describe("session/open.settings: an opaque carrier (docs/feat/config-carry.md)", () => {
  test("a created session: the factory gets them, and the result reports what it did", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    const opened = await open(client, {
      sessionId: "a",
      create: true,
      settings: { maxIterations: 7 },
    });
    expect(contexts.map((c) => c.settings)).toEqual([{ maxIterations: 7 }]);
    expect(opened.settings).toEqual({
      carried: { maxIterations: 7 },
      overridden: { dedupOutput: true },
    });
    connection.close();
  });

  test("a live id ignores them: one agent, the first values stand, and the report is the first one", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    await open(client, { sessionId: "a", create: true, settings: { maxIterations: 7 } });
    const again = await open(client, {
      sessionId: "a",
      create: true,
      settings: { maxIterations: 99 },
    });
    expect(again.created).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.settings).toEqual({ maxIterations: 7 });
    expect(again.settings?.carried).toEqual({ maxIterations: 7 });
    connection.close();
  });

  test("a recreate from messages is a create: its settings count", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    await open(client, {
      sessionId: "a",
      messages: [{ role: "user", content: "hi" }],
      settings: { maxIterations: 3 },
    });
    expect(contexts[0]?.settings).toEqual({ maxIterations: 3 });
    connection.close();
  });

  test("two sessions of one host get their own settings", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    await open(client, { sessionId: "a", create: true, settings: { maxIterations: 1 } });
    await open(client, { sessionId: "b", create: true, settings: { maxIterations: 2 } });
    expect(contexts.map((c) => c.settings?.maxIterations)).toEqual([1, 2]);
    connection.close();
  });

  test("no settings: the factory sees none, the result carries no report", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    const opened = await open(client, { sessionId: "a", create: true });
    expect(contexts[0]?.settings).toBeUndefined();
    expect(opened.settings).toBeUndefined();
    connection.close();
  });

  test("session/context with no id builds the probe from them; with an id it ignores them", async () => {
    const { contexts, client, connection } = setup();
    await client.request("initialize", INIT);
    await client.request("session/context", { settings: { maxIterations: 5 } });
    expect(contexts.map((c) => c.settings)).toEqual([{ maxIterations: 5 }]);
    await open(client, { sessionId: "a", create: true, settings: { maxIterations: 6 } });
    await client.request("session/context", {
      sessionId: "a",
      settings: { maxIterations: 8 },
    });
    expect(contexts.map((c) => c.settings)).toEqual([{ maxIterations: 5 }, { maxIterations: 6 }]);
    connection.close();
  });

  test("a v15 client against this daemon fails at initialize, never mid-session", async () => {
    // A v15 laptop relies on argv flags this daemon no longer has, and a v15 daemon
    // would strip `settings`: the bump is what makes both loud.
    const { client, connection, contexts } = setup();
    await expect(client.request("initialize", { ...INIT, protocolVersion: 15 })).rejects.toThrow(
      /protocol/i,
    );
    expect(contexts).toHaveLength(0);
    expect(PROTOCOL_VERSION).toBe(17);
    connection.close();
  });

  test("session/skills with no id passes them on", async () => {
    const { skillAsks, client, connection } = setup();
    await client.request("initialize", INIT);
    await client.request("session/skills", { settings: { loadSkills: false } });
    await client.request("session/skills", {});
    expect(skillAsks).toEqual([{ loadSkills: false }, undefined]);
    connection.close();
  });
});

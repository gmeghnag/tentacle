import { describe, expect, test } from "bun:test";
import { Agent, NO_CAPABILITIES } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type LogResult,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionToolsResult,
  SessionToolsResultSchema,
  type SessionUpdate,
} from "@tentacle/protocol";
import {
  ToolRegistry,
  builtinTools,
  chartTool,
  createSkillTool,
  diagramTool,
} from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// docs/feat/tool-toggles.md S2: the daemon holds the built-in tool switches —
// seeded from its own config (the agent `buildAgent` made), unioned with a
// client's seed (off wins), set by `kind: "tool"` (a group is one op), logged,
// kept across a settings sync and a restart, and listed by `session/tools`.

const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { streaming: true },
  clientInfo: { name: "tentacle", version: "1.0.0" },
};
const CWD = "/tmp/tool-toggles";
const env = {} as ExecutionEnvironment;
const echoTool = { ...builtinTools[4], name: "mcp__echo__echo", mcpServer: "echo" } as never;

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly tools: string[][] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.tools.push((request.tools ?? []).map((t) => t.name));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const skillTool = createSkillTool(
  [{ name: "k8s", location: "/s/k8s/SKILL.md", dir: "/s/k8s", files: [], filesTruncated: false }],
  async () => ({ body: "B", bodyLine: 1 }),
);

/** A daemon whose own config switched `hostOff` off (what `buildAgent` seeds). */
function daemon(hostOff: readonly string[] = [], store?: SpyDaemonStore) {
  const model = new Recorder();
  let built = 0;
  const createAgent: AgentFactory = (_cwd, ctx) => {
    built++;
    const permissions = ctx.reuse?.permissions ?? new PermissionBroker();
    const tools = new ToolRegistry()
      .registerAll(builtinTools)
      .register(chartTool as never)
      .register(diagramTool as never)
      .register(echoTool);
    if (skillTool) tools.register(skillTool);
    const agent = new Agent({
      model,
      tools,
      env,
      systemPrompt: "sys",
      requestPermission: (req, options) => permissions.request(req, options),
      capabilities: { ...NO_CAPABILITIES, disabledTools: [...hostOff] },
    });
    return { agent, permissions, settingsReport: { carried: {}, overridden: {} } };
  };
  const persister = store
    ? new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} })
    : undefined;
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent,
    ...(persister ? { persister } : {}),
  });
  const connect = async () => {
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
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const set = (sessionId: string, name: string, enabled: boolean) =>
      client.request("session/set_capability", { sessionId, kind: "tool", name, enabled });
    const toolsOf = async (params: Record<string, unknown>) =>
      SessionToolsResultSchema.parse(await client.request("session/tools", params));
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    const prompt = async (sessionId: string) => {
      const ends = of("turn_end").length;
      await client.request("session/prompt", {
        sessionId,
        turnId: crypto.randomUUID(),
        content: [{ type: "text", text: "hi" }],
      });
      for (let i = 0; i < 400 && of("turn_end").length === ends; i++) await Bun.sleep(1);
    };
    return { client, open, set, toolsOf, of, prompt };
  };
  return { host, model, connect, built: () => built };
}

type Entry = LogResult["entries"][number] & { capabilities?: { disabledTools?: string[] } };
const capsEntries = (hosted: { logRead(): LogResult }) =>
  (hosted.logRead().entries as Entry[]).filter((e) => e.type === "capabilities");
const VISUALS = ["chart", "diagram", "present"];

describe("the host config seeds the daemon's truth (D4)", () => {
  test("a created session snapshots the config's set, logs it in the first segment, and the model never gets it", async () => {
    // Mutation: start `caps` from NO_CAPABILITIES → the snapshot says [] and the log has no entry.
    const d = daemon(["chart"]);
    const a = await d.connect();
    const opened = await a.open({ sessionId: "S", create: true });
    expect(opened.capabilities?.disabledTools).toEqual(["chart"]);
    const hosted = d.host.get("S");
    if (!hosted) throw new Error("no session");
    expect(capsEntries(hosted).at(-1)?.capabilities?.disabledTools).toEqual(["chart"]);
    await a.prompt("S");
    expect(d.model.tools.at(-1)).not.toContain("chart");
    expect(d.model.tools.at(-1)).toContain("diagram");
  });

  test("a seed UNIONS with the host's set: it adds, it can never remove (a pod cannot re-enable)", async () => {
    // Mutation: seed replaces → chart is back on.
    const d = daemon(["chart"]);
    const a = await d.connect();
    const opened = await a.open({
      sessionId: "S",
      create: true,
      capabilities: { disabledMcp: [], disabledSkills: [], disabledTools: ["shell"] },
    });
    expect(opened.capabilities?.disabledTools).toEqual(["chart", "shell"]);
    // An older client's seed (no disabledTools) removes nothing either.
    const b = await d.connect();
    const old = await b.open({
      sessionId: "T",
      create: true,
      capabilities: { disabledMcp: ["echo"], disabledSkills: [] },
    });
    expect(old.capabilities?.disabledTools).toEqual(["chart"]);
    expect(old.capabilities?.disabledMcp).toEqual(["echo"]);
  });
});

describe("session/set_capability{kind: tool}", () => {
  test("a group is ONE op: one broadcast with every member; a repeat emits nothing; the next request lacks them", async () => {
    // Mutation: emit unconditionally → a second update on the repeat.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    const result = (await a.set("S", "shell", false)) as {
      capabilities: { disabledTools: string[] };
    };
    expect(result.capabilities.disabledTools).toEqual(["shell", "shell_kill", "shell_output"]);
    expect(a.of("capabilities")).toHaveLength(1);
    await a.set("S", "shell", false);
    expect(a.of("capabilities")).toHaveLength(1);
    await a.prompt("S");
    const sent = d.model.tools.at(-1) ?? [];
    for (const n of ["shell", "shell_kill", "shell_output"]) expect(sent).not.toContain(n);
    expect(sent).toContain("fs_read");
  });

  test("skill or an unknown name is InvalidParams and changes nothing", async () => {
    // Mutation: drop the CapabilityRefusal → InvalidParams mapping → a different error code.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    for (const name of ["skill", "fs_mult_edit"]) {
      const err = await a.set("S", name, false).catch((e: unknown) => e);
      expect((err as { code?: number }).code).toBe(JsonRpcErrorCode.InvalidParams);
    }
    expect(a.of("capabilities")).toEqual([]);
    expect(d.host.get("S")?.capabilities().disabledTools).toEqual([]);
  });

  test("a settings sync's fresh agent (built with the config set) keeps the session's set", async () => {
    const d = daemon(["chart"]);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.set("S", "chart", true); // the user turned the config-off tool back on
    await a.set("S", "diagram", false);
    await a.client.request("session/update_settings", {
      sessionId: "S",
      id: "u1",
      settings: { maxIterations: 3 },
    });
    expect(d.built()).toBe(2);
    await a.prompt("S");
    expect(d.model.tools.at(-1)).toContain("chart");
    expect(d.model.tools.at(-1)).not.toContain("diagram");
  });

  test("a restart after a NEW segment keeps the person's 'on': no entry means everything on, never the config's set (Q4)", async () => {
    // Fix round 1 (Review M1). Mutations: (a) a restore with no record entry
    // falls back to the host config's set → `chart` comes back off; (b) the
    // restore path does not hand the state to the agent → the model lacks `chart`.
    const store = new SpyDaemonStore();
    const d = daemon(["chart"], store);
    const { hosted } = d.host.open(
      { create: true, messages: [{ role: "user", content: "q" }] },
      { send: () => {} },
    );
    // The person turns the config-off tool back on: the state is all-on again.
    hosted.setCapability({ kind: "tool", name: "chart", enabled: true });
    // A compaction // /clear starts a NEW segment: `logSegmentFacts` logs nothing
    // when everything is on, so the record carries no entry for it.
    hosted.clear();
    await hosted.persisted();
    const record = store.durable.get(hosted.id);
    if (!record) throw new Error("nothing durable");
    expect(record.capabilities).toBeUndefined();
    // A restarted daemon whose config still says `chart` is off.
    const restarted = daemon(["chart"], store);
    const restored = restarted.host.restore(record);
    expect(restored.capabilities().disabledTools).toEqual([]);
    // And its agent really offers the tool (the state reached it, not just the snapshot).
    restored.prompt("t1", [{ type: "text", text: "go" }]);
    for (let i = 0; i < 400 && restarted.model.tools.length === 0; i++) await Bun.sleep(1);
    expect(restarted.model.tools.at(-1)).toContain("chart");
  });

  test("a serve restart keeps the record's set (the record wins, Q4)", async () => {
    const store = new SpyDaemonStore();
    const d = daemon(["chart"], store);
    const { hosted } = d.host.open({ create: true }, { send: () => {} });
    hosted.setCapability({ kind: "tool", name: "chart", enabled: true });
    hosted.setCapability({ kind: "tool", name: "visuals", enabled: false });
    hosted.setCapability({ kind: "tool", name: "present", enabled: true });
    await hosted.persisted();
    const record = store.durable.get(hosted.id);
    if (!record) throw new Error("nothing durable");
    expect(record.capabilities?.disabledTools).toEqual(["chart", "diagram"]);
    // A restarted daemon whose config now switches `fs_write` off too.
    const restarted = daemon(["fs_write"], store);
    const restored = restarted.host.restore(record);
    expect(restored.capabilities().disabledTools).toEqual(["chart", "diagram"]);
  });
});

describe("session/tools (D6)", () => {
  const byName = (r: SessionToolsResult) => new Map(r.tools.map((t) => [t.name, t]));

  test("lists registered built-ins with group, tokens, locked skill, disabled flags — and no MCP tool", async () => {
    const d = daemon(["chart"]);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.set("S", "shell", false);
    const tools = byName(await a.toolsOf({ sessionId: "S" }));
    expect(tools.has("mcp__echo__echo")).toBe(false);
    expect(tools.get("chart")).toMatchObject({ group: "visuals", disabled: true });
    expect(tools.get("diagram")?.disabled).toBeUndefined();
    expect(tools.get("shell_output")).toMatchObject({ group: "shell", disabled: true });
    expect(tools.get("fs_read")?.group).toBeUndefined();
    expect(tools.get("skill")).toMatchObject({ locked: true });
    for (const t of tools.values()) expect(t.tokens).toBeGreaterThan(0);
    // The heavy one is heavy: the figure is the definition's size.
    expect(tools.get("chart")?.tokens ?? 0).toBeGreaterThan(tools.get("shell_kill")?.tokens ?? 0);
  });

  test("with no session: the built-ins a session created now would have (the host's set included)", async () => {
    const d = daemon(["diagram"]);
    const a = await d.connect();
    const tools = byName(await a.toolsOf({}));
    expect(tools.get("diagram")?.disabled).toBe(true);
    expect(tools.get("chart")?.disabled).toBeUndefined();
  });
});

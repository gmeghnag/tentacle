import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
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
  MAX_DISABLED_CAPABILITIES,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionUpdate,
  SetCapabilityResultSchema,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import type { AgentFactory } from "../src/session-host.ts";
import { SessionHost } from "../src/session-host.ts";

// `session/set_capability` (docs/feat/session-capabilities.md S3a): the daemon
// holds the session's switches, hands them to the agent (what the NEXT model
// request offers), broadcasts every change to every attachment, snapshots
// them in OpenResult and seeds a created session. Each test names the mutation
// that turns it red (AGENTS §9).

const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { streaming: true },
  clientInfo: { name: "tentacle", version: "1.0.0" },
};

/** Records each request's tool names; answers with a bare "done". */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly tools: string[][] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.tools.push((request.tools ?? []).map((t) => t.name));
    yield { type: "done" };
  }
}

const env = {} as ExecutionEnvironment;
/** An MCP server's tool, tagged as the adapter tags it. */
const echoTool = { ...shellTool, name: "mcp__echo__echo", mcpServer: "echo" };

function daemon() {
  const model = new Recorder();
  const built: Agent[] = [];
  const createAgent: AgentFactory = (_cwd, ctx) => {
    const permissions = ctx.reuse?.permissions ?? new PermissionBroker();
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(shellTool).register(echoTool),
      env,
      requestPermission: (req, options) => permissions.request(req, options),
      skillListing: {
        skills: [
          {
            name: "k8s",
            description: "kubernetes",
            scope: "user",
            user: true,
            model: true,
            location: "/s/k8s/SKILL.md",
          },
        ],
        problems: [],
      },
    });
    built.push(agent);
    return { agent, permissions, settingsReport: { carried: {}, overridden: {} } };
  };
  const host = new SessionHost({ defaultCwd: "/tmp/session-capabilities", createAgent });
  const connect = async (name = "tentacle") => {
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
    await client.request("initialize", { ...INIT, clientInfo: { name, version: "1.0.0" } });
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const set = (sessionId: string, kind: "mcp" | "skill", name: string, enabled: boolean) =>
      client.request("session/set_capability", { sessionId, kind, name, enabled });
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    /** One prompt, run to its `turn_end`. */
    const prompt = async (sessionId: string) => {
      const ends = of("turn_end").length;
      await client.request("session/prompt", {
        sessionId,
        turnId: crypto.randomUUID(),
        content: [{ type: "text", text: "hi" }],
      });
      for (let i = 0; i < 200 && of("turn_end").length === ends; i++) {
        await Bun.sleep(1);
      }
    };
    return { client, open, set, of, prompt };
  };
  return { host, model, built, connect };
}

const NONE = { disabledMcp: [], disabledSkills: [], disabledTools: [] };

describe("session/set_capability is the session's", () => {
  test("A turns `echo` off: both attachments get it with `by`, and the next request lacks the tool", async () => {
    // Mutations: drop the `emit` in `setCapability` → no update; drop the
    // agent's `setCapabilities` → the request still offers `mcp__echo__echo`.
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect("phone");
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });
    await a.prompt("S");
    expect(d.model.tools.at(-1)).toContain("mcp__echo__echo");

    const result = SetCapabilityResultSchema.parse(await a.set("S", "mcp", "echo", false));
    const off = { disabledMcp: ["echo"], disabledSkills: [], disabledTools: [] };
    expect(result).toEqual({ capabilities: off });
    expect(a.of("capabilities")).toEqual([
      { type: "capabilities", capabilities: off, by: "tentacle" },
    ]);
    expect(b.of("capabilities")).toEqual([
      { type: "capabilities", capabilities: off, by: "tentacle" },
    ]);

    await b.prompt("S");
    expect(d.model.tools.at(-1)).not.toContain("mcp__echo__echo");
    expect(d.model.tools.at(-1)).toContain("shell");

    // And back on: lossless.
    await b.set("S", "mcp", "echo", true);
    await a.prompt("S");
    expect(d.model.tools.at(-1)).toContain("mcp__echo__echo");
    expect(a.of("capabilities").at(-1)).toEqual({
      type: "capabilities",
      capabilities: NONE,
      by: "phone",
    });
  });

  test("F4: concurrent deltas on DIFFERENT items both land, and both clients converge", async () => {
    // Mutation: make the op whole-state (replace the set with just `name`) → one is lost.
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect("phone");
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });

    await Promise.all([a.set("S", "mcp", "echo", false), b.set("S", "skill", "k8s", false)]);
    const both = { disabledMcp: ["echo"], disabledSkills: ["k8s"], disabledTools: [] };
    expect(a.of("capabilities").at(-1)?.capabilities).toEqual(both);
    expect(b.of("capabilities").at(-1)?.capabilities).toEqual(both);
    // One total order: both see the same sequence.
    expect(a.of("capabilities").map((u) => u.capabilities)).toEqual(
      b.of("capabilities").map((u) => u.capabilities),
    );
  });

  test("an idempotent set emits nothing and still answers the state", async () => {
    // Mutation: emit unconditionally → a second update appears.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    expect(await a.set("S", "skill", "k8s", true)).toEqual({ capabilities: NONE });
    expect(a.of("capabilities")).toEqual([]);
    await a.set("S", "skill", "k8s", false);
    await a.set("S", "skill", "k8s", false);
    expect(a.of("capabilities")).toHaveLength(1);
  });

  test("F5: OpenResult carries the snapshot on create and on a later attach", async () => {
    // Mutation: drop `capabilities` from the open result → undefined.
    const d = daemon();
    const a = await d.connect();
    expect((await a.open({ sessionId: "S", create: true })).capabilities).toEqual(NONE);
    await a.set("S", "mcp", "echo", false);
    const c = await d.connect();
    expect((await c.open({ sessionId: "S" })).capabilities).toEqual({
      disabledMcp: ["echo"],
      disabledSkills: [],
      disabledTools: [],
    });
  });

  test("OpenParams.capabilities seeds a CREATED session (normalized), and is ignored on an attach", async () => {
    // Mutation: drop the seed in `SessionHost.open` → the first request offers echo.
    const d = daemon();
    const a = await d.connect();
    const seed = { disabledMcp: ["zz", "echo", "echo"], disabledSkills: ["k8s"] };
    const opened = await a.open({ sessionId: "S", create: true, capabilities: seed });
    expect(opened.capabilities).toEqual({
      disabledMcp: ["echo", "zz"],
      disabledSkills: ["k8s"],
      disabledTools: [],
    });
    await a.prompt("S");
    expect(d.model.tools.at(-1)).not.toContain("mcp__echo__echo");
    // No update for a seed: nobody had a different snapshot.
    expect(a.of("capabilities")).toEqual([]);

    const b = await d.connect();
    const attached = await b.open({ sessionId: "S", capabilities: NONE });
    expect(attached.capabilities).toEqual({
      disabledMcp: ["echo", "zz"],
      disabledSkills: ["k8s"],
      disabledTools: [],
    });
  });

  test("a settings sync's fresh agent keeps the session's switches", async () => {
    // Mutation: drop `next.setCapabilities(this.caps)` in `swapAgent` → echo is back.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.set("S", "mcp", "echo", false);
    const result = (await a.client.request("session/update_settings", {
      sessionId: "S",
      id: "u1",
      settings: { maxIterations: 3 },
    })) as { applied: boolean };
    expect(result.applied).toBe(true);
    expect(d.built).toHaveLength(2);
    await a.prompt("S");
    expect(d.model.tools.at(-1)).not.toContain("mcp__echo__echo");
  });

  test("F10: a flood past the cap is InvalidParams and changes nothing; a too-long name is refused", async () => {
    // Mutation: drop the cap check → the 257th name is stored.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    for (let i = 0; i < MAX_DISABLED_CAPABILITIES; i++) {
      await a.set("S", "skill", `s${i}`, false);
    }
    const before = a.of("capabilities").length;
    const err = await a.set("S", "skill", "one-more", false).catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(a.of("capabilities")).toHaveLength(before);
    // Re-enabling one still works at the cap; the MCP set has its own cap.
    expect(
      ((await a.set("S", "mcp", "echo", false)) as { capabilities: { disabledMcp: string[] } })
        .capabilities.disabledMcp,
    ).toEqual(["echo"]);

    const long = await a.set("S", "mcp", "x".repeat(129), false).catch((e: unknown) => e);
    expect((long as { code?: number }).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  test("session/skills marks a skill turned off for this session", async () => {
    // Mutation: `HostedSession.skills` passes `[]` → no `disabled` mark.
    const d = daemon();
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    const before = (await a.client.request("session/skills", { sessionId: "S" })) as {
      skills: { name: string; disabled?: true }[];
    };
    expect(before.skills.map((s) => s.disabled)).toEqual([undefined]);
    await a.set("S", "skill", "k8s", false);
    const after = (await a.client.request("session/skills", { sessionId: "S" })) as {
      skills: { name: string; disabled?: true }[];
    };
    expect(after.skills.map((s) => [s.name, s.disabled])).toEqual([["k8s", true]]);
  });

  test("a set on an unknown session is UnknownSession", async () => {
    const d = daemon();
    const a = await d.connect();
    const unknown = await a.set("nope", "mcp", "echo", false).catch((e: unknown) => e);
    expect((unknown as { code?: number }).code).toBe(DomainErrorCode.UnknownSession);
  });
});

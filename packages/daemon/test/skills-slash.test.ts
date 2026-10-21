/**
 * `/name` on the wire: the `initialize` skill catalog and `session/prompt{skill}`
 * (docs/feat/skills-slash.md).
 */
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
  type InitializeResult,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  MAX_SKILL_CATALOG,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry, createSkillActivator } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { toSkillCatalog } from "../src/mapping.ts";
import { SessionHost } from "../src/session-host.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: string[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => m.content).join("\n"));
    yield { type: "text", delta: "done" };
    yield { type: "done" };
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A daemon whose agent can activate `deploy-app` (user) and `model-only` (model only). */
function harness(skills = [{ name: "deploy-app", description: "Deploy the app." }]) {
  const model = new Scripted();
  const host = new SessionHost({
    defaultCwd: "/tmp/daemon-work",
    skills,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const entry = (name: string, userInvocable: boolean) => ({
        name,
        location: `/s/${name}/SKILL.md`,
        dir: `/s/${name}`,
        files: [],
        filesTruncated: false,
        userInvocable,
      });
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        skills: createSkillActivator(
          [entry("deploy-app", true), entry("model-only", false)],
          async (s) => ({ body: `STEPS for ${s.name}`, bodyLine: 5 }),
        ),
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  new Connection(daemonCh, host);
  const updates: KnownSessionUpdateParams[] = [];
  const client = new RpcPeer(clientCh, {
    onNotification: (method, params) => {
      if (method === "session/update") {
        updates.push(params as KnownSessionUpdateParams);
      }
    },
  });
  return { client, updates, model };
}

async function openSession(client: RpcPeer): Promise<string> {
  await client.request("initialize", INIT);
  const opened = (await client.request("session/open", { create: true })) as { sessionId: string };
  return opened.sessionId;
}

describe("toSkillCatalog (always schema-valid, whatever the SKILL.md said)", () => {
  test("drops non-spec names and empty descriptions, makes descriptions one clean line", () => {
    expect(
      toSkillCatalog([
        { name: "ok", description: "  multi\nline\tdesc \u001b[31mred\u0007  " },
        { name: "Bad Name", description: "d" },
        { name: "blank", description: " \n\u0000 " },
        { name: "c1", description: "a\u009bb" },
      ]),
    ).toEqual([
      { name: "ok", description: "multi line desc [31mred" },
      { name: "c1", description: "a b" },
    ]);
  });

  test("cuts a long description and caps the entries", () => {
    const [one] = toSkillCatalog([{ name: "a", description: "x".repeat(2000) }]);
    expect(one?.description).toHaveLength(1024);
    const many = Array.from({ length: MAX_SKILL_CATALOG + 5 }, (_, i) => ({
      name: `s${i}`,
      description: "d",
    }));
    expect(toSkillCatalog(many)).toHaveLength(MAX_SKILL_CATALOG);
  });
});

describe("initialize carries the catalog", () => {
  test("the client receives the daemon's /name skills (validated by its peer)", async () => {
    const { client } = harness();
    const result = (await client.request("initialize", INIT)) as InitializeResult;
    expect(result.skills).toEqual([{ name: "deploy-app", description: "Deploy the app." }]);
  });

  test("no skills → an empty catalog", async () => {
    const { client } = harness([]);
    const result = (await client.request("initialize", INIT)) as InitializeResult;
    expect(result.skills).toEqual([]);
  });
});

describe("session/prompt{skill}", () => {
  test("a known skill streams as a tool call before the model's reply, which sees the content", async () => {
    const { client, updates, model } = harness();
    const sessionId = await openSession(client);
    const ack = await client.request("session/prompt", {
      sessionId,
      turnId: "t1",
      content: [{ type: "text", text: "/deploy-app to staging" }],
      skill: "deploy-app",
    });
    expect(ack).toEqual({ turnId: "t1" });
    for (let i = 0; i < 200 && !updates.some((u) => u.update.type === "turn_end"); i++) {
      await tick();
    }
    const kinds = updates.map((u) => u.update.type);
    expect(kinds[0]).toBe("turn_start");
    const start = updates.find((u) => u.update.type === "turn_start")?.update;
    expect(start?.type === "turn_start" && start.prompt).toBe("/deploy-app to staging");
    const call = updates.find((u) => u.update.type === "tool_call")?.update;
    expect(call?.type === "tool_call" && call.title).toBe("skill");
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("agent_message_chunk"));
    expect(model.seen[0]).toContain("STEPS for deploy-app");
    const end = updates.find((u) => u.update.type === "turn_end")?.update;
    expect(end?.type === "turn_end" && end.stopReason).toBe("end_turn");
  });

  test("a skill the user cannot activate → InvalidParams before the ack; nothing starts", async () => {
    const { client, updates, model } = harness();
    const sessionId = await openSession(client);
    // Unknown, model-only, and a known skill with no text (an activation needs
    // a user message to follow — review finding 2).
    for (const [skill, text] of [
      ["nope", "/nope"],
      ["model-only", "/model-only"],
      ["deploy-app", ""],
    ] as const) {
      const sent = client.request("session/prompt", {
        sessionId,
        turnId: `t-${skill}-${text.length}`,
        content: [{ type: "text", text }],
        skill,
      });
      await expect(sent).rejects.toBeInstanceOf(RpcError);
      await sent.catch((error: RpcError) => {
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain(`unknown skill "${skill}"`);
      });
    }
    await tick(20);
    expect(updates).toEqual([]);
    expect(model.seen).toEqual([]);
    // Not recorded as a turn: the session is idle and takes the next prompt.
    const ack = await client.request("session/prompt", {
      sessionId,
      turnId: "t-ok",
      content: [{ type: "text", text: "hello" }],
    });
    expect(ack).toEqual({ turnId: "t-ok" });
  });
});

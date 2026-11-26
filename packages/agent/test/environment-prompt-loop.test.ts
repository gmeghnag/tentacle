/**
 * The environment block in the agent loop (docs/feat/system-prompt-cwd.md): every
 * request's system head ends with it, and the stored history never holds it.
 * The expected bytes are spelled out here, never rendered by the code under test.
 */
import { describe, expect, test } from "bun:test";
import { SKILLS_PROMPT_HEADER } from "@tentacle/config";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  HeuristicTokenCounter,
  type ModelProvider,
  NO_CAPABILITIES,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig } from "../src/agent.ts";
import type { SkillListing } from "../src/session-skills.ts";
import { Session } from "../src/session.ts";
import { createSubagentRunner } from "../src/subagent.ts";

const ENV = { cwd: "/work/repo", platform: "linux" };
const BLOCK = "<cwd>\n/work/repo\n</cwd>\n<platform>linux</platform>";
const HEAD = "You are an agent.\n";
const SENT_HEAD = `You are an agent.\n\n${BLOCK}\n`;

/** Replays a script, one entry per request, and keeps a copy of each request. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[] = []) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    for (const e of this.script[this.turn++] ?? [
      { type: "text", delta: "end" },
      { type: "done" },
    ]) {
      yield e;
    }
  }
}

const echo: Tool<{ n: number }> = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ n: z.number() }),
  permission: "none",
  async execute(input) {
    return { content: `echoed ${input.n}` };
  },
};

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "echo", arguments: JSON.stringify({ n: 1 }) },
});
const done = (promptTokens?: number): StreamEvent =>
  promptTokens === undefined
    ? { type: "done" }
    : { type: "done", usage: { promptTokens, completionTokens: 1 } };

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(echo);
  return tools;
}

function agentWith(model: ModelProvider, extra: Partial<AgentConfig> = {}): Agent {
  return new Agent({
    model,
    tools: registry(),
    env: noopEnv,
    systemPrompt: HEAD,
    environment: ENV,
    ...extra,
  });
}

async function send(session: Session, text: string): Promise<void> {
  for await (const _ of session.send(text)) {
    // drain
  }
}

/** The system contents of one recorded request. */
const systems = (request: ChatRequest | undefined): unknown[] =>
  (request?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content);

describe("environment block in the agent loop", () => {
  test("(a) every round and the max_iterations final request end the head with the block", async () => {
    const model = new Scripted([
      [call("c1"), done()],
      [call("c2"), done()],
      [{ type: "text", delta: "report" }, done()],
    ]);
    const session = new Session(agentWith(model, { maxIterations: 2 }), "s1");
    await send(session, "go");
    expect(model.requests).toHaveLength(3);
    // The third is the forced final report: it advertises no tools.
    expect(model.requests[2]?.tools ?? []).toHaveLength(0);
    for (const request of model.requests) {
      expect(systems(request)).toEqual([SENT_HEAD]);
      expect(request.messages[0]?.content).toBe(SENT_HEAD);
    }
  });

  test("(b) the stored head is unchanged after a turn", async () => {
    const model = new Scripted([[call("c1"), done()]]);
    const session = new Session(agentWith(model), "s1");
    const stored = session.messages[0];
    await send(session, "go");
    expect(model.requests[0]?.messages[0]?.content).toBe(SENT_HEAD);
    expect<ChatMessage | undefined>(session.messages[0]).toBe(stored);
    expect(session.messages[0]?.content).toBe(HEAD);
    expect(JSON.stringify(session.messages)).not.toContain("<cwd>");
  });

  test("(c) two requests carry the same system bytes and the context line stays anchored", async () => {
    const model = new Scripted([
      [call("c1"), done(5000)],
      [{ type: "text", delta: "ok" }, done()],
    ]);
    const agent = agentWith(model, { contextAwareness: { window: 100_000, stepPercent: 1 } });
    const session = new Session(agent, "s1");
    await send(session, "go");
    expect(model.requests).toHaveLength(2);
    expect(systems(model.requests[1])).toEqual(systems(model.requests[0]));
    expect(systems(model.requests[0])).toEqual([SENT_HEAD]);
    // The second round's line is the provider's measure plus what came after
    // it: the head's per-request copy does not invalidate the anchor.
    const tool = session.messages.find((m) => m.role === "tool");
    const used = tool?.contextUsage?.used ?? 0;
    expect(used).toBeGreaterThanOrEqual(5000);
    expect(used).toBeLessThan(5200);
  });

  test("(c) the context count measures the request with the block", async () => {
    const counter = new HeuristicTokenCounter();
    const cwd = `/${"long-directory-name/".repeat(200)}`;
    const count = async (extra: Partial<AgentConfig>): Promise<number> => {
      const agent = agentWith(new Scripted(), extra);
      return (await agent.contextUsage(agent.startConversation())).used;
    };
    const withBlock = await count({ environment: { cwd, platform: "linux" } });
    const without = await count({ environment: { cwd: "" } });
    expect(withBlock - without).toBeGreaterThanOrEqual(counter.countText(cwd) - 1);
  });

  test("(d) a session seeded with an old stored head sends the block", async () => {
    const model = new Scripted();
    const old = [
      { role: "system" as const, content: "An old prompt.\n" },
      { role: "user" as const, content: "earlier" },
      { role: "assistant" as const, content: "answered" },
    ];
    const session = new Session(agentWith(model), "s1", { messages: old });
    await send(session, "again");
    expect(systems(model.requests[0])).toEqual([`An old prompt.\n\n${BLOCK}\n`]);
    expect(session.messages[0]?.content).toBe("An old prompt.\n");
  });

  test("(e) a hidden skill: the catalog is reduced and the block follows it", async () => {
    const names = ["k8s", "damajs"];
    const catalog = [
      SKILLS_PROMPT_HEADER,
      "",
      ...names.map(
        (n) =>
          `<skill><name>${n}</name><description>does ${n}</description><location>/s/${n}/SKILL.md</location></skill>`,
      ),
    ].join("\n");
    const listing: SkillListing = {
      skills: names.map((name) => ({
        name,
        description: `does ${name}`,
        scope: "user" as const,
        user: true,
        model: true,
        location: `/s/${name}/SKILL.md`,
      })),
      problems: [],
    };
    const model = new Scripted();
    const session = new Session(
      agentWith(model, {
        systemPrompt: `ID\n\n${catalog}\n`,
        skillListing: listing,
        capabilities: { ...NO_CAPABILITIES, disabledSkills: ["k8s"] },
      }),
      "s1",
    );
    await send(session, "go");
    const head = String(model.requests[0]?.messages[0]?.content);
    expect(head).toContain("damajs");
    expect(head).not.toContain("k8s");
    expect(head.endsWith(`\n\n${BLOCK}\n`)).toBe(true);
    expect(head.split("<cwd>")).toHaveLength(2);
    expect(session.messages[0]?.content).toBe(`ID\n\n${catalog}\n`);
  });

  test("(f) a native sub-agent's request ends with the parent's block", async () => {
    const model = new Scripted();
    const { run } = createSubagentRunner({
      model,
      env: noopEnv,
      tools: registry(),
      environment: ENV,
    });
    await run({ description: "d", prompt: "look", type: "general" });
    const head = String(model.requests[0]?.messages[0]?.content);
    expect(head.endsWith(`\n\n${BLOCK}\n`)).toBe(true);
  });

  test("(g) a replaced agent's next request carries ITS block; the stored head stays block-free", async () => {
    const before = new Scripted();
    const after = new Scripted();
    const session = new Session(agentWith(before), "s1");
    await send(session, "one");
    session.replaceAgent(
      agentWith(after, { environment: { cwd: "/workspace", platform: "darwin" } }),
    );
    await send(session, "two");
    expect(systems(after.requests[0])).toEqual([
      "You are an agent.\n\n<cwd>\n/workspace\n</cwd>\n<platform>darwin</platform>\n",
    ]);
    expect(session.messages[0]?.content).toBe(HEAD);
  });

  test("(h) no environment: the head is sent as stored", async () => {
    const model = new Scripted([[call("c1"), done()]]);
    const agent = new Agent({ model, tools: registry(), env: noopEnv, systemPrompt: HEAD });
    await send(new Session(agent, "s1"), "go");
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      expect(systems(request)).toEqual([HEAD]);
    }
  });

  test("an empty cwd and no platform: the head is sent as stored", async () => {
    const model = new Scripted();
    await send(new Session(agentWith(model, { environment: { cwd: "" } }), "s1"), "go");
    expect(systems(model.requests[0])).toEqual([HEAD]);
  });

  test("no system head: no block, and no message is inserted", async () => {
    const model = new Scripted();
    const agent = new Agent({ model, tools: registry(), env: noopEnv, environment: ENV });
    const session = new Session(agent, "s1");
    await send(session, "go");
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

// docs/fix/remote-agents-discoverable.md D1/D3: the remote agents the head lists.
describe("remote agents in the agent loop", () => {
  const environment = {
    ...ENV,
    remoteAgents: [{ type: "a2a:bravo", ownerDescription: "Reviewer", host: "agents.acme.dev" }],
  };
  const SECTION = [
    "<remote_agents>",
    "Remote agents (A2A) you can delegate to: call agent_task with subagent_type set to the name below. Your prompt is sent to that agent's host. Each agent's own card text is in agent_task's type list, marked as remote data.",
    "- a2a:bravo — Reviewer · agents.acme.dev",
    "</remote_agents>",
  ].join("\n");
  const LISTED = `You are an agent.\n\n${BLOCK}\n${SECTION}\n`;
  const off = { ...NO_CAPABILITIES, disabledTools: ["agent_task"] };

  test("(a) every round's head ends with the list, byte-identical", async () => {
    const model = new Scripted([[call("c1"), done()]]);
    await send(new Session(agentWith(model, { environment }), "s1"), "go");
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      expect(systems(request)).toEqual([LISTED]);
    }
  });

  test("(c) agent_task turned off: no list; turned back on: the list returns", async () => {
    const model = new Scripted();
    const agent = agentWith(model, { environment, capabilities: off });
    const session = new Session(agent, "s1");
    await send(session, "one");
    expect(systems(model.requests[0])).toEqual([SENT_HEAD]);
    agent.setCapabilities(NO_CAPABILITIES);
    await send(session, "two");
    expect(systems(model.requests[1])).toEqual([LISTED]);
    agent.setCapabilities(off);
    await send(session, "three");
    expect(systems(model.requests[2])).toEqual([SENT_HEAD]);
  });

  test("(c) another tool turned off keeps the list", async () => {
    const model = new Scripted();
    const capabilities = { ...NO_CAPABILITIES, disabledTools: ["echo"] };
    await send(new Session(agentWith(model, { environment, capabilities }), "s1"), "go");
    expect(systems(model.requests[0])).toEqual([LISTED]);
  });

  test("(c) the context count measures the head that is sent", async () => {
    const used = async (extra: Partial<AgentConfig>): Promise<number> => {
      const agent = agentWith(new Scripted(), extra);
      return (await agent.contextUsage(agent.startConversation())).used;
    };
    const listed = await used({ environment });
    const hidden = await used({ environment, capabilities: off });
    expect(listed).toBeGreaterThan(hidden);
    expect(hidden).toBe(await used({ capabilities: off }));
  });

  test("(d) the stored head stays block-free after the turn", async () => {
    const model = new Scripted([[call("c1"), done()]]);
    const session = new Session(agentWith(model, { environment }), "s1");
    await send(session, "go");
    expect(model.requests[0]?.messages[0]?.content).toBe(LISTED);
    expect(session.messages[0]?.content).toBe(HEAD);
    expect(JSON.stringify(session.messages)).not.toContain("remote_agents");
  });
});

import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import {
  SKILL_TOOL_NAME,
  type SkillActivator,
  ToolRegistry,
  createSkillActivator,
  createSkillTool,
} from "@tentacle/tools";
import { Agent, type SessionSkills } from "../src/agent.ts";

// Agent.installSkills + reloadSkills(…, through) — the swap seam of a context
// reset (docs/feat/context-reset-refresh.md). Nothing calls them yet.

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A skill set over `bodies` (name → body), built as the wiring builds one. */
function skillSet(bodies: Record<string, string>): SessionSkills {
  const entries = Object.keys(bodies).map((name) => ({
    name,
    location: `/s/${name}/SKILL.md`,
    dir: `/s/${name}`,
    files: [],
    filesTruncated: false,
  }));
  const reader = async (s: { name: string }) => ({ body: bodies[s.name] ?? "", bodyLine: 1 });
  return {
    tool: createSkillTool(entries, reader),
    activator: createSkillActivator(
      entries.map((e) => ({ ...e, userInvocable: true })),
      reader,
    ),
  };
}

function agentWith(
  initial: SessionSkills,
  script: readonly (readonly StreamEvent[])[] = [],
): { agent: Agent; tools: ToolRegistry; model: ScriptedProvider } {
  const tools = new ToolRegistry();
  if (initial.tool) {
    tools.register(initial.tool);
  }
  const model = new ScriptedProvider(script);
  const agent = new Agent({
    model,
    tools,
    env: noopEnv,
    systemPrompt: "SYS",
    ...(initial.activator ? { skills: initial.activator } : {}),
  });
  return { agent, tools, model };
}

const skillEnum = (req: ChatRequest | undefined): string[] | undefined =>
  (
    req?.tools?.find((t) => t.name === SKILL_TOOL_NAME)?.parameters as
      | { properties?: { name?: { enum?: string[] } } }
      | undefined
  )?.properties?.name?.enum;

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    // consume
  }
}

describe("Agent.installSkills", () => {
  test("the next model request offers the NEW skill list, and a call to a skill added later loads", async () => {
    const { agent, model } = agentWith(skillSet({ old: "OLD" }), [
      [{ type: "text", delta: "one" }, { type: "done" }],
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "skill", arguments: JSON.stringify({ name: "added" }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    await drain(agent.run("s", [{ role: "user", content: "a" }]));
    expect(skillEnum(model.requests[0])).toEqual(["old"]);

    agent.installSkills(skillSet({ old: "OLD", added: "ADDED BODY" }));
    const results: string[] = [];
    for await (const e of agent.run("s", [{ role: "user", content: "b" }])) {
      if (e.type === "tool_result") {
        results.push(e.result.content);
      }
    }
    expect(skillEnum(model.requests[1])).toEqual(["old", "added"]);
    expect(results[0]).toStartWith('<skill_content name="added">');
    expect(results[0]).toContain("ADDED BODY");
  });

  test("the activator swaps with it: what the USER may activate follows the new set", () => {
    const { agent } = agentWith(skillSet({ old: "OLD" }));
    expect([agent.canActivateForUser("old"), agent.canActivateForUser("added")]).toEqual([
      true,
      false,
    ]);
    agent.installSkills(skillSet({ added: "A" }));
    expect([agent.canActivateForUser("old"), agent.canActivateForUser("added")]).toEqual([
      false,
      true,
    ]);
  });

  test("an empty set removes the skill tool and the activator; a set can come back from none", () => {
    const { agent, tools } = agentWith(skillSet({ old: "OLD" }));
    expect(tools.get(SKILL_TOOL_NAME)).toBeDefined();
    agent.installSkills({});
    expect(tools.get(SKILL_TOOL_NAME)).toBeUndefined();
    expect(agent.canActivateForUser("old")).toBe(false);
    agent.installSkills(skillSet({ back: "B" }));
    expect(tools.get(SKILL_TOOL_NAME)).toBeDefined();
    expect(agent.canActivateForUser("back")).toBe(true);
  });

  test("other tools and their order are left alone", () => {
    const { agent, tools } = agentWith(skillSet({ old: "OLD" }));
    tools.register({
      name: "other",
      description: "d",
      inputSchema: (tools.get(SKILL_TOOL_NAME) as NonNullable<ReturnType<typeof tools.get>>)
        .inputSchema,
      permission: "none",
      execute: async () => ({ content: "x" }),
    });
    agent.installSkills(skillSet({ new1: "N" }));
    expect(tools.list().map((t) => t.name)).toEqual([SKILL_TOOL_NAME, "other"]);
  });
});

describe("Agent.reloadSkills through another activator", () => {
  const history = (name: string, content: string): ChatMessage[] => [
    { role: "system", content: "SYS" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "k1", name: SKILL_TOOL_NAME, arguments: JSON.stringify({ name }) }],
    },
    { role: "tool", content, toolCallId: "k1" },
  ];
  const stored = '<skill_content name="s1">\nSTORED';

  test("default → the installed activator, as compaction has always done", async () => {
    const { agent } = agentWith(skillSet({ s1: "INSTALLED" }));
    const [r] = await agent.reloadSkills("s", history("s1", stored));
    expect(r?.source).toBe("fresh");
    expect(r?.content).toContain("INSTALLED");
  });

  test("an explicit activator wins over the installed one — and installs nothing", async () => {
    const installed = skillSet({ s1: "INSTALLED" });
    const { agent, tools } = agentWith(installed);
    const next: SkillActivator | undefined = skillSet({ s1: "NEW BODY" }).activator;
    const [r] = await agent.reloadSkills("s", history("s1", stored), undefined, next);
    expect(r?.source).toBe("fresh");
    expect(r?.content).toContain("NEW BODY");
    expect(r?.content).not.toContain("INSTALLED");
    // The installed set is untouched (a reset installs only at its commit).
    expect(tools.get(SKILL_TOOL_NAME) === installed.tool).toBe(true);
    expect(agent.canActivateForUser("s1")).toBe(true);
  });

  test("a skill the new activator no longer knows is carried `unavailable` with its stored copy", async () => {
    const { agent } = agentWith(skillSet({ s1: "INSTALLED" }));
    const next = skillSet({ other: "O" }).activator;
    const [r] = await agent.reloadSkills("s", history("s1", stored), undefined, next);
    expect(r?.source).toBe("unavailable");
    expect(r?.content).toBe(stored);
  });

  test("null → no activator at all: everything unavailable, whatever is installed", async () => {
    const { agent } = agentWith(skillSet({ s1: "INSTALLED" }));
    const [r] = await agent.reloadSkills("s", history("s1", stored), undefined, null);
    expect(r?.source).toBe("unavailable");
  });
});

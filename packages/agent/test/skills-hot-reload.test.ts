/**
 * The user's skill rescan (docs/feat/skills-hot-reload.md): `/name` follows
 * the disk while the MODEL's skill set (the `skill` tool's enum, the system
 * prompt) changes only at a context reset — and a rescan never overwrites a
 * newer reset (F3).
 */
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
  type SkillActivatorEntry,
  type SkillBodyReader,
  ToolRegistry,
  createSkillActivator,
  createSkillTool,
} from "@tentacle/tools";
import { Agent, type SessionSkills } from "../src/agent.ts";
import { offeredSkillNames } from "../src/context-reset.ts";
import { type SkillListing, userRescanListing } from "../src/session-skills.ts";
import { Session } from "../src/session.ts";

/** Records a copy of each request's messages and its tool definitions. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: { messages: ChatMessage[]; tools: ChatRequest["tools"] }[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({
      messages: request.messages.map((m) => ({ ...m })),
      tools: request.tools,
    });
    for (const e of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield e;
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const read: SkillBodyReader = async (s) => ({ body: `STEPS for ${s.name}`, bodyLine: 5 });

const entry = (name: string): SkillActivatorEntry => ({
  name,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  files: [],
  filesTruncated: false,
  userInvocable: true,
});

/** A full set as `buildSessionSkills` makes it: every skill offered to both. */
function skillSet(names: readonly string[]): SessionSkills {
  const entries = names.map(entry);
  return {
    tool: createSkillTool(entries, read),
    activator: createSkillActivator(entries, read),
    listing: {
      skills: names.map((name) => ({
        name,
        description: `the ${name} skill`,
        scope: "user" as const,
        user: true,
        model: true,
        location: `/s/${name}/SKILL.md`,
      })),
      problems: [],
    },
  };
}

const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];

function build(
  start: readonly string[],
  rescanSkills: (() => Promise<SessionSkills>) | undefined,
  script: readonly (readonly StreamEvent[])[] = [say("ok"), say("ok"), say("ok")],
): { agent: Agent; model: Scripted; tools: ToolRegistry } {
  const set = skillSet(start);
  const tools = new ToolRegistry();
  if (set.tool) {
    tools.register(set.tool);
  }
  const model = new Scripted(script);
  const agent = new Agent({
    model,
    tools,
    env,
    systemPrompt: "SYS",
    ...(set.activator ? { skills: set.activator } : {}),
    ...(set.listing ? { skillListing: set.listing } : {}),
    ...(rescanSkills ? { rescanSkills } : {}),
  });
  return { agent, model, tools };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    // run the turn
  }
}

const enumOf = (tools: ChatRequest["tools"]): string[] => offeredSkillNames(tools ?? []);

/** A rescan the test releases by hand. */
function gated(): {
  scan: () => Promise<SessionSkills>;
  release: (set: SessionSkills) => void;
  calls: () => number;
} {
  const waiting: ((set: SessionSkills) => void)[] = [];
  let calls = 0;
  return {
    scan: () => {
      calls++;
      return new Promise<SessionSkills>((resolve) => waiting.push(resolve));
    },
    release: (set) => {
      for (const resolve of waiting.splice(0)) {
        resolve(set);
      }
    },
    calls: () => calls,
  };
}

describe("user rescan (T1: the load-bearing property)", () => {
  test("a skill added on disk is activatable at once; the model's enum and system prompt are untouched", async () => {
    const { agent, model } = build(["alpha"], async () => skillSet(["alpha", "beta"]));
    const session = new Session(agent);
    expect(session.canActivateSkill("beta")).toBe(false);
    await drain(session.send("first"));

    const listing = await session.refreshSkills();
    expect(session.canActivateSkill("beta")).toBe(true);
    // Mutation (red, verified): install the fresh TOOL too → beta is `model: true`
    // here, and the enum below becomes ["alpha","beta"].
    expect(listing.skills.map((s) => [s.name, s.model, s.modelAfterReset])).toEqual([
      ["alpha", true, undefined],
      ["beta", false, true],
    ]);

    await drain(session.send("/beta go", undefined, { skill: "beta" }));
    const [first, second] = [model.requests[0], model.requests.at(-1)];
    expect(enumOf(second?.tools)).toEqual(["alpha"]);
    expect(enumOf(first?.tools)).toEqual(["alpha"]);
    expect(first?.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(second?.messages[0]).toEqual({ role: "system", content: "SYS" });
    // The user's round ran through the fresh activator.
    const result = second?.messages.find((m) => m.role === "tool");
    expect(result?.content).toContain("STEPS for beta");
  });

  test("no rescan source: the installed listing is answered, nothing changes", async () => {
    const { agent } = build(["alpha"], undefined);
    const listing = await agent.refreshUserSkills();
    expect(listing.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(agent.canActivateForUser("alpha")).toBe(true);
  });

  test("a scan that throws installs nothing and rejects (F1)", async () => {
    const { agent } = build(["alpha"], () => Promise.reject(new Error("EACCES")));
    await expect(agent.refreshUserSkills()).rejects.toThrow("EACCES");
    expect(agent.canActivateForUser("alpha")).toBe(true);
    expect(agent.skillListing().skills.map((s) => s.name)).toEqual(["alpha"]);
  });
});

describe("user rescan (T2: a skill removed from disk)", () => {
  test("the model keeps it (problem line); /name no longer offers it", async () => {
    const { agent, tools } = build(["alpha", "gone"], async () => skillSet(["alpha"]));
    const listing = await agent.refreshUserSkills();
    expect(listing.problems).toEqual(["gone: removed — the model keeps it until a context reset"]);
    expect(agent.canActivateForUser("gone")).toBe(false);
    expect(enumOf(tools.definitions())).toEqual(["alpha", "gone"]);
  });

  test("/compact's re-read keeps the history copy of a removed skill", async () => {
    const { agent } = build(["alpha", "gone"], async () => skillSet(["alpha"]));
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "k1", name: SKILL_TOOL_NAME, arguments: '{"name":"gone"}' }],
      },
      {
        role: "tool",
        toolCallId: "k1",
        content: '<skill_content name="gone">\nOLD COPY\n</skill_content>',
      },
    ];
    await agent.refreshUserSkills();
    const carried = await agent.reloadSkills("s", messages);
    expect(carried.map((c) => [c.name, c.source])).toEqual([["gone", "unavailable"]]);
    expect(carried[0]?.content).toContain("OLD COPY");
  });
});

describe("user rescan vs context reset (T3, F3)", () => {
  test("a reset that installs while the scan runs wins: the stale scan installs nothing", async () => {
    const gate = gated();
    const { agent } = build(["alpha"], gate.scan);
    const pending = agent.refreshUserSkills();
    // A context reset commits meanwhile with a NEWER disk: alpha + gamma.
    agent.installSkills(skillSet(["alpha", "gamma"]));
    // The stale scan (taken before the reset) saw alpha + beta.
    gate.release(skillSet(["alpha", "beta"]));
    const listing = await pending;
    // Mutation (red, verified): drop the generation check → beta is installed.
    expect(listing.skills.map((s) => s.name)).toEqual(["alpha", "gamma"]);
    expect(agent.canActivateForUser("gamma")).toBe(true);
    expect(agent.canActivateForUser("beta")).toBe(false);
  });

  test("a rescan that commits before a reset is overwritten by the reset", async () => {
    const { agent } = build(["alpha"], async () => skillSet(["alpha", "beta"]));
    await agent.refreshUserSkills();
    expect(agent.canActivateForUser("beta")).toBe(true);
    agent.installSkills(skillSet(["alpha", "gamma"]));
    expect(agent.canActivateForUser("beta")).toBe(false);
    expect(agent.skillListing().skills.map((s) => s.name)).toEqual(["alpha", "gamma"]);
  });

  test("two concurrent rescans share one scan", async () => {
    const gate = gated();
    const { agent } = build(["alpha"], gate.scan);
    const a = agent.refreshUserSkills();
    const b = agent.refreshUserSkills();
    gate.release(skillSet(["alpha", "beta"]));
    expect(await a).toBe(await b);
    // Mutation (red, verified): no in-flight sharing → 2 scans.
    expect(gate.calls()).toBe(1);
    // The next ask scans again (not cached forever).
    const c = agent.refreshUserSkills();
    gate.release(skillSet(["alpha"]));
    await c;
    expect(gate.calls()).toBe(2);
  });
});

describe("userRescanListing (pure)", () => {
  const fresh: SkillListing = {
    skills: [
      { name: "a", description: "d", scope: "user", user: true, model: true, location: "/a" },
      { name: "b", description: "d", scope: "user", user: true, model: false, location: "/b" },
      { name: "c", description: "d", scope: "user", user: false, model: true, location: "/c" },
    ],
    problems: ["p"],
  };

  test("model = offered now; the disk's offer not yet given → modelAfterReset; removed → a problem", () => {
    expect(userRescanListing(fresh, ["a", "b", "z"])).toEqual({
      skills: [
        { name: "a", description: "d", scope: "user", user: true, model: true, location: "/a" },
        { name: "b", description: "d", scope: "user", user: true, model: true, location: "/b" },
        {
          name: "c",
          description: "d",
          scope: "user",
          user: false,
          model: false,
          modelAfterReset: true,
          location: "/c",
        },
      ],
      problems: ["p", "z: removed — the model keeps it until a context reset"],
    });
  });

  test("the same set as the model's: no marks, no extra problems", () => {
    expect(userRescanListing(fresh, ["a", "c"]).skills.some((s) => s.modelAfterReset)).toBe(false);
    expect(userRescanListing(fresh, ["a", "c"]).problems).toEqual(["p"]);
  });
});

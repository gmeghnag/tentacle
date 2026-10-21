/**
 * The user's `/name` skill activation: a `skill` round the loop writes before
 * the model's first round (docs/feat/skills-slash.md).
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
  activeSkillNames,
  createSkillActivator,
  createSkillTool,
  skillContentName,
} from "@tentacle/tools";
import { Agent, type AgentEvent, UnknownSkillError } from "../src/agent.ts";
import { Session } from "../src/session.ts";

/** Records a COPY of each request's messages (the loop passes its live array). */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
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

const entry = (name: string, userInvocable = true): SkillActivatorEntry => ({
  name,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  files: [],
  filesTruncated: false,
  userInvocable,
});

const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];

/**
 * An agent wired as `buildAgent` does: the model's `skill` tool over the
 * `offered` names only, the activator over every entry.
 */
function build(
  script: readonly (readonly StreamEvent[])[],
  opts: {
    entries?: readonly SkillActivatorEntry[];
    offered?: readonly string[];
    read?: SkillBodyReader;
  } = {},
): { agent: Agent; model: Scripted } {
  const entries = opts.entries ?? [entry("deploy-app")];
  const read: SkillBodyReader =
    opts.read ?? (async (s) => ({ body: `STEPS for ${s.name}`, bodyLine: 5 }));
  const offered = entries.filter((e) => (opts.offered ?? [e.name]).includes(e.name));
  const tools = new ToolRegistry();
  const tool = createSkillTool(offered, read);
  if (tool) {
    tools.register(tool);
  }
  const model = new Scripted(script);
  const agent = new Agent({
    model,
    tools,
    env,
    systemPrompt: "SYS",
    skills: createSkillActivator(entries, read),
  });
  return { agent, model };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

describe("the user's /name round", () => {
  test("writes [user, assistant{skill call}, tool{content}] before the model's FIRST round", async () => {
    const { agent, model } = build([say("deploying")]);
    const session = new Session(agent, "s");
    const events = await collect(
      session.send("/deploy-app to staging", undefined, { skill: "deploy-app" }),
    );

    const [, user, call, result, reply] = session.messages;
    expect(user).toEqual({ role: "user", content: "/deploy-app to staging" });
    expect(call?.role).toBe("assistant");
    expect(call?.content).toBe("");
    const toolCall = call?.toolCalls?.[0];
    expect(toolCall?.name).toBe(SKILL_TOOL_NAME);
    expect(JSON.parse(toolCall?.arguments ?? "")).toEqual({ name: "deploy-app" });
    expect(result?.role).toBe("tool");
    expect(result?.toolCallId).toBe(toolCall?.id ?? "missing");
    expect(skillContentName(result?.content ?? "")).toBe("deploy-app");
    expect(result?.content).toContain("STEPS for deploy-app");
    expect(reply).toEqual({ role: "assistant", content: "deploying" });

    // The exact property: the model's first request already carries the content.
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]?.at(-1)?.content).toContain("STEPS for deploy-app");
    // …and the derivation reads it as active (dedup, compaction).
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);

    // The same events a model call produces, committed after each push.
    const kinds = events.map((e) => e.type);
    expect(kinds.slice(0, 4)).toEqual([
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
    ]);
    expect(events[1]).toMatchObject({
      type: "tool_start",
      id: toolCall?.id,
      name: SKILL_TOOL_NAME,
    });
    expect(kinds.at(-1)).toBe("turn_end");
  });

  test("a skill hidden from the model (not in the tool enum, no tool at all) is still activatable", async () => {
    const { agent, model } = build([say("ok")], { offered: [] });
    const session = new Session(agent, "s");
    await collect(session.send("/deploy-app", undefined, { skill: "deploy-app" }));
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
    expect(model.seen[0]?.at(-1)?.content).toContain("STEPS for deploy-app");
  });

  test("already active → the round carries the 'already loaded' note, not the body again", async () => {
    let reads = 0;
    const { agent } = build([say("one"), say("two")], {
      read: async () => {
        reads++;
        return { body: "BODY", bodyLine: 5 };
      },
    });
    const session = new Session(agent, "s");
    await collect(session.send("/deploy-app", undefined, { skill: "deploy-app" }));
    await collect(session.send("/deploy-app again", undefined, { skill: "deploy-app" }));
    expect(reads).toBe(1);
    const results = session.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(results[1]?.content).toContain("already loaded");
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
  });

  test("an unreadable SKILL.md → an error result in the round; the turn goes on", async () => {
    const { agent, model } = build([say("it failed")], {
      read: async () => {
        throw new Error("ENOENT");
      },
    });
    const session = new Session(agent, "s");
    const events = await collect(session.send("/deploy-app", undefined, { skill: "deploy-app" }));
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.result.isError).toBe(true);
    expect(activeSkillNames(session.messages)).toEqual([]);
    expect(model.seen).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  test("a cancel during a hung read answers the call as cancelled and ends the turn", async () => {
    const { agent, model } = build([say("never")], {
      read: () => new Promise(() => {}),
    });
    const session = new Session(agent, "s");
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of session.send("/deploy-app", ac.signal, { skill: "deploy-app" })) {
      events.push(e);
      if (e.type === "tool_start") {
        setTimeout(() => ac.abort(), 5);
      }
    }
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.result.isError).toBe(true);
    expect(result?.type === "tool_result" && result.result.content).toContain("Cancelled");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(model.seen).toHaveLength(0);
    // The round stays answered: every call has its result.
    const call = session.messages.find((m) => m.role === "assistant")?.toolCalls?.[0];
    expect(session.messages.some((m) => m.role === "tool" && m.toolCallId === call?.id)).toBe(true);
  });

  test("Session.send refuses a skill the user cannot activate, before pushing anything", async () => {
    const { agent } = build([say("x")], {
      entries: [entry("deploy-app"), entry("model-only", false)],
    });
    const session = new Session(agent, "s");
    const before = [...session.messages];
    for (const [text, skill] of [
      ["/nope", "nope"],
      ["/model-only", "model-only"],
      ["", "deploy-app"],
    ] as const) {
      await expect(collect(session.send(text, undefined, { skill }))).rejects.toBeInstanceOf(
        UnknownSkillError,
      );
    }
    expect(session.messages).toEqual(before);
    expect(session.canActivateSkill("deploy-app")).toBe(true);
    expect(session.canActivateSkill("model-only")).toBe(false);
  });

  test("an agent without skills activates nothing for the user", () => {
    const agent = new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env });
    expect(agent.canActivateForUser("deploy-app")).toBe(false);
  });

  test("a user skill combined with a resume is a caller bug, rejected before anything runs", async () => {
    const { agent } = build([]);
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }] },
    ];
    await expect(
      collect(
        agent.runMessages(messages, "s", undefined, undefined, {
          resumeFrom: "c1",
          skill: "deploy-app",
        }),
      ),
    ).rejects.toThrow("resuming");
    expect(messages).toHaveLength(3);
  });

  test("/compact after a user-activated HIDDEN skill re-reads it fresh (not 'unavailable')", async () => {
    let version = 1;
    const { agent } = build([say("ok"), say("brief")], {
      offered: [],
      read: async () => ({ body: `BODY v${version}`, bodyLine: 5 }),
    });
    const session = new Session(agent, "s");
    await collect(session.send("/deploy-app", undefined, { skill: "deploy-app" }));
    version = 2;
    await session.compact();
    expect(activeSkillNames(session.messages)).toEqual(["deploy-app"]);
    const carried = session.messages.find((m) => m.role === "tool");
    expect(carried?.content).toContain("BODY v2");
    expect(session.messages[1]?.content).not.toContain("No longer in the Skills list");
  });
});

import { describe, expect, test } from "bun:test";
import { type SkillInfo, composeSystemPrompt } from "@tentacle/config";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  ToolCall,
} from "@tentacle/core";
import {
  CONTEXT_RESET_TOOL_NAME,
  SKILL_TOOL_NAME,
  ToolRegistry,
  createContextResetTool,
  createSkillActivator,
  createSkillTool,
} from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig, type AgentEvent, type SessionSkills } from "../src/agent.ts";
import { NO_CAPABILITIES, type SessionCapabilities } from "../src/capabilities.ts";
import { type CarriedSkill, carryOverSkills } from "../src/compact.ts";
import type { SkillListing } from "../src/session-skills.ts";
import { Session } from "../src/session.ts";
import { createSubagentRunner } from "../src/subagent.ts";

// docs/feat/session-capabilities.md, slice S2: the agent loop projects every
// model request through the session's capability switches — the tool list,
// the `skill` enum and the system prompt's catalog — judges a round's calls
// against that round's snapshot, and carries no disabled skill across a reset.

const MAX_MODEL_CALLS = 12;
const ECHO = "mcp__echo__echo";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  /** Runs when request `n` (0-based) arrives, BEFORE its reply streams: a mid-stream toggle. */
  onRequest: (n: number) => void = () => {};
  /** Requests handed to `countTokens` (the exact-count path of `contextUsage`). */
  readonly counted: ChatRequest[] = [];
  countTokens?: (request: ChatRequest) => Promise<number>;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.requests.length >= MAX_MODEL_CALLS) {
      throw new Error("runaway: too many model calls");
    }
    this.requests.push(request);
    this.onRequest(this.requests.length - 1);
    for (const event of this.script[this.turn++] ?? [{ type: "text", delta: "end" }]) {
      yield event;
    }
    yield { type: "done" };
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const call = (id: string, name: string, args: unknown = {}): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const calls = (...c: ToolCall[]): StreamEvent[] =>
  c.map((toolCall) => ({ type: "tool_call", toolCall }));

/** An MCP tool of server `echo`, tagged as the adapter tags it; `log` records each run. */
function echoTool(log: string[]): Tool<{ text?: string | undefined }> {
  return {
    name: ECHO,
    description: "echo",
    inputSchema: z.object({ text: z.string().optional() }),
    permission: "none",
    mcpServer: "echo",
    async execute(input) {
      log.push(input.text ?? "");
      return { content: "echoed" };
    },
  };
}

const info = (name: string): SkillInfo => ({
  name,
  description: `does ${name}`,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  scope: "user",
  files: [],
  filesTruncated: false,
  modelInvocable: true,
  userInvocable: true,
});

const SKILLS = ["k8s", "damajs"];
const promptOf = (names: readonly string[], identity = "ID"): string =>
  composeSystemPrompt({
    identity,
    agentsMd: undefined,
    agentsEnabled: false,
    skills: names.map(info),
  }).systemPrompt;

/** The listing the wiring gives the agent for `names` (all offered to the model now). */
const listingOf = (names: readonly string[]): SkillListing => ({
  skills: names.map((name) => ({
    name,
    description: `does ${name}`,
    scope: "user" as const,
    user: true,
    model: true,
    location: `/s/${name}/SKILL.md`,
  })),
  problems: [],
});

/** A skill set over `names` (body `BODY:<name>`), built as the wiring builds one. */
function skillSet(names: readonly string[], reads: string[] = []): SessionSkills {
  const entries = names.map((name) => ({
    name,
    location: `/s/${name}/SKILL.md`,
    dir: `/s/${name}`,
    files: [],
    filesTruncated: false,
  }));
  const reader = async (s: { name: string }) => {
    reads.push(s.name);
    return { body: `BODY:${s.name}`, bodyLine: 1 };
  };
  return {
    tool: createSkillTool(entries, reader),
    activator: createSkillActivator(
      entries.map((e) => ({ ...e, userInvocable: true })),
      reader,
    ),
    listing: listingOf(names),
  };
}

interface Harness {
  readonly agent: Agent;
  readonly session: Session;
  readonly model: ScriptedProvider;
  readonly tools: ToolRegistry;
  readonly echoed: string[];
  readonly reads: string[];
}

function harness(o: {
  script: readonly (readonly StreamEvent[])[];
  capabilities?: SessionCapabilities;
  extra?: Partial<AgentConfig>;
  reset?: boolean;
}): Harness {
  const echoed: string[] = [];
  const reads: string[] = [];
  const skills = skillSet(SKILLS, reads);
  const tools = new ToolRegistry().register(echoTool(echoed));
  if (skills.tool) {
    tools.register(skills.tool);
  }
  if (o.reset) {
    tools.register(createContextResetTool());
  }
  const model = new ScriptedProvider(o.script);
  const agent = new Agent({
    model,
    tools,
    env: noopEnv,
    systemPrompt: promptOf(SKILLS),
    ...(skills.activator ? { skills: skills.activator } : {}),
    ...(skills.listing ? { skillListing: skills.listing } : {}),
    ...(o.capabilities ? { capabilities: o.capabilities } : {}),
    ...(o.reset
      ? {
          contextReset: {
            maxPerMessage: -1,
            refresh: async () => ({
              systemPrompt: promptOf(SKILLS, "FRESH"),
              skills: skillSet(SKILLS, reads),
            }),
          },
        }
      : {}),
    ...o.extra,
  });
  const session = new Session(agent, "s1");
  return { agent, session, model, tools, echoed, reads };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

const resultOf = (events: readonly AgentEvent[], id: string): string | undefined => {
  const r = events.find((e) => e.type === "tool_result" && e.id === id);
  return r?.type === "tool_result" ? r.result.content : undefined;
};
const toolNames = (r: ChatRequest | undefined): string[] => (r?.tools ?? []).map((t) => t.name);
const systemOf = (r: ChatRequest | undefined): string => {
  const first: ChatMessage | undefined = r?.messages[0];
  return first?.role === "system" && typeof first.content === "string" ? first.content : "";
};
const skillEnumOf = (r: ChatRequest | undefined): unknown =>
  (
    r?.tools?.find((t) => t.name === SKILL_TOOL_NAME)?.parameters.properties as
      | { name?: { enum?: unknown } }
      | undefined
  )?.name?.enum;
const off = (over: Partial<SessionCapabilities>): SessionCapabilities => ({
  ...NO_CAPABILITIES,
  ...over,
});

describe("the round's request is projected through the switches", () => {
  test("F1/F2: a mid-stream toggle leaves the in-flight request and its calls alone; the NEXT request is projected", async () => {
    const h = harness({
      script: [
        calls(call("c1", ECHO, { text: "one" })),
        // The model "remembers" the tool from history: hidden by now (F3).
        calls(call("c2", ECHO, { text: "two" })),
        [{ type: "text", delta: "done" }],
      ],
    });
    h.model.onRequest = (n) => {
      if (n === 0) {
        h.agent.setCapabilities(off({ disabledMcp: ["echo"], disabledSkills: ["k8s"] }));
      }
    };
    const events = await collect(h.session.send("go"));
    const [first, second] = h.model.requests;
    // In flight when toggled: built from the old snapshot.
    expect(toolNames(first)).toContain(ECHO);
    expect(systemOf(first)).toContain("<name>k8s</name>");
    // Its call was visible in ITS snapshot: it ran (F2).
    expect(resultOf(events, "c1")).toBe("echoed");
    // The next request: no echo tool, no k8s in the enum, and a system prompt
    // byte-equal to one composed without k8s.
    expect(toolNames(second)).not.toContain(ECHO);
    expect(skillEnumOf(second)).toEqual(["damajs"]);
    expect(systemOf(second)).toBe(promptOf(["damajs"]));
    // A call to the now-hidden tool is answered, never executed (F3).
    expect(resultOf(events, "c2")).toBe(`${ECHO} is turned off for this session`);
    expect(h.echoed).toEqual(["one"]);
    // The stored history is untouched: the full prompt is still there.
    expect(h.session.messages[0]?.content).toBe(promptOf(SKILLS));
  });

  test("skill{name} of a disabled skill is answered 'turned off', never read", async () => {
    const h = harness({
      capabilities: off({ disabledSkills: ["k8s"] }),
      script: [
        calls(call("c1", SKILL_TOOL_NAME, { name: "k8s" })),
        [{ type: "text", delta: "ok" }],
      ],
    });
    const events = await collect(h.session.send("go"));
    expect(skillEnumOf(h.model.requests[0])).toEqual(["damajs"]);
    expect(resultOf(events, "c1")).toBe('skill "k8s" is turned off for this session');
    expect(h.reads).not.toContain("k8s");
  });

  test("F11: everything off → no `skill` tool, no catalog, built-ins only", async () => {
    const h = harness({
      capabilities: off({ disabledMcp: ["echo"], disabledSkills: SKILLS }),
      script: [[{ type: "text", delta: "ok" }]],
    });
    await collect(h.session.send("go"));
    expect(toolNames(h.model.requests[0])).toEqual([]);
    expect(systemOf(h.model.requests[0])).toBe("ID");
  });

  test("F13: an MCP server's tools registered AFTER the toggle are hidden by their tag", async () => {
    const h = harness({
      capabilities: off({ disabledMcp: ["late"] }),
      script: [
        calls(call("c1", SKILL_TOOL_NAME, { name: "damajs" })),
        [{ type: "text", delta: "ok" }],
      ],
    });
    h.model.onRequest = (n) => {
      if (n === 0) {
        h.tools.register({ ...echoTool([]), name: "mcp__late__x", mcpServer: "late" });
      }
    };
    await collect(h.session.send("go"));
    expect(toolNames(h.model.requests[1])).not.toContain("mcp__late__x");
    expect(toolNames(h.model.requests[1])).toContain(ECHO);
  });

  test("a GROUPED round (read-only mode) still refuses the hidden server's call", async () => {
    // Production default: `read-only`, so read-class MCP calls of one round
    // run as a group (`runGroup`), not one by one. The skill tool is
    // exclusive (never grouped), so the hidden thing in a group is an MCP tool.
    const readKeys = [{ mode: "read", resource: "mcp:echo" }] as const;
    const otherRan: string[] = [];
    const h = harness({
      capabilities: off({ disabledMcp: ["echo"] }),
      extra: { toolExecution: { mode: "read-only", maxParallel: 2 } },
      script: [
        calls(call("g1", ECHO, { text: "hidden" }), call("g2", "mcp__other__x")),
        [{ type: "text", delta: "ok" }],
      ],
    });
    h.tools.replace(ECHO, { ...echoTool(h.echoed), concurrency: () => readKeys });
    h.tools.register({
      ...echoTool([]),
      name: "mcp__other__x",
      mcpServer: "other",
      concurrency: () => [{ mode: "read", resource: "mcp:other" }],
      async execute() {
        otherRan.push("x");
        return { content: "other ran" };
      },
    });
    const events = await collect(h.session.send("go"));
    expect(events.some((e) => e.type === "tool_phase" && e.id === "g2")).toBe(true);
    expect(resultOf(events, "g1")).toBe(`${ECHO} is turned off for this session`);
    expect(h.echoed).toEqual([]);
    expect(resultOf(events, "g2")).toBe("other ran");
    expect(otherRan).toEqual(["x"]);
  });

  test("F15: the user's own /name of a disabled skill still runs", async () => {
    const h = harness({
      capabilities: off({ disabledSkills: ["k8s"] }),
      script: [[{ type: "text", delta: "ok" }]],
    });
    await collect(h.session.send("/k8s", undefined, { skill: "k8s" }));
    expect(h.reads).toContain("k8s");
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain("BODY:k8s");
  });

  test("the step-limit final request's system prompt is projected too", async () => {
    const h = harness({
      capabilities: off({ disabledSkills: ["k8s"] }),
      extra: { maxIterations: 1 },
      script: [calls(call("c1", ECHO)), [{ type: "text", delta: "report" }]],
    });
    await collect(h.session.send("go"));
    expect(h.model.requests).toHaveLength(2);
    expect(systemOf(h.model.requests[1])).toBe(promptOf(["damajs"]));
  });
});

describe("sub-agents follow the parent's live switches", () => {
  test("a child's request lacks the hidden server's tools", async () => {
    let state: SessionCapabilities = NO_CAPABILITIES;
    const echoed: string[] = [];
    const child = new ScriptedProvider([
      calls(call("e1", ECHO, { text: "child" })),
      [{ type: "text", delta: "report" }],
    ]);
    // The parent's user toggles WHILE the child's first round streams: the
    // child reads the switches live, per round — not a copy taken at spawn.
    child.onRequest = (n) => {
      if (n === 0) {
        state = off({ disabledMcp: ["echo"] });
      }
    };
    const { run } = createSubagentRunner({
      model: child,
      env: noopEnv,
      tools: new ToolRegistry().register(echoTool(echoed)),
      capabilities: () => state,
    });
    await run({ description: "d", prompt: "p", type: "general" });
    expect(child.requests).toHaveLength(2);
    expect(toolNames(child.requests[0])).toContain(ECHO);
    expect(echoed).toEqual(["child"]);
    expect(toolNames(child.requests[1])).not.toContain(ECHO);
  });
});

describe("contextUsage counts what is really sent", () => {
  test("the exact count is asked for the projected request", async () => {
    const h = harness({
      capabilities: off({ disabledMcp: ["echo"], disabledSkills: ["k8s"] }),
      script: [],
    });
    h.model.countTokens = async (r) => {
      h.model.counted.push(r);
      return 42;
    };
    expect(await h.agent.contextUsage(h.session.messages)).toEqual({ used: 42, exact: true });
    expect(toolNames(h.model.counted[0])).not.toContain(ECHO);
    expect(systemOf(h.model.counted[0])).toBe(promptOf(["damajs"]));
  });

  test("the estimate is smaller with things hidden", async () => {
    const on = harness({ script: [] });
    const hidden = harness({
      capabilities: off({ disabledMcp: ["echo"], disabledSkills: ["k8s"] }),
      script: [],
    });
    const a = await on.agent.contextUsage(on.session.messages);
    const b = await hidden.agent.contextUsage(hidden.session.messages);
    expect(a.exact).toBe(false);
    expect(b.used).toBeLessThan(a.used);
  });
});

describe("F12: a context reset keeps the projection and carries no disabled skill", () => {
  test("the restart request is projected and holds no k8s body", async () => {
    const h = harness({
      reset: true,
      script: [
        calls(call("c1", SKILL_TOOL_NAME, { name: "k8s" })),
        calls(call("c2", SKILL_TOOL_NAME, { name: "damajs" })),
        calls(call("c3", CONTEXT_RESET_TOOL_NAME, { prompt: "next: step 2" })),
        [{ type: "text", delta: "on" }],
      ],
    });
    h.model.onRequest = (n) => {
      if (n === 2) {
        h.agent.setCapabilities(off({ disabledSkills: ["k8s"] }));
      }
    };
    await collect(h.session.send("go"));
    const after = h.model.requests[3];
    expect(systemOf(after)).toBe(promptOf(["damajs"], "FRESH"));
    const sent = JSON.stringify(after?.messages.slice(1));
    expect(sent).toContain("BODY:damajs");
    expect(sent).not.toContain("k8s");
  });

  test("/compact (Session.compact) carries no disabled skill's body into the new history", async () => {
    const h = harness({
      script: [
        calls(call("c1", SKILL_TOOL_NAME, { name: "k8s" })),
        calls(call("c2", SKILL_TOOL_NAME, { name: "damajs" })),
        [{ type: "text", delta: "done" }],
        // The summary request of /compact.
        [{ type: "text", delta: "SUMMARY" }],
      ],
    });
    await collect(h.session.send("go"));
    expect(JSON.stringify(h.session.messages)).toContain("BODY:k8s");
    h.agent.setCapabilities(off({ disabledSkills: ["k8s"] }));
    await h.session.compact();
    const after = JSON.stringify(h.session.messages.slice(1));
    expect(after).toContain("SUMMARY");
    expect(after).toContain("BODY:damajs");
    expect(after).not.toContain("BODY:k8s");
  });

  test("carryOverSkills drops a disabled skill from both kept and dropped", () => {
    const carried = (name: string, i: number): CarriedSkill => ({
      name,
      call: call(`k${i}`, SKILL_TOOL_NAME, { name }),
      content: `BODY:${name}`,
      source: "fresh",
      resultIndex: i,
    });
    const skills = [carried("old", 1), carried("k8s", 2), carried("damajs", 3)];
    expect(carryOverSkills(skills, 1_000, ["k8s"])).toEqual({
      kept: [carried("old", 1), carried("damajs", 3)],
      dropped: [],
    });
    expect(carryOverSkills(skills, "BODY:damajs".length, ["k8s"])).toEqual({
      kept: [carried("damajs", 3)],
      dropped: ["old"],
    });
  });
});

// docs/feat/tool-toggles.md: built-in tools switched off (`disabledTools`) go
// through the SAME projection and the SAME execution guard.
describe("built-in tool switches (disabledTools)", () => {
  /** A built-in that asks permission; `ran` counts executions. */
  function spyBuiltin(name: string, ran: string[]): Tool<{ x?: string | undefined }> {
    return {
      name,
      description: `the ${name} tool`,
      inputSchema: z.object({ x: z.string().optional() }),
      permission: "ask",
      async execute() {
        ran.push(name);
        return { content: `${name} ran` };
      },
    };
  }
  const VISUALS = ["chart", "diagram", "present"];

  test("a config-seeded set keeps those tools out of EVERY model request; skill stays", async () => {
    const ran: string[] = [];
    const h = harness({
      capabilities: off({ disabledTools: VISUALS }),
      script: [calls(call("c1", "fs_read")), [{ type: "text", delta: "done" }]],
    });
    for (const n of [...VISUALS, "fs_read"]) h.tools.register(spyBuiltin(n, ran));
    await collect(h.session.send("go"));
    expect(h.model.requests).toHaveLength(2);
    for (const r of h.model.requests) {
      const names = toolNames(r);
      for (const n of VISUALS) expect(names).not.toContain(n);
      expect(names).toContain("fs_read");
      expect(names).toContain(SKILL_TOOL_NAME);
    }
  });

  test("set mid-session: the next request drops the tool, and switching it back restores it", async () => {
    const h = harness({
      script: [
        [{ type: "text", delta: "one" }],
        [{ type: "text", delta: "two" }],
        [{ type: "text", delta: "three" }],
      ],
    });
    h.tools.register(spyBuiltin("chart", []));
    await collect(h.session.send("a"));
    h.agent.setCapabilities(off({ disabledTools: ["chart"] }));
    await collect(h.session.send("b"));
    h.agent.setCapabilities(NO_CAPABILITIES);
    await collect(h.session.send("c"));
    expect(toolNames(h.model.requests[0])).toContain("chart");
    expect(toolNames(h.model.requests[1])).not.toContain("chart");
    expect(toolNames(h.model.requests[2])).toContain("chart");
  });

  test("a call to a disabled tool is refused, never executed, and asks no permission", async () => {
    const ran: string[] = [];
    const asked: string[] = [];
    const h = harness({
      capabilities: off({ disabledTools: ["chart"] }),
      extra: {
        requestPermission: async (req) => {
          asked.push(req.tool);
          return { allowed: true };
        },
      },
      script: [calls(call("c1", "chart", { x: "y" })), [{ type: "text", delta: "ok" }]],
    });
    h.tools.register(spyBuiltin("chart", ran));
    const events = await collect(h.session.send("go"));
    expect(resultOf(events, "c1")).toBe("chart is turned off for this session");
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("the same call runs (through the gate) when the tool is on — the refusal is the switch", async () => {
    const ran: string[] = [];
    const asked: string[] = [];
    const h = harness({
      extra: {
        requestPermission: async (req) => {
          asked.push(req.tool);
          return { allowed: true };
        },
      },
      script: [calls(call("c1", "chart", { x: "y" })), [{ type: "text", delta: "ok" }]],
    });
    h.tools.register(spyBuiltin("chart", ran));
    const events = await collect(h.session.send("go"));
    expect(resultOf(events, "c1")).toBe("chart ran");
    expect(ran).toEqual(["chart"]);
    expect(asked).toEqual(["chart"]);
  });

  test("skill in the set (a hostile seed) never hides the skill tool nor refuses its call", async () => {
    const h = harness({
      capabilities: off({ disabledTools: [SKILL_TOOL_NAME] }),
      script: [
        calls(call("s1", SKILL_TOOL_NAME, { name: "k8s" })),
        [{ type: "text", delta: "ok" }],
      ],
    });
    const events = await collect(h.session.send("go"));
    expect(toolNames(h.model.requests[0])).toContain(SKILL_TOOL_NAME);
    expect(resultOf(events, "s1")).not.toContain("turned off");
    expect(h.reads).toEqual(["k8s"]);
  });

  test("a child (explore) never gets a tool the parent disabled — its own `search` included — and its call is refused", async () => {
    const ran: string[] = [];
    const state = off({ disabledTools: ["search"] });
    const child = new ScriptedProvider([
      calls(call("s1", "search", { pattern: "x" })),
      [{ type: "text", delta: "report" }],
    ]);
    const { run } = createSubagentRunner({
      model: child,
      env: noopEnv,
      tools: new ToolRegistry().register(spyBuiltin("fs_read", ran)),
      capabilities: () => state,
    });
    await run({ description: "d", prompt: "p", type: "explore" });
    expect(child.requests.length).toBeGreaterThan(0);
    for (const r of child.requests) {
      expect(toolNames(r)).toContain("fs_read");
      expect(toolNames(r)).not.toContain("search");
    }
    const answered = child.requests[1]?.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "s1",
    );
    expect(JSON.stringify(answered?.content)).toContain("search is turned off for this session");
    // The child holds no setter: the parent's state is what it was.
    expect(state.disabledTools).toEqual(["search"]);
  });
});

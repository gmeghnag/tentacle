/**
 * The daemon-measured tool duration (docs/fix/tool-duration.md): the wall time
 * of the tool's own run on an injected monotonic clock — never the permission
 * prompt, the `tool_call` pre-hooks or the result transforms — on the
 * `tool_result` event and the tool message; absent on every synthetic result.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  ToolResult,
} from "@tentacle/core";
import { type SkillActivator, ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { HookRunner } from "../src/hooks.ts";
import { Session } from "../src/session.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const e of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield e;
    }
  }
}

const callTurn = (name = "write"): StreamEvent[] => [
  { type: "tool_call", toolCall: { id: "c1", name, arguments: '{"n":1}' } },
  { type: "done" },
];

/** A fake monotonic clock: tests advance `t` where time "passes". */
function clock() {
  const c = { t: 1000, now: () => c.t };
  return c;
}

/** An `ask` tool whose run takes `runMs` on the fake clock. */
function timedTool(c: { t: number }, runMs: number, ran: string[] = []): Tool<{ n: number }> {
  return {
    name: "write",
    description: "write",
    inputSchema: z.object({ n: z.number() }),
    permission: "ask",
    async execute(input) {
      ran.push(`write#${input.n}`);
      c.t += runMs;
      return { content: `ok-${input.n}` };
    },
  };
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

async function run(
  agent: Agent,
  signal?: AbortSignal,
): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const events: AgentEvent[] = [];
  for await (const e of agent.runMessages(messages, "s1", signal)) {
    events.push(e);
  }
  return { events, messages };
}

function onlyResult(events: readonly AgentEvent[]) {
  const results = events.filter((e) => e.type === "tool_result");
  expect(results).toHaveLength(1);
  const result = results[0];
  if (result?.type !== "tool_result") throw new Error("expected a tool_result");
  return result;
}

const toolMessages = (messages: readonly ChatMessage[]) =>
  messages.filter((m) => m.role === "tool");

describe("tool duration: what is measured", () => {
  test("the permission wait is NOT tool time: a 5 s approval + a 200 ms run → 200", async () => {
    // Mutation (red, verified): take the start read above `gate.authorize` → 5200.
    const c = clock();
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200)),
      env,
      now: c.now,
      requestPermission: async () => {
        c.t += 5000; // the user takes 5 s to answer
        return { allowed: true, scope: "once" };
      },
    });
    const { events, messages } = await run(agent);
    expect(onlyResult(events).durationMs).toBe(200);
    expect(toolMessages(messages).map((m) => m.durationMs)).toEqual([200]);
  });

  test("result transforms (spill / summarise / tool_result hooks) are NOT tool time", async () => {
    // Mutation (red, verified): take the end read after `transformResult` → 1200.
    const c = clock();
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200)),
      env,
      now: c.now,
      resultTransforms: [
        (result: ToolResult) => {
          c.t += 1000; // a summarise model call
          return result;
        },
      ],
    });
    const { events, messages } = await run(agent);
    expect(onlyResult(events).durationMs).toBe(200);
    expect(toolMessages(messages).map((m) => m.durationMs)).toEqual([200]);
  });

  test("a tool_call pre-hook that lets the call through is NOT tool time", async () => {
    const c = clock();
    const hookEnv: ExecutionEnvironment = {
      ...env,
      exec: async () => {
        c.t += 3000; // a slow pre-hook
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200)),
      env: hookEnv,
      now: c.now,
      hooks: new HookRunner({
        specs: [{ event: "tool_call", matcher: "write", command: "pre.sh" }],
        env: hookEnv,
        cwd: "/w",
      }),
    });
    const { events } = await run(agent);
    expect(onlyResult(events).durationMs).toBe(200);
  });

  test("an unknown tool is measured too (the registry ran; ~0 ms and true)", async () => {
    const c = clock();
    const agent = new Agent({
      model: new Scripted([callTurn("nope")]),
      tools: new ToolRegistry(),
      env,
      now: c.now,
    });
    const { events, messages } = await run(agent);
    const result = onlyResult(events);
    expect(result.result.isError).toBe(true);
    expect(result.durationMs).toBe(0);
    expect(toolMessages(messages).map((m) => m.durationMs)).toEqual([0]);
  });

  test("the default clock is real and gives an integer ms ≥ 0", async () => {
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool({ t: 0 }, 0)),
      env,
    });
    const { events } = await run(agent);
    const ms = onlyResult(events).durationMs;
    expect(Number.isInteger(ms)).toBe(true);
    expect((ms ?? -1) >= 0).toBe(true);
  });
});

describe("tool duration: synthetic results carry none", () => {
  // Mutation (red, verified): stamp a duration on every `toolMessage` → these fail.
  function expectNoDuration(events: readonly AgentEvent[], messages: readonly ChatMessage[]) {
    const result = onlyResult(events);
    expect(result.result.isError).toBe(true);
    expect("durationMs" in result).toBe(false);
    const [message] = toolMessages(messages);
    expect(message).toBeDefined();
    expect(message !== undefined && "durationMs" in message).toBe(false);
  }

  test("denied by the user", async () => {
    const c = clock();
    const ran: string[] = [];
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200, ran)),
      env,
      now: c.now,
      requestPermission: async () => ({ allowed: false }),
    });
    const { events, messages } = await run(agent);
    expect(ran).toEqual([]);
    expectNoDuration(events, messages);
  });

  test("blocked by a tool_call hook", async () => {
    const c = clock();
    const hookEnv: ExecutionEnvironment = {
      ...env,
      exec: async () => ({ stdout: "", stderr: "no", exitCode: 2 }),
    };
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200)),
      env: hookEnv,
      now: c.now,
      hooks: new HookRunner({
        specs: [{ event: "tool_call", matcher: "write", command: "deny.sh" }],
        env: hookEnv,
        cwd: "/w",
      }),
    });
    const { events, messages } = await run(agent);
    expect(onlyResult(events).result.hook?.action).toBe("blocked");
    expectNoDuration(events, messages);
  });

  test("approved after the cancel (the tool never starts)", async () => {
    const c = clock();
    const ran: string[] = [];
    const ac = new AbortController();
    const agent = new Agent({
      model: new Scripted([callTurn()]),
      tools: new ToolRegistry().register(timedTool(c, 200, ran)),
      env,
      now: c.now,
      requestPermission: async () => {
        ac.abort(); // the cancel lands while the prompt is open
        return { allowed: true, scope: "once" };
      },
    });
    const { events, messages } = await run(agent, ac.signal);
    expect(ran).toEqual([]);
    expectNoDuration(events, messages);
  });

  test("cancelled before start (a later call of the round)", async () => {
    const c = clock();
    const ac = new AbortController();
    const first: Tool<{ n: number }> = {
      ...timedTool(c, 200),
      permission: "none",
      async execute() {
        ac.abort(); // the cancel lands while call #1 runs
        return { content: "ok" };
      },
    };
    const agent = new Agent({
      model: new Scripted([
        [
          { type: "tool_call", toolCall: { id: "c1", name: "write", arguments: '{"n":1}' } },
          { type: "tool_call", toolCall: { id: "c2", name: "write", arguments: '{"n":2}' } },
          { type: "done" },
        ],
      ]),
      tools: new ToolRegistry().register(first),
      env,
      now: c.now,
    });
    const { events, messages } = await run(agent, ac.signal);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.id)).toEqual(["c1", "c2"]);
    const c2 = results[1];
    expect(c2 !== undefined && "durationMs" in c2).toBe(false);
    const m2 = toolMessages(messages).find((m) => m.toolCallId === "c2");
    expect(m2?.content).toContain("Cancelled");
    expect(m2 !== undefined && "durationMs" in m2).toBe(false);
  });
});

describe("tool duration: the user's /skill round", () => {
  function stubActivator(c: { t: number }): SkillActivator {
    return {
      has: () => true,
      userInvocable: () => true,
      async activate(name) {
        c.t += 30;
        return { content: `<skill_content name="${name}">x</skill_content>` };
      },
    };
  }

  test("brackets the activator's read only → 30", async () => {
    // Mutation (red, verified): drop the brackets in runUserSkill → no duration.
    const c = clock();
    const agent = new Agent({
      model: new Scripted([]),
      tools: new ToolRegistry(),
      env,
      now: c.now,
      skills: stubActivator(c),
      resultTransforms: [
        (result: ToolResult) => {
          c.t += 1000;
          return result;
        },
      ],
    });
    const session = new Session(agent, "s");
    const events: AgentEvent[] = [];
    for await (const e of session.send("/x", undefined, { skill: "x" })) {
      events.push(e);
    }
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" ? result.durationMs : "none").toBe(30);
    expect(toolMessages(session.messages).map((m) => m.durationMs)).toEqual([30]);
  });

  test("cancelled before the read → none", async () => {
    const c = clock();
    const ac = new AbortController();
    ac.abort();
    const agent = new Agent({
      model: new Scripted([]),
      tools: new ToolRegistry(),
      env,
      now: c.now,
      skills: stubActivator(c),
    });
    const session = new Session(agent, "s");
    const events: AgentEvent[] = [];
    for await (const e of session.send("/x", ac.signal, { skill: "x" })) {
      events.push(e);
    }
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" ? result.result.content : "none").toContain("Cancelled");
    expect(result !== undefined && "durationMs" in result).toBe(false);
    const [message] = toolMessages(session.messages);
    expect(message).toBeDefined();
    expect(message !== undefined && "durationMs" in message).toBe(false);
  });
});

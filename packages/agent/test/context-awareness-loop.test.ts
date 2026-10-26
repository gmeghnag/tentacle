/**
 * Context awareness in the agent loop (docs/feat/context-awareness.md): which
 * message carries the `[context: …]` line, what it counts, and the property the
 * provider's prompt cache depends on — a request never changes the bytes of a
 * message an earlier request already sent.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  HeuristicTokenCounter,
  type ModelProvider,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig } from "../src/agent.ts";
import { contextLine } from "../src/context-awareness.ts";
import { Session } from "../src/session.ts";
import { createSubagentRunner } from "../src/subagent.ts";

const counter = new HeuristicTokenCounter();

/** Replays a script, one round per request, and keeps a deep copy of each request. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
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

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const call = (id: string, n = 1): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "echo", arguments: JSON.stringify({ n }) },
});
const done = (promptTokens?: number): StreamEvent =>
  promptTokens === undefined
    ? { type: "done" }
    : { type: "done", usage: { promptTokens, completionTokens: 900 } };

function agentWith(model: ModelProvider, extra: Partial<AgentConfig> = {}): Agent {
  const tools = new ToolRegistry();
  tools.register(echo);
  return new Agent({
    model,
    tools,
    env,
    systemPrompt: "sys",
    contextAwareness: { window: 1000, stepPercent: 1 },
    ...extra,
  });
}

async function send(session: Session, text: string): Promise<void> {
  for await (const _ of session.send(text)) {
    // drain
  }
}

const LINE = /\n\n\[context: [^\]]+\]$/;
/** The message without its context field (what the loop counted before annotating it). */
const plain = (m: ChatMessage): ChatMessage => {
  const { contextUsage: _, ...rest } = m;
  return rest;
};

describe("context awareness in the agent loop", () => {
  test("the user prompt carries the first line; the model sees it, the history keeps clean content", async () => {
    const model = new Scripted([[{ type: "text", delta: "hi" }, done()]]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    const user = session.messages[1];
    expect(user?.content).toBe("go");
    expect(user?.contextUsage).toBeDefined();
    const sent = model.requests[0]?.messages[1]?.content ?? "";
    expect(sent).toBe(`go\n\n${contextLine(user?.contextUsage ?? { used: 0, window: 1 })}`);
    expect(model.requests[0]?.messages[1]).not.toHaveProperty("contextUsage");
  });

  test("with no usage reported the count is the heuristic over the history plus the tool definitions", async () => {
    const model = new Scripted([[{ type: "text", delta: "hi" }, done()]]);
    const agent = agentWith(model);
    const session = new Session(agent, "s1");
    await send(session, "go");
    const tools = model.requests[0]?.tools ?? [];
    expect(tools.length).toBe(1);
    expect(session.messages[1]?.contextUsage).toEqual({
      used:
        counter.countMessages([
          { role: "system", content: "sys" },
          { role: "user", content: "go" },
        ]) + counter.countText(JSON.stringify(tools)),
      window: 1000,
    });
  });

  test("with usage, the count is the measured prompt plus only what came after it (never completion tokens)", async () => {
    const model = new Scripted([
      [call("c1"), done(400)],
      [{ type: "text", delta: "ok" }, done(500)],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    // system, user, assistant(call), tool, assistant
    const tool = session.messages[3];
    expect(tool?.role).toBe("tool");
    expect(tool?.content).toBe("echoed 1");
    const after = session.messages.slice(2, 4).map(plain);
    expect(tool?.contextUsage).toEqual({ used: 400 + counter.countMessages(after), window: 1000 });
    // Request 2 carries it on the tool result, rendered.
    const sent = model.requests[1]?.messages[3]?.content ?? "";
    expect(sent).toMatch(LINE);
    expect(sent.startsWith("echoed 1\n\n[context: ")).toBe(true);
  });

  test("several tool results in one round: only the last one carries the line", async () => {
    const model = new Scripted([[call("c1", 1), call("c2", 2), done(400)]]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools.length).toBe(2);
    expect(tools[0]?.contextUsage).toBeUndefined();
    expect(tools[1]?.contextUsage).toBeDefined();
  });

  test("a jump of several steps is ONE line with the new value", async () => {
    const model = new Scripted([
      [call("c1"), done(400)],
      [call("c2"), done(470)],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    // system, user, assistant, tool, assistant, tool, assistant
    const m = session.messages;
    const lines = m.flatMap((x) => (x.contextUsage ? [x.contextUsage] : []));
    // The prompt's first line, then exactly one per request: ~4x%, then ~4(7+)%.
    expect(lines.length).toBe(3);
    expect(m[3]?.contextUsage?.used).toBe(400 + counter.countMessages(m.slice(2, 4).map(plain)));
    expect(m[5]?.contextUsage?.used).toBe(470 + counter.countMessages(m.slice(4, 6).map(plain)));
  });

  test("the same step again emits nothing; a decrease emits nothing", async () => {
    const model = new Scripted([
      [call("c1"), done(400)],
      [call("c2"), done(300)],
      [call("c3"), done(301)],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.contextUsage !== undefined)).toEqual([true, false, false]);
  });

  test("CACHE: every request's messages are a byte-identical prefix of the next request's", async () => {
    const model = new Scripted([
      [call("c1"), done(100)],
      [call("c2"), done(300)],
      [{ type: "text", delta: "" }, done(500)], // an empty round: popped, then nudged
      // A second empty round: popped, the nudge (already SENT) stays last and
      // nothing new is pushed — the crossing to 70% must wait, never rewrite it.
      // (Mutation, red, verified: annotate from index 0 instead of `unseen`.)
      [{ type: "text", delta: "" }, done(700)],
      [call("c3"), done(800)],
      [{ type: "text", delta: "done" }, done(900)],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    await send(session, "again");
    expect(model.requests.length).toBeGreaterThanOrEqual(6);
    for (let k = 0; k + 1 < model.requests.length; k++) {
      const before = model.requests[k]?.messages ?? [];
      const after = model.requests[k + 1]?.messages ?? [];
      // An empty round's assistant message is popped, so the prefix is the request itself.
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    }
    // And the lines did land (non-vacuous): several messages carry one.
    expect(session.messages.filter((m) => m.contextUsage).length).toBeGreaterThanOrEqual(4);
  });

  test("a message an earlier request sent is never replaced (identity)", async () => {
    const seen: ChatMessage[][] = [];
    const inner = new Scripted([
      [call("c1"), done(100)],
      [{ type: "text", delta: "" }, done(500)],
      [{ type: "text", delta: "" }, done(700)], // the sent nudge stays last
      [{ type: "text", delta: "ok" }, done(800)],
    ]);
    let history: ChatMessage[] = [];
    const model: ModelProvider = {
      id: "spy",
      stream(request) {
        seen.push([...history]);
        return inner.stream(request);
      },
    };
    const session = new Session(agentWith(model), "s1");
    history = session.messages;
    await send(session, "go");
    for (const [k, snapshot] of seen.entries()) {
      for (const [i, m] of snapshot.entries()) {
        expect({ k, i, same: session.messages[i] === m }).toEqual({ k, i, same: true });
      }
    }
  });

  test("after a compaction the first request emits again; the summary is never annotated", async () => {
    const model = new Scripted([
      [{ type: "text", delta: "hi" }, done(900)],
      [{ type: "text", delta: "the summary" }, done()], // the compaction's summarize call
      [{ type: "text", delta: "ok" }, done()],
    ]);
    const session = new Session(agentWith(model), "s1");
    await send(session, "go");
    await session.compact();
    const summary = session.messages.at(-1);
    expect(summary?.role).toBe("user");
    expect(session.messages.some((m) => m.contextUsage)).toBe(false);
    await send(session, "next");
    expect(session.messages.find((m) => m.content === "next")?.contextUsage).toBeDefined();
    expect(session.messages.includes(summary as ChatMessage)).toBe(true);
    expect(summary?.contextUsage).toBeUndefined();
  });

  test("disabled: no line is written, but a stored one is still rendered (stable prefix)", async () => {
    const model = new Scripted([
      [call("c1"), done(400)],
      [{ type: "text", delta: "ok" }, done(500)],
    ]);
    const tools = new ToolRegistry();
    tools.register(echo);
    const agent = new Agent({ model, tools, env, systemPrompt: "sys" });
    const stored: ChatMessage = {
      role: "user",
      content: "old",
      contextUsage: { used: 82000, window: 128000 },
    };
    const session = new Session(agent, "s1", {
      messages: [{ role: "system", content: "sys" }, stored, { role: "assistant", content: "a" }],
    });
    await send(session, "go");
    expect(session.messages.filter((m) => m.contextUsage).length).toBe(1);
    for (const r of model.requests) {
      expect(r.messages[1]?.content).toBe("old\n\n[context: 82k / 128k tokens (64%)]");
    }
  });

  test("Agent.run: the given user message carries the first line", async () => {
    const model = new Scripted([[{ type: "text", delta: "hi" }, done()]]);
    for await (const _ of agentWith(model).run("s1", [{ role: "user", content: "task" }])) {
      // drain
    }
    expect(model.requests[0]?.messages[1]?.content).toMatch(/^task\n\n\[context: /);
  });

  test("the final no-tools report renders the stored lines", async () => {
    const model = new Scripted([
      [call("c1"), done(400)],
      [{ type: "text", delta: "report" }, done()],
    ]);
    const session = new Session(agentWith(model, { maxIterations: 1 }), "s1");
    await send(session, "go");
    const final = model.requests[1];
    expect(final?.tools).toBeUndefined();
    expect(final?.messages[1]?.content).toMatch(/^go\n\n\[context: /);
    expect(final?.messages.some((m) => "contextUsage" in m)).toBe(false);
  });

  test("a sub-agent annotates its own history; the parent gets only the report", async () => {
    const child = new Scripted([[{ type: "text", delta: "the report" }, done(250)]]);
    const { run } = createSubagentRunner({
      model: child,
      env,
      tools: new ToolRegistry(),
      contextAwareness: { window: 1000, stepPercent: 1 },
    });
    const result = await run({ type: "general", description: "d", prompt: "do it" });
    expect(result.report).toBe("the report");
    expect(child.requests[0]?.messages.at(-1)?.content).toMatch(/^do it\n\n\[context: /);
  });

  // Review F1: a type with its own model counts against ITS window, not the parent's.
  test("a sub-agent type with its own model + contextWindow counts against that window", async () => {
    // Mutation (red, verified): ignore `type.contextWindow` in subagent.ts → "/ 200k".
    const parent = new Scripted([]);
    const small = new Scripted([[{ type: "text", delta: "r" }, done()]]);
    const plain = new Scripted([[{ type: "text", delta: "r" }, done()]]);
    const types = [
      {
        name: "small",
        description: "d",
        prompt: "p",
        tools: "all" as const,
        model: "small-model",
        contextWindow: 32000,
      },
      { name: "big", description: "d", prompt: "p", tools: "all" as const, model: "big-model" },
    ];
    const { run } = createSubagentRunner({
      model: parent,
      modelFor: (id) => (id === "small-model" ? small : plain),
      env,
      tools: new ToolRegistry(),
      types,
      contextAwareness: { window: 200000, stepPercent: 1 },
    });
    await run({ type: "small", description: "d", prompt: "go" });
    await run({ type: "big", description: "d", prompt: "go" });
    expect(small.requests[0]?.messages.at(-1)?.content).toMatch(/ \/ 32k tokens \(\d+%\)\]$/);
    // No contextWindow on the type → the parent's window (unchanged behaviour).
    expect(plain.requests[0]?.messages.at(-1)?.content).toMatch(/ \/ 200k tokens \(\d+%\)\]$/);
  });
});

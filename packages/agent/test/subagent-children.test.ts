/**
 * What a sub-agent is given, and how it ends (docs/feat/parallel-agents.md,
 * Design 5): T-C1 (its rounds inherit `tools.*`), T-C2 (its spill path),
 * T-C3 (`subagent_end` on a failure).
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  ToolProgressEvent,
} from "@tentacle/core";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent, createSubagentRunner } from "../src/index.ts";
import { spillLargeOutput } from "../src/result-pipeline.ts";

const noopEnv = (writes: { path: string; contents: string }[] = []): ExecutionEnvironment => ({
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  async writeFile(path, contents) {
    writes.push({ path, contents });
  },
});

const call = (id: string, name: string, args: unknown): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});

/** The script of each conversation, chosen by its first user message. */
class ByPrompt implements ModelProvider {
  readonly id = "by-prompt";
  private readonly turns = new Map<string, number>();
  constructor(private readonly scripts: Record<string, readonly (readonly StreamEvent[])[]>) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const key = request.messages.find((m) => m.role === "user")?.content ?? "";
    const turn = this.turns.get(key) ?? 0;
    this.turns.set(key, turn + 1);
    const events = this.scripts[key]?.[turn] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const agentType = { name: "worker", description: "works", prompt: "work", tools: "all" as const };

describe("a child's rounds (T-C1)", () => {
  /** A read-class tool recording how many of it overlap. */
  function overlapping() {
    let running = 0;
    const state = { peak: 0 };
    const tool: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      concurrency: () => [{ mode: "read", resource: "x" }],
      async execute() {
        running++;
        state.peak = Math.max(state.peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { content: "ok" };
      },
    };
    return { tool, state };
  }
  const twoReads = () =>
    new ByPrompt({
      go: [
        [call("r1", "read", { path: "a" }), call("r2", "read", { path: "b" }), { type: "done" }],
      ],
    });

  test("a child gets exactly tools.execution: its reads overlap", async () => {
    const { tool, state } = overlapping();
    const { run } = createSubagentRunner({
      model: twoReads(),
      env: noopEnv(),
      tools: new ToolRegistry().register(tool),
      types: [agentType],
      toolExecution: { mode: "parallel", maxParallel: 8 },
    });
    await run({ description: "d", prompt: "go", type: "worker" });
    expect(state.peak).toBe(2);
  });

  test("tools.execution sequential: they do not overlap", async () => {
    const { tool, state } = overlapping();
    const { run } = createSubagentRunner({
      model: twoReads(),
      env: noopEnv(),
      tools: new ToolRegistry().register(tool),
      types: [agentType],
      toolExecution: { mode: "sequential", maxParallel: 8 },
    });
    await run({ description: "d", prompt: "go", type: "worker" });
    expect(state.peak).toBe(1);
  });

  test("absent: sequential", async () => {
    const { tool, state } = overlapping();
    const { run } = createSubagentRunner({
      model: twoReads(),
      env: noopEnv(),
      tools: new ToolRegistry().register(tool),
      types: [agentType],
    });
    await run({ description: "d", prompt: "go", type: "worker" });
    expect(state.peak).toBe(1);
  });
});

describe("spill paths (T-C2)", () => {
  test("two children with one server call id spill to different files", async () => {
    const noisy: Tool<{ path: string }> = {
      name: "noisy",
      description: "noisy",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      async execute(input) {
        return { content: `${input.path}\n`.repeat(2000) };
      },
    };
    // The same call id from the server in both children (a server may reuse ids).
    const script = (path: string) => [
      [call("same-id", "noisy", { path }), { type: "done" } as StreamEvent],
    ];
    const writes: { path: string; contents: string }[] = [];
    const { run } = createSubagentRunner({
      model: new ByPrompt({ one: script("one"), two: script("two") }),
      env: noopEnv(writes),
      tools: new ToolRegistry().register(noisy),
      types: [agentType],
      resultTransforms: [spillLargeOutput({ maxInlineChars: 100 })],
    });
    await run({ description: "d", prompt: "one", type: "worker" });
    await run({ description: "d", prompt: "two", type: "worker" });
    expect(writes.length).toBe(2);
    expect(writes[0]?.path).not.toBe(writes[1]?.path);
    expect(writes[0]?.path).toContain("noisy-same-id");
    expect(writes[0]?.contents).toContain("one");
    expect(writes[1]?.contents).toContain("two");
  });

  test("the main agent's path is unchanged", async () => {
    const noisy: Tool = {
      name: "noisy",
      description: "noisy",
      inputSchema: z.object({}),
      permission: "none",
      async execute() {
        return { content: "x\n".repeat(5000) };
      },
    };
    const writes: { path: string; contents: string }[] = [];
    const agent = new Agent({
      model: new ByPrompt({ go: [[call("c1", "noisy", {}), { type: "done" }]] }),
      tools: new ToolRegistry().register(noisy),
      env: noopEnv(writes),
      resultTransforms: [spillLargeOutput({ maxInlineChars: 100 })],
    });
    for await (const _ of agent.run("s", [{ role: "user", content: "go" }])) {
      // drained
    }
    expect(writes[0]?.path).toBe(".tentacle/tool-output/noisy-c1.txt");
  });
});

describe("subagent_end on failure (T-C3)", () => {
  test("a child's model throw closes its tree, then the call's isError", async () => {
    const model: ModelProvider = {
      id: "failing",
      async *stream(request) {
        const first = request.messages.find((m) => m.role === "user")?.content;
        if (first === "boom") {
          // biome-ignore lint/correctness/noConstantCondition: a generator that throws first
          if (true) {
            throw new Error("model down");
          }
          yield { type: "done" };
          return;
        }
        if (request.messages.some((m) => m.role === "tool")) {
          yield { type: "done" };
          return;
        }
        yield call("c1", "agent_task", { description: "d", prompt: "boom" });
        yield { type: "done" };
      },
    };
    const tools = new ToolRegistry();
    const { run, types } = createSubagentRunner({
      model,
      env: noopEnv(),
      tools,
      types: [agentType],
    });
    tools.register(createTaskTool((o, c) => run(o, c), types));
    const agent = new Agent({ model, tools, env: noopEnv() });
    const events: AgentEvent[] = [];
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      events.push(event);
    }
    const end = events.findIndex((e) => e.type === "subagent_end");
    const result = events.findIndex((e) => e.type === "tool_result");
    expect(end).toBeGreaterThan(-1);
    expect(end).toBeLessThan(result);
    const ended = events[end];
    expect(ended?.type === "subagent_end" && ended.stopReason).toBe("error");
    const answered = events[result];
    expect(answered?.type === "tool_result" && answered.result.isError).toBe(true);
    expect(answered?.type === "tool_result" && answered.result.content).toContain("model down");
  });

  test("a child that finishes still ends once, with its own reason", async () => {
    const seen: ToolProgressEvent[] = [];
    const { run } = createSubagentRunner({
      model: new ByPrompt({ go: [[{ type: "text", delta: "ok" }, { type: "done" }]] }),
      env: noopEnv(),
      tools: new ToolRegistry(),
      types: [agentType],
    });
    await run(
      { description: "d", prompt: "go", type: "worker" },
      { onEvent: (event) => seen.push(event) },
    );
    expect(seen.filter((e) => e.kind === "subagent_end").length).toBe(1);
  });
});

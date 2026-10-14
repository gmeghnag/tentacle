import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@agent-harness/core";
import { ToolRegistry } from "@agent-harness/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/index.ts";

/** A model whose turns are scripted; records every request it receives. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;

  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

const echoTool: Tool<{ text: string }> = {
  name: "echo",
  description: "Echo text back.",
  inputSchema: z.object({ text: z.string() }),
  permission: "none",
  async execute(input) {
    return { content: input.text };
  },
};

function registryWithEcho(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

describe("Agent.run", () => {
  test("a plain text answer ends the turn", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "Hello" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    const events = await collect(agent.run("s1", [{ role: "user", content: "hi" }]));

    expect(events).toEqual([
      { type: "text", delta: "Hello" },
      { type: "turn_end", reason: "end_turn" },
    ]);
  });

  test("runs a tool call and feeds the result back to the model", async () => {
    const model = new ScriptedProvider([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"hi"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "done!" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    const events = await collect(agent.run("s1", [{ role: "user", content: "use echo" }]));

    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "text", "turn_end"]);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ name: "echo", result: { content: "hi" } });

    // The second model call must see the tool result as a `tool` message.
    const secondTurn = model.requests[1];
    expect(secondTurn?.messages).toContainEqual({
      role: "tool",
      content: "hi",
      toolCallId: "c1",
    });
  });

  test("stops at maxIterations when the model never ends the turn", async () => {
    const loopingModel: ModelProvider = {
      id: "looping",
      async *stream() {
        yield { type: "tool_call", toolCall: { id: "c", name: "echo", arguments: '{"text":"x"}' } };
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      model: loopingModel,
      tools: registryWithEcho(),
      env: noopEnv,
      maxIterations: 2,
    });

    const events = await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_iterations" });
  });

  test("delivers a final tools-less summary turn when it hits maxIterations", async () => {
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"a"}' } }],
      [{ type: "tool_call", toolCall: { id: "c2", name: "echo", arguments: '{"text":"b"}' } }],
      [{ type: "text", delta: "RECOVERED SUMMARY" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv, maxIterations: 2 });

    const events = await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e.type === "text" ? e.delta : ""))
      .join("");
    expect(text).toContain("RECOVERED SUMMARY"); // recovered a report at the cap
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_iterations" });
    // The final summary request offered NO tools (so the model must answer in prose).
    expect(model.requests.at(-1)?.tools ?? []).toHaveLength(0);
  });

  test("maxIterations -1 runs unbounded until the turn ends on its own", async () => {
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "a", name: "echo", arguments: '{"text":"1"}' } }],
      [{ type: "tool_call", toolCall: { id: "b", name: "echo", arguments: '{"text":"2"}' } }],
      [{ type: "tool_call", toolCall: { id: "c", name: "echo", arguments: '{"text":"3"}' } }],
      [{ type: "text", delta: "finally done" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv, maxIterations: -1 });

    const events = await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    // All three tool rounds ran (no cap), and the turn ended normally — not at a limit.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  test("auto-continues when the model stalls with an empty round after a tool call", async () => {
    // Round 1: a tool call. Round 2: an EMPTY response (no text, no tool calls)
    // — the model stalled after the tool result instead of continuing. Round 3:
    // the real answer. On the buggy code the turn ends silently at round 2.
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"x"}' } }],
      [{ type: "done" }], // stall: nothing produced
      [{ type: "text", delta: "resumed answer" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    const events = await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e.type === "text" ? e.delta : ""))
      .join("");
    expect(text).toContain("resumed answer"); // the nudge un-stuck the model
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    // The auto-nudge is internal: it must NOT surface as a user "steer" event.
    expect(events.filter((e) => e.type === "steer")).toHaveLength(0);
  });

  test("an empty-response stall does not loop forever (bounded auto-continue)", async () => {
    // A tool call, then the model returns an empty round every time: the loop
    // nudges a bounded number of times, then gives up with end_turn.
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"x"}' } }],
      // every subsequent turn falls through to the default [{ done }] (empty).
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    const events = await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    // Bounded: one tool round + a small, finite number of empty retries — not 16.
    expect(model.requests.length).toBeLessThanOrEqual(4);
  });

  test("an already-aborted signal cancels immediately", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "unused" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });
    const ac = new AbortController();
    ac.abort();

    const events = await collect(agent.run("s1", [{ role: "user", content: "hi" }], ac.signal));

    expect(events).toEqual([{ type: "turn_end", reason: "cancelled" }]);
  });

  test("a mid-stream abort ends the turn as cancelled, not an error", async () => {
    const ac = new AbortController();
    // Mimics a real provider: some text streams, then the abort rejects the
    // underlying stream read with an AbortError.
    const model: ModelProvider = {
      id: "mid-abort",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "partial" };
        ac.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      },
    };
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    const events = await collect(agent.run("s1", [{ role: "user", content: "hi" }], ac.signal));

    expect(events).toEqual([
      { type: "text", delta: "partial" },
      { type: "turn_end", reason: "cancelled" },
    ]);
  });

  test("a stream error that is not an abort still propagates", async () => {
    const model: ModelProvider = {
      id: "boom",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "x" };
        throw new Error("network boom");
      },
    };
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });

    await expect(collect(agent.run("s1", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      "network boom",
    );
  });
});

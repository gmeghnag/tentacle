import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
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
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv, now: () => 0 });

    const events = await collect(agent.run("s1", [{ role: "user", content: "use echo" }]));

    expect(events.map((e) => e.type)).toEqual([
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
      "text",
      "turn_end",
    ]);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ name: "echo", result: { content: "hi" } });

    // The second model call must see the tool result as a `tool` message (its
    // display-only `durationMs` is dropped by the provider mappers,
    // providers/test/tool-duration.test.ts).
    const secondTurn = model.requests[1];
    expect(secondTurn?.messages).toContainEqual({
      role: "tool",
      content: "hi",
      toolCallId: "c1",
      durationMs: 0,
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

describe("Agent cancel (post-stream / between-tools)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const abortError = () => new DOMException("The operation was aborted", "AbortError");

  /** A model that takes `delayMs` before yielding, then emits `events`. When
   * `honoursAbort` it throws AbortError once the signal has aborted (a real
   * provider); otherwise it completes normally even after the abort (a
   * misbehaving one — the leak this describe-block pins). */
  function lateProvider(
    events: readonly StreamEvent[],
    delayMs: number,
    honoursAbort: boolean,
  ): ModelProvider {
    return {
      id: "late",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        await sleep(delayMs);
        for (const event of events) {
          if (honoursAbort && request.signal?.aborted) {
            throw abortError();
          }
          yield event;
        }
      },
    };
  }

  /** A tool that ignores ctx.signal, runs after `slowMs`, and records starts. */
  function slowTool(name: string, slowMs: number, ran: string[]): Tool<{ n: number }> {
    return {
      name,
      description: name,
      inputSchema: z.object({ n: z.number() }),
      permission: "none",
      async execute(input) {
        ran.push(`${name}#${input.n}`);
        await sleep(slowMs);
        return { content: `ok-${input.n}` };
      },
    };
  }

  function registryWith(ran: string[]): ToolRegistry {
    return new ToolRegistry().register(slowTool("slow", 120, ran));
  }

  test("a stream that completes after the abort does not run its tools", async () => {
    const ran: string[] = [];
    const ac = new AbortController();
    // The cancel lands mid-stream (50 ms) and the model, which ignores its
    // signal, still completes with a tool call (~200 ms).
    const model = lateProvider(
      [{ type: "tool_call", toolCall: { id: "c1", name: "slow", arguments: '{"n":1}' } }],
      200,
      false,
    );
    const agent = new Agent({ model, tools: registryWith(ran), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const timer = setTimeout(() => ac.abort(), 50);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    // No tool may run after the cancel.
    expect(ran).toEqual([]);
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(0);
    // The late round is discarded wholesale: no assistant reply in history.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
  });

  test("a stream that completes after the abort does not keep its reply in history", async () => {
    const ac = new AbortController();
    const model = lateProvider(
      [{ type: "text", delta: "late reply" }, { type: "done" }],
      200,
      false,
    );
    const agent = new Agent({ model, tools: registryWith([]), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const timer = setTimeout(() => ac.abort(), 50);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    // The late reply must not be persisted, and the turn is cancelled, not end_turn.
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  test("a cancel during tool #1 stops tool #2 and answers it synthetically", async () => {
    const ran: string[] = [];
    const ac = new AbortController();
    // The model is fast (returns immediately with two calls); the cancel lands
    // while the slow tool #1 is running.
    const model: ModelProvider = {
      id: "two-calls",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", toolCall: { id: "c1", name: "slow", arguments: '{"n":1}' } };
        yield { type: "tool_call", toolCall: { id: "c2", name: "slow", arguments: '{"n":2}' } };
        yield { type: "done" };
      },
    };
    const agent = new Agent({ model, tools: registryWith(ran), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const timer = setTimeout(() => ac.abort(), 30);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    // Tool #1 already started and ran; tool #2 must not.
    expect(ran).toEqual(["slow#1"]);
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    // Tool #2 is answered (history stays valid) even though it never ran.
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.id)).toEqual(["c1", "c2"]);
    const c2 = results.at(1);
    if (c2?.type !== "tool_result") throw new Error("expected a c2 tool_result event");
    expect(c2.result.isError).toBe(true);
    expect(messages.at(-1)).toEqual({
      role: "tool",
      content: c2.result.content,
      toolCallId: "c2",
    });
    // No dangling tool call: every id in the assistant message has a tool answer.
    const assistant = messages.find((m) => m.role === "assistant");
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    for (const call of assistant?.toolCalls ?? []) {
      expect(answered.has(call.id)).toBe(true);
    }
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
  });

  test("a cancel during the max-iterations final stream ends cancelled and drops the late summary", async () => {
    const ac = new AbortController();
    let calls = 0;
    const model: ModelProvider = {
      id: "cap-late",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool_call", toolCall: { id: "c1", name: "fast", arguments: '{"n":1}' } };
          yield { type: "done" };
          return;
        }
        // The final (tools-less) turn: the model ignores the signal and
        // completes after the abort, with a summary that must not be kept.
        await sleep(200);
        yield { type: "text", delta: "late summary" };
        yield { type: "done" };
      },
    };
    const fastTool: Tool<{ n: number }> = {
      name: "fast",
      description: "fast",
      inputSchema: z.object({ n: z.number() }),
      permission: "none",
      async execute(input) {
        return { content: `ok-${input.n}` };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(fastTool),
      env: noopEnv,
      maxIterations: 1,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const timer = setTimeout(() => ac.abort(), 50);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    // Only the tool-call round is kept; the late final-turn summary is dropped.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("a cancel during the last tool of a capped turn ends cancelled, not max_iterations", async () => {
    const ran: string[] = [];
    const ac = new AbortController();
    const model: ModelProvider = {
      id: "cap-last-tool",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", toolCall: { id: "c1", name: "slow", arguments: '{"n":1}' } };
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      model,
      tools: registryWith(ran),
      env: noopEnv,
      maxIterations: 1,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    // The cancel lands while the (only) tool — the turn's last tool — is running.
    const timer = setTimeout(() => ac.abort(), 30);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    // The tool already started and ran; the cap is hit; the user cancelled.
    // The turn must report `cancelled`, not `max_iterations` (the cancel wins).
    expect(ran).toEqual(["slow#1"]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
  });

  test("a tool approved after the cancel does not run", async () => {
    const ran: string[] = [];
    const ac = new AbortController();
    // The model returns one call to an `ask`-level tool immediately.
    const model: ModelProvider = {
      id: "ask-tool",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", toolCall: { id: "c1", name: "write", arguments: '{"n":1}' } };
        yield { type: "done" };
      },
    };
    // The `ask` tool: its permission prompt is only answered AFTER the cancel
    // (a headless or non-TUI requester can approve late; the TUI denies on Esc).
    const writeTool: Tool<{ n: number }> = {
      name: "write",
      description: "write",
      inputSchema: z.object({ n: z.number() }),
      permission: "ask",
      async execute(input) {
        ran.push(`write#${input.n}`);
        return { content: `ok-${input.n}` };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(writeTool),
      env: noopEnv,
      // Approves ~100 ms in — well after the cancel at 30 ms.
      requestPermission: async () => {
        await sleep(100);
        return { allowed: true, scope: "once" };
      },
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const timer = setTimeout(() => ac.abort(), 30);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    // The approval arrives after the cancel, so the tool must NOT run.
    expect(ran).toEqual([]);
    // It is answered with the cancel note (isError), not a real result.
    const result = events.find((e) => e.type === "tool_result");
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.result.isError).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
  });

  test("a provider that honours the signal still takes the clean catch path", async () => {
    const ac = new AbortController();
    const model = lateProvider([{ type: "text", delta: "never" }, { type: "done" }], 200, true);
    const agent = new Agent({ model, tools: registryWith([]), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const timer = setTimeout(() => ac.abort(), 50);

    const events = await collect(agent.runMessages(messages, "s1", ac.signal));
    clearTimeout(timer);

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("history_commit (the snapshot cut)", () => {
  /**
   * Drive a turn and check, at every `history_commit`, the exact property the
   * daemon's cut stands on: the history reflects every event yielded so far —
   * and, at every later event, the history is append-only past the last cut
   * (nothing a cut covered is ever removed or replaced).
   */
  async function observe(
    gen: AsyncGenerator<AgentEvent>,
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void = () => {},
  ): Promise<{ events: AgentEvent[]; commits: number }> {
    const events: AgentEvent[] = [];
    let covered: ChatMessage[] = [];
    let commits = 0;
    const appendOnly = (): void => {
      covered.forEach((m, i) => expect(messages[i]).toBe(m));
    };
    for await (const event of gen) {
      appendOnly();
      if (event.type === "history_commit") {
        commits++;
        for (const e of events) {
          if (e.type === "tool_result") {
            // The message carries the event's measured duration, if any (docs/fix/tool-duration.md).
            expect(messages).toContainEqual({
              role: "tool",
              content: e.result.content,
              toolCallId: e.id,
              ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
            });
          } else if (e.type === "steer") {
            expect(messages.some((m) => m.role === "user" && m.content === e.text)).toBe(true);
          } else if (e.type === "tool_start") {
            const calls = messages.flatMap((m) => m.toolCalls ?? []);
            expect(calls.some((c) => c.id === e.id)).toBe(true);
          }
        }
        // All visible assistant text so far is kept (whitespace-only rounds are
        // dropped by design: the empty-round nudge).
        const said = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
        const kept = messages.map((m) => (m.role === "assistant" ? m.content : "")).join("");
        expect(kept.replace(/\s/g, "")).toBe(said.replace(/\s/g, ""));
        covered = [...messages];
      }
      events.push(event);
      onEvent(event);
    }
    appendOnly();
    return { events, commits };
  }

  test("tool rounds commit after the assistant push and after each tool push; the nudge's pop is never covered", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text", delta: "Let me " },
        { type: "text", delta: "look." },
        { type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"one"}' } },
        { type: "tool_call", toolCall: { id: "c2", name: "echo", arguments: '{"text":"two"}' } },
        { type: "done" },
      ],
      // Empty round: pushed, then popped and replaced by the nudge.
      [{ type: "text", delta: " " }, { type: "done" }],
      [
        { type: "tool_call", toolCall: { id: "c3", name: "echo", arguments: '{"text":"three"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "Done." }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const queue: string[] = [];
    const { events, commits } = await observe(
      agent.runMessages(messages, "s1", undefined, () => queue.splice(0)),
      messages,
      // A steer typed during round 1 lands at the next boundary.
      (e) => {
        if (e.type === "tool_result" && e.id === "c1") queue.push("steer-A");
      },
    );
    // Round 1: assistant + two tools; round 3: assistant + one tool.
    expect(commits).toBe(5);
    expect(events.map((e) => e.type)).toEqual([
      "text",
      "text",
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
      "steer",
      "text",
      "context_note",
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
      "text",
      "turn_end",
    ]);
    expect(messages.map((m) => m.content)).toContain("Continue with the task.");
  });

  test("a cancelled tool commits after its synthetic answer", async () => {
    const ac = new AbortController();
    const model: ModelProvider = {
      id: "two-calls",
      async *stream(): AsyncIterable<StreamEvent> {
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "echo", arguments: '{"text":"a"}' },
        };
        yield {
          type: "tool_call",
          toolCall: { id: "c2", name: "echo", arguments: '{"text":"b"}' },
        };
        yield { type: "done" };
      },
    };
    const agent = new Agent({ model, tools: registryWithEcho(), env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const { events, commits } = await observe(
      agent.runMessages(messages, "s1", ac.signal),
      messages,
      // Cancel once tool #1 answered: tool #2 gets the synthetic note.
      (e) => {
        if (e.type === "tool_result" && e.id === "c1") ac.abort();
      },
    );
    expect(commits).toBe(3);
    expect(events.map((e) => e.type)).toEqual([
      "history_commit",
      "tool_start",
      "tool_result",
      "history_commit",
      "tool_result",
      "history_commit",
      "turn_end",
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
  });

  test("the step-limit path commits only inside tool rounds, never after the last drain", async () => {
    const looping: ModelProvider = {
      id: "looping",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        if (request.tools === undefined) {
          yield { type: "text", delta: "Report." };
        } else {
          yield {
            type: "tool_call",
            toolCall: { id: crypto.randomUUID(), name: "echo", arguments: '{"text":"x"}' },
          };
        }
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      model: looping,
      tools: registryWithEcho(),
      env: noopEnv,
      maxIterations: 2,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const { events, commits } = await observe(agent.runMessages(messages, "s1"), messages);
    expect(commits).toBe(4);
    const tail = events.slice(events.findLastIndex((e) => e.type === "history_commit") + 1);
    expect(tail.map((e) => e.type)).toEqual(["text", "turn_end"]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_iterations" });
  });
});

describe("ToolContext.history", () => {
  test("a tool sees the live history: the turn so far, incl. earlier results of the same round", async () => {
    const seen: (readonly ChatMessage[])[] = [];
    const spy: Tool<{ text: string }> = {
      name: "spy",
      description: "records the history it sees",
      inputSchema: z.object({ text: z.string() }),
      permission: "none",
      async execute(input, ctx) {
        seen.push([...(ctx.history ?? [])]);
        return { content: `r-${input.text}` };
      },
    };
    const model = new ScriptedProvider([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "spy", arguments: '{"text":"1"}' } },
        { type: "tool_call", toolCall: { id: "c2", name: "spy", arguments: '{"text":"2"}' } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(spy),
      env: noopEnv,
      now: () => 0,
    });
    await collect(agent.run("s1", [{ role: "user", content: "go" }]));

    expect(seen.length).toBe(2);
    expect(seen[0]?.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The second call of the round sees the first call's result.
    expect(seen[1]?.at(-1)).toEqual({
      role: "tool",
      content: "r-1",
      toolCallId: "c1",
      durationMs: 0,
    });
  });
});

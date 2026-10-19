import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { Session } from "../src/session.ts";

/** Records each request's messages so we can assert what the model saw. */
class RecordingProvider implements ModelProvider {
  readonly id = "rec";
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
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

describe("steering (enqueue mid-turn)", () => {
  test("injects a queued message before the next model round and emits a steer event", async () => {
    // Round 1 produces plain text (no tool calls) → the loop would normally end.
    // We enqueue during round 1, so the agent injects it and runs round 2.
    const model = new RecordingProvider([
      [{ type: "text", delta: "step one" }, { type: "done" }],
      [{ type: "text", delta: "handled the steer" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);

    const events = [];
    for await (const event of session.send("start")) {
      if (event.type === "text" && event.delta === "step one") {
        session.enqueue("actually, also do X"); // queued mid-turn
      }
      events.push(event);
    }

    // A steer event was emitted with the queued text.
    const steer = events.find((e) => e.type === "steer");
    expect(steer).toMatchObject({ type: "steer", text: "actually, also do X" });

    // The model's second round saw the injected user message.
    expect(model.seen).toHaveLength(2);
    const round2 = model.seen[1] ?? [];
    expect(round2.some((m) => m.role === "user" && m.content === "actually, also do X")).toBe(true);

    // The turn only ends after the steer is handled.
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "end_turn" });
  });

  test("a turn with no steering ends normally", async () => {
    const model = new RecordingProvider([[{ type: "text", delta: "done" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);
    const events = [];
    for await (const event of session.send("hi")) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "steer")).toBe(false);
    expect(model.seen).toHaveLength(1);
  });

  test("enqueue clears between turns (a leftover never leaks into the next send)", async () => {
    const model = new RecordingProvider([
      [{ type: "text", delta: "a" }, { type: "done" }],
      [{ type: "text", delta: "b" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);

    // Queue before any turn runs; the next send starts fresh and must NOT inject it.
    session.enqueue("stale");
    for await (const _ of session.send("one")) {
      // drain
    }
    for await (const _ of session.send("two")) {
      // drain
    }
    const everyMessage = model.seen.flat();
    expect(everyMessage.some((m) => m.content === "stale")).toBe(false);
  });

  // A round that only calls a tool; with `maxIterations: 1` the cap is hit right
  // after it and the agent gives the model ONE final no-tools round.
  const toolRound: readonly StreamEvent[] = [
    { type: "tool_call", toolCall: { id: "c1", name: "missing", arguments: "{}" } },
    { type: "done" },
  ];

  test("a message queued during the last allowed round reaches the final report (max_iterations)", async () => {
    const model = new RecordingProvider([
      toolRound,
      [{ type: "text", delta: "report" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, maxIterations: 1 });
    const session = new Session(agent);

    const events = [];
    for await (const event of session.send("start")) {
      if (event.type === "tool_start") {
        session.enqueue("also X"); // queued while the last allowed round runs
      }
      events.push(event);
    }

    expect(events.filter((e) => e.type === "steer")).toEqual([{ type: "steer", text: "also X" }]);
    // The final (no-tools) round saw it, so the report can address it.
    const final = model.seen[1] ?? [];
    expect(final.some((m) => m.role === "user" && m.content === "also X")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "max_iterations" });
  });

  test("a message queued during the final report is kept in history, not dropped (max_iterations)", async () => {
    const model = new RecordingProvider([
      toolRound,
      [{ type: "text", delta: "report" }, { type: "done" }],
      [{ type: "text", delta: "next" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, maxIterations: 1 });
    const session = new Session(agent);

    const events = [];
    for await (const event of session.send("start")) {
      if (event.type === "text" && event.delta === "report") {
        session.enqueue("also Y"); // no round is left to run it in
      }
      events.push(event);
    }

    // Echoed (the client clears its pending entry) and the turn still ends capped…
    expect(events.filter((e) => e.type === "steer")).toEqual([{ type: "steer", text: "also Y" }]);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "max_iterations" });
    // …and it is in the history, so the model sees it on the next turn.
    for await (const _ of session.send("go on")) {
      // drain
    }
    const next = model.seen[2] ?? [];
    expect(next.some((m) => m.role === "user" && m.content === "also Y")).toBe(true);
  });
});

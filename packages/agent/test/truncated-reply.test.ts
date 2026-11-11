/**
 * A reply that was CUT must never be presented as a complete answer
 * (docs/fix/truncated-reply-silent.md, owner Q1a/Q2a).
 *
 * Cases pinned here, all measured on the buggy code first:
 * (1) text + `finish_reason: "length"` — the text is kept, a `truncated_reply`
 *     notice is yielded, and the loop re-asks ONCE from where it stopped;
 * (2) a stream with no stop reason at all — the turn FAILS (`ModelStreamCutError`)
 *     instead of ending `end_turn` with the partial text as the answer;
 * (5) a tool call cut by `length` — the call is NEVER run (on the buggy code it
 *     ran and cost 17 rounds).
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ModelStreamCutError } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { AgentEvent } from "../src/index.ts";
import { Agent } from "../src/index.ts";
import { Session } from "../src/session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A provider that plays one scripted round per model call. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatMessage[][] = [];
  private round = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    for (const event of this.script[this.round++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

const types = (events: readonly AgentEvent[]): string[] => events.map((e) => e.type);

const run = async (
  model: ModelProvider,
  tools = new ToolRegistry(),
): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> => {
  const agent = new Agent({ model, tools, env: noopEnv });
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const events: AgentEvent[] = [];
  for await (const event of agent.runMessages(messages, "s1")) {
    events.push(event);
  }
  return { events, messages };
};

describe("case (1): text cut by finish_reason 'length'", () => {
  test("keeps the text, says so, and re-asks ONCE", async () => {
    const model = new Scripted([
      [
        { type: "text", delta: "la vera" },
        { type: "done", stopReason: "length" },
      ],
      [
        { type: "text", delta: " soluzione" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    const { events, messages } = await run(model);

    // The notice crosses as its own event, and the turn still ends normally.
    expect(events.filter((e) => e.type === "truncated_reply")).toEqual([
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });

    // The re-ask reached the model as a user message telling it to resume.
    expect(model.seen).toHaveLength(2);
    const reask = model.seen[1]?.at(-1);
    expect(reask?.role).toBe("user");
    expect(reask?.content).toContain("cut off at the output limit");

    // Both halves of the answer are in the history, in order.
    const assistant = messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(assistant).toEqual(["la vera", " soluzione"]);
  });

  test("the re-ask is BOUNDED to one: a second cut ends the turn, no loop", async () => {
    const cut = (delta: string): StreamEvent[] => [
      { type: "text", delta },
      { type: "done", stopReason: "length" },
    ];
    const model = new Scripted([cut("a"), cut("b"), cut("c")]);
    const { events } = await run(model);
    // Two calls: the cut round and its one re-ask. A third would be the loop
    // this bound exists to prevent (a full context re-truncates immediately).
    expect(model.seen).toHaveLength(2);
    expect(events.filter((e) => e.type === "truncated_reply")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  test("the ONE re-ask is BOUNDED: the first cut says a re-ask is coming, the second says it is not (Review MEDIUM-2)", async () => {
    // The owner's own case: the reply is cut, the loop re-asks once, and the
    // continuation is cut too. `retrying` is the loop's own fact, so the two
    // notices DIFFER — a frontend guessing it from the reason (as both did)
    // promised a continuation that could never come.
    const cut = (delta: string): StreamEvent[] => [
      { type: "text", delta },
      { type: "done", stopReason: "length" },
    ];
    const model = new Scripted([cut("la vera"), cut(" soluzione")]);
    const { events } = await run(model);
    expect(events.flatMap((e) => (e.type === "truncated_reply" ? [e.retrying] : []))).toEqual([
      true,
      false,
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
  });

  test("a refused cut tool call is never retried: `retrying` is false", async () => {
    // No re-ask follows a refused call (the arguments are partial JSON), so the
    // notice must not promise one.
    const model = new Scripted([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "nope", arguments: "{" } },
        { type: "done", stopReason: "length" },
      ],
    ]);
    const events: AgentEvent[] = [];
    try {
      for await (const event of new Agent({
        model,
        tools: new ToolRegistry(),
        env: noopEnv,
      }).runMessages([{ role: "user", content: "hi" }], "s1")) {
        events.push(event);
      }
    } catch {
      // the turn fails: asserted by the case (5) test above
    }
    expect(events.flatMap((e) => (e.type === "truncated_reply" ? [e.retrying] : []))).toEqual([
      false,
    ]);
  });

  test("the re-ask does not eat the turn's step budget", async () => {
    // `maxIterations: 1`: the cut round is the whole budget, so a re-ask that
    // spent a step would end as max_iterations instead of delivering the rest.
    const model = new Scripted([
      [
        { type: "text", delta: "one" },
        { type: "done", stopReason: "length" },
      ],
      [
        { type: "text", delta: " two" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, maxIterations: 1 });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([
      "one",
      " two",
    ]);
  });
});

describe("case (2): a stream that ends with no stop reason", () => {
  test("FAILS the turn — partial text is not an answer (owner Q2a)", async () => {
    const model = new Scripted([
      [
        { type: "text", delta: "la vera" },
        { type: "done", stopReason: "other" },
      ],
    ]);
    let error: unknown;
    try {
      await run(model);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ModelStreamCutError);
    expect((error as ModelStreamCutError).kind).toBe("no-stop-reason");
    // One call: a cut stream is not retried as if it were a truncation.
    expect(model.seen).toHaveLength(1);
  });

  test("the cut's text is kept in the history, never lost (a later resume shows it)", async () => {
    const model = new Scripted([
      [
        { type: "text", delta: "la vera" },
        { type: "done", stopReason: "other" },
      ],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);
    const seen: AgentEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of session.send("hi")) {
        seen.push(event);
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelStreamCutError);
    // The notice reached the user BEFORE the failure.
    expect(types(seen)).toContain("truncated_reply");
    const { messages } = session;
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "la vera" });
  });
});

describe("case (5): a tool call cut by 'length' is NEVER run", () => {
  test("refused before dispatch: no tool_start, no round loop", async () => {
    let ran = 0;
    const echo = {
      name: "echo",
      description: "echo",
      inputSchema: {
        _def: {},
        parse: (v: unknown) => v,
        safeParse: (v: unknown) => ({ success: true as const, data: v }),
      },
      permission: "none" as const,
      async execute(): Promise<{ content: string }> {
        ran++;
        return { content: "ran" };
      },
    };
    const tools = new ToolRegistry().register(echo as never);
    const model = new Scripted([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "echo", arguments: '{"text":"one' } },
        { type: "done", stopReason: "length" },
      ],
    ]);
    const events: AgentEvent[] = [];
    let error: unknown;
    const agent = new Agent({ model, tools, env: noopEnv });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    try {
      for await (const event of agent.runMessages(messages, "s1")) {
        events.push(event);
      }
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ModelStreamCutError);
    expect((error as ModelStreamCutError).kind).toBe("cut-tool-call");
    // The whole point: the partial call never reached the tool, and the turn
    // did not sit in a retry loop (16 wasted rounds before this fix).
    expect(ran).toBe(0);
    expect(types(events)).not.toContain("tool_start");
    expect(model.seen).toHaveLength(1);
    // The user is told which cut it was, and why the call did not run.
    expect(events.filter((e) => e.type === "truncated_reply")).toEqual([
      { type: "truncated_reply", reason: "length", retrying: false },
    ]);
    expect((error as Error).message).toContain("the call was not run");
  });
});

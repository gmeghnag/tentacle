import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  Tool,
} from "@tentacle/core";
import { DsmlToolCallLeakError } from "@tentacle/core";
import type { StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent, type AgentStopReason } from "../src/agent.ts";
import { Session } from "../src/session.ts";

const noopTool: Tool = {
  name: "noop",
  description: "does nothing",
  inputSchema: z.object({}),
  permission: "none",
  execute: () => Promise.resolve({ content: "ok", isError: false }),
};

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A provider whose rounds leak a DSML tool call, or answer plainly. */
class Leaking implements ModelProvider {
  readonly id = "leaking";
  readonly seen: ChatMessage[][] = [];
  private round = 0;
  /** `true` for a round that leaks (throws), `false` for a plain answer. */
  constructor(private readonly leaks: readonly boolean[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    const leaksThisRound = this.leaks[this.round++] ?? false;
    yield { type: "text", delta: "partial" };
    if (leaksThisRound) {
      throw new DsmlToolCallLeakError(42);
    }
    yield { type: "done" };
  }
}

const run = async (model: ModelProvider): Promise<{ type: string }[]> => {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
  const session = new Session(agent);
  const events: { type: string }[] = [];
  for await (const event of session.send("go")) {
    events.push({ type: event.type });
  }
  return events;
};

describe("a DSML-leaked tool call", () => {
  test("is re-asked ONCE, then the turn proceeds", async () => {
    const model = new Leaking([true, false]);
    const events = await run(model);

    // Two rounds: the leak, then the re-ask.
    expect(model.seen).toHaveLength(2);
    // The re-ask reached the model as a user message naming the mistake.
    const last = model.seen[1] ?? [];
    const note = last.at(-1);
    expect(note?.role).toBe("user");
    expect(note?.content).toContain("DSML");

    // The turn ended normally, not as an error; the notice rides its own event,
    // which crosses the wire as its own display KIND (Review MEDIUM-1).
    expect(events.at(-1)?.type).toBe("turn_end");
    expect(events.filter((e) => e.type === "dsml_leak")).toHaveLength(1);
  });

  test("is bounded: a SECOND leak fails the turn instead of looping", async () => {
    const model = new Leaking([true, true, false]);
    await expect(run(model)).rejects.toBeInstanceOf(DsmlToolCallLeakError);
    // Exactly two attempts: the turn does not sit in a retry loop.
    expect(model.seen).toHaveLength(2);
  });

  test("a re-ask does not cost the turn's step budget", async () => {
    // The bug (docs/fix/reask-budget-and-compact-length.md): the re-ask used to
    // move `budgetFrom` DOWN, so `iteration - budgetFrom` grew by 2 per leak and
    // a small cap (sub-agents run with one) was spent before any real work.
    // Round 0 leaks; every tool-offered round calls the tool; the tool-free
    // final report ends the turn. `maxIterations: 2` must buy TWO real rounds.
    let toolRounds = 0;
    let call = 0;
    const model: ModelProvider = {
      id: "leak-budget",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        const round = call++;
        if (round === 0) {
          yield { type: "text", delta: "x" };
          throw new DsmlToolCallLeakError(42);
        }
        if (request.tools && request.tools.length > 0) {
          toolRounds++;
          yield { type: "tool_call", toolCall: { id: `c${round}`, name: "noop", arguments: "{}" } };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text", delta: "final report" };
        yield { type: "done", stopReason: "stop" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(noopTool),
      env: noopEnv,
      maxIterations: 2,
    });
    const session = new Session(agent);
    const ends: AgentStopReason[] = [];
    for await (const event of session.send("go")) {
      if (event.type === "turn_end") {
        ends.push(event.reason);
      }
    }

    // The exact property: the leak is free, so both real rounds run, then the cap.
    // `budgetFrom--` (the bug) → 0; deleting the line (a re-ask costs a step) → 1.
    expect(toolRounds).toBe(2);
    expect(ends).toEqual(["max_iterations"]);
  });

  test("a leak on the last allowed round still gets its replacement round", async () => {
    // `maxIterations: 1`: round 0 leaks (free), round 1 must still run — with
    // tools offered, answering in text — so the turn ends on its own answer
    // instead of jumping straight to the forced `max_iterations` report.
    let call = 0;
    let lastOfferedTools: boolean | undefined;
    const model: ModelProvider = {
      id: "leak-last-round",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        const round = call++;
        if (round === 0) {
          yield { type: "text", delta: "x" };
          throw new DsmlToolCallLeakError(7);
        }
        lastOfferedTools = (request.tools?.length ?? 0) > 0;
        yield { type: "text", delta: "recovered" };
        yield { type: "done", stopReason: "stop" };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(noopTool),
      env: noopEnv,
      maxIterations: 1,
    });
    const session = new Session(agent);
    const events: AgentEvent[] = [];
    for await (const event of session.send("go")) {
      events.push(event);
    }

    expect(call).toBe(2);
    expect(lastOfferedTools).toBe(true);
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(session.messages.at(-1)?.content).toBe("recovered");
  });

  test("never leaves the leaked text in the history", async () => {
    // The second round sees the history the first leak left behind: the re-ask
    // note, and no assistant message carrying the DSML text.
    const model = new Leaking([true, true]);
    await expect(run(model)).rejects.toBeInstanceOf(DsmlToolCallLeakError);
    const second = model.seen[1] ?? [];
    expect(second.some((m) => m.role === "assistant")).toBe(false);
  });
});

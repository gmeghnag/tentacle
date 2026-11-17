/**
 * The `usage` AgentEvent carries what the daemon cannot see
 * (docs/feat/token-usage-log.md): the 0-based round index inside the turn and
 * how many messages the request carried — so a per-round row can be logged
 * without guessing. The provider's own numbers stay in `usage`, untouched for
 * every existing consumer.
 */
import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig, type AgentEvent, Session } from "@tentacle/agent";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const echo: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ n: z.number() }),
  permission: "none",
  async execute() {
    return { content: "echoed 1" };
  },
};

/** Replays a script, one round per request, keeping each request. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield* this.script[this.turn++] ?? [{ type: "text", delta: "end" }, { type: "done" }];
  }
}

const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "echo", arguments: JSON.stringify({ n: 1 }) },
});
const done = (promptTokens: number): StreamEvent => ({
  type: "done",
  usage: { promptTokens, completionTokens: 7 },
  stopReason: "stop",
});

async function usageEvents(model: ModelProvider, extra: Partial<AgentConfig> = {}) {
  const agent = new Agent({
    model,
    tools: new ToolRegistry().register(echo),
    env,
    systemPrompt: "sys",
    ...extra,
  });
  const events: AgentEvent[] = [];
  const session = new Session(agent, "s1");
  for await (const event of session.send("go")) events.push(event);
  return events.filter((e) => e.type === "usage");
}

describe("the usage event carries round + messages (docs/feat/token-usage-log.md)", () => {
  test("two rounds: round 0 then round 1, each with the message count it sent", async () => {
    // Mutation: `yield { type: "usage", usage: event.usage }` (no round/messages) → both undefined.
    const model = new Scripted([
      [{ type: "text", delta: "a" }, call("c1"), done(100)],
      [{ type: "text", delta: "b" }, done(160)],
    ]);
    const events = await usageEvents(model);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.round)).toEqual([0, 1]);
    expect(events.map((e) => e.messages)).toEqual([
      model.requests[0]?.messages.length ?? -1,
      model.requests[1]?.messages.length ?? -2,
    ]);
    // The second round really did send a longer context (that is the analysis).
    expect(events[1]?.messages ?? 0).toBeGreaterThan(events[0]?.messages ?? 0);
  });

  test("the forced final report is `final: true` and carries NO round", async () => {
    // Mutation: tag the final report with `round: iteration` → it claims a round.
    // A spent step budget (maxIterations 1) forces the no-tools report.
    const model = new Scripted([
      [{ type: "text", delta: "a" }, call("c1"), done(100)],
      [{ type: "text", delta: "report" }, done(200)],
    ]);
    const events = await usageEvents(model, { maxIterations: 1 });
    const last = events.at(-1);
    expect(last?.final).toBe(true);
    expect(last?.round).toBeUndefined();
    expect(last?.messages).toBeDefined();
    expect(last?.messages ?? -1).toBe(model.requests.at(-1)?.messages.length ?? -2);
    expect(last?.usage.promptTokens).toBe(200);
  });

  test("a provider that reports no usage yields no usage event at all", async () => {
    // Mutation: yield `usage: {promptTokens: 0, …}` when the provider said nothing → an event appears.
    const model = new Scripted([
      [
        { type: "text", delta: "a" },
        { type: "done", stopReason: "stop" },
      ],
    ]);
    expect(await usageEvents(model)).toEqual([]);
  });
});

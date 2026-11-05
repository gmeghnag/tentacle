import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, Session } from "../src/index.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

class CountingProvider implements ModelProvider {
  readonly id = "counting";
  readonly counted: ChatRequest[] = [];
  constructor(private readonly count: (r: ChatRequest) => Promise<number | undefined>) {}
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("must not generate");
  }
  countTokens(request: ChatRequest): Promise<number | undefined> {
    this.counted.push(request);
    return this.count(request);
  }
}

function sessionOf(model: ModelProvider, systemPrompt = "sys"): Session {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, systemPrompt });
  return new Session(agent, "s1");
}

describe("Session.contextUsage: the context at open", () => {
  test("a provider that counts: the EXACT figure, from the request the loop would send", async () => {
    const model = new CountingProvider(async () => 4321);
    const session = sessionOf(model);
    expect(await session.contextUsage()).toEqual({ used: 4321, exact: true });
    expect(model.counted).toHaveLength(1);
    expect(model.counted[0]?.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(model.counted[0]?.tools).toBeDefined();
  });

  test("the provider cannot count (undefined): the estimate, not exact", async () => {
    const model = new CountingProvider(async () => undefined);
    const got = await sessionOf(model, "x".repeat(4000)).contextUsage();
    expect(got.exact).toBe(false);
    expect(got.used).toBeGreaterThan(500); // ~4000 chars / 4, tools included
  });

  test("the count throws: the estimate, silently", async () => {
    const model = new CountingProvider(async () => {
      throw new Error("tokenize down");
    });
    const got = await sessionOf(model).contextUsage();
    expect(got.exact).toBe(false);
    expect(got.used).toBeGreaterThan(0);
  });

  test("a provider with no countTokens at all: the estimate", async () => {
    const model: ModelProvider = { id: "bare", stream: async function* () {} };
    expect((await sessionOf(model).contextUsage()).exact).toBe(false);
  });

  test("a slow count is cut at the cap and the estimate answers", async () => {
    const model = new CountingProvider(() => new Promise(() => {})); // never settles
    const started = Date.now();
    const got = await sessionOf(model).contextUsage(undefined, 50);
    expect(got.exact).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a stored context line is rendered into the model's copy, as the loop does", async () => {
    const model = new CountingProvider(async () => 1);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent, "s2", {
      messages: [{ role: "user", content: "hi", contextUsage: { used: 10, window: 100 } }],
    });
    await session.contextUsage();
    expect(model.counted[0]?.messages[0]?.content).toContain("[context: 10 / 100 tokens");
  });
});

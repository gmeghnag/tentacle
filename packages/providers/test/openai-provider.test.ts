import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { ModelRequestError, OpenAIProvider } from "../src/index.ts";

// A fake OpenAI-compatible endpoint that streams a scripted completion:
// two text chunks, a reasoning chunk, a tool call split across two chunks,
// then a usage report — exercising every normalisation path.
const EVENTS: unknown[] = [
  { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { choices: [{ delta: { reasoning_content: "thinking" } }] },
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: " world" } }] },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Rome"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const payload = (await req.json()) as { model: string };
      if (payload.model === "err") {
        return new Response("boom", { status: 500 });
      }
      const sse = `${EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

async function collect(model: string): Promise<StreamEvent[]> {
  const provider = new OpenAIProvider({ baseURL, model });
  const out: StreamEvent[] = [];
  for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
    out.push(event);
  }
  return out;
}

describe("OpenAIProvider.stream", () => {
  test("streams text, reasoning, an assembled tool call, and usage", async () => {
    const events = await collect("test-model");

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello world");

    const reasoning = events.find((e) => e.type === "reasoning");
    expect(reasoning).toEqual({ type: "reasoning", delta: "thinking" });

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({
      type: "tool_call",
      toolCall: { id: "call_1", name: "get_weather", arguments: '{"city":"Rome"}' },
    });

    const done = events.at(-1);
    expect(done).toEqual({
      type: "done",
      usage: { promptTokens: 10, completionTokens: 5 },
      stopReason: "tool_calls",
      // reasoning-echo D2: the streamed reasoning rides on `done`.
      reasoning: {
        source: "openai:test-model",
        body: { format: "openai", field: "reasoning_content", text: "thinking" },
      },
    });
  });

  test("throws ModelRequestError on a non-2xx response", async () => {
    const run = async () => {
      for await (const _ of new OpenAIProvider({ baseURL, model: "err" }).stream({
        messages: [{ role: "user", content: "x" }],
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(ModelRequestError);
  });
});

// docs/feat/token-usage-log.md: the server's prompt-cache split is carried, and
// only when the server reports one — a 0 would claim a full cache miss.
describe("OpenAIProvider.stream prompt-cache usage", () => {
  const doneOf = async (usage: unknown): Promise<StreamEvent | undefined> => {
    const provider = new OpenAIProvider({
      baseURL,
      model: "test-model",
      fetch: (async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    });
    let last: StreamEvent | undefined;
    for await (const e of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
      last = e;
    }
    return last;
  };

  test("prompt_tokens_details.cached_tokens is carried as cachedPromptTokens", async () => {
    // Mutation: drop the `prompt_tokens_details` spread in openai-provider.ts → the field vanishes.
    expect(
      await doneOf({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({
      type: "done",
      usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 4 },
      stopReason: "stop",
    });
  });

  test("a null cached_tokens (LiteLLM-style proxy) ⇒ the field is absent, never null", async () => {
    // Mutation: back to `!== undefined` at the spread → `cachedPromptTokens: null`,
    // which `LogUsageEntrySchema` refuses and so poisons the session log (fix round 1).
    const done = await doneOf({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: null },
    });
    expect(done).toEqual({
      type: "done",
      usage: { promptTokens: 10, completionTokens: 5 },
      stopReason: "stop",
    });
    const usage = done?.type === "done" ? done.usage : undefined;
    expect(usage !== undefined && "cachedPromptTokens" in usage).toBe(false);
  });

  test("no cache split ⇒ the field is absent, not 0", async () => {
    // Mutation: `cached_tokens … ?? 0` → `in` becomes true.
    const done = await doneOf({ prompt_tokens: 10, completion_tokens: 5 });
    const usage = done?.type === "done" ? done.usage : undefined;
    expect(usage?.promptTokens).toBe(10);
    expect(usage !== undefined && "cachedPromptTokens" in usage).toBe(false);
  });
});

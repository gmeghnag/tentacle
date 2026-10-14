import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@agent-harness/core";
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
    expect(done).toEqual({ type: "done", usage: { promptTokens: 10, completionTokens: 5 } });
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

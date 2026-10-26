/**
 * docs/fix/tool-duration.md: a tool message's `durationMs` is display-only
 * metadata — the provider request bodies are byte-identical with and without
 * it, so the model never sees it and it costs no context.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { buildPayload } from "../src/anthropic-provider.ts";
import { OpenAIProvider } from "../src/index.ts";

const history = (extra: Partial<ChatMessage>): ChatMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
  { role: "tool", content: "ok", toolCallId: "c1", ...extra },
];

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;
const bodies: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

describe("a tool message's durationMs never reaches the model", () => {
  test("Anthropic: the payload is identical with and without it", () => {
    const plain = JSON.stringify(buildPayload("m", { messages: history({}) }));
    const timed = JSON.stringify(buildPayload("m", { messages: history({ durationMs: 1234 }) }));
    expect(timed).toBe(plain);
    expect(timed).not.toContain("durationMs");
  });

  test("OpenAI: the request body is byte-identical with and without it", async () => {
    // Mutation (red, verified): spread the whole message in toWireMessage → fails.
    const provider = new OpenAIProvider({ baseURL, model: "m" });
    for (const messages of [history({}), history({ durationMs: 1234 })]) {
      for await (const _ of provider.stream({ messages })) {
        // drain
      }
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0] ?? "missing");
    expect(bodies[1]).not.toContain("durationMs");
  });
});

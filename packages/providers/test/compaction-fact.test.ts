/**
 * docs/feat/harness-notices.md S1: a compaction summary's `compacted` field is
 * display-only — the provider request bodies are byte-identical with and
 * without it, so the model never sees it and it costs no context.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { buildPayload } from "../src/anthropic-provider.ts";
import { OpenAIProvider } from "../src/index.ts";

const history = (extra: Partial<ChatMessage>): ChatMessage[] => [
  { role: "user", content: "Summary of the earlier conversation", ...extra },
  { role: "assistant", content: "ok" },
  { role: "user", content: "go on" },
];
const fact = { compacted: { fromTokens: 182000, toTokens: 9000, toExact: true as const } };

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

describe("a summary message's compacted fact never reaches the model", () => {
  test("Anthropic: the payload is identical with and without it", () => {
    const plain = JSON.stringify(buildPayload("m", { messages: history({}) }));
    const marked = JSON.stringify(buildPayload("m", { messages: history(fact) }));
    expect(marked).toBe(plain);
    expect(marked).not.toContain("compacted");
    expect(marked).not.toContain("fromTokens");
  });

  test("OpenAI: the request body is byte-identical with and without it", async () => {
    const provider = new OpenAIProvider({ baseURL, model: "m" });
    for (const messages of [history({}), history(fact)]) {
      for await (const _ of provider.stream({ messages })) {
        // drain
      }
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0] ?? "missing");
    expect(bodies[1]).not.toContain("compacted");
    expect(bodies[1]).not.toContain("fromTokens");
  });

  test("a fired wake's scheduled record never reaches the model either (scheduled-fire-row)", () => {
    const wake = { scheduled: { id: "sc-1", spec: "every 10m", fire: 5, at: 1_763_394_840_000 } };
    const plain = JSON.stringify(buildPayload("m", { messages: history({}) }));
    const marked = JSON.stringify(buildPayload("m", { messages: history(wake) }));
    expect(marked).toBe(plain);
    expect(marked).not.toContain("1763394840000");
  });
});

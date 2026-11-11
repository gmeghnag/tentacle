/**
 * Anthropic must name its stop reason too (docs/fix/truncated-reply-silent.md,
 * owner Q4a: both providers, one seam). `max_tokens`/`refusal` CUT the reply;
 * `end_turn` finished it; a stream with no `message_delta` stop reason was cut
 * outright.
 *
 * RED before the fix: Anthropic's `done` was `{ type, usage }`, so a reply cut
 * by `max_tokens` was indistinguishable from a complete one — its own tool-call
 * refusal was the only hint, and text had none.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { AnthropicProvider } from "../src/index.ts";

const sse = (...events: unknown[]): string =>
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}`;

const START = (usage = { input_tokens: 10 }) => ({
  type: "message_start",
  message: { usage },
});
const TEXT = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
];
const DELTA = (stop_reason: string | null) => ({
  type: "message_delta",
  delta: { stop_reason },
  usage: { output_tokens: 5 },
});
const STOP = { type: "message_stop" };

const BODIES: Record<string, () => string> = {
  max_tokens: () => sse(START(), ...TEXT("la vera"), DELTA("max_tokens"), STOP),
  end_turn: () => sse(START(), ...TEXT("done"), DELTA("end_turn"), STOP),
  refusal: () => sse(START(), ...TEXT("no"), DELTA("refusal"), STOP),
  // No `message_delta` at all: the body ended mid-reply.
  cut: () => sse(START(), ...TEXT("la vera")),
};

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string };
      return new Response((BODIES[body.model ?? ""] ?? (() => ""))(), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

async function collect(model: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of new AnthropicProvider({ baseURL, model }).stream({
    messages: [{ role: "user", content: "hi" }],
  })) {
    out.push(event);
  }
  return out;
}

const doneOf = (events: readonly StreamEvent[]): StreamEvent | undefined =>
  events.find((e) => e.type === "done");

describe("AnthropicProvider names the stop reason", () => {
  test("max_tokens is 'length': the text was cut, not finished", async () => {
    expect(doneOf(await collect("max_tokens"))).toEqual({
      type: "done",
      usage: { promptTokens: 10, completionTokens: 5 },
      stopReason: "length",
    });
  });

  test("refusal is 'length' too (TRUNCATING_STOP_REASONS)", async () => {
    expect(doneOf(await collect("refusal"))).toMatchObject({ stopReason: "length" });
  });

  test("end_turn is 'stop', a finished reply", async () => {
    expect(doneOf(await collect("end_turn"))).toMatchObject({ stopReason: "stop" });
  });

  test("no stop reason at all is 'other': the stream was cut", async () => {
    expect(doneOf(await collect("cut"))).toMatchObject({ stopReason: "other" });
  });
});

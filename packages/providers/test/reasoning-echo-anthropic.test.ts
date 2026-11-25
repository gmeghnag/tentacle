/**
 * T3 (docs/fix/reasoning-echo.md, s3): the Anthropic provider keeps a
 * response's reasoning blocks — `thinking` with its `signature`, and
 * `redacted_thinking` with its `data` — hands them over on `done`, and sends
 * them back FIRST, verbatim and in order, on the assistant message that carries
 * them (D2/D3), only to the provider that produced them (D5).
 *
 * RED before s3: `signature_delta` was ignored and `content_block_start` kept
 * only type/id/name, so `done` carried no record and `buildPayload` wrote text +
 * `tool_use` only.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ReasoningRecord, StreamEvent } from "@tentacle/core";
import { applyCacheControl } from "../src/anthropic-cache.ts";
import { buildPayload } from "../src/anthropic-provider.ts";
import { AnthropicProvider } from "../src/index.ts";

type Json = Record<string, unknown>;

const sse = (events: unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const START = { type: "message_start", message: { usage: { input_tokens: 10 } } };
const END = (stop_reason: string) => [
  { type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
const block = (index: number, content_block: Json, deltas: Json[], stop = true): Json[] => [
  { type: "content_block_start", index, content_block },
  ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
  ...(stop ? [{ type: "content_block_stop", index }] : []),
];
const THINKING = (index: number, parts: string[], signature?: string): Json[] =>
  block(index, { type: "thinking", thinking: "" }, [
    ...parts.map((thinking) => ({ type: "thinking_delta", thinking })),
    ...(signature !== undefined ? [{ type: "signature_delta", signature }] : []),
  ]);
const REDACTED = (index: number, data: string): Json[] =>
  block(index, { type: "redacted_thinking", data }, []);
const TEXT = (index: number, text: string): Json[] =>
  block(index, { type: "text", text: "" }, [{ type: "text_delta", text }]);
const TOOL = (index: number, id: string): Json[] =>
  block(index, { type: "tool_use", id, name: "ls", input: {} }, [
    { type: "input_json_delta", partial_json: "{}" },
  ]);

/** A provider whose fake `/messages` answers each request with the next body; bodies are captured. */
function fake(responses: string[]): { provider: AnthropicProvider; bodies: Json[] } {
  const bodies: Json[] = [];
  const provider = new AnthropicProvider({
    baseURL: "http://unused.local/v1",
    model: "m",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Json);
      return new Response(responses[bodies.length - 1] ?? sse([START, ...END("end_turn")]), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });
  return { provider, bodies };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of stream) {
    events.push(e);
  }
  return events;
}

function doneReasoning(events: StreamEvent[]): ReasoningRecord | undefined {
  const done = events.find((e) => e.type === "done");
  return done?.type === "done" ? done.reasoning : undefined;
}

const FULL = sse([
  START,
  ...THINKING(0, ["Let me ", "look."], "sig-A"),
  ...REDACTED(1, "ENC=="),
  ...TEXT(2, "I will list."),
  ...TOOL(3, "toolu_1"),
  ...END("tool_use"),
]);

const RECORD: ReasoningRecord = {
  source: "anthropic:m",
  body: {
    format: "anthropic",
    blocks: [
      { type: "thinking", thinking: "Let me look.", signature: "sig-A" },
      { type: "redacted_thinking", data: "ENC==" },
    ],
  },
};

const USER: ChatMessage = { role: "user", content: "go" };
const CALL = { id: "toolu_1", name: "ls", arguments: "{}" };
const RESULT: ChatMessage = { role: "tool", content: "a b", toolCallId: "toolu_1" };

describe("decode (D2)", () => {
  test("done carries the thinking (deltas + signature) and redacted blocks, in stream order", async () => {
    const { provider } = fake([FULL]);
    const events = await collect(provider.stream({ messages: [USER] }));
    expect(doneReasoning(events)).toEqual(RECORD);
    // The live display stream is unchanged.
    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", delta: "Let me " },
      { type: "reasoning", delta: "look." },
    ]);
  });

  test("an omitted-display block (empty thinking + signature) is kept", async () => {
    const { provider } = fake([
      sse([START, ...THINKING(0, [], "sig-O"), ...TEXT(1, "hi"), ...END("end_turn")]),
    ]);
    const events = await collect(provider.stream({ messages: [USER] }));
    expect(doneReasoning(events)).toEqual({
      source: "anthropic:m",
      body: {
        format: "anthropic",
        blocks: [{ type: "thinking", thinking: "", signature: "sig-O" }],
      },
    });
  });

  test("an unsigned thinking block is dropped (it would 400); none left ⇒ no record", async () => {
    const { provider } = fake([
      sse([START, ...THINKING(0, ["half"]), ...TEXT(1, "hi"), ...END("end_turn")]),
    ]);
    const events = await collect(provider.stream({ messages: [USER] }));
    expect(doneReasoning(events)).toBeUndefined();
  });

  test("a thinking block never closed (cut stream) is not kept", async () => {
    const cut = block(
      1,
      { type: "thinking", thinking: "" },
      [
        { type: "thinking_delta", thinking: "x" },
        { type: "signature_delta", signature: "sig-C" },
      ],
      false,
    );
    const { provider } = fake([
      sse([START, ...THINKING(0, ["a"], "sig-A"), ...cut, ...END("end_turn")]),
    ]);
    const events = await collect(provider.stream({ messages: [USER] }));
    expect(doneReasoning(events)).toEqual({
      source: "anthropic:m",
      body: {
        format: "anthropic",
        blocks: [{ type: "thinking", thinking: "a", signature: "sig-A" }],
      },
    });
  });

  test("no reasoning ⇒ no record", async () => {
    const { provider } = fake([sse([START, ...TEXT(0, "hi"), ...END("end_turn")])]);
    expect(doneReasoning(await collect(provider.stream({ messages: [USER] })))).toBeUndefined();
  });
});

describe("encode (D3/D5)", () => {
  test("round trip: request 2's assistant content is [thinking, redacted, text, tool_use], verbatim", async () => {
    const { provider, bodies } = fake([FULL]);
    const record = doneReasoning(await collect(provider.stream({ messages: [USER] })));
    expect(record).toBeDefined();
    const assistant: ChatMessage = {
      role: "assistant",
      content: "I will list.",
      toolCalls: [CALL],
      ...(record ? { reasoning: record } : {}),
    };
    await collect(provider.stream({ messages: [USER, assistant, RESULT] }));
    const messages = bodies[1]?.messages as Json[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me look.", signature: "sig-A" },
        { type: "redacted_thinking", data: "ENC==" },
        { type: "text", text: "I will list." },
        { type: "tool_use", id: "toolu_1", name: "ls", input: {} },
      ],
    });
  });

  test("a no-call assistant message with a record uses blocks: reasoning first, then text", () => {
    const payload = buildPayload(
      "m",
      { messages: [USER, { role: "assistant", content: "hi", reasoning: RECORD }] },
      undefined,
      undefined,
      "anthropic:m",
    );
    expect((payload.messages as Json[])[1]).toEqual({
      role: "assistant",
      content: [
        ...(RECORD.body.format === "anthropic" ? RECORD.body.blocks : []),
        { type: "text", text: "hi" },
      ],
    });
  });

  test("a reasoning-only assistant message (no text, no calls) is still dropped", () => {
    const payload = buildPayload(
      "m",
      { messages: [USER, { role: "assistant", content: "", reasoning: RECORD }, USER] },
      undefined,
      undefined,
      "anthropic:m",
    );
    expect((payload.messages as Json[]).map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("another source, or an openai-format record, is not sent (and the message is unchanged)", () => {
    const openai: ReasoningRecord = {
      source: "anthropic:m",
      body: { format: "openai", field: "reasoning_content", text: "t" },
    };
    for (const reasoning of [{ ...RECORD, source: "anthropic:other" }, openai]) {
      const payload = buildPayload(
        "m",
        {
          messages: [
            USER,
            { role: "assistant", content: "hi", toolCalls: [CALL], reasoning },
            RESULT,
          ],
        },
        undefined,
        undefined,
        "anthropic:m",
      );
      expect((payload.messages as Json[])[1]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "toolu_1", name: "ls", input: {} },
        ],
      });
    }
  });

  test("no cache_control ever lands on a reasoning block (P8)", () => {
    for (const last of [
      { role: "assistant", content: "hi", reasoning: RECORD },
      { role: "assistant", content: "", toolCalls: [CALL], reasoning: RECORD },
    ] as ChatMessage[]) {
      const payload = buildPayload(
        "m",
        { messages: [USER, last] },
        undefined,
        undefined,
        "anthropic:m",
      );
      applyCacheControl(payload);
      const content = (payload.messages as Json[])[1]?.content as Json[];
      expect(content.slice(0, 2).map((b) => b.type)).toEqual(["thinking", "redacted_thinking"]);
      for (const b of content.slice(0, 2)) {
        expect(b.cache_control).toBeUndefined();
      }
      expect(content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    }
  });
});

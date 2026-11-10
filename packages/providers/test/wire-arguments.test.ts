import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { buildPayload } from "../src/anthropic-provider.ts";
import { OpenAIProvider } from "../src/index.ts";

const BAD = '{"path":"a.txt","content":"line1\nunterminated';
const marker = (n: number) => `{"_invalid_arguments":true,"bytes":${n}}`;

const history = (args: string): ChatMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: args }] },
  { role: "tool", content: "ok", toolCallId: "c1" },
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

describe("OpenAI: function.arguments is always a JSON object", () => {
  const send = async (args: string): Promise<string> => {
    const provider = new OpenAIProvider({ baseURL, model: "m" });
    for await (const _ of provider.stream({ messages: history(args) })) {
      // drain
    }
    return bodies.at(-1) ?? "";
  };

  test("invalid JSON is replaced by the marker", async () => {
    const body = await send(BAD);
    const bytes = new TextEncoder().encode(BAD).length;
    expect(JSON.parse(body).messages[1].tool_calls[0].function.arguments).toBe(marker(bytes));
  });

  test("non-object JSON is replaced by the marker", async () => {
    expect(JSON.parse(await send("[]")).messages[1].tool_calls[0].function.arguments).toBe(
      marker(2),
    );
  });

  test('"" becomes {} (the registry reads it as no arguments)', async () => {
    expect(JSON.parse(await send("")).messages[1].tool_calls[0].function.arguments).toBe("{}");
  });

  test("a valid object is sent verbatim (byte-identical to before the guard)", async () => {
    const body = JSON.parse(await send('{"a":1}'));
    expect(body.messages[1].tool_calls[0].function.arguments).toBe('{"a":1}');
    // The rest of the body is untouched: same roles and content as the input.
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(body.messages[2].content).toBe("ok");
  });

  test("the marker itself passes through unchanged (idempotent)", async () => {
    const m = marker(7);
    expect(JSON.parse(await send(m)).messages[1].tool_calls[0].function.arguments).toBe(m);
  });
});

describe("Anthropic: tool_use.input is always an object", () => {
  const input = (args: string): unknown => {
    const payload = buildPayload("m", { messages: history(args) }) as {
      messages: { content: { type: string; input?: unknown }[] }[];
    };
    return payload.messages[1]?.content[0]?.input;
  };

  test("non-object JSON degrades to {}", () => {
    expect(input("[]")).toEqual({});
    expect(input('"x"')).toEqual({});
  });

  test("invalid JSON degrades to {}", () => {
    expect(input(BAD)).toEqual({});
  });

  test("a valid object is kept as is", () => {
    expect(input('{"a":1}')).toEqual({ a: 1 });
  });
});

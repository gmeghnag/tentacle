/**
 * C3, T8 (docs/feat/voice-conversation.md §4 + F9): the OpenAI-compatible wire
 * gets the "do not reason" switches when the request says `reasoning:"off"`, and
 * a server that rejects them costs ONE retry, remembered — never a failed turn.
 *
 * The switches are the only portable pair an OpenAI-compatible endpoint accepts:
 * `reasoning_effort:"none"` (vLLM / llama.cpp's OpenAI surface) and
 * `chat_template_kwargs:{enable_thinking:false}` (the model's own switch). A
 * server that knows neither answers 400, which is what F9 converges on.
 *
 * Mutations that must turn these red: omit the switches → the first test red;
 * retry more than once / not remember → the "remembered" test counts 2 bodies,
 * not 3; refuse the turn instead of retrying → the turn rejects.
 *
 * Anthropic has no such switch: §4 says a no-op there, and this file asserts the
 * request it builds is unchanged (the same body with and without `reasoning`).
 */
import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@tentacle/core";
import { AnthropicProvider } from "../src/anthropic-provider.ts";
import { OpenAIProvider } from "../src/openai-provider.ts";

const SSE = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`;

/** A fake endpoint that records every body and answers with `status`. */
function endpoint(status: number | (() => number) = 200) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const code = typeof status === "function" ? status() : status;
    if (code !== 200) {
      return new Response("bad request", { status: code });
    }
    return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const voiceOff: ChatRequest = {
  messages: [{ role: "user", content: "ciao" }],
  reasoning: "off",
};
const plain: ChatRequest = { messages: [{ role: "user", content: "ciao" }] };

async function drain(provider: OpenAIProvider, request: ChatRequest): Promise<void> {
  for await (const _ of provider.stream(request)) {
    // drain
  }
}

describe("T8 the OpenAI-compatible payload carries the reasoning switches", () => {
  test('`reasoning:"off"` adds both switches; an ordinary turn adds neither', async () => {
    const fake = endpoint();
    const provider = new OpenAIProvider({
      baseURL: "http://x/v1",
      model: "m",
      fetch: fake.fetchImpl,
    });
    await drain(provider, voiceOff);
    await drain(provider, plain);

    const [off, on] = fake.bodies;
    expect(off?.reasoning_effort).toBe("none");
    expect(off?.chat_template_kwargs).toEqual({ enable_thinking: false });
    // Nothing leaks into a turn that did not ask for it.
    expect(on?.reasoning_effort).toBeUndefined();
    expect(on?.chat_template_kwargs).toBeUndefined();
  });

  test("F9 a 400 costs ONE retry without them, and the retry is remembered", async () => {
    // The switch-carrying body is rejected; the plain retry succeeds; the NEXT
    // voice turn goes straight to the plain body — one rejection per provider.
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.reasoning_effort !== undefined) {
        return new Response("unknown field: reasoning_effort", { status: 400 });
      }
      return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ baseURL: "http://x/v1", model: "m", fetch: fetchImpl });

    await drain(provider, voiceOff);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.reasoning_effort).toBe("none");
    expect(bodies[1]?.reasoning_effort).toBeUndefined();

    // Remembered: this turn never even tries the switches.
    await drain(provider, voiceOff);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]?.reasoning_effort).toBeUndefined();
  });

  test("F9 a 400 on the plain body too is the turn's real failure (no loop)", async () => {
    const fake = endpoint(400);
    const provider = new OpenAIProvider({
      baseURL: "http://x/v1",
      model: "m",
      fetch: fake.fetchImpl,
    });
    await expect(drain(provider, voiceOff)).rejects.toMatchObject({ status: 400 });
    // Exactly one retry: the plain body was already tried.
    expect(fake.bodies).toHaveLength(2);
  });

  test("a non-400 answer is never retried (a 500 belongs to the retry layer)", async () => {
    const fake = endpoint(500);
    const provider = new OpenAIProvider({
      baseURL: "http://x/v1",
      model: "m",
      fetch: fake.fetchImpl,
    });
    await expect(drain(provider, voiceOff)).rejects.toMatchObject({ status: 500 });
    expect(fake.bodies).toHaveLength(1);
  });
});

describe("T8 Anthropic is a no-op (§4)", () => {
  test("the request body is identical with and without `reasoning`", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        [
          "event: message_start",
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}`,
          "",
          "event: message_stop",
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const provider = new AnthropicProvider({
      baseURL: "http://x/v1",
      model: "m",
      apiKey: "k",
      fetch: fetchImpl,
    });
    for await (const _ of provider.stream(voiceOff)) {
      // drain
    }
    for await (const _ of provider.stream(plain)) {
      // drain
    }
    const [voiceBody, plainBody] = bodies;
    if (voiceBody === undefined || plainBody === undefined) {
      throw new Error("expected two request bodies");
    }
    expect(voiceBody).toEqual(plainBody);
    expect(voiceBody?.reasoning_effort).toBeUndefined();
    expect(voiceBody?.chat_template_kwargs).toBeUndefined();
  });
});

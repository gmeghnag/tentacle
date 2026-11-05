import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@tentacle/core";
import { AnthropicProvider, OpenAIProvider, RetryingModelProvider } from "../src/index.ts";

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fake fetch answering each URL from `answers` (status + JSON), recording the calls. */
function fakeFetch(
  answers: Record<string, { status?: number; json?: unknown }>,
  calls: Call[],
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const a = answers[url] ?? { status: 404, json: { error: "not found" } };
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
}

const REQUEST: ChatRequest = {
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ],
  tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
  temperature: 0.2,
  maxTokens: 99,
};

describe("AnthropicProvider.countTokens", () => {
  test("POSTs /messages/count_tokens with the payload minus the generation knobs; returns input_tokens", async () => {
    const calls: Call[] = [];
    const p = new AnthropicProvider({
      baseURL: "https://api.test/v1",
      model: "claude-x",
      apiKey: "k",
      fetch: fakeFetch(
        { "https://api.test/v1/messages/count_tokens": { json: { input_tokens: 1234 } } },
        calls,
      ),
    });
    expect(await p.countTokens(REQUEST)).toBe(1234);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body ?? {};
    expect(body.model).toBe("claude-x");
    expect(body.system).toBe("be brief");
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("temperature");
    expect(calls[0]?.headers["x-api-key"]).toBe("k");
  });

  test("an error status or a bad shape: undefined (an estimate follows), never a throw", async () => {
    const bad = new AnthropicProvider({
      baseURL: "https://api.test/v1",
      model: "m",
      fetch: fakeFetch({}, []),
    });
    expect(await bad.countTokens(REQUEST)).toBeUndefined();
    const odd = new AnthropicProvider({
      baseURL: "https://api.test/v1",
      model: "m",
      fetch: fakeFetch(
        { "https://api.test/v1/messages/count_tokens": { json: { input_tokens: "many" } } },
        [],
      ),
    });
    expect(await odd.countTokens(REQUEST)).toBeUndefined();
  });
});

describe("OpenAIProvider.countTokens (llama.cpp: /apply-template then /tokenize at the server root)", () => {
  test("templates the chat, tokenizes the prompt, returns the token count", async () => {
    const calls: Call[] = [];
    const p = new OpenAIProvider({
      baseURL: "http://host:8080/v1",
      model: "m",
      fetch: fakeFetch(
        {
          "http://host:8080/apply-template": { json: { prompt: "<s>be brief hi" } },
          "http://host:8080/tokenize": { json: { tokens: [1, 2, 3, 4, 5, 6, 7] } },
        },
        calls,
      ),
    });
    expect(await p.countTokens(REQUEST)).toBe(7);
    expect(calls.map((c) => c.url)).toEqual([
      "http://host:8080/apply-template",
      "http://host:8080/tokenize",
    ]);
    expect((calls[0]?.body.messages as unknown[]).length).toBe(2);
    // The templated prompt already carries its special tokens: the tokenizer adds none.
    expect(calls[1]?.body).toEqual({ content: "<s>be brief hi", add_special: false });
  });

  test("a server without those endpoints (404): undefined, never a throw", async () => {
    const p = new OpenAIProvider({
      baseURL: "https://api.openai.test/v1",
      model: "m",
      fetch: fakeFetch({}, []),
    });
    expect(await p.countTokens(REQUEST)).toBeUndefined();
  });

  test("a template answer without a prompt: undefined", async () => {
    const p = new OpenAIProvider({
      baseURL: "http://h/v1",
      model: "m",
      fetch: fakeFetch({ "http://h/apply-template": { json: { nope: 1 } } }, []),
    });
    expect(await p.countTokens(REQUEST)).toBeUndefined();
  });
});

describe("RetryingModelProvider forwards countTokens", () => {
  test("to the wrapped provider; absent when it has none", async () => {
    const inner = { id: "i", stream: async function* () {}, countTokens: async () => 42 };
    expect(await new RetryingModelProvider(inner).countTokens(REQUEST)).toBe(42);
    const bare = { id: "b", stream: async function* () {} };
    expect(await new RetryingModelProvider(bare).countTokens(REQUEST)).toBeUndefined();
  });
});

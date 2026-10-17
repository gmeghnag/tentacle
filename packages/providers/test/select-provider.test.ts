import { describe, expect, test } from "bun:test";
import { AnthropicProvider, OpenAIProvider, createModelProvider } from "../src/index.ts";

describe("createModelProvider", () => {
  test("defaults to the OpenAI provider when provider is unset", () => {
    expect(createModelProvider({ baseURL: "http://h/v1", model: "m" })).toBeInstanceOf(
      OpenAIProvider,
    );
  });

  test("openai selects the OpenAI provider", () => {
    const p = createModelProvider({ provider: "openai", baseURL: "http://h/v1", model: "m" });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.id).toBe("openai:m");
  });

  test("anthropic selects the Anthropic provider, carrying the api key", () => {
    const p = createModelProvider({
      provider: "anthropic",
      baseURL: "http://h/v1",
      model: "m",
      apiKey: "sk-test",
    });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.id).toBe("anthropic:m");
  });

  test("a configured maxTokens reaches the wire for both providers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n");
    }) as unknown as typeof fetch;
    for (const provider of ["openai", "anthropic"] as const) {
      const p = createModelProvider({
        provider,
        baseURL: "http://h/v1",
        model: "m",
        maxTokens: 1234,
        fetch: fakeFetch,
      });
      for await (const _ of p.stream({ messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    }
    expect(bodies.map((b) => b.max_tokens)).toEqual([1234, 1234]);
  });

  test("an unset maxTokens leaves the OpenAI payload without max_tokens", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n");
    }) as unknown as typeof fetch;
    const p = createModelProvider({ baseURL: "http://h/v1", model: "m", fetch: fakeFetch });
    for await (const _ of p.stream({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    expect("max_tokens" in body).toBe(false);
  });
});

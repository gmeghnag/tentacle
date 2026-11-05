/** A server's parallel slots (docs/feat/parallel-agents.md, Design 6; T-S). */
import { describe, expect, test } from "bun:test";
import { slotsBounded } from "@tentacle/core";
import { AnthropicProvider, OpenAIProvider, RetryingModelProvider } from "../src/index.ts";

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

function provider(
  answer: () => Promise<Response>,
  over: { baseURL?: string; apiKey?: string } = {},
): { p: OpenAIProvider; seen: Seen[] } {
  const seen: Seen[] = [];
  const p = new OpenAIProvider({
    baseURL: over.baseURL ?? "http://llama:8080/v1",
    model: "m",
    ...(over.apiKey ? { apiKey: over.apiKey } : {}),
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return answer();
    }) as unknown as typeof fetch,
  });
  return { p, seen };
}

const json =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("OpenAIProvider.slots", () => {
  test("GET <root>/props, without /v1, with the bearer, refusing redirects", async () => {
    const { p, seen } = provider(json({ total_slots: 3 }), { apiKey: "k" });
    expect(await p.slots()).toBe(3);
    expect(seen[0]?.url).toBe("http://llama:8080/props");
    expect(seen[0]?.init?.method).toBe("GET");
    expect(seen[0]?.init?.redirect).toBe("error");
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  test("no key: no authorization header", async () => {
    const { p, seen } = provider(json({ total_slots: 1 }));
    await p.slots();
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test.each([[0], [-1], [1.5], [1025], ["3"], [null]])(
    "total_slots %p is no answer, and is memoized",
    async (value) => {
      const { p, seen } = provider(json({ total_slots: value }));
      expect(await p.slots()).toBeUndefined();
      expect(await p.slots()).toBeUndefined();
      expect(seen.length).toBe(1);
    },
  );

  test("garbage on a 200: no answer, memoized", async () => {
    const { p, seen } = provider(async () => new Response("<html>"));
    expect(await p.slots()).toBeUndefined();
    await p.slots();
    expect(seen.length).toBe(1);
  });

  test("the upper bound itself is an answer", async () => {
    const { p } = provider(json({ total_slots: 1024 }));
    expect(await p.slots()).toBe(1024);
  });

  test("an answer is memoized", async () => {
    const { p, seen } = provider(json({ total_slots: 2 }));
    expect(await p.slots()).toBe(2);
    expect(await p.slots()).toBe(2);
    expect(seen.length).toBe(1);
  });

  test("a 404 (not llama.cpp): no cap, memoized", async () => {
    const { p, seen } = provider(json({}, 404));
    expect(await p.slots()).toBeUndefined();
    await p.slots();
    expect(seen.length).toBe(1);
  });

  test("a 5xx (a server still loading) is not memoized", async () => {
    let status = 503;
    const { p, seen } = provider(async () => new Response('{"total_slots":2}', { status }));
    expect(await p.slots()).toBeUndefined();
    status = 200;
    expect(await p.slots()).toBe(2);
    expect(seen.length).toBe(2);
  });

  test("a network failure is not memoized, and never rejects", async () => {
    let fail = true;
    const { p, seen } = provider(async () => {
      if (fail) {
        throw new Error("connection refused");
      }
      return new Response('{"total_slots":2}');
    });
    expect(await p.slots()).toBeUndefined();
    fail = false;
    expect(await p.slots()).toBe(2);
    expect(seen.length).toBe(2);
  });

  test("a hung server: cut by its own timeout, not memoized", async () => {
    let calls = 0;
    const hung = new OpenAIProvider({
      baseURL: "http://llama:8080/v1",
      model: "m",
      slotsTimeoutMs: 5,
      fetch: ((_url: string, init?: RequestInit) => {
        calls++;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as unknown as typeof fetch,
    });
    expect(await hung.slots()).toBeUndefined();
    expect(await hung.slots()).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("the caller's abort reaches the fetch", async () => {
    let signal: AbortSignal | null | undefined;
    const p = new OpenAIProvider({
      baseURL: "http://llama:8080/v1",
      model: "m",
      fetch: ((_url: string, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const asked = p.slots(controller.signal);
    controller.abort();
    expect(await asked).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});

describe("other providers", () => {
  test("Anthropic has no method", () => {
    const p = new AnthropicProvider({ baseURL: "http://a", model: "m", apiKey: "k" });
    expect((p as { slots?: unknown }).slots).toBeUndefined();
  });

  test("RetryingModelProvider forwards, never retries", async () => {
    let calls = 0;
    const inner = {
      id: "i",
      async *stream() {},
      async slots() {
        calls++;
        throw new Error("down");
      },
    };
    const p = new RetryingModelProvider(inner);
    await expect(p.slots()).rejects.toThrow("down");
    expect(calls).toBe(1);
    const bare = new RetryingModelProvider({ id: "b", async *stream() {} });
    expect(await bare.slots()).toBeUndefined();
  });
});

describe("slotsBounded", () => {
  test("no method; a rejection; a hang: undefined, never a throw", async () => {
    expect(await slotsBounded({})).toBeUndefined();
    expect(
      await slotsBounded({
        slots: async () => {
          throw new Error("x");
        },
      }),
    ).toBeUndefined();
    expect(
      await slotsBounded({ slots: () => new Promise(() => {}) }, undefined, 5),
    ).toBeUndefined();
  });

  test("an abort ends it at once, and the provider's signal is aborted", async () => {
    let inner: AbortSignal | undefined;
    const controller = new AbortController();
    const asked = slotsBounded(
      {
        slots: (signal) => {
          inner = signal;
          return new Promise(() => {});
        },
      },
      controller.signal,
    );
    controller.abort();
    expect(await asked).toBeUndefined();
    expect(inner?.aborted).toBe(true);
  });
});

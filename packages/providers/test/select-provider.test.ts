import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { AnthropicProvider, OpenAIProvider, createModelProvider } from "../src/index.ts";

describe("createModelProvider", () => {
  test("defaults to the OpenAI provider when provider is unset", () => {
    expect(createModelProvider({ baseURL: "http://h/v1", model: "m" }).inner).toBeInstanceOf(
      OpenAIProvider,
    );
  });

  test("openai selects the OpenAI provider", () => {
    const p = createModelProvider({ provider: "openai", baseURL: "http://h/v1", model: "m" });
    expect(p.inner).toBeInstanceOf(OpenAIProvider);
    expect(p.id).toBe("openai:m");
  });

  test("anthropic selects the Anthropic provider, carrying the api key", () => {
    const p = createModelProvider({
      provider: "anthropic",
      baseURL: "http://h/v1",
      model: "m",
      apiKey: "sk-test",
    });
    expect(p.inner).toBeInstanceOf(AnthropicProvider);
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

// A loopback endpoint that drops the first `drops` connections, then answers
// with `sse` in full. Raw `node:net`, so the client sees Bun's REAL connection
// error — the property the retry classifier depends on. `drop` is where: right
// after reading the request (no response byte: the incident's shape), or after
// a chunked 200 and a partial tool-call delta (chunked, so Bun reports the
// reset as an error instead of a clean end of body).
async function flakyEndpoint(
  drops: number,
  sse: string,
  drop: "before-response" | "mid-tool-call" = "before-response",
): Promise<{
  readonly baseURL: string;
  readonly connections: () => number;
  readonly close: () => void;
}> {
  let connections = 0;
  const srv = createServer((socket) => {
    connections += 1;
    const n = connections;
    socket.once("data", () => {
      if (n > drops) {
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: ${Buffer.byteLength(sse)}\r\nconnection: close\r\n\r\n${sse}`,
        );
        return;
      }
      if (drop === "before-response") {
        socket.resetAndDestroy();
        return;
      }
      const partial = `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }],
            },
          },
        ],
      })}\n\n`;
      socket.write(
        `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n${Buffer.byteLength(partial).toString(16)}\r\n${partial}\r\n`,
      );
      setTimeout(() => socket.resetAndDestroy(), 20);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    connections: () => connections,
    close: () => srv.close(),
  };
}

const sseOf = (...chunks: unknown[]): string =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;

describe("createModelProvider — connection resilience", () => {
  test("a connection reset before any output is retried transparently", async () => {
    const endpoint = await flakyEndpoint(
      1,
      sseOf({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }),
    );
    try {
      const p = createModelProvider({ baseURL: endpoint.baseURL, model: "m" });
      let text = "";
      for await (const event of p.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "text") {
          text += event.delta;
        }
      }
      expect(text).toBe("recovered");
      expect(endpoint.connections()).toBe(2);
    } finally {
      endpoint.close();
    }
  });

  test("a drop mid tool call (nothing delivered yet) is regenerated, the call emitted once", async () => {
    // The provider holds tool-call deltas until finish_reason, so this drop is
    // before any delivered event: retried, and the partial call never leaks.
    const endpoint = await flakyEndpoint(
      1,
      sseOf(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c2", function: { name: "read", arguments: '{"path":"a"}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
      "mid-tool-call",
    );
    try {
      const p = createModelProvider({ baseURL: endpoint.baseURL, model: "m" });
      const calls: unknown[] = [];
      for await (const event of p.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "tool_call") {
          calls.push(event.toolCall);
        }
      }
      expect(calls).toEqual([{ id: "c2", name: "read", arguments: '{"path":"a"}' }]);
      expect(endpoint.connections()).toBe(2);
    } finally {
      endpoint.close();
    }
  });
});

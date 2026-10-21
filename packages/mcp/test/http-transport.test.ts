import { describe, expect, test } from "bun:test";
import { McpClient } from "../src/client.ts";
import { connectMcpServers } from "../src/connect.ts";
import { createStreamableHttpTransport, sseMessages } from "../src/http-transport.ts";
import type { McpHttpServerSpec } from "../src/types.ts";

const spec: McpHttpServerSpec = {
  type: "http",
  url: "https://mcp.test/mcp",
  headers: { Authorization: "Bearer secret-token" },
};

interface Seen {
  readonly method: string;
  readonly headers: { get(name: string): string | null };
  readonly body: unknown;
  readonly signal?: AbortSignal | null;
}

type Reply = (body: { id?: unknown; method?: string }, seen: Seen) => Response | Promise<Response>;

/** A fake `fetch` recording every call and answering with `reply`. */
function fakeFetch(reply: Reply) {
  const calls: Seen[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted();
    const seen: Seen = {
      method: init.method ?? "GET",
      headers: new Headers(init.headers as Record<string, string>),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(seen);
    return reply((seen.body ?? {}) as { id?: unknown; method?: string }, seen);
  };
  return { fetch, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });

/** An SSE response whose body arrives in the given raw chunks. */
const sse = (chunks: readonly string[], headers: Record<string, string> = {}): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", ...headers } },
  );

const accepted = (): Response => new Response(null, { status: 202 });

/** Answer the handshake; `tools/list` is delegated to `tools`. */
function server(tools: Reply, session = "sess-1"): Reply {
  return (body, seen) => {
    if (body.method === "initialize") {
      return json(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
        { "mcp-session-id": session },
      );
    }
    if (body.id === undefined) {
      return accepted();
    }
    return tools(body, seen);
  };
}

describe("sseMessages", () => {
  test("joins multi-line data, handles CRLF split across chunks, skips other events", async () => {
    const out: string[] = [];
    const body = sse([
      ": comment\r",
      "\nevent: ping\ndata: ignored\n\n",
      'data: {"a":\n',
      "data: 1}\r\n\r",
      "\nid: 7\ndata: last",
    ]).body;
    if (!body) {
      throw new Error("no body");
    }
    for await (const data of sseMessages(body)) {
      out.push(data);
    }
    expect(out).toEqual(['{"a":\n1}', "last"]);
  });
});

describe("createStreamableHttpTransport", () => {
  test("handshake: JSON reply, session id + protocol version echoed, user headers sent", async () => {
    const { fetch, calls } = fakeFetch(
      server((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } })),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    expect(await client.listTools()).toEqual([{ name: "t" }]);

    const [init, initialized, list] = calls;
    expect(init?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(init?.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(init?.headers.get("mcp-session-id")).toBeNull();
    expect(initialized?.body).toMatchObject({ method: "notifications/initialized" });
    expect(list?.headers.get("mcp-session-id")).toBe("sess-1");
    expect(list?.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(list?.headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("SSE reply: a server request before the reply is answered -32601, then the call resolves", async () => {
    const { fetch, calls } = fakeFetch(
      server((body) => {
        if (body.method === "tools/call") {
          return sse([
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage" })}\n\n`,
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "hi" }] } })}\n\n`,
          ]);
        }
        return accepted();
      }),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    const result = await client.callTool("t", {});
    expect(result.content?.[0]?.text).toBe("hi");
    const reply = calls.find((c) => (c.body as { id?: unknown }).id === 99);
    expect(reply?.body).toMatchObject({ id: 99, error: { code: -32601 } });
  });

  test("non-2xx for a request → that call fails with the status; the connection stays open", async () => {
    const { fetch } = fakeFetch(
      server(() => new Response("boom", { status: 500, statusText: "Internal Server Error" })),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    await expect(client.listTools()).rejects.toThrow("HTTP 500 Internal Server Error");
    expect(client.isClosed).toBe(false);
  });

  test("an HTTP error status is not an MCP answer: `ping` rejects (proxy 503, expired token 401)", async () => {
    for (const [status, statusText] of [
      [503, "Service Unavailable"],
      [401, "Unauthorized"],
    ] as const) {
      const { fetch } = fakeFetch(server(() => new Response(null, { status, statusText })));
      const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
      await client.initialize();
      await expect(client.ping(1_000)).rejects.toThrow(`HTTP ${status} ${statusText}`);
      expect(client.isClosed).toBe(false);
    }
  });

  test("a JSON-RPC error the server itself sent still counts as reachable for `ping`", async () => {
    const { fetch } = fakeFetch(
      server((body) =>
        json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no ping" } }),
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    await client.ping(1_000);
  });

  test("401 at initialize fails the handshake with the status, never the token", async () => {
    const { fetch } = fakeFetch(
      () => new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    const error = await client.initialize().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(error)).toContain("HTTP 401 Unauthorized");
    expect(String(error)).not.toContain("secret-token");
  });

  test("404 while holding a session → closed as expired, pending call rejected", async () => {
    const { fetch } = fakeFetch(server(() => new Response(null, { status: 404 })));
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    await expect(client.listTools()).rejects.toThrow("MCP connection closed: MCP session expired");
    expect(client.isClosed).toBe(true);
    expect(client.closeReason).toContain("session expired");
  });

  test("fetch rejects (unreachable) → closed with the reason, so `ping` reports unreachable", async () => {
    let down = false;
    const { fetch } = fakeFetch(
      server((body) => {
        if (down) {
          throw new Error("Unable to connect");
        }
        return json({ jsonrpc: "2.0", id: body.id, result: {} });
      }),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    down = true;
    await expect(client.ping(1_000)).rejects.toThrow("MCP connection closed: Unable to connect");
    expect(client.isClosed).toBe(true);
  });

  test("2xx whose body ends without the reply → the call fails instead of hanging", async () => {
    const { fetch } = fakeFetch(server(() => sse([": keepalive\n\n"])));
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }), undefined, {
      callTimeoutMs: 2_000,
    });
    await client.initialize();
    // `callTool` (bounded by `callTimeoutMs`), so without the synthesized reply
    // this fails on the timeout instead of hanging (`tools/list` has no bound).
    await expect(client.callTool("t", {})).rejects.toThrow("ended the response without a result");
    expect(client.isClosed).toBe(false);
  });

  test("close() aborts in-flight streams and releases the session once", async () => {
    let aborted = false;
    const { fetch, calls } = fakeFetch(
      server((body, seen) => {
        if (body.method === "tools/list") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Like real `fetch`: aborting the request errors its body stream.
                seen.signal?.addEventListener("abort", () => {
                  aborted = true;
                  controller.error(new Error("aborted"));
                });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return accepted();
      }),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    const pending = client.listTools();
    await Bun.sleep(5);
    client.close();
    client.close();
    await expect(pending).rejects.toThrow("MCP connection closed");
    await Bun.sleep(5);
    expect(aborted).toBe(true);
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.headers.get("mcp-session-id")).toBe("sess-1");
  });
});

describe("Streamable HTTP end-to-end (localhost)", () => {
  test("connectMcpServers lists and calls a remote server's tools over SSE replies", async () => {
    const sessions = new Set<string>();
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "DELETE") {
          sessions.delete(req.headers.get("mcp-session-id") ?? "");
          return new Response(null, { status: 200 });
        }
        const msg = (await req.json()) as { id?: number; method: string; params?: unknown };
        if (msg.method === "initialize") {
          sessions.add("s-e2e");
          return Response.json(
            { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } },
            { headers: { "mcp-session-id": "s-e2e" } },
          );
        }
        if (!sessions.has(req.headers.get("mcp-session-id") ?? "")) {
          return new Response(null, { status: 404 });
        }
        if (msg.id === undefined) {
          return new Response(null, { status: 202 });
        }
        const result =
          msg.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : msg.method === "tools/call"
              ? { content: [{ type: "text", text: JSON.stringify(msg.params) }] }
              : {};
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const result = await connectMcpServers({
        remote: { type: "http", url: `http://localhost:${http.port}/mcp` },
      });
      expect(result.errors).toEqual({});
      const [connection] = result.connections;
      expect(connection?.toolNames).toEqual(["echo"]);
      await connection?.ping(1_000);
      const tool = result.tools[0];
      expect(tool?.name).toBe("mcp__remote__echo");
      result.dispose();
      await Bun.sleep(20);
      expect(sessions.size).toBe(0);
      expect(connection?.isOpen()).toBe(false);
    } finally {
      http.stop(true);
    }
  });

  test("an unreachable server is isolated into `errors` with a reason", async () => {
    const result = await connectMcpServers(
      { gone: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      { timeoutMs: 2_000 },
    );
    expect(result.connections).toHaveLength(0);
    expect(result.errors.gone).toContain("MCP connection closed:");
  });
});

import { describe, expect, test } from "bun:test";
import {
  McpClient,
  McpHttpStatusError,
  McpServerError,
  McpStreamLostError,
} from "../src/client.ts";
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

const json = (body: unknown, headers: Record<string, string> = {}, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
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

/**
 * A legacy (2025-03-26) server: rejects the modern `server/discover` probe the
 * way the TypeScript SDK does (400 + a non-modern JSON-RPC error), answers the
 * handshake; everything else is delegated to `tools`.
 */
function server(tools: Reply, session = "sess-1"): Reply {
  return (body, seen) => {
    if (body.method === "server/discover") {
      return json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Bad Request: Server not initialized" },
        },
        {},
        400,
      );
    }
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
  test("legacy handshake after the probe: JSON reply, session id + version echoed, user headers sent", async () => {
    const { fetch, calls } = fakeFetch(
      server((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } })),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    expect(await client.listTools()).toEqual([{ name: "t" }]);

    expect(client.era).toBe("legacy");
    const [probe, init, initialized, list] = calls;
    expect(probe?.body).toMatchObject({ method: "server/discover" });
    expect(probe?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(init?.headers.get("mcp-protocol-version")).toBeNull();
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

/** A modern-only (2026-07-28) server: stateless, discover + tools; answers `call`. */
function modernServer(
  call: Reply,
  tools: unknown[] = [{ name: "t", inputSchema: { type: "object" } }],
): Reply {
  return (body, seen) => {
    if (body.method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "initialize: this server supports 2026-07-28" },
        },
        {},
        400,
      );
    }
    const meta = (seen.body as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
    const version = meta?.["io.modelcontextprotocol/protocolVersion"];
    if (version !== "2026-07-28") {
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported: ["2026-07-28"], requested: version },
          },
        },
        {},
        400,
      );
    }
    if (body.method === "server/discover") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        },
      });
    }
    if (body.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "complete", tools, ttlMs: 0, cacheScope: "private" },
      });
    }
    return call(body, seen);
  };
}

describe("createStreamableHttpTransport — modern (2026-07-28)", () => {
  const annotated = [
    {
      name: "execute_sql",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
      },
    },
    {
      name: "bad",
      inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } },
    },
  ];

  test("no handshake; every request carries the version header, Mcp-Method/Mcp-Name and Mcp-Param-*", async () => {
    const { fetch, calls } = fakeFetch(
      modernServer(
        (body) =>
          json({
            jsonrpc: "2.0",
            id: body.id,
            result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
          }),
        annotated,
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    expect(client.era).toBe("modern");
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["execute_sql"]); // the invalid annotation drops `bad`
    const result = await client.callTool("execute_sql", { region: "us-west1", query: "SELECT 1" });
    expect(result.content?.[0]?.text).toBe("ok");

    expect(calls.map((c) => (c.body as { method?: string }).method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
    for (const c of calls) {
      expect(c.headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(c.headers.get("mcp-method")).toBe((c.body as { method?: string }).method ?? null);
      expect(c.headers.get("mcp-session-id")).toBeNull();
      expect(c.headers.get("authorization")).toBe("Bearer secret-token");
    }
    const call = calls[2];
    expect(call?.headers.get("mcp-name")).toBe("execute_sql");
    expect(call?.headers.get("mcp-param-region")).toBe("us-west1");
  });

  test("a 400 with a modern error keeps its code: HeaderMismatch fails that call, the connection stays", async () => {
    const { fetch } = fakeFetch(
      modernServer((body) =>
        json(
          { jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "Header mismatch" } },
          {},
          400,
        ),
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    const error = await client.callTool("t", {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpServerError);
    expect((error as McpServerError).code).toBe(-32020);
    expect(client.isClosed).toBe(false);
  });

  test("a 400 UnsupportedProtocolVersion listing no common version fails the connect", async () => {
    const { fetch } = fakeFetch((body) =>
      json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32022, message: "Unsupported", data: { supported: ["2099-01-01"] } },
        },
        {},
        400,
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await expect(client.initialize()).rejects.toThrow("supports protocol versions 2099-01-01");
  });

  test("cancel = close that request's stream: no `notifications/cancelled` POST, connection stays", async () => {
    let streamAborted = false;
    const { fetch, calls } = fakeFetch(
      modernServer(
        (_body, seen) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                seen.signal?.addEventListener("abort", () => {
                  streamAborted = true;
                  controller.error(new Error("aborted"));
                });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    const abort = new AbortController();
    const pending = client.callTool("t", {}, { signal: abort.signal });
    await Bun.sleep(5);
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    await Bun.sleep(5);
    expect(streamAborted).toBe(true);
    expect(
      calls.some((c) => (c.body as { method?: string }).method === "notifications/cancelled"),
    ).toBe(false);
    expect(client.isClosed).toBe(false);
    await client.ping(1_000); // still usable
  });

  test("legacy cancel still POSTs `notifications/cancelled` (and closes the stream)", async () => {
    const { fetch, calls } = fakeFetch(
      server((body, seen) => {
        if (body.method === "tools/call") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                seen.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
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
    const abort = new AbortController();
    const pending = client.callTool("t", {}, { signal: abort.signal });
    await Bun.sleep(5);
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    await Bun.sleep(5);
    const cancelled = calls.find(
      (c) => (c.body as { method?: string }).method === "notifications/cancelled",
    );
    expect(cancelled?.body).toMatchObject({ params: { reason: "aborted" } });
    expect(client.isClosed).toBe(false);
  });
});

/** An SSE body that emits `chunks`, then stays open until the request's signal aborts. */
function openStream(seen: Seen, chunks: readonly string[], onAbort?: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        seen.signal?.addEventListener("abort", () => {
          onAbort?.();
          controller.error(new Error("aborted"));
        });
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("createStreamableHttpTransport — part-2 review fixes", () => {
  test("a gateway 503/401 with a JSON-RPC-shaped body is still an HTTP failure: ping rejects", async () => {
    for (const status of [503, 401]) {
      const { fetch } = fakeFetch(
        server((body) =>
          json(
            { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "gateway" } },
            {},
            status,
          ),
        ),
      );
      const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
      await client.initialize();
      const error = await client.ping(1_000).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(McpHttpStatusError);
      expect(String(error)).toContain(`HTTP ${status}`);
    }
  });

  test("a gateway's own JSON error on 404 (not JSON-RPC) is an HTTP failure: ping rejects", async () => {
    let gatewayDown = false;
    const { fetch } = fakeFetch((body, seen) =>
      gatewayDown
        ? json({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, {}, 404)
        : modernServer(() => accepted())(body, seen),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    gatewayDown = true;
    await expect(client.ping(1_000)).rejects.toBeInstanceOf(McpHttpStatusError);
  });

  test("a 400 JSON-RPC error for another id is not taken as ours", async () => {
    const { fetch } = fakeFetch(
      server(() =>
        json({ jsonrpc: "2.0", id: 999, error: { code: -32602, message: "not yours" } }, {}, 400),
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    await expect(client.listTools()).rejects.toThrow("HTTP 400");
  });

  test("a stream that breaks mid-reply fails only that call (outcome unknown); the connection lives", async () => {
    const { fetch } = fakeFetch(
      server((body) => {
        if (body.method === "tools/call") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": working\n\n"));
                setTimeout(() => controller.error(new Error("connection reset")), 5);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return json({ jsonrpc: "2.0", id: body.id, result: {} });
      }),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    const error = await client.callTool("t", {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpStreamLostError);
    expect(String(error)).toContain("outcome is unknown");
    expect(client.isClosed).toBe(false);
    await client.ping(1_000);
  });

  test("a stream the server keeps open after the reply is closed by the client", async () => {
    let aborted = false;
    const { fetch } = fakeFetch(
      server((body, seen) =>
        openStream(
          seen,
          [`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n\n`],
          () => {
            aborted = true;
          },
        ),
      ),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    await client.listTools();
    await Bun.sleep(5);
    expect(aborted).toBe(true);
    expect(client.isClosed).toBe(false);
  });

  test("2026 binding rules stay off legacy requests: no Mcp-Method/Mcp-Name, no x-mcp-header filtering", async () => {
    const invalid = {
      name: "bad",
      inputSchema: { properties: { n: { type: "number", "x-mcp-header": "N" } } },
    };
    const { fetch, calls } = fakeFetch(
      server((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [invalid] } })),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }));
    await client.initialize();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["bad"]);
    const list = calls.find((c) => (c.body as { method?: string }).method === "tools/list");
    expect(list?.headers.get("mcp-method")).toBeNull();
    expect(list?.headers.get("mcp-name")).toBeNull();
  });

  test("a probe that times out on a silent legacy server: stream closed, nothing POSTed, legacy fallback", async () => {
    let probeAborted = false;
    const legacyServer = server(() => json({ jsonrpc: "2.0", id: 0, result: {} }));
    const { fetch, calls } = fakeFetch((body, seen) =>
      body.method === "server/discover"
        ? openStream(seen, [], () => {
            probeAborted = true;
          })
        : legacyServer(body, seen),
    );
    const client = new McpClient(createStreamableHttpTransport(spec, { fetch }), undefined, {
      probeTimeoutMs: 20,
    });
    await client.initialize();
    expect(client.era).toBe("legacy");
    expect(probeAborted).toBe(true);
    expect(
      calls.some((c) => (c.body as { method?: string }).method === "notifications/cancelled"),
    ).toBe(false);
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

  test("a strict modern-only server: connect, list, call and ping, with spec header validation", async () => {
    const seen: string[] = [];
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push(req.method);
        if (req.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const msg = (await req.json()) as {
          id?: number;
          method: string;
          params?: { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
        };
        const reject = (code: number, message: string, data?: unknown) =>
          Response.json(
            { jsonrpc: "2.0", id: msg.id, error: { code, message, data } },
            { status: 400 },
          );
        const version = msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
        if (msg.method === "initialize" || version !== "2026-07-28") {
          return reject(-32022, "Unsupported protocol version", { supported: ["2026-07-28"] });
        }
        if (
          req.headers.get("mcp-protocol-version") !== version ||
          req.headers.get("mcp-method") !== msg.method ||
          (msg.method === "tools/call" && req.headers.get("mcp-name") !== msg.params?.name)
        ) {
          return reject(-32020, "Header mismatch");
        }
        const result =
          msg.method === "server/discover"
            ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
            : msg.method === "tools/list"
              ? {
                  tools: [{ name: "echo", inputSchema: { type: "object" } }],
                  ttlMs: 0,
                  cacheScope: "private",
                }
              : { content: [{ type: "text", text: JSON.stringify(msg.params?.arguments) }] };
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", ...result } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const result = await connectMcpServers({
        modern: { type: "http", url: `http://localhost:${http.port}/mcp` },
      });
      expect(result.errors).toEqual({});
      const [connection] = result.connections;
      expect(connection?.toolNames).toEqual(["echo"]);
      await connection?.ping(1_000);
      const tool = result.tools[0];
      const out = await tool?.execute({ a: 1 }, { signal: new AbortController().signal } as never);
      expect(out).toMatchObject({ content: '{"a":1}', isError: false });
      result.dispose();
      await Bun.sleep(20);
      expect(seen.every((m) => m === "POST")).toBe(true); // no GET stream, no session DELETE
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

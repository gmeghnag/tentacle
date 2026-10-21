import { describe, expect, test } from "bun:test";
import { McpClient, McpHandshakeClosedError } from "../src/client.ts";
import type { McpTransport } from "../src/types.ts";

/** A transport backed by in-memory handlers keyed by JSON-RPC method. */
function scriptedTransport(handlers: Record<string, (params: unknown) => unknown>): {
  transport: McpTransport;
  sent: unknown[];
} {
  let onMessage: ((m: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const sent: unknown[] = [];
  const transport: McpTransport = {
    send(message) {
      sent.push(message);
      const m = message as { id?: unknown; method?: string; params?: unknown };
      if (typeof m.id !== "number") {
        return; // notification
      }
      const id = m.id;
      const method = m.method ?? "";
      queueMicrotask(() => {
        const handler = handlers[method];
        if (handler) {
          onMessage?.({ jsonrpc: "2.0", id, result: handler(m.params) });
        } else {
          onMessage?.({ jsonrpc: "2.0", id, error: { message: `no handler: ${method}` } });
        }
      });
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
    close() {
      onClose?.();
    },
  };
  return { transport, sent };
}

describe("McpClient", () => {
  test("initialize handshakes and then sends the initialized notification", async () => {
    const { transport, sent } = scriptedTransport({
      initialize: () => ({ protocolVersion: "2024-11-05", capabilities: {} }),
    });
    const client = new McpClient(transport);
    await client.initialize();
    const methods = sent.map((m) => (m as { method?: string }).method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
  });

  test("listTools returns the server's tools", async () => {
    const { transport } = scriptedTransport({
      initialize: () => ({ protocolVersion: "2025-11-25" }),
      "tools/list": () => ({
        tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }],
      }),
    });
    const client = new McpClient(transport);
    await client.initialize();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");
  });

  test("callTool forwards name and arguments and returns the result", async () => {
    let received: unknown;
    const { transport } = scriptedTransport({
      initialize: () => ({ protocolVersion: "2025-11-25" }),
      "tools/call": (params) => {
        received = params;
        return { content: [{ type: "text", text: "hi there" }] };
      },
    });
    const client = new McpClient(transport);
    await client.initialize();
    const result = await client.callTool("echo", { msg: "hi" });
    expect(received).toEqual({ name: "echo", arguments: { msg: "hi" } });
    expect(result.content?.[0]).toEqual({ type: "text", text: "hi there" });
  });

  test("a JSON-RPC error rejects the request", async () => {
    const { transport } = scriptedTransport({}); // no handlers → error responses
    const client = new McpClient(transport);
    await expect(client.initialize()).rejects.toThrow("no handler: initialize");
  });

  test("closing rejects in-flight requests", async () => {
    // A transport that never replies, so the request stays pending until close.
    let onClose: (() => void) | undefined;
    const transport: McpTransport = {
      send() {},
      onMessage() {},
      onClose(l) {
        onClose = l;
      },
      close() {
        onClose?.();
      },
    };
    const client = new McpClient(transport);
    const pending = client.listTools();
    client.close();
    await expect(pending).rejects.toThrow("closed");
  });
});

/** A transport that records sends but never replies, and can inject messages. */
function silentTransport(): {
  transport: McpTransport;
  sent: unknown[];
  emit: (message: unknown) => void;
} {
  let onMessage: ((m: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const transport: McpTransport = {
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onClose() {},
    close() {},
  };
  return { transport, sent, emit: (m) => onMessage?.(m) };
}

const methodsOf = (sent: unknown[]): unknown[] =>
  sent.map((m) => (m as { method?: string }).method);

describe("McpClient per-call timeout + cancellation", () => {
  test("callTool rejects on timeout and sends notifications/cancelled", async () => {
    const { transport, sent } = silentTransport();
    const client = new McpClient(transport);
    await expect(client.callTool("slow", {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(methodsOf(sent)).toContain("notifications/cancelled");
  });

  test("callTool rejects when the abort signal fires, sending a cancellation", async () => {
    const { transport, sent } = silentTransport();
    const client = new McpClient(transport);
    const ac = new AbortController();
    const pending = client.callTool("slow", {}, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(methodsOf(sent)).toContain("notifications/cancelled");
  });

  test("an already-aborted signal rejects without even sending the request", async () => {
    const { transport, sent } = silentTransport();
    const client = new McpClient(transport);
    const ac = new AbortController();
    ac.abort();
    await expect(client.callTool("x", {}, { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(sent).toHaveLength(0);
  });

  test("replies method-not-found to an inbound server request (never hangs it)", () => {
    const { transport, sent, emit } = silentTransport();
    new McpClient(transport);
    emit({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} });
    const reply = sent.find((m) => (m as { id?: number }).id === 99) as {
      id: number;
      error: { code: number };
    };
    expect(reply).toMatchObject({ id: 99, error: { code: -32601 } });
  });

  test("ignores an inbound server notification (no id) without replying", () => {
    const { transport, sent, emit } = silentTransport();
    new McpClient(transport);
    emit({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    expect(sent).toHaveLength(0);
  });
});

describe("McpClient ping (reachability)", () => {
  test("resolves when the server answers ping", async () => {
    const { transport, sent } = scriptedTransport({ ping: () => ({}) });
    const client = new McpClient(transport);
    await client.ping(50);
    expect(methodsOf(sent)).toEqual(["ping"]);
  });

  test("an error response still proves the server is reachable", async () => {
    const { transport } = scriptedTransport({}); // no `ping` handler → error response
    const client = new McpClient(transport);
    await client.ping(50);
  });

  test("rejects on timeout", async () => {
    const { transport } = silentTransport();
    const client = new McpClient(transport);
    await expect(client.ping(20)).rejects.toThrow(/timed out/);
  });

  test("rejects once closed, and isClosed reports it", async () => {
    const { transport } = scriptedTransport({ ping: () => ({}) });
    const client = new McpClient(transport);
    expect(client.isClosed).toBe(false);
    client.close();
    expect(client.isClosed).toBe(true);
    await expect(client.ping(50)).rejects.toThrow("closed");
  });
});

type Reply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | "silent";

/** A transport whose server answers each request through `reply` (by method, with params). */
function eraTransport(reply: (method: string, params: unknown) => Reply): {
  transport: McpTransport;
  sent: { method?: string; params?: { _meta?: Record<string, unknown> } }[];
  closeNow(reason: string): void;
} {
  let onMessage: ((m: unknown) => void) | undefined;
  let onClose: ((reason?: string) => void) | undefined;
  const sent: { method?: string; params?: { _meta?: Record<string, unknown> } }[] = [];
  const transport: McpTransport = {
    send(message) {
      const m = message as { id?: unknown; method?: string; params?: unknown };
      sent.push(m as (typeof sent)[number]);
      if (typeof m.id !== "number" || m.method === undefined) {
        return;
      }
      const id = m.id;
      const r = reply(m.method, m.params);
      if (r !== "silent") {
        queueMicrotask(() => onMessage?.({ jsonrpc: "2.0", id, ...r }));
      }
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
    close() {
      onClose?.();
    },
  };
  return { transport, sent, closeNow: (reason) => onClose?.(reason) };
}

const discover = (supportedVersions: unknown): Reply => ({
  result: { resultType: "complete", supportedVersions, capabilities: { tools: {} } },
});
const unsupported = (supported: string[]): Reply => ({
  error: { code: -32022, message: "Unsupported protocol version", data: { supported } },
});
const legacy =
  (protocolVersion: string) =>
  (method: string): Reply =>
    method === "initialize"
      ? { result: { protocolVersion, capabilities: {} } }
      : method === "server/discover"
        ? { error: { code: -32601, message: "Method not found" } }
        : { result: { tools: [] } };

describe("McpClient dual-era negotiation (MCP 2026-07-28 backward compatibility)", () => {
  test("a DiscoverResult with our version → modern: no initialize, `_meta` on every request", async () => {
    const { transport, sent } = eraTransport((method) =>
      method === "server/discover"
        ? discover(["2026-07-28", "2025-11-25"])
        : { result: { tools: [] } },
    );
    const client = new McpClient(transport, { name: "t", version: "1" });
    await client.initialize();
    expect(client.era).toBe("modern");
    expect(client.protocolVersion).toBe("2026-07-28");
    await client.listTools();
    expect(sent.map((m) => m.method)).toEqual(["server/discover", "tools/list"]);
    for (const m of sent) {
      expect(m.params?._meta).toEqual({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      });
    }
  });

  test("UnsupportedProtocolVersion listing our modern version → modern", async () => {
    const { transport } = eraTransport(() => unsupported(["2026-07-28"]));
    const client = new McpClient(transport);
    await client.initialize();
    expect(client.era).toBe("modern");
  });

  test("a dual-era server offering only legacy versions → legacy handshake", async () => {
    const { transport, sent } = eraTransport((method) =>
      method === "server/discover" ? unsupported(["2025-06-18"]) : legacy("2025-06-18")(method),
    );
    const client = new McpClient(transport);
    await client.initialize();
    expect(client.era).toBe("legacy");
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(sent.map((m) => m.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
  });

  test("a modern server sharing no version → rejects, naming both sides", async () => {
    const { transport, sent } = eraTransport(() => unsupported(["2099-01-01"]));
    const client = new McpClient(transport);
    await expect(client.initialize()).rejects.toThrow(
      /supports protocol versions 2099-01-01.*2026-07-28/,
    );
    expect(sent.some((m) => m.method === "initialize")).toBe(false);
  });

  test("another reserved modern error (HeaderMismatch) → rejects, never falls back", async () => {
    const { transport, sent } = eraTransport(() => ({
      error: { code: -32020, message: "Header mismatch" },
    }));
    const client = new McpClient(transport);
    await expect(client.initialize()).rejects.toThrow("Header mismatch");
    expect(sent.some((m) => m.method === "initialize")).toBe(false);
  });

  test.each([
    ["-32601", { error: { code: -32601, message: "Method not found" } }],
    ["-32602", { error: { code: -32602, message: "Invalid params" } }],
    ["a codeless error", { error: { code: -32000, message: "Server not initialized" } }],
    ["a non-discover result", { result: {} }],
  ] as const)(
    "legacy fallback on %s; the legacy version is negotiated",
    async (_name, probeReply) => {
      const { transport, sent } = eraTransport((method) =>
        method === "server/discover" ? (probeReply as Reply) : legacy("2025-11-25")(method),
      );
      const client = new McpClient(transport);
      await client.initialize();
      expect(client.era).toBe("legacy");
      expect(client.protocolVersion).toBe("2025-11-25");
      const init = sent.find((m) => m.method === "initialize") as {
        params?: { protocolVersion?: string };
      };
      expect(init.params?.protocolVersion).toBe("2025-11-25");
      await client.listTools();
      expect(sent.at(-1)?.params?._meta).toBeUndefined();
    },
  );

  test("a silent probe → legacy after the probe timeout", async () => {
    const { transport } = eraTransport((method) =>
      method === "server/discover" ? "silent" : legacy("2024-11-05")(method),
    );
    const client = new McpClient(transport, undefined, { probeTimeoutMs: 20 });
    await client.initialize();
    expect(client.era).toBe("legacy");
  });

  test("the transport closing during the probe is unreachable, not legacy", async () => {
    const t = eraTransport(() => "silent");
    const client = new McpClient(t.transport, undefined, { probeTimeoutMs: 5_000 });
    const pending = client.initialize();
    t.closeNow("Unable to connect");
    await expect(pending).rejects.toThrow("MCP connection closed: Unable to connect");
  });

  test("a legacy server picking a version we do not speak → rejects and closes", async () => {
    const { transport } = eraTransport(legacy("2030-01-01"));
    const client = new McpClient(transport);
    await expect(client.initialize()).rejects.toThrow("chose protocol version 2030-01-01");
    expect(client.isClosed).toBe(true);
  });

  test("ping: `server/discover` when modern (no `ping` in 2026-07-28), `ping` when legacy", async () => {
    const modern = eraTransport((method) =>
      method === "server/discover"
        ? discover(["2026-07-28"])
        : { error: { code: -32601, message: "x" } },
    );
    const m = new McpClient(modern.transport);
    await m.initialize();
    await m.ping(1_000);
    expect(modern.sent.at(-1)?.method).toBe("server/discover");

    const old = eraTransport((method) =>
      method === "ping" ? { result: {} } : legacy("2025-11-25")(method),
    );
    const l = new McpClient(old.transport);
    await l.initialize();
    await l.ping(1_000);
    expect(old.sent.at(-1)?.method).toBe("ping");
  });

  test("an input_required result (MRTR) fails the call instead of passing an interim result", async () => {
    const { transport } = eraTransport((method) =>
      method === "server/discover"
        ? discover(["2026-07-28"])
        : { result: { resultType: "input_required", inputRequests: {} } },
    );
    const client = new McpClient(transport);
    await client.initialize();
    await expect(client.callTool("t", {})).rejects.toThrow("input_required");
  });
});

describe("McpClient — part-2 review fixes", () => {
  test("a close during the probe is a McpHandshakeClosedError (the caller may respawn)", async () => {
    const t = eraTransport(() => "silent");
    const client = new McpClient(t.transport);
    const pending = client.initialize();
    t.closeNow("process exited");
    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpHandshakeClosedError);
    expect(String(error)).toContain("process exited");
  });

  test("a timed-out probe is abandoned silently: no notifications/cancelled, transport told to abandon", async () => {
    const t = eraTransport((method) =>
      method === "server/discover" ? "silent" : legacy("2025-06-18")(method),
    );
    const abandoned: unknown[] = [];
    const client = new McpClient(
      { ...t.transport, abandon: (id) => abandoned.push(id) },
      undefined,
      { probeTimeoutMs: 20 },
    );
    await client.initialize();
    expect(client.era).toBe("legacy");
    expect(t.sent.some((m) => m.method === "notifications/cancelled")).toBe(false);
    expect(abandoned).toEqual([1]); // the probe's id
  });

  test("an ordinary call's timeout still notifies the server", async () => {
    const t = eraTransport((method) =>
      method === "tools/call" ? "silent" : legacy("2025-06-18")(method),
    );
    const client = new McpClient(t.transport, undefined, { callTimeoutMs: 20 });
    await client.initialize();
    await expect(client.callTool("t", {})).rejects.toThrow("timed out");
    expect(t.sent.at(-1)?.method).toBe("notifications/cancelled");
  });

  test("legacyOnly skips the probe", async () => {
    const t = eraTransport(legacy("2025-11-25"));
    const client = new McpClient(t.transport);
    await client.initialize({ legacyOnly: true });
    expect(t.sent[0]?.method).toBe("initialize");
    expect(t.sent.some((m) => m.method === "server/discover")).toBe(false);
  });

  test("a legacy initialize result without protocolVersion is rejected", async () => {
    const t = eraTransport((method) =>
      method === "initialize" ? { result: { capabilities: {} } } : legacy("2025-11-25")(method),
    );
    const client = new McpClient(t.transport);
    await expect(client.initialize()).rejects.toThrow("did not state a protocol version");
    expect(client.isClosed).toBe(true);
  });

  test("listTools follows nextCursor across pages", async () => {
    const pages: Record<string, unknown> = {
      "": { tools: [{ name: "a" }], nextCursor: "p2" },
      p2: { tools: [{ name: "b" }, { name: "c" }], nextCursor: "p3" },
      p3: { tools: [{ name: "d" }] },
    };
    const t = eraTransport((method, params) =>
      method === "tools/list"
        ? { result: pages[(params as { cursor?: string } | undefined)?.cursor ?? ""] }
        : legacy("2025-11-25")(method),
    );
    const client = new McpClient(t.transport);
    await client.initialize();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["a", "b", "c", "d"]);
    const cursors = t.sent
      .filter((m) => m.method === "tools/list")
      .map((m) => (m.params as { cursor?: string } | undefined)?.cursor);
    expect(cursors).toEqual([undefined, "p2", "p3"]);
  });

  test("a repeated cursor or an endless list fails instead of looping", async () => {
    const loop = eraTransport((method) =>
      method === "tools/list"
        ? { result: { tools: [], nextCursor: "same" } }
        : legacy("2025-11-25")(method),
    );
    const a = new McpClient(loop.transport);
    await a.initialize();
    await expect(a.listTools()).rejects.toThrow('repeated tools/list cursor "same"');

    let n = 0;
    const endless = eraTransport((method) =>
      method === "tools/list"
        ? { result: { tools: [], nextCursor: `c${n++}` } }
        : legacy("2025-11-25")(method),
    );
    const b = new McpClient(endless.transport);
    await b.initialize();
    await expect(b.listTools()).rejects.toThrow("more than 100 pages");
  });
});

describe("McpClient — part-3 review fixes", () => {
  test("a close during the legacy initialize after a probe is a McpHandshakeClosedError", async () => {
    const t = eraTransport((method) => {
      if (method === "initialize") {
        queueMicrotask(() => t.closeNow("process exited"));
        return "silent";
      }
      return { error: { code: -32600, message: "not initialized" } };
    });
    const client = new McpClient(t.transport);
    const error = await client.initialize().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpHandshakeClosedError);
  });

  test("legacyOnly: a close is a plain failure, never another respawn signal", async () => {
    const t = eraTransport(() => {
      queueMicrotask(() => t.closeNow("process exited"));
      return "silent";
    });
    const client = new McpClient(t.transport);
    const error = await client.initialize({ legacyOnly: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McpHandshakeClosedError);
  });

  test("a modern server still booting when the probe timed out is found on the second probe", async () => {
    let discovers = 0;
    const t = eraTransport((method) => {
      if (method === "server/discover") {
        discovers++;
        return discovers === 1 ? "silent" : discover(["2026-07-28"]);
      }
      // A modern-only server rejects the legacy handshake.
      return { error: { code: -32601, message: "initialize is not supported" } };
    });
    const client = new McpClient(t.transport, undefined, { probeTimeoutMs: 20 });
    await client.initialize();
    expect(client.era).toBe("modern");
    expect(t.sent.map((m) => m.method)).toEqual([
      "server/discover",
      "initialize",
      "server/discover",
    ]);
  });

  test("no second probe when the first one was answered: the initialize error stands", async () => {
    const t = eraTransport((method) =>
      method === "server/discover"
        ? { error: { code: -32601, message: "Method not found" } }
        : { error: { code: -32603, message: "broken" } },
    );
    const client = new McpClient(t.transport);
    await expect(client.initialize()).rejects.toThrow("broken");
    expect(t.sent.filter((m) => m.method === "server/discover")).toHaveLength(1);
  });

  test("a timed-out probe, a failed initialize and a non-modern second probe: the initialize error stands", async () => {
    let discovers = 0;
    const t = eraTransport((method) => {
      if (method === "server/discover") {
        discovers++;
        return discovers === 1
          ? "silent"
          : { error: { code: -32601, message: "Method not found" } };
      }
      return { error: { code: -32603, message: "broken" } };
    });
    const client = new McpClient(t.transport, undefined, { probeTimeoutMs: 20 });
    await expect(client.initialize()).rejects.toThrow("broken");
  });
});

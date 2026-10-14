import { describe, expect, test } from "bun:test";
import { McpClient } from "../src/client.ts";
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
      initialize: () => ({}),
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
      initialize: () => ({}),
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

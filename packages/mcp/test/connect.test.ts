import { describe, expect, test } from "bun:test";
import { connectMcpServers } from "../src/connect.ts";
import type { McpTransport } from "../src/types.ts";

/** An auto-responding in-memory transport for a server exposing one tool. */
function okTransport(toolName: string): McpTransport {
  let onMessage: ((m: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const results: Record<string, unknown> = {
    initialize: {},
    "tools/list": { tools: [{ name: toolName, inputSchema: { type: "object" } }] },
  };
  return {
    send(message) {
      const m = message as { id?: unknown; method?: string };
      if (typeof m.id !== "number") {
        return;
      }
      const id = m.id;
      const result = results[m.method ?? ""];
      queueMicrotask(() => onMessage?.({ jsonrpc: "2.0", id, result }));
    },
    onMessage(l) {
      onMessage = l;
    },
    onClose(l) {
      onClose = l;
    },
    close() {
      onClose?.();
    },
  };
}

/** A transport that never answers — initialize will hit the timeout. */
function silentTransport(): McpTransport {
  let onClose: (() => void) | undefined;
  return {
    send() {},
    onMessage() {},
    onClose(l) {
      onClose = l;
    },
    close() {
      onClose?.();
    },
  };
}

describe("connectMcpServers", () => {
  test("connects each server and collects namespaced tools", async () => {
    const result = await connectMcpServers(
      {
        alpha: { command: "x" },
        beta: { command: "y" },
      },
      { createTransport: (spec) => okTransport(`t-${spec.command}`) },
    );
    expect(result.errors).toEqual({});
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["mcp__alpha__t-x", "mcp__beta__t-y"]);
    // Each connection also keeps its server's bare tool names (what `/mcp` lists).
    const bare = Object.fromEntries(result.connections.map((c) => [c.name, c.toolNames]));
    expect(bare).toEqual({ alpha: ["t-x"], beta: ["t-y"] });
    result.dispose();
  });

  test("isolates a failing server without losing the healthy ones", async () => {
    const result = await connectMcpServers(
      {
        good: { command: "x" },
        bad: { command: "y" },
      },
      {
        timeoutMs: 50,
        createTransport: (spec) => (spec.command === "y" ? silentTransport() : okTransport("ok")),
      },
    );
    expect(result.tools.map((t) => t.name)).toEqual(["mcp__good__ok"]);
    expect(result.errors.bad).toContain("timed out");
    result.dispose();
  });

  test("no servers → empty result", async () => {
    const result = await connectMcpServers({});
    expect(result.tools).toEqual([]);
    expect(result.connections).toEqual([]);
  });
});

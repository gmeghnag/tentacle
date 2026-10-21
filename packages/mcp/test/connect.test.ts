import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectMcpServers } from "../src/connect.ts";
import type { McpTransport } from "../src/types.ts";

/** An auto-responding in-memory transport for a server exposing one tool. */
function okTransport(toolName: string): McpTransport {
  let onMessage: ((m: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const results: Record<string, unknown> = {
    initialize: { protocolVersion: "2025-11-25" },
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
      {
        createTransport: (spec) => okTransport(`t-${"command" in spec ? spec.command : spec.url}`),
      },
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
        createTransport: (spec) =>
          "command" in spec && spec.command === "y" ? silentTransport() : okTransport("ok"),
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

describe("connectMcpServers — legacy stdio servers vs the era probe (real processes)", () => {
  const fixture = join(import.meta.dir, "fixtures", "strict-legacy-stdio-server.ts");
  const strict = (mode: string) => ({
    command: process.execPath,
    args: [fixture],
    env: { MODE: mode },
  });

  test("a server that exits on the probe is respawned once, legacy-only, and connects", async () => {
    const result = await connectMcpServers({ s: strict("exit-on-unknown") });
    try {
      expect(result.errors).toEqual({});
      const [connection] = result.connections;
      expect(connection?.toolNames).toEqual(["echo"]);
      await connection?.ping(1_000);
    } finally {
      result.dispose();
    }
  });

  test("a server that answers the probe with an error and then exits is respawned too", async () => {
    const result = await connectMcpServers({ s: strict("reply-then-exit") });
    try {
      expect(result.errors).toEqual({});
      expect(result.connections[0]?.toolNames).toEqual(["echo"]);
    } finally {
      result.dispose();
    }
  });

  test("a timed-out probe sends no cancel notification, so a strict server survives it", async () => {
    const result = await connectMcpServers({ s: strict("strict-notify") }, { probeTimeoutMs: 100 });
    try {
      expect(result.errors).toEqual({});
      expect(result.connections[0]?.toolNames).toEqual(["echo"]);
    } finally {
      result.dispose();
    }
  });
});

describe("connectMcpServers — respawn policy", () => {
  /** A transport that dies on the probe (like a legacy server exiting), else answers. */
  function dyingOnProbe(): McpTransport {
    let onMessage: ((m: unknown) => void) | undefined;
    let onClose: ((reason?: string) => void) | undefined;
    return {
      send(message) {
        const m = message as { id?: unknown; method?: string };
        if (m.method === "server/discover") {
          queueMicrotask(() => onClose?.("server exited"));
          return;
        }
        if (typeof m.id === "number") {
          const id = m.id;
          const result =
            m.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : { tools: [{ name: "t", inputSchema: { type: "object" } }] };
          queueMicrotask(() => onMessage?.({ jsonrpc: "2.0", id, result }));
        }
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

  test("stdio: respawned exactly once, the second spawn never probes", async () => {
    const spawned: string[][] = [];
    const result = await connectMcpServers(
      { s: { command: "x" } },
      {
        createTransport: () => {
          const methods: string[] = [];
          spawned.push(methods);
          const inner = dyingOnProbe();
          return {
            ...inner,
            send(m) {
              methods.push((m as { method?: string }).method ?? "");
              inner.send(m);
            },
          };
        },
      },
    );
    expect(result.errors).toEqual({});
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toEqual(["server/discover"]);
    expect(spawned[1]?.[0]).toBe("initialize");
  });

  test("http: a close during the probe is unreachable — no retry", async () => {
    let created = 0;
    const result = await connectMcpServers(
      { r: { type: "http", url: "https://x.test/mcp" } },
      {
        createTransport: () => {
          created++;
          return dyingOnProbe();
        },
      },
    );
    expect(created).toBe(1);
    expect(result.errors.r).toContain("server exited");
  });
});

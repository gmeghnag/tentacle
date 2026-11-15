import { describe, expect, test } from "bun:test";
import type { Tool } from "@tentacle/core";
import type { ConnectMcpResult, McpConnection, McpServerStatus } from "@tentacle/mcp";
import { ToolRegistry } from "@tentacle/tools";
import { capStderr, createMcpHub } from "../src/mcp-hub.ts";

/** A fake connection: open until `close()` (or `crash()`), one listed tool name. */
function fakeConnection(name: string, toolNames: string[], onClose?: () => void): McpConnection {
  let open = true;
  const listeners = new Set<(reason?: string) => void>();
  return {
    name,
    toolNames,
    tools: [],
    close: () => {
      open = false;
      onClose?.();
      for (const listener of listeners) listener();
    },
    isOpen: () => open,
    ping: async () => {},
    client: () => ({}) as ReturnType<McpConnection["client"]>,
    onClose: (listener) => {
      listeners.add(listener);
    },
  };
}

/** One tool per server, named `mcp__<server>__<tool>`. */
function toolFor(server: string, tool: string): Tool {
  return { name: `mcp__${server}__${tool}` } as unknown as Tool;
}

/** A `connect` seam whose promise the test resolves by hand. */
function deferredConnect(result: ConnectMcpResult) {
  let settle: (value: ConnectMcpResult) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<ConnectMcpResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return {
    connect: () => promise,
    settle: () => settle(result),
    fail: (error: unknown) => fail(error),
    result,
  };
}

/** Let the hub's `then`/`catch` handlers run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMcpHub", () => {
  test("T1: a registry built before settle gets the tools at settle; one built after, at once", async () => {
    const connection = fakeConnection("echo", ["echo"]);
    const deferred = deferredConnect({
      connections: [connection],
      tools: [toolFor("echo", "echo")],
      errors: {},
      dispose: () => connection.close(),
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect },
    );
    hub.start();
    const early = new ToolRegistry();
    hub.onBuilt(early);
    expect(early.list().map((t) => t.name)).toEqual([]);
    expect(hub.ready()).toBe(false);

    deferred.settle();
    await tick();
    expect(early.list().map((t) => t.name)).toEqual(["mcp__echo__echo"]);
    expect(hub.ready()).toBe(true);

    const late = new ToolRegistry();
    hub.onBuilt(late);
    expect(late.list().map((t) => t.name)).toEqual(["mcp__echo__echo"]);
    hub.dispose();
  });

  test("T2: a name clash is skipped and reported, never silently dropped", async () => {
    const clashes: string[] = [];
    const connection = fakeConnection("echo", ["echo"]);
    const deferred = deferredConnect({
      connections: [connection],
      tools: [toolFor("echo", "echo")],
      errors: {},
      dispose: () => connection.close(),
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect, onClash: (line) => clashes.push(line) },
    );
    hub.start();
    // A built-in already owns the name the MCP tool would take.
    const registry = new ToolRegistry();
    registry.register(toolFor("echo", "echo"));
    hub.onBuilt(registry);
    deferred.settle();
    await tick();

    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toContain("mcp__echo__echo");
    // The pre-existing entry is the one that stays.
    expect(registry.list().map((t) => t.name)).toEqual(["mcp__echo__echo"]);
    hub.dispose();
  });

  test("T3: a connect that throws marks every server failed, is ready, and drops pending", async () => {
    const deferred = deferredConnect({
      connections: [],
      tools: [],
      errors: {},
      dispose: () => {},
    });
    const notices: Record<string, string>[] = [];
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect, onErrors: (errors) => notices.push({ ...errors }) },
    );
    hub.start();
    const registry = new ToolRegistry();
    hub.onBuilt(registry);
    deferred.fail(new Error("boom"));
    await tick();

    expect(hub.ready()).toBe(true);
    const status: McpServerStatus[] = await hub.status();
    expect(status.map((s) => [s.name, s.state])).toEqual([["echo", "failed"]]);
    expect(status[0]?.error).toContain("boom");
    expect(notices).toEqual([{ "*": "Error: boom" }]);
    expect(registry.list()).toEqual([]);
    // Nothing is left to flush into a registry built later.
    const later = new ToolRegistry();
    hub.onBuilt(later);
    expect(later.list()).toEqual([]);
    hub.dispose();
  });

  test("T4: dispose before settle closes the late connections exactly once, at settle", async () => {
    let closes = 0;
    const connection = fakeConnection("echo", ["echo"], () => {
      closes += 1;
    });
    const deferred = deferredConnect({
      connections: [connection],
      tools: [toolFor("echo", "echo")],
      errors: {},
      dispose: () => connection.close(),
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect },
    );
    hub.start();
    hub.dispose();
    // Nothing was connected yet: no close to run.
    expect(closes).toBe(0);

    deferred.settle();
    await tick();
    expect(closes).toBe(1);
    // A second dispose (the `exit` handler after `stop()`) is a no-op.
    hub.dispose();
    expect(closes).toBe(1);
  });

  test("T4b: dispose after settle closes at once and stays idempotent", async () => {
    let closes = 0;
    const connection = fakeConnection("echo", ["echo"], () => {
      closes += 1;
    });
    const deferred = deferredConnect({
      connections: [connection],
      tools: [toolFor("echo", "echo")],
      errors: {},
      dispose: () => connection.close(),
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect },
    );
    hub.start();
    deferred.settle();
    await tick();
    hub.dispose();
    expect(closes).toBe(1);
    hub.dispose();
    expect(closes).toBe(1);
  });

  test("a connect that reports per-server errors forwards them to onErrors", async () => {
    const connection = fakeConnection("echo", ["echo"]);
    const seen: Record<string, string>[] = [];
    const deferred = deferredConnect({
      connections: [connection],
      tools: [toolFor("echo", "echo")],
      errors: { missing: "spawn ENOENT" },
      dispose: () => connection.close(),
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" }, missing: { type: "stdio", command: "nope" } },
      { connect: deferred.connect, onErrors: (errors) => seen.push({ ...errors }) },
    );
    hub.start();
    deferred.settle();
    await tick();
    expect(seen).toEqual([{ missing: "spawn ENOENT" }]);
    expect(hub.ready()).toBe(true);
    hub.dispose();
  });

  test("status is `connecting` until the connect settles", async () => {
    const deferred = deferredConnect({
      connections: [],
      tools: [],
      errors: {},
      dispose: () => {},
    });
    const hub = createMcpHub(
      { echo: { type: "stdio", command: "x" } },
      { connect: deferred.connect },
    );
    expect((await hub.status()).map((s) => s.state)).toEqual(["connecting"]);
    hub.start();
    expect((await hub.status()).map((s) => s.state)).toEqual(["connecting"]);
    hub.dispose();
  });
});

describe("capStderr", () => {
  test("T10: 80 lines become 50 notices and one suppression line, per server", () => {
    const lines: string[] = [];
    const sink = capStderr((line) => lines.push(line));
    for (let i = 0; i < 80; i++) {
      sink("echo", `line ${i}`);
    }
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe("mcp echo: line 0");
    expect(lines[49]).toBe("mcp echo: line 49");
    expect(lines[50]).toBe("mcp echo: further stderr suppressed");
    // The cap is per server: another one still gets its own budget.
    sink("other", "hello");
    expect(lines[51]).toBe("mcp other: hello");
  });
});

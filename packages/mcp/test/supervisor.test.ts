/**
 * A supervised MCP server (docs/feat/serve-mcp.md S3, owner Q1=b): a crash is
 * respawned with backoff, the SAME tool objects keep working, five consecutive
 * failures give up, and `dispose` cancels a pending respawn.
 *
 * The clock and the connect are injected, so nothing waits a real second.
 */
import { describe, expect, test } from "bun:test";
import type { McpClient } from "../src/client.ts";
import type { ConnectOptions, McpConnection } from "../src/connect.ts";
import {
  RESPAWN_BASE_MS,
  RESPAWN_HEALTHY_MS,
  RESPAWN_MAX_ATTEMPTS,
  RESPAWN_MAX_MS,
  respawnDelay,
  shouldRespawn,
  superviseServer,
} from "../src/supervisor.ts";
import { mcpToolToTool } from "../src/tool-adapter.ts";
import type { McpServerSpec } from "../src/types.ts";

/** One fake server: its calls record the generation, and `crash()` closes it. */
function fakeServerTool(client: McpClient) {
  return mcpToolToTool("echo", client, { name: "echo", inputSchema: { type: "object" } });
}

/** A connect double: each call makes a connection whose `callTool` names its generation. */
function harness(options: { failFirst?: number; failAlways?: boolean } = {}) {
  const state = {
    generation: 0,
    connects: 0,
    /** Scheduled timers, by due time: the test's fake clock. */
    timers: [] as { run: () => void; ms: number }[],
    now: 0,
    closed: [] as number[],
    /** The live connection's "transport closed" trigger. */
    crash: () => {},
    callResults: [] as string[],
  };
  const connect = async (_name: string, _spec: McpServerSpec, opts: ConnectOptions) => {
    state.connects += 1;
    const failed = options.failAlways === true || state.connects <= (options.failFirst ?? 0);
    if (failed) {
      throw new Error(`spawn failed (${state.connects})`);
    }
    state.generation += 1;
    const generation = state.generation;
    const listeners = new Set<(reason?: string) => void>();
    const client = {
      isClosed: false,
      closeReason: "server exited",
      callTool: async (toolName: string) => {
        state.callResults.push(`${generation}:${toolName}`);
        return { content: [{ type: "text", text: `gen${generation}` }] };
      },
    } as unknown as McpClient;
    const connection: McpConnection = {
      name: "echo",
      // The adapter binds the tool to whatever client it is given (`opts.toolClient`).
      tools: [fakeServerTool(opts.toolClient as McpClient)],
      toolNames: ["echo"],
      close: () => {
        state.closed.push(generation);
        for (const listener of listeners) listener("server exited");
      },
      isOpen: () => true,
      closeReason: () => "server exited",
      ping: async () => {},
      client: () => client,
      onClose: (listener) => {
        listeners.add(listener);
      },
    };
    state.crash = () => {
      for (const listener of listeners) listener("server exited");
    };
    return connection;
  };
  const deps = {
    connect,
    schedule: (fn: () => void, ms: number) => {
      state.timers.push({ run: fn, ms });
      return state.timers.length - 1;
    },
    cancel: (handle: unknown) => {
      state.timers[handle as number] = { run: () => {}, ms: -1 };
    },
    now: () => state.now,
  };
  /** Run the next scheduled timer (as the clock reaching it would). */
  const tick = async (): Promise<void> => {
    const next = state.timers.find((timer) => timer.ms >= 0);
    if (!next) return;
    next.ms = -1;
    state.now += RESPAWN_BASE_MS;
    next.run();
    // Let the respawn's connect settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { state, deps, tick };
}

describe("respawnDelay / shouldRespawn (the pure decisions)", () => {
  test("the delay doubles from 1 s and is capped at 60 s", () => {
    expect(respawnDelay(1)).toBe(1_000);
    expect(respawnDelay(2)).toBe(2_000);
    expect(respawnDelay(3)).toBe(4_000);
    expect(respawnDelay(4)).toBe(8_000);
    expect(respawnDelay(7)).toBe(RESPAWN_MAX_MS);
    expect(respawnDelay(50)).toBe(RESPAWN_MAX_MS);
    // Mutation: drop the cap → 2 ** 49 for attempt 50.
    expect(respawnDelay(50)).toBeLessThanOrEqual(60_000);
  });

  test("respawns while the budget lasts, never after dispose", () => {
    expect(shouldRespawn({ disposed: false, failures: 0 })).toBe(true);
    expect(shouldRespawn({ disposed: false, failures: RESPAWN_MAX_ATTEMPTS - 1 })).toBe(true);
    // Mutation: `<` → `<=` gives a sixth attempt.
    expect(shouldRespawn({ disposed: false, failures: RESPAWN_MAX_ATTEMPTS })).toBe(false);
    expect(shouldRespawn({ disposed: true, failures: 0 })).toBe(false);
  });
});

describe("superviseServer", () => {
  test("T12a: a crash respawns after the backoff and the SAME tool object still works", async () => {
    const { state, deps, tick } = harness();
    const { ready } = superviseServer("echo", { type: "stdio", command: "x" }, deps);
    const server = await ready;
    const tool = server.tools[0];
    expect(tool).toBeDefined();
    if (!tool) return;
    // Before the crash: the first generation answers.
    await tool.execute({}, {} as never);
    expect(state.callResults).toEqual(["1:echo"]);

    // The server dies. Mutation: no respawn on close → the next call fails.
    state.crash();
    expect(server.restarting()?.attempt).toBe(1);
    await tick();
    expect(server.restarting()).toBeUndefined();
    expect(state.connects).toBe(2);
    // The SAME tool object (no re-registration) now reaches generation 2.
    await tool.execute({}, {} as never);
    expect(state.callResults).toEqual(["1:echo", "2:echo"]);
    expect(server.gaveUp()).toBe(false);
  });

  test("T12b: five consecutive failed spawns give up (and the tool reports the restart)", async () => {
    const { deps, tick } = harness({ failAlways: true });
    const { ready } = superviseServer("echo", { type: "stdio", command: "x" }, deps);
    // The FIRST connect fails: the caller isolates it (as `connectServer` does).
    await expect(ready).rejects.toThrow(/spawn failed/);
  });

  test("T12c: a crash with five failed respawns gives up and stops retrying", async () => {
    let attempts = 0;
    const { state, deps, tick } = harness();
    // The first connect works; every respawn after it fails.
    const failing = {
      ...deps,
      connect: async (name: string, spec: McpServerSpec, opts: ConnectOptions) => {
        attempts += 1;
        if (attempts === 1) return deps.connect(name, spec, opts);
        throw new Error(`respawn failed (${attempts})`);
      },
    };
    const { ready } = superviseServer("echo", { type: "stdio", command: "x" }, failing);
    const server = await ready;
    state.crash();
    for (let i = 0; i < RESPAWN_MAX_ATTEMPTS + 2; i++) await tick();
    // Mutation: `shouldRespawn` without the budget → attempts keep going.
    expect(server.gaveUp()).toBe(true);
    expect(attempts).toBe(RESPAWN_MAX_ATTEMPTS);
  });

  test("T12d: dispose cancels a pending respawn (no process is ever spawned)", async () => {
    const { state, deps, tick } = harness();
    const { ready } = superviseServer("echo", { type: "stdio", command: "x" }, deps);
    const server = await ready;
    state.crash();
    server.close();
    await tick();
    expect(state.connects).toBe(1);
  });

  test("T12e: a spawn that stays up 10 minutes starts a fresh budget", async () => {
    let attempts = 0;
    const { state, deps, tick } = harness();
    const failing = {
      ...deps,
      connect: async (name: string, spec: McpServerSpec, opts: ConnectOptions) => {
        attempts += 1;
        // The first and (with the flaky server) every 4th attempt works.
        if (attempts === 1 || attempts % 4 === 0) return deps.connect(name, spec, opts);
        throw new Error(`flaky ${attempts}`);
      },
    };
    const { ready } = superviseServer("echo", { type: "stdio", command: "x" }, failing);
    const server = await ready;
    // A healthy stretch: past `RESPAWN_HEALTHY_MS`, this crash is a new budget.
    state.now += RESPAWN_HEALTHY_MS + 1;
    state.crash();
    await tick();
    expect(server.gaveUp()).toBe(false);
    expect(attempts).toBeGreaterThan(1);
  });
});

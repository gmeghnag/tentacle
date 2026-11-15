/**
 * A supervised MCP server (docs/feat/serve-mcp.md S3, owner Q1=b).
 *
 * A `serve` daemon runs for days, and "restart serve" is not something anyone
 * can do from a phone — so a server that crashes must come back by itself. The
 * supervisor wraps ONE server's connection: it hears the transport close
 * (`McpConnection.onClose`, wired to the client), respawns after 1 s, 2 s, 4 s …
 * (capped at 60 s), and gives up after `RESPAWN_MAX_ATTEMPTS` consecutive
 * failures. A spawn that stays up `RESPAWN_HEALTHY_MS` resets the count, so a
 * server that crashes once a day never exhausts its budget.
 *
 * Tools stay STABLE across a respawn: `McpConnection.tools` close over the
 * client that made them, so a respawn would otherwise strand every live session
 * on a dead client. `routerClient` is the client those tools are built against:
 * it forwards every call to whatever client is current, and the supervisor moves
 * it forward on each respawn — invisible to a session mid-conversation.
 *
 * The decision logic is pure and clock-injected (`respawnDelay`,
 * `shouldRespawn`), so both are pinned without a real timer.
 */
import type { Tool } from "@tentacle/core";
import type { McpClient } from "./client.ts";
import { type ConnectOptions, type McpConnection, connectServer } from "./connect.ts";
import type { McpServerSpec } from "./types.ts";

/** First delay after a crash, doubling per attempt. */
export const RESPAWN_BASE_MS = 1_000;
/** Never wait longer than this between attempts. */
export const RESPAWN_MAX_MS = 60_000;
/** Give up after this many consecutive failures. */
export const RESPAWN_MAX_ATTEMPTS = 5;
/** A spawn that stays up this long counts as healthy: a later crash restarts the count. */
export const RESPAWN_HEALTHY_MS = 10 * 60 * 1000;

/** The delay before attempt `attempt` (1-based): 1 s, 2 s, 4 s, … capped at 60 s. */
export function respawnDelay(attempt: number): number {
  return Math.min(RESPAWN_BASE_MS * 2 ** Math.max(0, attempt - 1), RESPAWN_MAX_MS);
}

/** Whether a closed server is respawned: never after `dispose`, never past the budget. */
export function shouldRespawn(state: {
  readonly disposed: boolean;
  readonly failures: number;
}): boolean {
  return !state.disposed && state.failures < RESPAWN_MAX_ATTEMPTS;
}

/**
 * The client a supervised server's tools are built against: every call forwards
 * to the CURRENT client, so a tool object created by the first connect keeps
 * working across respawns. With no live client it rejects (the server is
 * restarting) — the model gets a tool error, never a hang.
 */
function routerClient(current: () => McpClient | undefined): McpClient {
  return new Proxy({} as McpClient, {
    get(_target, property) {
      const client = current();
      if (client === undefined) {
        return property === "isClosed"
          ? true
          : () => Promise.reject(new Error("MCP server is restarting"));
      }
      const value = Reflect.get(client as unknown as Record<string | symbol, unknown>, property);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

/** A server whose tools survive a respawn: an `McpConnection` plus its state. */
export interface SupervisedServer extends McpConnection {
  /** `/mcp`: `attempt` of the respawn in flight; undefined when connected or given up. */
  restarting(): { readonly attempt: number } | undefined;
  /** True once the supervisor stopped retrying (the budget is spent). */
  gaveUp(): boolean;
}

export interface SupervisorDeps {
  /** How one connection is made (a test injects a fake; default `connectServer`). */
  readonly connect?: (
    name: string,
    spec: McpServerSpec,
    options: ConnectOptions,
  ) => Promise<McpConnection>;
  /** The `connectServer` options (transport factory, stderr, timeouts). */
  readonly connectOptions?: ConnectOptions;
  /** A timer (a test injects a fake clock). Default `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  /** The matching cancel. Default `clearTimeout`. */
  readonly cancel?: (handle: unknown) => void;
  /** Now in ms (a test injects it): a long-lived spawn resets the failure count. */
  readonly now?: () => number;
  /** Every restart attempt, its failure and the final give-up (one line each). */
  readonly onRestart?: (line: string) => void;
}

/**
 * Supervise one server. `ready` resolves once the FIRST connection is made — it
 * rejects with the server's connect error, so the caller isolates that server
 * exactly as `connectServer` does today.
 */
export function superviseServer(
  name: string,
  spec: McpServerSpec,
  deps: SupervisorDeps = {},
): { readonly ready: Promise<SupervisedServer>; readonly server: SupervisedServer } {
  const connect = deps.connect ?? connectServer;
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  let live: McpConnection | undefined;
  /** The client tools call: the routing proxy, so a respawn never strands them. */
  let routedClient: McpClient | undefined;
  let failures = 0;
  let attempt = 0;
  let disposed = false;
  let gaveUp = false;
  let timer: unknown;
  let upSince = 0;
  let tools: readonly Tool[] = [];
  let toolNames: readonly string[] = [];
  /** Set while a respawn's connect is in flight, so one crash schedules one retry. */
  let respawning = false;
  /** Why the last connection died: `/mcp`'s `restarting` line names the attempt. */
  let lastReason: (() => string | undefined) | undefined;
  /** Whoever is told when the server closes (a caller's own subscription). */
  const closeListeners = new Set<(reason?: string) => void>();

  const closeServer = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    closeLive();
    for (const listener of closeListeners) {
      listener();
    }
    closeListeners.clear();
  };

  const router = routerClient(() => routedClient);
  // Every connect (the first and each respawn) builds its tools against the ROUTER.
  const options: ConnectOptions = { ...(deps.connectOptions ?? {}), toolClient: router };

  const closeLive = (): void => {
    const connection = live;
    live = undefined;
    routedClient = undefined;
    if (connection === undefined) {
      return;
    }
    lastReason = () => connection.closeReason?.();
    try {
      connection.close();
    } catch {
      // Already gone: the restart path must still continue.
    }
  };

  const arm = (): void => {
    if (!shouldRespawn({ disposed, failures })) {
      if (!disposed) {
        gaveUp = true;
        deps.onRestart?.(`mcp ${name}: gave up after ${failures} failed restarts`);
      }
      return;
    }
    attempt = failures;
    timer = schedule(respawn, respawnDelay(attempt));
  };

  const adopt = (connection: McpConnection): void => {
    live = connection;
    routedClient = connection.client();
    upSince = now();
    attempt = 0;
    respawning = false;
    // The NEXT crash (never the `close()` a dispose does) schedules a respawn.
    connection.onClose(() => {
      if (disposed || live !== connection) {
        return;
      }
      crash();
    });
  };

  const respawn = (): void => {
    timer = undefined;
    if (!shouldRespawn({ disposed, failures })) {
      return;
    }
    respawning = true;
    connect(name, spec, options).then(
      (connection) => {
        if (disposed) {
          respawning = false;
          connection.close();
          return;
        }
        adopt(connection);
        deps.onRestart?.(`mcp ${name}: reconnected (after ${failures} failed restart(s))`);
      },
      (error: unknown) => {
        failures += 1;
        respawning = false;
        deps.onRestart?.(
          `mcp ${name}: restart failed (${failures}/${RESPAWN_MAX_ATTEMPTS}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        arm();
      },
    );
  };

  /** The transport closed: drop the dead client, count it, then respawn. */
  const crash = (): void => {
    if (disposed) {
      return;
    }
    closeLive();
    // A spawn that stayed up long enough was healthy: this crash is a fresh budget.
    if (now() - upSince >= RESPAWN_HEALTHY_MS) {
      failures = 0;
    }
    failures += 1;
    if (!respawning) {
      deps.onRestart?.(`mcp ${name}: connection closed; restarting (attempt ${failures})`);
      arm();
    }
  };

  const server: SupervisedServer = {
    name,
    get toolNames() {
      return toolNames;
    },
    get tools() {
      return tools;
    },
    // A held-open connection is `closed` with the reason; a respawn in flight is
    // `restarting()` (`status.ts` shows that as `connecting` + why).
    close: closeServer,
    isOpen: () => live?.isOpen() === true,
    closeReason: () => live?.closeReason?.() ?? lastReason?.(),
    ping: async (ms: number) => {
      const connection = live;
      if (connection === undefined) {
        throw new Error("MCP connection is restarting");
      }
      await connection.ping(ms);
    },
    client: () => router,
    onClose: (listener) => {
      closeListeners.add(listener);
    },
    restarting: () =>
      live !== undefined || gaveUp ? undefined : { attempt: Math.max(1, attempt || failures) },
    gaveUp: () => gaveUp,
  };

  const ready = connect(name, spec, options).then((connection) => {
    if (disposed) {
      connection.close();
      throw new Error(`MCP server "${name}" was disposed during its connect`);
    }
    // The tools route through the ROUTING client (not this connect's own), so
    // the same tool objects keep working after the supervisor respawns the
    // server — that is the whole point of S3 (docs/feat/serve-mcp.md).
    tools = connection.tools;
    toolNames = connection.toolNames;
    adopt(connection);
    return server;
  });
  // The caller handles a first-connect failure; a crash-path rejection is ours.
  ready.catch(() => {});

  return { ready, server };
}

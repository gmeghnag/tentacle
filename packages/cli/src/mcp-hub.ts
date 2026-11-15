/**
 * One MCP connection set per daemon, shared by every session it hosts.
 *
 * Both hosts that run a model themselves — the worker (a local TUI) and `serve`
 * (the phone, `connect`) — need the same three things: connect the configured
 * servers ONCE, in the background, register their tools into every registry
 * built before the connect settles, and report `/mcp`'s per-server state. This
 * module holds that logic once, so a host only wires it (§7: logic in a pure
 * module, the components only render/route).
 *
 * The `pending` set is the whole race fix: a session built while the handshake
 * is in flight gets its MCP tools the moment the connect settles, so a slow
 * server can never leave a live session without its tools.
 */
import type { Tool } from "@tentacle/core";
import {
  type ConnectMcpResult,
  type McpConnection,
  type McpServerStatus,
  type McpServers,
  McpStatusTracker,
  connectMcpServers,
} from "@tentacle/mcp";
import type { ToolRegistry } from "@tentacle/tools";

/** What `createMcpHub` may be given (every field has a production default). */
export interface McpHubOptions {
  /**
   * The connect itself (tests inject a controllable one). Default
   * `connectMcpServers`, with `onStderr` routed to this hub's capped sink.
   */
  readonly connect?: (servers: McpServers) => Promise<ConnectMcpResult>;
  /** Per-server connection errors and a connect that threw (one call each). */
  readonly onErrors?: (errors: Readonly<Record<string, string>>) => void;
  /** A tool whose name a built-in/other server already owns, skipped. */
  readonly onClash?: (line: string) => void;
  /** Every stderr line of every server, when the transport reports them. */
  readonly onStderr?: (server: string, line: string) => void;
  /** A restart attempt, its failure and the final give-up (docs/feat/serve-mcp.md S3). */
  readonly onRestart?: (line: string) => void;
}

/** The daemon-wide MCP connection set: started once, disposed once. */
export interface McpHub {
  /** Begin the background connect. Safe to call once; a no-op after. */
  start(): void;
  /** A freshly built agent's registry: MCP tools now, or at settle. */
  onBuilt(registry: ToolRegistry): void;
  /** `/mcp`'s answer for any session (the set is daemon-wide). */
  status(): Promise<McpServerStatus[]>;
  /** The connect has settled (or failed): a context count is no longer an estimate. */
  ready(): boolean;
  /** Close every connection. Before settle, remembered and run at settle. */
  dispose(): void;
}

/** Max stderr lines forwarded per server per daemon run. */
export const MAX_STDERR_LINES = 50;

/**
 * Bound a server's stderr: `mcp <name>: <line>` for the first
 * `MAX_STDERR_LINES` lines, then one `mcp <name>: further stderr suppressed`.
 * A chatty server must not flood the daemon's terminal (or a `connect` TUI's).
 */
export function capStderr(
  notice: (line: string) => void,
  max = MAX_STDERR_LINES,
): (server: string, line: string) => void {
  const counts = new Map<string, number>();
  const suppressed = new Set<string>();
  return (server, line) => {
    const count = counts.get(server) ?? 0;
    if (count < max) {
      counts.set(server, count + 1);
      notice(`mcp ${server}: ${line}`);
      return;
    }
    if (!suppressed.has(server)) {
      suppressed.add(server);
      notice(`mcp ${server}: further stderr suppressed`);
    }
  };
}

/**
 * The supervisor shape a connection may also provide (S3,
 * docs/feat/serve-mcp.md): `connectServer` returns it, so `connect` happens
 * through a supervisor. Declared here so the hub needs no dependency on it.
 */
interface Closable {
  close(): void;
}

export function createMcpHub(servers: McpServers, options: McpHubOptions = {}): McpHub {
  const names = Object.keys(servers);
  const tracker = new McpStatusTracker(names);
  let tools: readonly Tool[] = [];
  let settled = false;
  let disposed = false;
  /** Registries built before the connect settled. */
  const pending = new Set<ToolRegistry>();
  /** What `dispose` must close once the connect settles. */
  let connections: readonly Closable[] = [];

  const register = (registry: ToolRegistry): void => {
    for (const tool of tools) {
      try {
        registry.register(tool);
      } catch {
        // A name a built-in / another server already owns. Skipped, but never
        // silently: the line names the tool so the user can rename a server.
        options.onClash?.(`mcp tool "${tool.name}" already registered; skipped`);
      }
    }
  };

  const closeAll = (): void => {
    for (const connection of connections) {
      try {
        connection.close();
      } catch {
        // A connection that is already gone must not stop the others closing.
      }
    }
    connections = [];
  };

  let started = false;
  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      const connect =
        options.connect ??
        ((all: McpServers) =>
          connectMcpServers(all, {
            ...(options.onStderr
              ? { onStderr: (server: string, line: string) => options.onStderr?.(server, line) }
              : {}),
            // S3: a long-lived daemon's crashed server comes back by itself, and
            // the line that says so is a startup-fact notice, one per attempt.
            ...(options.onRestart ? { onRestart: options.onRestart } : {}),
          }));
      connect(servers)
        .then((result) => {
          tracker.settle(result);
          tools = result.tools;
          settled = true;
          connections = result.connections;
          for (const registry of pending) {
            register(registry);
          }
          pending.clear();
          if (Object.keys(result.errors).length > 0) {
            options.onErrors?.({ ...result.errors });
          }
          // A dispose that landed while the handshake was in flight: the
          // connections arrived after it, so close them now (else the daemon
          // exits leaving server processes behind).
          if (disposed) {
            closeAll();
          }
        })
        .catch((error: unknown) => {
          const message = String(error);
          tracker.fail(message);
          settled = true;
          pending.clear();
          options.onErrors?.({ "*": message });
        });
    },

    onBuilt(registry: ToolRegistry): void {
      register(registry);
      if (!settled) {
        pending.add(registry);
      }
    },

    status: () => tracker.probe(),

    ready: () => settled,

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // Before settle there is nothing to close yet: the settle handler does it.
      closeAll();
    },
  };
}

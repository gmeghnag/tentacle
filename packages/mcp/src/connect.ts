/**
 * Connect to configured MCP servers and surface their tools.
 *
 * Each server is spawned (stdio) or reached (Streamable HTTP), handshaken and
 * queried for its tools; failures are isolated (a broken server is skipped, not
 * fatal to startup) and bounded by a timeout so a hanging server can't block the
 * app. The returned `dispose` closes every connection (killing stdio subprocesses).
 */
import type { Tool } from "@tentacle/core";
import { McpClient, McpHandshakeClosedError } from "./client.ts";
import { createStreamableHttpTransport } from "./http-transport.ts";
import { mcpToolToTool } from "./tool-adapter.ts";
import { type StdioTransportOptions, createStdioTransport } from "./transport.ts";
import type { McpServerSpec, McpServers, McpTransport } from "./types.ts";

export interface McpConnection {
  readonly name: string;
  readonly tools: readonly Tool[];
  /** The server's own (bare) tool names, in its `tools/list` order — what `/mcp` lists. */
  readonly toolNames: readonly string[];
  close(): void;
  /** False once the server process is gone / unreachable (or `close()` ran). */
  isOpen(): boolean;
  /** Why the connection closed, when the transport said (e.g. unreachable). */
  closeReason?(): string | undefined;
  /** MCP `ping`: resolves if the server answers within `timeoutMs`. */
  ping(timeoutMs: number): Promise<void>;
}

export interface ConnectMcpResult {
  readonly connections: readonly McpConnection[];
  /** All tools across every connected server, ready to register. */
  readonly tools: readonly Tool[];
  /** Errors keyed by server name (connection/handshake failures). */
  readonly errors: Readonly<Record<string, string>>;
  /** Shut down every connected server. */
  dispose(): void;
}

/** Default time budget for a server's handshake + tool listing. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface ConnectOptions {
  readonly timeoutMs?: number;
  /** Injectable transport factory (tests pass an in-memory one). */
  readonly createTransport?: (spec: McpServerSpec, opts?: StdioTransportOptions) => McpTransport;
  /** Era-probe timeout per server (tests shorten it); omitted → the client default. */
  readonly probeTimeoutMs?: number;
  /** Receives a server's stderr lines (server name + line); omitted → dropped. */
  readonly onStderr?: (server: string, line: string) => void;
}

/** The transport a spec names: Streamable HTTP for `type: "http"`, else stdio. */
function createTransport(spec: McpServerSpec, opts?: StdioTransportOptions): McpTransport {
  return spec.type === "http"
    ? createStreamableHttpTransport(spec)
    : createStdioTransport(spec, opts);
}

/** Connect one server: spawn/reach it, handshake, list tools, adapt them. */
export async function connectServer(
  name: string,
  spec: McpServerSpec,
  options: ConnectOptions = {},
): Promise<McpConnection> {
  const timeout = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));
  /** Spawn/reach the server and negotiate; on failure the half-open client is closed. */
  const open = async (legacyOnly: boolean): Promise<McpClient> => {
    const transport = (options.createTransport ?? createTransport)(spec, {
      ...(options.onStderr ? { onStderr: (line: string) => options.onStderr?.(name, line) } : {}),
    });
    const opened = new McpClient(transport, undefined, {
      ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
    });
    try {
      await withTimeout(
        opened.initialize({ legacyOnly }),
        timeout,
        `MCP server "${name}" initialize`,
      );
      return opened;
    } catch (error) {
      opened.close();
      throw toError(error);
    }
  };
  let client: McpClient;
  try {
    client = await open(false);
  } catch (error) {
    // Some legacy stdio servers exit when the first message is not `initialize`
    // (our era probe) — at once, or after answering it. Respawn once,
    // legacy-only: the spec's dual-era client must work with them. Over HTTP a
    // close before the handshake means unreachable.
    if (!(error instanceof McpHandshakeClosedError) || spec.type === "http") {
      throw error;
    }
    client = await open(true);
  }
  try {
    const defs = await withTimeout(client.listTools(), timeout, `MCP server "${name}" tools/list`);
    const tools = defs.map((def) => mcpToolToTool(name, client, def));
    return {
      name,
      tools,
      toolNames: defs.map((def) => def.name),
      close: () => client.close(),
      isOpen: () => !client.isClosed,
      closeReason: () => client.closeReason,
      ping: (ms) => client.ping(ms),
    };
  } catch (error) {
    client.close();
    throw toError(error);
  }
}

/** Connect every configured server, isolating per-server failures. */
export async function connectMcpServers(
  servers: McpServers,
  options: ConnectOptions = {},
): Promise<ConnectMcpResult> {
  const connections: McpConnection[] = [];
  const errors: Record<string, string> = {};

  const results = await Promise.allSettled(
    Object.entries(servers).map(async ([name, spec]) => {
      const connection = await connectServer(name, spec, options);
      return connection;
    }),
  );
  const names = Object.keys(servers);
  results.forEach((result, i) => {
    const name = names[i] ?? "unknown";
    if (result.status === "fulfilled") {
      connections.push(result.value);
    } else {
      errors[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
  });

  const tools = connections.flatMap((c) => [...c.tools]);
  return {
    connections,
    tools,
    errors,
    dispose(): void {
      for (const connection of connections) {
        connection.close();
      }
    },
  };
}

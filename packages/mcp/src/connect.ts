/**
 * Connect to configured MCP servers and surface their tools.
 *
 * Each server is spawned, handshaken and queried for its tools; failures are
 * isolated (a broken server is skipped, not fatal to startup) and bounded by a
 * timeout so a hanging server can't block the app. The returned `dispose` kills
 * every spawned subprocess.
 */
import type { Tool } from "@agent-harness/core";
import { McpClient } from "./client.ts";
import { mcpToolToTool } from "./tool-adapter.ts";
import { type StdioTransportOptions, createStdioTransport } from "./transport.ts";
import type { McpServers, McpStdioServerSpec, McpTransport } from "./types.ts";

export interface McpConnection {
  readonly name: string;
  readonly tools: readonly Tool[];
  close(): void;
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
  readonly createTransport?: (
    spec: McpStdioServerSpec,
    opts?: StdioTransportOptions,
  ) => McpTransport;
  /** Receives a server's stderr lines (server name + line); omitted → dropped. */
  readonly onStderr?: (server: string, line: string) => void;
}

/** Connect one stdio server: spawn, handshake, list tools, adapt them. */
export async function connectServer(
  name: string,
  spec: McpStdioServerSpec,
  options: ConnectOptions = {},
): Promise<McpConnection> {
  const transport = (options.createTransport ?? createStdioTransport)(spec, {
    ...(options.onStderr ? { onStderr: (line: string) => options.onStderr?.(name, line) } : {}),
  });
  const client = new McpClient(transport);
  const timeout = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  try {
    await withTimeout(client.initialize(), timeout, `MCP server "${name}" initialize`);
    const defs = await withTimeout(client.listTools(), timeout, `MCP server "${name}" tools/list`);
    const tools = defs.map((def) => mcpToolToTool(name, client, def));
    return { name, tools, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error instanceof Error ? error : new Error(String(error));
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

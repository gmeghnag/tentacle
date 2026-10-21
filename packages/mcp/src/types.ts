/**
 * MCP (Model Context Protocol) types — just what this client needs.
 *
 * We speak MCP's JSON-RPC 2.0 over a transport (stdio or Streamable HTTP), negotiate
 * capabilities, list the server's tools and call them. Resources/prompts are
 * out of scope for this first slice.
 */

/** A configured stdio MCP server (spawned as a subprocess). */
export interface McpStdioServerSpec {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** A configured remote MCP server, reached over Streamable HTTP. */
export interface McpHttpServerSpec {
  readonly type: "http";
  readonly url: string;
  /** Extra request headers (e.g. `Authorization`); sent only to `url`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** Map of server name → spec, as it appears in `config.jsonc`. */
export type McpServers = Readonly<Record<string, McpServerSpec>>;

/** A tool as advertised by `tools/list`. */
export interface McpToolDef {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema?: Record<string, unknown>;
}

/** One content block returned by `tools/call`. */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/** Result of `tools/call`. */
export interface McpCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/**
 * A bidirectional message channel carrying parsed JSON-RPC messages. The client
 * is transport-agnostic; `createStdioTransport` and
 * `createStreamableHttpTransport` are the concrete ones, and tests use an
 * in-memory pair.
 */
export interface McpTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** `reason` says why the channel died, when the transport knows (never secrets). */
  onClose(listener: (reason?: string) => void): void;
  close(): void;
}

/** Protocol version this client advertises during `initialize`. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

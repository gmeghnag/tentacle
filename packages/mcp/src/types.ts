/**
 * MCP (Model Context Protocol) types — just what this client needs.
 *
 * We speak MCP's JSON-RPC 2.0 over a transport (stdio for now), negotiate
 * capabilities, list the server's tools and call them. Resources/prompts are
 * out of scope for this first slice.
 */

/** A configured stdio MCP server (spawned as a subprocess). */
export interface McpStdioServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** Map of server name → spec, as it appears in `config.jsonc`. */
export type McpServers = Readonly<Record<string, McpStdioServerSpec>>;

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
 * is transport-agnostic; `createStdioTransport` is the concrete one, and tests
 * use an in-memory pair.
 */
export interface McpTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** Protocol version this client advertises during `initialize`. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

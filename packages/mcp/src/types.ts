/**
 * MCP (Model Context Protocol) types — just what this client needs.
 *
 * We speak MCP's JSON-RPC 2.0 over a transport (stdio or Streamable HTTP),
 * negotiate the protocol era (modern 2026-07-28, or a legacy `initialize`
 * handshake), list the server's tools and call them. Resources/prompts are
 * out of scope for this first slice.
 */

/** What every server spec may carry, whatever its transport. */
interface McpServerSpecBase {
  /** Which tools may run as reads (`McpReadOnlyTools`). Absent → `"hint"`. */
  readonly readOnlyTools?: McpReadOnlyTools;
}

/** A configured stdio MCP server (spawned as a subprocess). */
export interface McpStdioServerSpec extends McpServerSpecBase {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** A configured remote MCP server, reached over Streamable HTTP. */
export interface McpHttpServerSpec extends McpServerSpecBase {
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
  /** The server's hints about the tool (untrusted: the server says so). */
  readonly annotations?: { readonly readOnlyHint?: unknown };
}

/**
 * `mcpServers.<name>.readOnlyTools` (docs/feat/parallel-tools.md): which of a
 * server's tools may run beside other read-class calls. `"hint"` (default):
 * those whose `annotations.readOnlyHint` is `true`; `"none"`: none; a list:
 * exactly those, by their bare MCP name.
 */
export type McpReadOnlyTools = "hint" | "none" | readonly string[];

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
  /**
   * Stop waiting for request `id` without telling the server (no
   * `notifications/cancelled`). Streamable HTTP closes that request's stream;
   * a transport with nothing per-request to release omits it.
   */
  abandon?(id: number | string): void;
  close(): void;
}

/**
 * Modern protocol versions this client speaks (per-request `_meta`, no
 * handshake — MCP 2026-07-28 and later), newest first; the first is preferred.
 */
export const MCP_MODERN_VERSIONS: readonly string[] = ["2026-07-28"];

/**
 * Legacy protocol versions this client accepts (`initialize` handshake —
 * 2025-11-25 and earlier), newest first; the first is the one it offers.
 */
export const MCP_LEGACY_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/** The `_meta` keys a modern request carries. */
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** JSON-RPC error codes the MCP spec reserves (-32020…-32099): a modern server sent them. */
export const MCP_ERROR_HEADER_MISMATCH = -32020;
export const MCP_ERROR_MISSING_CLIENT_CAPABILITY = -32021;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;

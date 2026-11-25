/**
 * `serve`'s MCP-server wiring (docs/feat/serve-mcp-server.md M5): the tools
 * adapter and the `/mcp` route, built over the daemon's own `SessionHost`. No
 * store of its own — the session log is the record. Off without a token.
 *
 * `durable` is left to `McpTools`' default: the session's own
 * `persistedLanded()` = `SessionPersister.lastWriteLanded(id)`, run after the
 * turn's start is visible. A failed write is reported to the operator by the
 * persister AND refuses the task (`isError`, the turn cancelled): no unrecorded
 * task is ever handed out (fix round 1, review finding 2).
 */
import {
  type AskMode,
  type HooksTrustPrecheck,
  MCP_PATH,
  McpTools,
  type SessionHost,
  type WsServerOptions,
  createMcpRoute,
} from "@tentacle/daemon";
import { APP_VERSION } from "./version.ts";

/** The one caller the CLI knows (its token's name in the session id: `mcp-default-…`). */
export const MCP_CLI_CALLER = "default";

export interface ServeMcpOptions {
  /** The MCP bearer token (`--mcp-token`, `--mcp-token-command`). */
  readonly token: string;
  /** Who answers a session's asks: the owner only (default) or the caller too. */
  readonly asks?: AskMode;
}

export interface BuildMcpInput {
  readonly host: SessionHost;
  readonly options: ServeMcpOptions;
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
}

/** `asks: owner` — the startup line's tail. */
export function describeMcp(options: ServeMcpOptions): string {
  return `asks: ${options.asks ?? "owner"}`;
}

/** `--mcp-asks` value → mode; anything else is a usage error (fail closed). */
export function parseMcpAsks(value: string | undefined): AskMode {
  if (value === undefined || value === "owner") {
    return "owner";
  }
  if (value === "both") {
    return "both";
  }
  throw new Error(`--mcp-asks must be "owner" or "both" (got "${value}")`);
}

/** The `claude mcp add` line for the startup notice (`<token>` is a placeholder, never the secret). */
export function mcpAddHint(httpUrl: string): string {
  return `claude mcp add --transport http tentacle ${httpUrl}${MCP_PATH} --header "Authorization: Bearer <token>"`;
}

/** The route `startWsServer` asks after A2A, and what releases its attachments at stop. */
export function buildMcp(input: BuildMcpInput): {
  readonly route: NonNullable<WsServerOptions["mcp"]>;
  readonly dispose: () => void;
} {
  const { host, options } = input;
  const asks = options.asks ?? "owner";
  const tools = new McpTools({
    host,
    version: APP_VERSION,
    callerAsks: () => asks,
    ...(input.hooksTrustPrecheck ? { hooksTrustPrecheck: input.hooksTrustPrecheck } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const route = createMcpRoute({
    tools,
    callers: [{ name: MCP_CLI_CALLER, token: options.token }],
    serverInfo: { name: "tentacle", version: APP_VERSION },
    ...(input.onAudit ? { onAudit: input.onAudit } : {}),
  });
  return { route, dispose: () => tools.dispose() };
}

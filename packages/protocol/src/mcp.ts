/**
 * `mcp/status` — the daemon's MCP servers and whether each is reachable now
 * (the TUI's `/mcp`, docs/feat/mcp-status.md). A pull: the daemon probes on
 * each request. Additive (an older daemon answers `MethodNotFound`). The daemon
 * may be a pod (not trusted, AGENTS §7): names and errors are bounded and free
 * of control characters before anything reaches the UI.
 */
import { z } from "zod";

/** At most this many servers in one `mcp/status` result. */
export const MAX_MCP_SERVERS = 256;
/** At most this many tool names per server (the rest are counted in `moreTools`). */
export const MAX_MCP_TOOL_NAMES = 128;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;

export const McpServerStateSchema = z.enum([
  "connecting",
  "connected",
  "unresponsive",
  "closed",
  "failed",
]);
export type McpServerState = z.infer<typeof McpServerStateSchema>;

export const McpServerStatusSchema = z.object({
  name: z.string().min(1).max(256).regex(NO_CONTROL),
  state: McpServerStateSchema,
  /**
   * The bare MCP names of the tools the server contributed (none unless it
   * connected), in its order — the first `MAX_MCP_TOOL_NAMES`
   * (docs/feat/mcp-tools-panel.md).
   */
  tools: z.array(z.string().min(1).max(128).regex(NO_CONTROL)).max(MAX_MCP_TOOL_NAMES),
  /** Tools beyond the names listed (truncated or unnameable): count = `tools.length + moreTools`. */
  moreTools: z.number().int().nonnegative(),
  /** Round trip of the probe `ping`, in ms (`connected` only). */
  latencyMs: z.number().nonnegative().optional(),
  /** Why it is not `connected` (one line). */
  error: z.string().max(1000).regex(NO_CONTROL).optional(),
});
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpStatusParamsSchema = z.object({});
export type McpStatusParams = z.infer<typeof McpStatusParamsSchema>;

export const McpStatusResultSchema = z.object({
  servers: z.array(McpServerStatusSchema).max(MAX_MCP_SERVERS),
});
export type McpStatusResult = z.infer<typeof McpStatusResultSchema>;

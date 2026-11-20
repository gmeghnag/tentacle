/**
 * `session/tools` — the built-in tools of ONE session (docs/feat/tool-toggles.md
 * D6): each REGISTERED built-in with its group, the heuristic token cost of its
 * definition and whether it is switched off, for the TUI's `/tools` panel. MCP
 * tools are not listed (`/mcp` has them). A request, so the client knows when
 * its list is fresh; the daemon never pushes. The daemon may be a pod (not
 * trusted, AGENTS §7): every string is bounded and free of control characters,
 * and the numbers are display only. Additive: an older daemon answers
 * `MethodNotFound`.
 */
import { z } from "zod";
import { SessionIdSchema, SessionSettingsSchema } from "./session.ts";
import { line } from "./text-line.ts";

/** At most this many tools in one `session/tools` result. */
export const MAX_TOOL_LIST = 128;

export const ToolListEntrySchema = z.object({
  name: line(128),
  /** The switch group it belongs to (`subagents`, `shell`, `visuals`, …); none = switched alone. */
  group: line(64).optional(),
  /** The heuristic token count of its definition (`~N`), display only. */
  tokens: z.number().int().nonnegative(),
  /** Switched off for the model in THIS session. */
  disabled: z.literal(true).optional(),
  /** Can never be switched off (`skill`). */
  locked: z.literal(true).optional(),
});
export type ToolListEntry = z.infer<typeof ToolListEntrySchema>;

export const SessionToolsParamsSchema = z.object({
  /**
   * A session this connection opened. Absent → the tools a session the daemon
   * creates NOW would have (a client opens its session lazily, at the first
   * prompt).
   */
  sessionId: SessionIdSchema.optional(),
  /** With no `sessionId`: the `session/open` settings that session would be created from. */
  settings: SessionSettingsSchema.optional(),
});
export type SessionToolsParams = z.infer<typeof SessionToolsParamsSchema>;

export const SessionToolsResultSchema = z.object({
  tools: z.array(ToolListEntrySchema).max(MAX_TOOL_LIST),
});
export type SessionToolsResult = z.infer<typeof SessionToolsResultSchema>;

/**
 * Tool contract.
 *
 * A tool pairs a Zod input schema (also compiled to JSON Schema for the model)
 * with a typed handler. The registry validates arguments against `inputSchema`
 * before `execute` is ever called, so handlers receive already-valid input.
 */
import type { z } from "zod";
import type { ExecutionEnvironment } from "./execution.ts";
import type { JobController } from "./jobs.ts";
import type { ChatMessage } from "./model.ts";

/** Whether a tool call needs user approval before running. */
export type PermissionLevel = "none" | "ask" | "deny";

/**
 * Optional structured payload a tool can attach to its result so a rich
 * frontend can render it specially (e.g. a file diff). Text-only frontends
 * ignore it and show `content`.
 */
export type ToolResultDetail = {
  readonly kind: "diff";
  readonly path: string;
  /** Unified-diff text (old → new). */
  readonly patch: string;
  readonly added: number;
  readonly removed: number;
};

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly details?: ToolResultDetail;
}

/**
 * Live progress a long-running tool (e.g. the `agent_task` sub-agent) can emit while
 * it runs, for the frontend to render. Framework-neutral so `core` stays free
 * of an `agent` dependency; the agent loop maps these onto its event stream.
 */
export type ToolProgressEvent =
  | { readonly kind: "subagent_start"; readonly agentType: string; readonly description: string }
  | { readonly kind: "subagent_tool"; readonly label: string }
  | { readonly kind: "subagent_end"; readonly toolUses: number; readonly stopReason: string };

export interface ToolContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly env: ExecutionEnvironment;
  /** Optional sink for live progress; the agent loop interleaves it into its stream. */
  readonly emitProgress?: (event: ToolProgressEvent) => void;
  /** Optional background-job registry; the shell tools use it when wired. */
  readonly jobs?: JobController;
  /**
   * The conversation so far (read-only view of the live history), for a tool
   * whose answer depends on what is already in context — e.g. `skill` does
   * not load a skill twice. Absent outside the agent loop.
   */
  readonly history?: readonly ChatMessage[];
}

export interface Tool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  /**
   * Optional precomputed JSON Schema for the model-facing definition, used
   * verbatim instead of converting `inputSchema`. Set this when the authoritative
   * schema comes from elsewhere (e.g. an MCP server advertises JSON Schema), so
   * the model sees the real parameters while `inputSchema` stays a permissive
   * runtime guard.
   */
  readonly jsonSchema?: Record<string, unknown>;
  readonly permission: PermissionLevel;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

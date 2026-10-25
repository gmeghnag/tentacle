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

/**
 * A result too large for the context (`spillLargeOutput`), as data: what a
 * frontend shows instead of the model's banner, never parsed from `content`
 * (docs/feat/tui-spill-note.md).
 */
export interface ToolResultSpill {
  /** Length of the full output (`String.length`). */
  readonly chars: number;
  /** Where the full output was saved (workspace-relative); absent = it could not be written. */
  readonly path?: string;
  /** The preview's first part, and its last part ("" when nothing was omitted). */
  readonly head: string;
  readonly tail: string;
  /** Characters between `head` and `tail` (0: `head` is the whole output). */
  readonly omitted: number;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly details?: ToolResultDetail;
  /** Set when the output was spilled: `content` is the model's banner + preview. */
  readonly spill?: ToolResultSpill;
  /**
   * Set when a user hook intervened on this call (H1): it `blocked` the call
   * (`reason` = the hook's own reason, if it gave one) or `modified` its input.
   * Separate from `details`: a modified `fs_edit` still carries its diff.
   */
  readonly hook?: {
    readonly action: "blocked" | "modified";
    readonly name: string;
    readonly reason?: string;
  };
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

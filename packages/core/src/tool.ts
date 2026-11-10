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
import type { PathLocks } from "./path-locks.ts";

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
  /**
   * Set on a call the person refused WITH a reply: the reply as data
   * (docs/feat/permission-reply.md). A frontend shows it instead of the
   * model's text; kept only while `content` is the agent's own denial text
   * (a transform that rewrote it drops this copy).
   */
  readonly denialReply?: string;
}

/**
 * Live progress a long-running tool (e.g. the `agent_task` sub-agent) can emit while
 * it runs, for the frontend to render. Framework-neutral so `core` stays free
 * of an `agent` dependency; the agent loop maps these onto its event stream.
 */
export type ToolProgressEvent =
  | {
      readonly kind: "subagent_start";
      readonly agentType: string;
      readonly description: string;
      /**
       * The `models` NAME the child runs on, when its pick named an entry (never
       * an id, a URL or a key: AGENTS §7). Whether the panel SHOWS it is the
       * daemon's decision, against the main agent's CURRENT model (docs/feat/
       * subagent-panel.md, Review round 3 M2).
       */
      readonly model?: string;
      /**
       * The model id the child really runs on — daemon-side only, like the
       * runtime's other local facts: it never reaches the wire (the row carries a
       * NAME or nothing). It exists so the daemon can re-decide `model` whenever
       * the session's main model changes (Review round 3 M2).
       */
      readonly modelId?: string;
    }
  | { readonly kind: "subagent_tool"; readonly label: string }
  // One model call's tokens of the child (its own; never added to the parent's totals).
  | {
      readonly kind: "subagent_usage";
      readonly promptTokens: number;
      readonly completionTokens: number;
    }
  /**
   * A child ended. `agentId` is set only when it MOVED to the background: its
   * tool call ends here, with the `sa-N` it now is, and its report arrives
   * later as the ordinary background `[background]` note
   * (docs/feat/subagent-detach.md).
   */
  | {
      readonly kind: "subagent_end";
      readonly toolUses: number;
      readonly stopReason: string;
      readonly agentId?: string;
    };

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
  /**
   * Per-path locks the read-modify-write file tools hold across read→write.
   * Absent → the env's shared instance (`pathLocksFor(env)`), so a parent and
   * its sub-agents (one env) exclude each other without any wiring.
   */
  readonly pathLocks?: PathLocks;
  /**
   * The call being executed — `agent_task` hands it to its sub-agent, whose
   * permission asks are attributed to it. Absent outside the agent loop.
   */
  readonly toolCallId?: string;
  /**
   * The loop's result transforms for THIS call (redaction, hooks, spill),
   * callable after the call returned: a background sub-agent's report is
   * shaped by them when it finishes, as a foreground one is when it returns.
   * A background `agent_task` therefore runs them (and the PostToolUse hooks)
   * twice for its call id: the launch line, then the report. Absent outside the
   * agent loop.
   */
  readonly shapeResult?: (result: ToolResult, signal?: AbortSignal) => Promise<ToolResult>;
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
  /**
   * What a call touches, for the round executor (docs/feat/parallel-tools.md):
   * calls whose keys do not conflict may run at the same time. Absent =
   * `"exclusive"` (conflicts with everything: always runs alone).
   */
  readonly concurrency?: ToolConcurrency;
  /**
   * This call spawns a sub-agent: what kind, by its (unvalidated) input. Absent =
   * not a spawn. Spawns overlap in their own lane under `subagents.*`, whatever
   * `concurrency` says (docs/feat/parallel-agents.md, Design 1). A throw counts
   * as "not groupable".
   */
  readonly spawnKind?: (input: unknown) => SpawnKind;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

/** A spawned sub-agent's kind: `read-only` when its whole tool-set only reads. */
export type SpawnKind = "read-only" | "writer";

/**
 * A resource a call touches. Two keys CONFLICT iff they name the same
 * `resource` and at least one is a `write`.
 */
export interface ResourceKey {
  readonly mode: "read" | "write";
  readonly resource: string;
}

/**
 * A tool's concurrency class: `"exclusive"`, or a TOTAL function of the call's
 * (unvalidated) input to its keys — a garbage input must give `"exclusive"`;
 * a throw counts as `"exclusive"`. A call is read-class iff its keys are
 * non-empty and all `read`.
 */
export type ToolConcurrency =
  | "exclusive"
  | ((input: unknown) => readonly ResourceKey[] | "exclusive");

/**
 * `session/update` streaming notifications (agent → client).
 *
 * These carry everything that happens *during* a turn: streamed assistant text,
 * reasoning, tool-call lifecycle, and plan updates. Members are intentionally
 * NOT `.strict()` so new optional fields can be added without breaking older
 * clients (forward compatibility of a streamed event feed).
 */
import { z } from "zod";
import { ContentBlockSchema } from "./content.ts";
import { SessionIdSchema } from "./session.ts";

export const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** A streamed chunk of the assistant's visible message. */
export const AgentMessageChunkSchema = z.object({
  type: z.literal("agent_message_chunk"),
  content: ContentBlockSchema,
});

/** A streamed chunk of the assistant's reasoning (if the model exposes it). */
export const AgentThoughtChunkSchema = z.object({
  type: z.literal("agent_thought_chunk"),
  content: ContentBlockSchema,
});

/** A tool call the agent is about to run / is running. */
export const ToolCallSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string().min(1),
  title: z.string(),
  status: ToolCallStatusSchema,
  /** Raw arguments the model produced (shape depends on the tool). */
  rawInput: z.unknown().optional(),
});

/** A later status/result update for a previously announced tool call. */
export const ToolCallUpdateSchema = z.object({
  type: z.literal("tool_call_update"),
  toolCallId: z.string().min(1),
  status: ToolCallStatusSchema,
  content: z.array(ContentBlockSchema).optional(),
});

export const PlanEntryStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export const PlanEntrySchema = z.object({
  content: z.string(),
  status: PlanEntryStatusSchema,
});

/** The agent's current plan / todo list for the turn. */
export const PlanSchema = z.object({
  type: z.literal("plan"),
  entries: z.array(PlanEntrySchema),
});

/** Token usage so far this turn — lets a remote client drive its context meter. */
export const AgentUsageSchema = z.object({
  type: z.literal("agent_usage"),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});

/**
 * A background shell job finished. Unlike the other updates this is NOT
 * turn-scoped: a job can exit while the session is idle, so the daemon streams
 * it the moment it happens (the client surfaces it like a local job-exit
 * notice). The model is told separately, server-side, at the next turn.
 */
export const BackgroundExitSchema = z.object({
  type: z.literal("background_exit"),
  jobId: z.string().min(1),
  command: z.string(),
  status: z.string(),
  exitCode: z.number().int().nullable(),
});

export const SessionUpdateSchema = z.discriminatedUnion("type", [
  AgentMessageChunkSchema,
  AgentThoughtChunkSchema,
  ToolCallSchema,
  ToolCallUpdateSchema,
  PlanSchema,
  AgentUsageSchema,
  BackgroundExitSchema,
]);
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

/** Params of the `session/update` notification. */
export const SessionUpdateParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    /**
     * Monotonic per-session sequence number (additive, forward-compatible):
     * lets a reconnecting client replay the tail of the current turn exactly.
     */
    seq: z.number().int().nonnegative().optional(),
    update: SessionUpdateSchema,
  })
  .strict();
export type SessionUpdateParams = z.infer<typeof SessionUpdateParamsSchema>;

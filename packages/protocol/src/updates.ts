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
import { SessionIdSchema, StopReasonSchema, TurnErrorSchema, TurnIdSchema } from "./session.ts";

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

/** A user message queued mid-turn (steering) was injected into the running turn. */
export const SteerSchema = z.object({
  type: z.literal("steer"),
  text: z.string(),
});

/** A turn began (first update of every turn); carries the prompt so a replay shows what was asked. */
export const TurnStartSchema = z.object({
  type: z.literal("turn_start"),
  turnId: TurnIdSchema,
  prompt: z.string(),
});

/** A turn ended (last update of every turn): the turn's outcome, in the stream. */
export const TurnEndUpdateSchema = z.object({
  type: z.literal("turn_end"),
  turnId: TurnIdSchema,
  // Spelled out, not `TurnEndSchema.extend`: a shared `.optional()` instance
  // exports as an anonymous cross-$def ref, which the exporter refuses.
  stopReason: StopReasonSchema,
  error: TurnErrorSchema.optional(),
});

export const SessionUpdateSchema = z.discriminatedUnion("type", [
  AgentMessageChunkSchema,
  AgentThoughtChunkSchema,
  ToolCallSchema,
  ToolCallUpdateSchema,
  PlanSchema,
  AgentUsageSchema,
  BackgroundExitSchema,
  SteerSchema,
  TurnStartSchema,
  TurnEndUpdateSchema,
]);
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

/**
 * Event class (parent `session-reattach` §14, decision E). A client MUST skip
 * an unknown `display` event and MUST fail loudly on an unknown `mandatory`
 * one (a turn/permission/history event it cannot act on would be a hang).
 */
export type UpdateClass = "display" | "mandatory";

/**
 * The class of every known update type — the source of truth for the per-frame
 * `mandatory` flag and the schema's `x-event-class`. A `Record` makes a new
 * variant without a class a compile error.
 */
export const UPDATE_CLASS: Readonly<Record<SessionUpdate["type"], UpdateClass>> = {
  agent_message_chunk: "display",
  agent_thought_chunk: "display",
  tool_call: "display",
  tool_call_update: "display",
  plan: "display",
  agent_usage: "display",
  background_exit: "display",
  steer: "display",
  turn_start: "mandatory",
  turn_end: "mandatory",
};

/** Own keys only: a frame with `type: "toString"` is unknown, not known. */
export function isKnownUpdateType(type: string): type is SessionUpdate["type"] {
  return Object.hasOwn(UPDATE_CLASS, type);
}

/** Catch-all for an update type this peer does not know (a newer daemon's). */
export const UnknownSessionUpdateSchema = z
  .object({ type: z.string().min(1) })
  .describe(
    "An update type this client does not know. Client rule: a frame whose `type` is a known " +
      "SessionUpdate tag but that fails its member is malformed (error); otherwise skip it unless " +
      "the frame's `mandatory` is true (error: the daemon is newer than this client).",
  );
export type UnknownSessionUpdate = z.infer<typeof UnknownSessionUpdateSchema>;

/**
 * Known updates first (zod returns the first match), then the catch-all. Exported
 * as `anyOf`, not `oneOf`: a catch-all that excludes the known tags needs `not`,
 * which Swift codegen drops (docs/feat/session-wire-classes.md, experiment).
 */
export const SessionUpdateOrUnknownSchema = z
  .union([SessionUpdateSchema, UnknownSessionUpdateSchema])
  .describe("A known SessionUpdate, or an UnknownSessionUpdate (see its client rule).");

/** Params of the `session/update` notification. */
export const SessionUpdateParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    /** Monotonic per-session sequence number; counts unknown (skipped) events too. */
    seq: z.number().int().nonnegative(),
    /** Present (always `true`) iff the update's class is `mandatory`; never `false`. */
    mandatory: z.literal(true).optional(),
    update: SessionUpdateOrUnknownSchema,
  })
  .strict();
export type SessionUpdateParams = z.infer<typeof SessionUpdateParamsSchema>;
/** A frame whose update is a known type — what an emitter (the daemon) builds. */
export type KnownSessionUpdateParams = Omit<SessionUpdateParams, "update"> & {
  update: SessionUpdate;
};

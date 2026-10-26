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
import { PermissionRequestUpdateSchema, PermissionResolvedUpdateSchema } from "./permission.ts";
import {
  MAX_SESSION_TITLE,
  QueuedEntrySchema,
  ReturnedEntrySchema,
  SessionIdSchema,
  StopReasonSchema,
  TurnErrorSchema,
  TurnIdSchema,
} from "./session.ts";
import { ToolResultSpillSchema } from "./spill.ts";
import { line } from "./text-line.ts";

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
  /** Set when the result was spilled: `content` is the model's banner (docs/feat/tui-spill-note.md). */
  spill: ToolResultSpillSchema.optional(),
  /** Set when the tool actually ran: its daemon-measured run time in ms (display only, docs/fix/tool-duration.md). */
  durationMs: z.number().int().nonnegative().optional(),
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

/**
 * A user message queued mid-turn (steering) was injected into the running turn.
 * `id`: the row's enqueue id, so each client drops exactly that row — another
 * writer's steer drops none of mine (absent from an older daemon).
 */
export const SteerSchema = z.object({
  type: z.literal("steer"),
  text: z.string(),
  id: z.string().min(1).optional(),
});

/**
 * The agent loop added a user-role message of its own to the history: the
 * nudge after an empty round, the note telling the model a background job
 * ended, or a user hook's note (`hook`: shown dimmed, docs/feat/hooks-turn.md).
 * Display-only (frontends usually hide the loop's own notes), but it makes
 * every history message replayable, so a client that resynced and one that
 * did not agree.
 */
export const ContextNoteSchema = z.object({
  type: z.literal("context_note"),
  text: z.string(),
  reason: z.enum(["continue", "background_exit", "hook"]),
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
  /** As `TurnEnd.delivered`: on a `session/send_now` turn's end only. */
  delivered: z.boolean().optional(),
});

/**
 * The history was replaced wholesale: a barrier. Anything a client holds from
 * before it is stale — resync (`snapshot`) instead of applying later updates
 * on top of it. Starts a new epoch. `compact`: a compaction, between turns
 * (the snapshot names no turn). `context_reset` (protocol 12): the model
 * renewed its own context INSIDE a turn — the snapshot's `turn` names that
 * turn, and its remaining updates follow the cut.
 */
export const HistoryReplacedSchema = z.object({
  type: z.literal("history_replaced"),
  reason: z.enum(["compact", "context_reset"]),
});

/**
 * The session ended for every client: the last update an attached client
 * gets. Drop the session; a command on it now is `UnknownSession`. A running
 * turn's `turn_end{cancelled}` precedes it. `closed`: `session/close` or the
 * daemon's idle reaper / detached cap — on `serve` it is kept archived
 * (listed, reopenable). `deleted`: `session/delete` — it is gone.
 */
export const SessionClosedSchema = z.object({
  type: z.literal("session_closed"),
  reason: z.enum(["closed", "deleted"]),
});

/**
 * The session's chosen title changed (generated after the first exchange, or
 * set by `session/rename`): every attached client gets it, while idle too.
 * Not turn-scoped. Display only — the title is also in the snapshot and in
 * `session/list`, so a client that skips it misses nothing it must act on.
 */
export const SessionTitleUpdateSchema = z.object({
  type: z.literal("session_title"),
  title: line(MAX_SESSION_TITLE),
  source: z.enum(["model", "user"]),
});

/**
 * The session's queue changed (a row queued, delivered, sent now, returned to
 * its writer or reclaimed): the FULL state, replacing any earlier one (rules:
 * the queue comment in `session.ts`). Every attached client gets it, while
 * idle too. Not turn-scoped. Display only: a client that skips it loses
 * nothing daemon-side (returned rows wait for a reclaim; the snapshot carries
 * the state) and the daemon waits on nobody.
 */
export const QueuedUpdateSchema = z.object({
  type: z.literal("queued"),
  entries: z.array(QueuedEntrySchema),
  returned: z.array(ReturnedEntrySchema),
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
  ContextNoteSchema,
  TurnStartSchema,
  TurnEndUpdateSchema,
  HistoryReplacedSchema,
  SessionClosedSchema,
  PermissionRequestUpdateSchema,
  PermissionResolvedUpdateSchema,
  SessionTitleUpdateSchema,
  QueuedUpdateSchema,
]);
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

/**
 * Event class (parent `session-reattach` §14, decision E; protocol 10). A
 * client MUST skip an unknown `display` event (reporting it once as
 * `unsupported`) and MUST fail loudly on an unknown `mandatory` one (a
 * turn/history event it cannot act on would be a hang). `blocking` is a
 * mandatory event the daemon WAITS on a client to answer: it is sent
 * `mandatory` only to a client that declared it at `initialize`
 * (`clientCapabilities.updates`); another client gets it as display, and with
 * no declaring client attached the daemon takes the type's fallback at once
 * (docs/feat/protocol-v10-forward-compat.md).
 */
export type UpdateClass = "display" | "mandatory" | "blocking";

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
  context_note: "display",
  turn_start: "mandatory",
  turn_end: "mandatory",
  history_replaced: "mandatory",
  session_closed: "mandatory",
  permission_request: "blocking",
  permission_resolved: "mandatory",
  // A label: skipping it hangs nothing (the snapshot and the list carry it).
  session_title: "display",
  // Full state, also in the snapshot; returned rows wait for a reclaim (nothing hangs).
  queued: "display",
};

/** Every update type this build knows — what a client declares at `initialize`. */
export const KNOWN_UPDATE_TYPES: readonly SessionUpdate["type"][] = Object.keys(
  UPDATE_CLASS,
) as SessionUpdate["type"][];

/** The `blocking` types, derived from `UPDATE_CLASS` (each type is classified there, once). */
export const BLOCKING_UPDATE_TYPES: ReadonlySet<SessionUpdate["type"]> = new Set(
  KNOWN_UPDATE_TYPES.filter((type) => UPDATE_CLASS[type] === "blocking"),
);

/**
 * Does a client that declared `declared` at `initialize` understand `type`?
 * No list (a defensive case: every v10 client sends one) = the v10 base set,
 * i.e. every type this build knows.
 */
export function clientSupportsUpdate(
  declared: readonly string[] | undefined,
  type: string,
): boolean {
  return declared === undefined ? isKnownUpdateType(type) : declared.includes(type);
}

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
export const SessionUpdateParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Monotonic per-session sequence number; counts unknown (skipped) events too. */
  seq: z.number().int().nonnegative(),
  /** Present (always `true`) iff the update's class is `mandatory`; never `false`. */
  mandatory: z.literal(true).optional(),
  update: SessionUpdateOrUnknownSchema,
});
export type SessionUpdateParams = z.infer<typeof SessionUpdateParamsSchema>;
/** A frame whose update is a known type — what an emitter (the daemon) builds. */
export type KnownSessionUpdateParams = Omit<SessionUpdateParams, "update"> & {
  update: SessionUpdate;
};

/**
 * Session lifecycle & handshake (ACP-shaped).
 *
 * Flow:
 *   1. `initialize`     — client ↔ agent capability/version handshake.
 *   2. `session/new`    — create a conversation; returns a `sessionId`.
 *   3. `session/prompt` — client submits a user turn under a client-chosen
 *      `turnId`; acks at once. The turn's end is `turn_end` in the stream.
 *   4. `session/cancel` — notification to interrupt the active turn.
 */
import { z } from "zod";
import { ContentBlockSchema } from "./content.ts";

export const SessionIdSchema = z.string().min(1);
export type SessionId = z.infer<typeof SessionIdSchema>;

// --- conversation history (for resume seed + snapshot) ------------------
// Mirrors `@tentacle/core`'s `ChatMessage`/`ToolCall` on the wire, so a
// session can be seeded on `session/new` and read back via `session/snapshot`.

export const WireToolCallSchema = z
  .object({ id: z.string(), name: z.string(), arguments: z.string() })
  .strict();

export const ChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z.array(WireToolCallSchema).optional(),
    toolCallId: z.string().optional(),
  })
  .strict();
export type WireChatMessage = z.infer<typeof ChatMessageSchema>;

// --- initialize ---------------------------------------------------------

export const ClientCapabilitiesSchema = z
  .object({
    /** Client can render streamed `session/update` notifications. */
    streaming: z.boolean().default(true),
  })
  .strict();
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

export const AgentCapabilitiesSchema = z
  .object({
    tools: z.boolean().default(true),
    permissions: z.boolean().default(true),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const InitializeParamsSchema = z
  .object({
    protocolVersion: z.number().int(),
    clientCapabilities: ClientCapabilitiesSchema,
  })
  .strict();
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

export const InitializeResultSchema = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: AgentCapabilitiesSchema,
  })
  .strict();
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// --- session/new --------------------------------------------------------

export const NewSessionParamsSchema = z
  .object({
    /** Working directory the session's tools operate against. */
    cwd: z.string().optional(),
    /** Seed history for a resumed session (verbatim, replaces a fresh start). */
    messages: z.array(ChatMessageSchema).optional(),
    /** Client-chosen session id (so the client owns the persistence uid). */
    sessionId: SessionIdSchema.optional(),
  })
  .strict();
export type NewSessionParams = z.infer<typeof NewSessionParamsSchema>;

export const NewSessionResultSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();
export type NewSessionResult = z.infer<typeof NewSessionResultSchema>;

// --- session/prompt -----------------------------------------------------

/**
 * Client-chosen id of one turn: the idempotency key of `session/prompt` (a
 * retry with the same id never runs a second turn) and the tag of its
 * `turn_start`/`turn_end` updates.
 */
export const TurnIdSchema = z.string().min(1).max(128);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const PromptParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    content: z.array(ContentBlockSchema).min(1),
  })
  .strict();
export type PromptParams = z.infer<typeof PromptParamsSchema>;

export const StopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_iterations",
  "cancelled",
  "error",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Why a turn failed; redacted to "internal error" on a remote daemon (a provider message can carry secrets). */
export const TurnErrorSchema = z.object({
  code: z.number().int().optional(),
  message: z.string(),
});
export type TurnError = z.infer<typeof TurnErrorSchema>;

/** How a turn ended: streamed in `turn_end`, cached for a retried `session/prompt`. */
export const TurnEndSchema = z.object({
  stopReason: StopReasonSchema,
  /** Present on `stopReason: "error"`. */
  error: TurnErrorSchema.optional(),
});
// Not `.strict()`: it also rides `turn_end`, whose members stay open (see updates.ts).
export type TurnEnd = z.infer<typeof TurnEndSchema>;

/**
 * The ack: the turn was accepted (or, on a retry, already exists). `ended` is
 * present only when a retried `turnId` names a turn that already finished.
 */
export const PromptResultSchema = z
  .object({
    turnId: TurnIdSchema,
    ended: TurnEndSchema.optional(),
  })
  .strict();
export type PromptResult = z.infer<typeof PromptResultSchema>;

// --- session/cancel (notification) -------------------------------------

export const CancelParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();
export type CancelParams = z.infer<typeof CancelParamsSchema>;

// --- session/compact ----------------------------------------------------

export const CompactParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();
export type CompactParams = z.infer<typeof CompactParamsSchema>;

export const CompactResultSchema = z
  .object({
    /** Message count before and after compaction. */
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
  })
  .strict();
export type CompactResult = z.infer<typeof CompactResultSchema>;

// --- session/snapshot ---------------------------------------------------
// Read the session's current history back (the main thread persists it; the
// daemon/worker owns the live conversation but not the on-disk store).

export const SnapshotParamsSchema = z.object({ sessionId: SessionIdSchema }).strict();
export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

export const SnapshotResultSchema = z.object({ messages: z.array(ChatMessageSchema) }).strict();
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

// --- session/enqueue (steering) ------------------------------------------
// Queue a user message for injection into the turn currently running, at the
// next model-round boundary. The daemon resolves it as soon as it has pushed
// the text into the session's steering queue — the model may not have seen it
// yet (that happens at the boundary, streamed back as a `steer` update). `id`
// is the client-chosen idempotency key: a retry of an accepted id is a no-op
// success, even after its turn ended. `turnId` binds it to the turn it was
// typed during: a (retried) enqueue never lands in a later turn — it is
// `NoTurnRunning` unless that exact turn is still running.

export const EnqueueParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    id: z.string().min(1).max(128),
    turnId: TurnIdSchema,
    text: z.string().min(1),
  })
  .strict();
export type EnqueueParams = z.infer<typeof EnqueueParamsSchema>;

export const EnqueueResultSchema = z.object({}).strict();
export type EnqueueResult = z.infer<typeof EnqueueResultSchema>;

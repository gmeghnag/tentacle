/**
 * Session lifecycle & handshake (ACP-shaped).
 *
 * Flow:
 *   1. `initialize`     — client ↔ agent capability/version handshake.
 *   2. `session/open`   — attach to a live session (replaying what the client
 *      missed) or create one; returns its `sessionId`. Sessions belong to the
 *      daemon, not to a connection: a dropped connection only detaches.
 *   3. `session/prompt` — client submits a user turn under a client-chosen
 *      `turnId`; acks at once. The turn's end is `turn_end` in the stream.
 *   4. `session/cancel` — notification to interrupt the active turn.
 *   5. `session/close`  — end the session for every client (idempotent).
 */
import { z } from "zod";
import { ContentBlockSchema } from "./content.ts";

export const SessionIdSchema = z.string().min(1);
export type SessionId = z.infer<typeof SessionIdSchema>;

// --- conversation history (for resume seed + snapshot) ------------------
// Mirrors `@tentacle/core`'s `ChatMessage`/`ToolCall` on the wire, so a
// session can be seeded on `session/open` and read back via `session/snapshot`.

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

//
// The snapshot is taken at a consistent CUT of the session's update stream:
// every update with `seq <= since.seq` is reflected in `messages`, and replay
// of `seq > since.seq` (same epoch) carries the rest — never doubled, never
// lost. Paged newest-first: the first page (no `cursor`) is the newest slice
// and carries the cut; `cursor` fetches the slice just before it.
// One overlap is by design: an assistant message lists its `toolCalls` before
// their `tool_call` updates are emitted, so a replayed `tool_call` may name a
// call already in `messages` — the same call: clients key tool calls by
// `toolCallId` (upsert), never append a duplicate.

/**
 * A position in a session's update stream (decision D1). `epoch` changes with
 * every incarnation of the session and every history replacement (compaction):
 * compare it for equality only. `seq` is comparable with update `seq`s of the
 * same epoch.
 */
export const HistoryCutSchema = z
  .object({
    epoch: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type HistoryCut = z.infer<typeof HistoryCutSchema>;

export const SnapshotParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    /** Opaque: a previous page's `cursor` (an older slice). Absent → the newest page. */
    cursor: z.string().min(1).max(256).optional(),
    /** Max messages in this page. Absent → everything up to the cut, in one page. */
    limit: z.number().int().min(1).optional(),
  })
  .strict();
export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

/** The turn running at the cut (its `turn_start` is at or before `since`). */
export const SnapshotTurnSchema = z.object({ turnId: TurnIdSchema }).strict();
export type SnapshotTurn = z.infer<typeof SnapshotTurnSchema>;

export const SnapshotResultSchema = z
  .object({
    /** Chronological slice of the history, ending at the cut (or at the cursor). */
    messages: z.array(ChatMessageSchema),
    /** The cut this snapshot is consistent with. First page only. */
    since: HistoryCutSchema.optional(),
    /** Present iff a turn was running at the cut. First page only. */
    turn: SnapshotTurnSchema.optional(),
    /** Present iff older messages exist: pass it back for the previous page. */
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

// --- session/open -------------------------------------------------------
// Attach to a session, or create it. Synchronous on the daemon (look up or
// create, replay, attach — one step), so two concurrent opens of one id never
// build two agents, and no update falls between the replay and the live stream.
//
//   - `sessionId` live → attach. `create`/`messages` are ignored: a live id is
//     never overwritten. `since` covered (same epoch, still in the replay
//     ring) → the updates after it are replayed, `resync: false`. Otherwise
//     (absent, another epoch, evicted, …) → `resync: true` and the updates
//     after the session's current cut are replayed: take a `session/snapshot`
//     and apply the buffered updates past its `since` on top of it.
//   - not live (or no `sessionId`) and `create: true` or `messages` → a new
//     session (seeded with `messages`), `created: true`. No `sessionId` → the
//     daemon picks one.
//   - not live, neither → `UnknownSession`: the daemon lost it (a restart, a
//     close); the client decides whether to recreate it from its own history.
//
// ORDERING: replayed updates are ordinary `session/update` notifications, sent
// before any live one and possibly BEFORE this response: a client routes (or
// buffers) a session's updates from the moment it sends `open`.
// Any authenticated client may open any session (one token = one principal).

export const OpenParamsSchema = z
  .object({
    /** Client-chosen id (so the client owns the persistence uid); absent → daemon-chosen. */
    sessionId: SessionIdSchema.optional(),
    /** The last cut this client applied: a snapshot's `since`, advanced by each applied update. */
    since: HistoryCutSchema.optional(),
    /** Create the session if it is not live (a fresh, empty one unless `messages`). */
    create: z.boolean().optional(),
    /** Seed history: recreate a session that is not live from the client's copy. */
    messages: z.array(ChatMessageSchema).optional(),
    /** Working directory the session's tools operate against (not honoured: the daemon confines it). */
    cwd: z.string().optional(),
  })
  .strict();
export type OpenParams = z.infer<typeof OpenParamsSchema>;

export const OpenResultSchema = z
  .object({
    sessionId: SessionIdSchema,
    /** The session's current epoch: with the last applied `seq`, the client's next `since`. */
    epoch: z.string().min(1).max(128),
    /** A new session was built (vs attached to a live one). */
    created: z.boolean(),
    /** `since` could not be honoured: snapshot, then apply the buffered updates past its cut. */
    resync: z.boolean(),
  })
  .strict();
export type OpenResult = z.infer<typeof OpenResultSchema>;

// --- session/close ------------------------------------------------------
// End the session for everyone: abort its turn, stop its background jobs, tell
// every attached client (`session_closed`), forget it. Idempotent: an unknown
// or already-closed id is a no-op success. Needs no prior `open`.

export const CloseParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();
export type CloseParams = z.infer<typeof CloseParamsSchema>;

export const CloseResultSchema = z.object({}).strict();
export type CloseResult = z.infer<typeof CloseResultSchema>;

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

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
import { line } from "./text-line.ts";

export const SessionIdSchema = z.string().min(1);
export type SessionId = z.infer<typeof SessionIdSchema>;

// --- conversation history (for resume seed + snapshot) ------------------
// Mirrors `@tentacle/core`'s `ChatMessage`/`ToolCall` on the wire, so a
// session can be seeded on `session/open` and read back via `session/snapshot`.

export const WireToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(WireToolCallSchema).optional(),
  toolCallId: z.string().optional(),
});
export type WireChatMessage = z.infer<typeof ChatMessageSchema>;

// --- initialize ---------------------------------------------------------

export const ClientCapabilitiesSchema = z.object({
  /** Client can render streamed `session/update` notifications. */
  streaming: z.boolean().default(true),
  /**
   * The `session/update` types this client understands (protocol 10). The
   * daemon emits a BLOCKING type (`BLOCKING_UPDATE_TYPES`) only to a client
   * that lists it. Absent = the v10 base set.
   */
  updates: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/),
    )
    .max(256)
    .optional(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

export const AgentCapabilitiesSchema = z.object({
  tools: z.boolean().default(true),
  permissions: z.boolean().default(true),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const InitializeParamsSchema = z.object({
  protocolVersion: z.number().int(),
  clientCapabilities: ClientCapabilitiesSchema,
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

// --- skills (the `/name` catalog) -----------------------------------------
// The skills the user can activate on this daemon, so a client can offer
// `/name` with autocomplete (docs/feat/skills-slash.md). Per daemon (built at
// its start), so it rides `initialize`, refreshed on every reconnect. The
// daemon may be a pod (not trusted, AGENTS §7): the client's result
// validation pins names to the spec pattern and keeps control characters (a
// terminal escape) out of descriptions before anything reaches the UI.

/** A skill name as the agentskills.io spec defines it: lowercase alnum + single hyphens. */
export const SkillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
export type SkillName = z.infer<typeof SkillNameSchema>;

/** At most this many entries in the `initialize` skill catalog. */
export const MAX_SKILL_CATALOG = 200;
/** Max length of a catalog description (the spec's limit). */
export const MAX_SKILL_DESCRIPTION = 1024;

export const SkillSummarySchema = z.object({
  name: SkillNameSchema,
  /** One line: no control characters (C0, DEL, C1). */
  description: z
    .string()
    .min(1)
    .max(MAX_SKILL_DESCRIPTION)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const InitializeResultSchema = z.object({
  protocolVersion: z.number().int(),
  agentCapabilities: AgentCapabilitiesSchema,
  /** The skills a user can activate with `/name` (`session/prompt{skill}`); may be empty. */
  skills: z.array(SkillSummarySchema).max(MAX_SKILL_CATALOG),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// --- session/prompt -----------------------------------------------------

/**
 * Client-chosen id of one turn: the idempotency key of `session/prompt` (a
 * retry with the same id never runs a second turn) and the tag of its
 * `turn_start`/`turn_end` updates.
 */
export const TurnIdSchema = z.string().min(1).max(128);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const PromptParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  content: z.array(ContentBlockSchema).min(1),
  /**
   * The user activates this skill (`/name`, from the `initialize` catalog):
   * the daemon loads it as a `skill` tool round right after the prompt,
   * before the model's first round. Structured on purpose — the daemon never
   * parses the text. One the daemon cannot activate → `InvalidParams`.
   */
  skill: SkillNameSchema.optional(),
});
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
  /**
   * Set by the daemon on the end of a `session/send_now` turn only: `true`
   * if it started (its texts reached the history), `false` if it was
   * cancelled before it started (it delivered nothing). Absent on other turns
   * and from an older daemon.
   */
  delivered: z.boolean().optional(),
});
// Not `.strict()`: it also rides `turn_end`, whose members stay open (see updates.ts).
export type TurnEnd = z.infer<typeof TurnEndSchema>;

/**
 * The ack: the turn was accepted (or, on a retry, already exists). `ended` is
 * present only when a retried `turnId` names a turn that already finished.
 */
export const PromptResultSchema = z.object({
  turnId: TurnIdSchema,
  ended: TurnEndSchema.optional(),
});
export type PromptResult = z.infer<typeof PromptResultSchema>;

// --- session/cancel (notification) -------------------------------------

export const CancelParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type CancelParams = z.infer<typeof CancelParamsSchema>;

// --- session/compact ----------------------------------------------------

export const CompactParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type CompactParams = z.infer<typeof CompactParamsSchema>;

export const CompactResultSchema = z.object({
  /** Message count before and after compaction. */
  before: z.number().int().nonnegative(),
  after: z.number().int().nonnegative(),
});
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
export const HistoryCutSchema = z.object({
  epoch: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
});
export type HistoryCut = z.infer<typeof HistoryCutSchema>;

export const SnapshotParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Opaque: a previous page's `cursor` (an older slice). Absent → the newest page. */
  cursor: z.string().min(1).max(256).optional(),
  /** Max messages in this page. Absent → everything up to the cut, in one page. */
  limit: z.number().int().min(1).optional(),
});
export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

/** The turn running at the cut (its `turn_start` is at or before `since`). */
export const SnapshotTurnSchema = z.object({ turnId: TurnIdSchema });
export type SnapshotTurn = z.infer<typeof SnapshotTurnSchema>;

export const SnapshotResultSchema = z.object({
  /** Chronological slice of the history, ending at the cut (or at the cursor). */
  messages: z.array(ChatMessageSchema),
  /** The cut this snapshot is consistent with. First page only. */
  since: HistoryCutSchema.optional(),
  /** Present iff a turn was running at the cut. First page only. */
  turn: SnapshotTurnSchema.optional(),
  /** Present iff older messages exist: pass it back for the previous page. */
  cursor: z.string().min(1).optional(),
});
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

export const OpenParamsSchema = z.object({
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
});
export type OpenParams = z.infer<typeof OpenParamsSchema>;

export const OpenResultSchema = z.object({
  sessionId: SessionIdSchema,
  /** The session's current epoch: with the last applied `seq`, the client's next `since`. */
  epoch: z.string().min(1).max(128),
  /** A new session was built (vs attached to a live one). */
  created: z.boolean(),
  /** `since` could not be honoured: snapshot, then apply the buffered updates past its cut. */
  resync: z.boolean(),
});
export type OpenResult = z.infer<typeof OpenResultSchema>;

// --- session/close ------------------------------------------------------
// End the session for everyone: abort its turn, stop its background jobs, tell
// every attached client (`session_closed`), forget it. Idempotent: an unknown
// or already-closed id is a no-op success. Needs no prior `open`.

export const CloseParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type CloseParams = z.infer<typeof CloseParamsSchema>;

export const CloseResultSchema = z.object({});
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

export const EnqueueParamsSchema = z.object({
  sessionId: SessionIdSchema,
  id: z.string().min(1).max(128),
  turnId: TurnIdSchema,
  text: z.string().min(1),
});
export type EnqueueParams = z.infer<typeof EnqueueParamsSchema>;

export const EnqueueResultSchema = z.object({});
export type EnqueueResult = z.infer<typeof EnqueueResultSchema>;

// --- session/send_now ----------------------------------------------------
// Cancel what runs and start a new turn whose prompt is the queued texts,
// joined with "\n\n", in one daemon step: no other client's prompt can start
// in between (docs/feat/send-now-a.md). `turnId` is the NEW turn's id and
// idempotency key (a retry acks it, like `session/prompt`). `interrupt` names
// what the client believes is running: a stale request (it already ended)
// never cancels some OTHER turn — `TurnInProgress` instead. A message whose
// `id` the daemon already injected (drained as a steer) is left out of the
// prompt. If all were and nothing runs, the new turn is a continuation
// (prompt "") when the history ends with an unanswered user message (whoever
// wrote it; a compaction summary alone does not count); otherwise
// `NoTurnRunning` (nothing to send, nothing to restore). After a daemon
// restart, an idle history of one user message (after the system one) reads
// as a compaction summary → `NoTurnRunning` even if that text is unanswered:
// the text stays in the history, and the next prompt gets it answered. A successor
// cancelled (or its session closed) before it started ends with a `turn_end`
// and NO `turn_start`: it delivered nothing — neither its prompt nor any steer
// enqueued to it; the client that owns the texts restores them. The turn's end
// says which (`delivered`, in its `turn_end` and in a retried ack's `ended`):
// a client never infers it from a `turn_start` it may not have seen (a resync
// can hide one). Additive (an older daemon answers `MethodNotFound`).

export const SendNowTargetSchema = z.discriminatedUnion("kind", [
  /** The turn the client sees running. */
  z.object({ kind: z.literal("turn"), turnId: TurnIdSchema }),
  z.object({ kind: z.literal("compaction") }),
]);
export type SendNowTarget = z.infer<typeof SendNowTargetSchema>;

export const SendNowMessageSchema = z.object({
  /** The client's enqueue key (`session/enqueue` `id`); a fresh one if never enqueued. */
  id: z.string().min(1).max(128),
  text: z.string().min(1),
});
export type SendNowMessage = z.infer<typeof SendNowMessageSchema>;

export const SendNowParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  interrupt: SendNowTargetSchema,
  /** In queue order. An empty send-now never reaches the wire. */
  messages: z.array(SendNowMessageSchema).min(1),
});
export type SendNowParams = z.infer<typeof SendNowParamsSchema>;

/** The ack of the new turn: `PromptResultSchema` (`ended` only on a retry of an ended one). */
export type SendNowResult = PromptResult;

// --- session/list --------------------------------------------------------
// The daemon's sessions, one page at a time (docs/feat/session-list.md). A
// read: it does not attach, and it moves no session's TTL clock. Order:
// `updatedAt` desc, then `sessionId` asc. `updatedAt` is the last change of the
// CONVERSATION (a turn starting or ending, a successful compaction, or
// creation) — opening, viewing or closing a session never reorders the list; a
// running session sits at its turn's start. Paging is keyset: `cursor` is a
// position, not an index, so it survives a closed session and a daemon
// restart, and skips or repeats no entry — assuming the daemon's clock does
// not step back (a stamp taken after a backward step is smaller). A session
// updated while paging moves above the cursor: it is not in later pages, it is
// at the top of the next listing. Additive (an older daemon answers
// `MethodNotFound`). The daemon may be a pod (not trusted, AGENTS §7): every
// string is bounded and control-free before anything reaches a UI.
// Any authenticated client may list (one token = one principal).

/** At most this many entries in one `session/list` page (and the max `limit`). */
export const MAX_SESSION_LIST = 200;
/** Max length of a listed title. */
export const MAX_SESSION_TITLE = 256;

export const SessionListParamsSchema = z.object({
  /** Max entries in this page, 1..MAX_SESSION_LIST. Absent → MAX_SESSION_LIST. */
  limit: z.number().int().min(1).max(MAX_SESSION_LIST).optional(),
  /** Opaque: a previous page's `cursor`. Absent → the first (most recent) page. */
  cursor: z.string().min(1).optional(),
});
export type SessionListParams = z.infer<typeof SessionListParamsSchema>;

export const SessionListEntrySchema = z.object({
  sessionId: SessionIdSchema,
  /** One line, no control characters, never empty ("(empty)" before the first prompt). */
  title: line(MAX_SESSION_TITLE),
  /** The directory the session's tools run against (the daemon's project today). */
  cwd: line(4096),
  /** ms since epoch. */
  createdAt: z.number().int().nonnegative(),
  /** ms since epoch, the daemon's clock: the last conversation change. Never decreases while that clock does not step back. */
  updatedAt: z.number().int().nonnegative(),
  /** A turn or a compaction is running. */
  running: z.boolean(),
  /** Clients attached right now (the lister itself is not one). */
  attached: z.number().int().nonnegative(),
  /** Persisted but not loaded. Always false for now. */
  archived: z.boolean(),
});
export type SessionListEntry = z.infer<typeof SessionListEntrySchema>;

export const SessionListResultSchema = z.object({
  /** Most recently updated first; ties by `sessionId` ascending. */
  sessions: z.array(SessionListEntrySchema).max(MAX_SESSION_LIST),
  /** Present iff more entries follow: pass it back for the next page. */
  cursor: z.string().min(1).optional(),
});
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

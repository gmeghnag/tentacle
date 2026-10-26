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
import { ToolResultSpillSchema } from "./spill.ts";
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
  /** On a spilled tool result: the spill as data (display only, docs/feat/tui-spill-note.md). */
  spill: ToolResultSpillSchema.optional(),
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

/**
 * Who the client is: a program name and its version (the CLI sends
 * `{ name: "tentacle", version: APP_VERSION }`). Optional and informational —
 * a daemon only uses it to word a `VersionMismatch` (docs/feat/version-mismatch-notice.md).
 */
export const ClientInfoSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

/**
 * Every daemon must be able to read the `initialize` of every later client far
 * enough to reach the version check: a param this schema refuses ends in
 * `InvalidParams` and hides the real `VersionMismatch`. So fields here stay
 * additive and lenient — `clientInfo` that does not validate is dropped, never
 * an error.
 */
export const InitializeParamsSchema = z.object({
  protocolVersion: z.number().int(),
  clientCapabilities: ClientCapabilitiesSchema,
  clientInfo: ClientInfoSchema.optional().catch(undefined),
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

/**
 * The `data` of a `VersionMismatch` error from `initialize`: both sides'
 * protocol (and tentacle version, when known) and which side must update — a
 * fact from the protocol numbers, which only grow. Every daemon since this
 * field sends it; its absence means the daemon predates it. Its shape only
 * GROWS (additive fields, like `initialize`'s): a client keys on its presence,
 * and shows a report it cannot read as the daemon's own words.
 */
export const VersionMismatchDataSchema = z.object({
  client: z.object({ protocol: z.number().int(), tentacle: z.string().optional() }),
  daemon: z.object({ protocol: z.number().int(), tentacle: z.string().optional() }),
  update: z.enum(["client", "daemon"]),
});
export type VersionMismatchData = z.infer<typeof VersionMismatchDataSchema>;

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
  /**
   * The turn the client means (a turn's or a waiting send-now's `turnId`):
   * any other turn is left running, so a late cancel never stops a turn
   * another device started meanwhile. Absent → whatever runs, a compaction
   * included. An older build drops it (strip schema) and cancels blindly.
   */
  turnId: TurnIdSchema.optional(),
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

// --- session titles -------------------------------------------------------
// The DAEMON owns a session's title (docs/feat/session-titles.md): `auto` is
// derived from the history (the first user message, cut — never empty);
// `model` was generated by the model after the first exchange; `user` was set
// by `session/rename` and is never overwritten by a generated one. A change of
// a model/user title is streamed as `session_title` (display class) to every
// attached client; a client that missed it reads the title in the snapshot's
// first page and in `session/list`. A client never derives a title itself.

/** Max length of a title on the wire (listed, snapshot, update). */
export const MAX_SESSION_TITLE = 256;

export const TitleSourceSchema = z.enum(["auto", "model", "user"]);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

/** A session's title as the daemon holds it. One line, bounded, control-free (the daemon may be a pod). */
export const SessionTitleSchema = z.object({
  text: line(MAX_SESSION_TITLE),
  source: TitleSourceSchema,
});
export type SessionTitle = z.infer<typeof SessionTitleSchema>;

/** A chosen (non-`auto`) title: what `session/open` seeds a recreated session with. */
export const SeedTitleSchema = z.object({
  text: line(MAX_SESSION_TITLE),
  source: z.enum(["model", "user"]),
});
export type SeedTitle = z.infer<typeof SeedTitleSchema>;

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

// --- the session's queue (docs/feat/queued-broadcast.md) -----------------
// Every attached client sees the session's queued steers, whoever typed them,
// and sees each row leave. A row is `{id, text}`: `id` is the key its writer
// sent (`session/enqueue` `id`, or a `session/send_now` message `id`), so
// "mine" is an id my client sent — there is no device label. The state is
// always FULL (the `queued` update replaces any earlier one; the snapshot's
// first page carries it at the cut), so a client converges after any loss.
//
// A row leaves `entries` in the `queued` that follows its `steer` (delivered),
// the send-now `turn_start` whose prompt carries it (sent now), or its turn's
// `turn_end`: then it is in `returned` — back with its WRITER, never re-sent
// by itself — or, the row of a send-now cancelled before it started, restored
// by that send-now's own client (`delivered: false`). A row leaves `returned`
// in the `queued` that follows a `session/reclaim` of it, or a send-now that
// carries it in its prompt. Nothing else removes one: no expiry.

/** One queued row: its writer's key and text. */
export const QueuedEntrySchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().min(1),
});
export type QueuedEntry = z.infer<typeof QueuedEntrySchema>;

/**
 * Why a row went back to its writer (a daemon fact, for the notice):
 * `cancelled` — its turn was cancelled (an Esc, a send-now then cancelled);
 * `failed` — its turn ended early (an error, a limit, a hook stop);
 * `ended` — the session was closed or deleted.
 */
export const ReturnCauseSchema = z.enum(["cancelled", "failed", "ended"]);
export type ReturnCause = z.infer<typeof ReturnCauseSchema>;

/** A row back with its writer, until a `session/reclaim` of it. */
export const ReturnedEntrySchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().min(1),
  cause: ReturnCauseSchema,
});
export type ReturnedEntry = z.infer<typeof ReturnedEntrySchema>;

/** The session's queue NOW: the rows waiting, in delivery order, and the rows back with their writer (oldest first). */
export const QueueStateSchema = z.object({
  entries: z.array(QueuedEntrySchema),
  returned: z.array(ReturnedEntrySchema),
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export const SnapshotResultSchema = z.object({
  /** Chronological slice of the history, ending at the cut (or at the cursor). */
  messages: z.array(ChatMessageSchema),
  /** The cut this snapshot is consistent with. First page only. */
  since: HistoryCutSchema.optional(),
  /** Present iff a turn was running at the cut. First page only. */
  turn: SnapshotTurnSchema.optional(),
  /** Present iff older messages exist: pass it back for the previous page. */
  cursor: z.string().min(1).optional(),
  /** The session's title now (first page only; an older daemon sends none). */
  title: SessionTitleSchema.optional(),
  /** The queue at the cut (first page only; an older daemon sends none: it does not report the queue). */
  queued: QueueStateSchema.optional(),
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
//   - `sessionId` ARCHIVED (a `serve` daemon keeps an ended session: closed,
//     idle past the TTL, evicted by the detached cap) and `reopen: true` →
//     reloaded with its full history, as after a daemon restart: `created:
//     false`, `resync: true` (a new epoch: snapshot). `create`/`messages` are
//     ignored: the daemon's copy wins. Without `reopen` → `SessionArchived`,
//     whatever `create`/`messages` say: a reconnect (or any open that did not
//     mean to reopen) never revives a session someone ended, and never builds
//     a second session over its record. Only a person's explicit "reopen"
//     sends `reopen: true` (docs/feat/session-archive.md). A reopen builds a
//     live session, so it is admitted like a new one: past `maxSessions` →
//     `TooManySessions` (same `data`), and the record stays archived.
//   - `sessionId` DELETED (removed by `session/delete`; the daemon keeps a
//     tombstone of the id, durable on a `serve` daemon) → `SessionDeleted`,
//     whatever `create`/`messages`/`reopen` say: the id is never reused. A
//     client does not recreate it and drops its own copy.
//   - not live, not archived (or no `sessionId`) and `create: true` or
//     `messages` → a new session (seeded with `messages`, and with `title`
//     when given: the client's copy of a chosen title, so a recreate never
//     regenerates over a rename), `created: true`. No `sessionId` → the
//     daemon picks one. `title` is ignored in every other case.
//   - not live, not archived, neither → `UnknownSession`: the daemon does not
//     have it (never existed, or a daemon that persists nothing lost
//     it: a pod restart, a close); the client decides whether to recreate it
//     from its own history.
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
  /** Reload `sessionId` if it is archived (a person's explicit reopen). Absent → an archived id is `SessionArchived`. */
  reopen: z.boolean().optional(),
  /** Seed title of a session this open CREATES (ignored otherwise; see above). */
  title: SeedTitleSchema.optional(),
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
// every attached client (`session_closed{closed}`). On a daemon that persists
// (`serve`) it is kept ARCHIVED: listed (`archived: true`), reopenable
// (`session/open{reopen}`), removed only by `session/delete`. Elsewhere (a pod
// daemon, the in-process worker) it is gone. Idempotent: an unknown, archived
// or already-closed id is a no-op success. Needs no prior `open`.

export const CloseParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type CloseParams = z.infer<typeof CloseParamsSchema>;

export const CloseResultSchema = z.object({});
export type CloseResult = z.infer<typeof CloseResultSchema>;

// --- session/detach -----------------------------------------------------
// Stop receiving this session's updates on this connection; the session keeps
// running (turn, jobs, pending asks, queue) for any client, and counts as
// detached for the idle TTL, the detached cap and `session/list.attached` once
// no connection is attached. Idempotent: an id not open on this connection is
// a no-op success. On a connection that serves the model (pod reverse-tunnel)
// it also cancels the session's turn, exactly as closing that connection does.
// No update is sent to anyone. Additive: an older daemon answers
// `MethodNotFound`.

export const DetachParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type DetachParams = z.infer<typeof DetachParamsSchema>;

export const DetachResultSchema = z.object({});
export type DetachResult = z.infer<typeof DetachResultSchema>;

// --- session/delete -----------------------------------------------------
// Remove a session for good: a live one is ended first (its turn aborted, its
// jobs stopped, `session_closed{deleted}` to every attached client), then its
// daemon record is removed; an archived one just loses its record. The daemon
// keeps a tombstone of the id (on a `serve` daemon it survives a restart): a
// later `open` of it is `SessionDeleted`, so an offline client's reconnect
// never recreates it. Idempotent: an unknown id is a no-op success. Needs no prior `open`. A record the daemon could not load (corrupt,
// a newer daemon's, another project's) is not listed and not deletable here:
// the daemon's start notice names its file. Only the DAEMON's copy: a
// client's own store is the client's to delete. Any authenticated client may
// delete (one token = one principal).

export const DeleteParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type DeleteParams = z.infer<typeof DeleteParamsSchema>;

export const DeleteResultSchema = z.object({});
export type DeleteResult = z.infer<typeof DeleteResultSchema>;

// --- session/rename -----------------------------------------------------
// Set a session's title by hand (`source: "user"`): it wins over any
// generated title, now and later (a generation in flight is dropped). The
// daemon stores it as one line (control characters and runs of whitespace →
// one space, cut to its cap) and answers with the stored title; nothing
// visible left → `InvalidParams`. A live session streams `session_title` to
// every attached client; an ARCHIVED one (a `serve` daemon) is renamed in
// place — its record is rewritten, it is not reopened. A deleted id →
// `SessionDeleted`; an unknown one → `UnknownSession`. Allowed mid-turn (it
// touches neither the history nor the turn) and does not move `updatedAt`.
// Needs no prior `open`. Additive (an older daemon answers `MethodNotFound`).
// Any authenticated client may rename (one token = one principal).

export const RenameParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Raw text; the daemon makes it one line. Bounded so a client cannot send megabytes. */
  title: z
    .string()
    .min(1)
    .max(MAX_SESSION_TITLE * 4),
});
export type RenameParams = z.infer<typeof RenameParamsSchema>;

export const RenameResultSchema = z.object({
  /** The title as stored (`source: "user"`). */
  title: SessionTitleSchema,
});
export type RenameResult = z.infer<typeof RenameResultSchema>;

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
// can hide one). Additive (an older daemon answers `MethodNotFound`). A
// refusal (`TurnInProgress`, `CompactInProgress`) says in `error.data` which
// texts the daemon holds anyway (`SendNowRefusalSchema`): never inferred.

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

/**
 * `error.data` of a refused `session/send_now` (`TurnInProgress`,
 * `CompactInProgress`): which of the request's messages the daemon HOLDS — in
 * the history, or queued in the running turn or the reserved send-now (which
 * carries that queue over), so they share any queued text's fate. The others
 * did not reach it: the client restores exactly those. Additive: an older
 * daemon sends no `data` (the client then restores them all — a possible
 * duplicate, never a loss); an older client ignores it.
 */
export const SendNowRefusalSchema = z.object({
  /** Message ids, in request order. */
  held: z.array(z.string()),
});
export type SendNowRefusal = z.infer<typeof SendNowRefusalSchema>;

// --- session/reclaim -----------------------------------------------------
// The writer took its returned rows back (they are in its input now): drop
// `ids` from the session's `returned` (see the queue comment above). An id not
// there (unknown, already reclaimed) is ignored: a retry is a no-op success.
// Not gated by who asks (one token, one principal): a client reclaims only
// the ids it sent itself, or on a person's explicit act. Additive (an older
// daemon answers `MethodNotFound`, but it never reports `returned` either).

export const ReclaimParamsSchema = z.object({
  sessionId: SessionIdSchema,
  ids: z.array(z.string().min(1).max(128)).min(1),
});
export type ReclaimParams = z.infer<typeof ReclaimParamsSchema>;

export const ReclaimResultSchema = z.object({});
export type ReclaimResult = z.infer<typeof ReclaimResultSchema>;

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

export const SessionListParamsSchema = z.object({
  /** Max entries in this page, 1..MAX_SESSION_LIST. Absent → MAX_SESSION_LIST. */
  limit: z.number().int().min(1).max(MAX_SESSION_LIST).optional(),
  /** Opaque: a previous page's `cursor`. Absent → the first (most recent) page. */
  cursor: z.string().min(1).optional(),
});
export type SessionListParams = z.infer<typeof SessionListParamsSchema>;

export const SessionListEntrySchema = z.object({
  sessionId: SessionIdSchema,
  /** The session's title (renamed / generated, else the first message). One line, no control characters, never empty ("(empty)" before the first prompt). */
  title: line(MAX_SESSION_TITLE),
  /** The directory the session's tools run against (the session's own: an archived one carries its record's). */
  cwd: line(4096),
  /** ms since epoch. */
  createdAt: z.number().int().nonnegative(),
  /** ms since epoch, the daemon's clock: the last conversation change. Never decreases while that clock does not step back. */
  updatedAt: z.number().int().nonnegative(),
  /** A turn or a compaction is running. */
  running: z.boolean(),
  /** Clients attached right now (the lister itself is not one). */
  attached: z.number().int().nonnegative(),
  /** Ended and kept, not loaded (`running: false`, `attached: 0`): `session/open{reopen}` reloads it. */
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

/**
 * `session/log` (protocol 17, docs/feat/session-log.md): a session's committed
 * history as a typed, ordered event log. The laptop reads it at its own save
 * points with `after` = the last entry it holds, so a read moves only what
 * changed since (the old read-back moved the whole history every time).
 *
 * Every entry carries the ENVELOPE: `type` (the discriminator), `seq` (+1 per
 * entry along a lineage), `id` (`"<incarnation>/<seq>"`, opaque), `prev` (the
 * previous entry's `id`: the parent link — a fork is detected, never spliced),
 * `ts` (the daemon's clock, display only) and `critical`.
 *
 * `critical` (owner decision, 2026-11-07): a reader that does not know an
 * entry's `type` SKIPS it when `critical` is absent/false and REFUSES the
 * whole log when it is `true` (it cannot project without it). The v1 table is
 * owner-approved and binding: critical = `base`, `message`, `replace`,
 * `truncate`; not critical = `title`, `checkpoint`, `turn_start`, `turn_end`,
 * `call_started`, `subagent_background`, `subagent_end`. Adding a critical type
 * (or changing a value) is decided with the owner AND bumps `PROTOCOL_VERSION`,
 * like a `mandatory` update class. v2 (owner-approved 2026-11-12,
 * docs/feat/attachments-core.md) adds two more CRITICAL types, `media_message`
 * and `media_replace`: a message that carries image refs, which an older build
 * would silently strip if it rode a plain `message`.
 *
 * The RESULT carries entries as the open envelope (`.passthrough()`): one
 * unknown type must not reject the whole read at the peer's result parse. The
 * reader then parses each entry it knows with its own (strip) schema below and
 * keeps ONLY that re-serialized value — an entry from a pod is never kept
 * verbatim (F4: a pod is not trusted).
 *
 * The same entries are what the laptop's disk log will hold (task 2): they are
 * self-describing, ordered by `seq`, linked by `prev`, segmented at `base`.
 *
 * `subagent_background` / `subagent_end` (docs/feat/subagent-ledger-log.md) are
 * two NON-critical types: a background sub-agent exists, and it ended (with its
 * report, capped). A build that does not know them skips them; the LOAD
 * derivation (`subagentLoadNotes`, core) turns what they leave open into a
 * history note, so a restart is honest without them.
 */
import { z } from "zod";
import {
  ChatMessageSchema,
  type MessageWithAttachments,
  MessageWithAttachmentsSchema,
  type MessageWithoutAttachments,
  MessageWithoutAttachmentsSchema,
  SessionIdSchema,
  SessionTitleSchema,
  StopReasonSchema,
  TurnIdSchema,
  type WireChatMessage,
} from "./session.ts";

/**
 * Char budget of one `session/log` page (the daemon's cap): far below the 8 MiB
 * frame cap, and about one old snapshot page for head-of-line delay. A single
 * larger entry travels alone.
 */
export const LOG_PAGE_MAX_CHARS = 256 * 1024;

/** An entry's opaque id (`"<incarnation>/<seq>"` from a daemon; never parsed by a reader). */
export const LogEntryIdSchema = z.string().min(1).max(256);

/**
 * A background sub-agent's `description`, capped (docs/feat/subagent-ledger-log.md):
 * enforced by the EMITTER (the ledger), never discovered by a reader.
 */
export const SUBAGENT_DESCRIPTION_MAX_CHARS = 512;
/**
 * A background sub-agent's report as `subagent_end` carries it (64 KiB). The
 * emitter caps it (head + tail + a cut line) so the log never holds a value a
 * reader must refuse.
 */
export const SUBAGENT_REPORT_MAX_CHARS = 64 * 1024;
/**
 * A background sub-agent's `agentType` (the tool's own type name), `callId` (the
 * `agent_task` call's id) and `stopReason` (6a's free text): capped by the EMITTER
 * (the ledger), so a reader never refuses a value a task legitimately writes
 * (review M4).
 */
export const SUBAGENT_AGENT_TYPE_MAX_CHARS = 128;
export const SUBAGENT_CALL_ID_MAX_CHARS = 256;
export const SUBAGENT_STOP_REASON_MAX_CHARS = 64;

/** A position in a log: the last entry a reader holds. Both must match (a seq alone is ambiguous across lineages). */
export const LogCursorSchema = z.object({
  seq: z.number().int().positive(),
  id: LogEntryIdSchema,
});
export type LogCursor = z.infer<typeof LogCursorSchema>;

/** Fresh instances per schema: the JSON Schema export refuses a reused anonymous one. */
const envelopeShape = () => ({
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  seq: z.number().int().positive(),
  id: LogEntryIdSchema,
  /** Absent only on a lineage's first entry (the wire never sends `null` for "none"). */
  prev: z.string().min(1).max(256).optional(),
  ts: z.number().int().nonnegative(),
  critical: z.boolean().optional(),
});

/** Any entry as the wire carries it: the envelope, every other member kept for the reader's own parse. */
export const LogEntryEnvelopeSchema = z.object(envelopeShape()).passthrough();
export type LogEntryEnvelope = z.infer<typeof LogEntryEnvelopeSchema>;

/** Why a segment starts (`base.reason`). */
export const LogBaseReasonSchema = z.enum(["create", "seed", "reload", "compact", "context_reset"]);
export type LogBaseReason = z.infer<typeof LogBaseReasonSchema>;

const critical = () => ({ critical: z.literal(true) });
const skippable = () => ({ critical: z.literal(false).optional() });

/**
 * RESET: the projection becomes the `count` `message` entries that follow.
 * Starts a segment; every daemon incarnation starts with one. `turn`: the
 * turn open at this point (a context reset inside it, a reload that resumes
 * it) — a cold read from here knows a turn is open.
 */
export const LogBaseEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("base"),
  inc: z.string().min(1).max(128),
  reason: LogBaseReasonSchema,
  count: z.number().int().nonnegative(),
  turn: TurnIdSchema.optional(),
});

/** Append one message to the projection. A message WITH refs rides `media_message` (below):
 * a plain `message` that carries them is MALFORMED, never half-loaded (review M2). */
export const LogMessageEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("message"),
  message: MessageWithoutAttachmentsSchema,
});

/** `projection[index] = message` (`index` < the projection's length). */
export const LogReplaceEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("replace"),
  index: z.number().int().nonnegative(),
  message: MessageWithoutAttachmentsSchema,
});

/**
 * Append one message that CARRIES image refs (docs/feat/attachments-core.md).
 * A separate, critical type on purpose: an older build knows `message` and
 * would strip `attachments` — a silent half-load. An unknown critical type
 * makes it refuse the whole log loudly, and only for sessions with images
 * (a text-only session stays readable by every build, unlike a header bump).
 */
export const LogMediaMessageEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("media_message"),
  message: MessageWithAttachmentsSchema,
});

/** `projection[index] = message`, where the message carries image refs (see above). */
export const LogMediaReplaceEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("media_replace"),
  index: z.number().int().nonnegative(),
  message: MessageWithAttachmentsSchema,
});

/** `projection.length = length` (never grows it): the removal entry (F3). */
export const LogTruncateEntrySchema = z.object({
  ...envelopeShape(),
  ...critical(),
  type: z.literal("truncate"),
  length: z.number().int().nonnegative(),
});

/** The daemon's title, as `session/list` shows it. */
export const LogTitleEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("title"),
  title: SessionTitleSchema,
});

/** The projection here has `count` messages and `projectionDigest` `digest` (F2: derivation drift). Not security: a pod writes it. */
export const LogCheckpointEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("checkpoint"),
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A turn was accepted (its messages follow, from its first commit). */
export const LogTurnStartEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("turn_start"),
  turnId: TurnIdSchema,
});

/** The turn ended, after its last message. */
export const LogTurnEndEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("turn_end"),
  turnId: TurnIdSchema,
  stopReason: StopReasonSchema,
});

/** A tool call is about to start (it may have run: "interrupted", never "not run"). */
export const LogCallStartedEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("call_started"),
  callId: z.string().min(1).max(256),
});

/**
 * A sub-agent's `agent_task` call started it in the BACKGROUND
 * (docs/feat/subagent-ledger-log.md): the durable fact that it exists, so a
 * load can tell "running" from "never existed". The payload field is `agentId`,
 * never `id`: every entry's envelope already carries `id`.
 */
export const LogSubagentBackgroundEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("subagent_background"),
  agentId: z.string().min(1).max(64),
  callId: z.string().min(1).max(SUBAGENT_CALL_ID_MAX_CHARS),
  agentType: z.string().min(1).max(SUBAGENT_AGENT_TYPE_MAX_CHARS),
  description: z.string().max(SUBAGENT_DESCRIPTION_MAX_CHARS),
});

/** A background sub-agent ended (`report`: its work product, capped by the emitter). */
export const LogSubagentEndEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("subagent_end"),
  agentId: z.string().min(1).max(64),
  /** A bounded free string, not `StopReasonSchema`: 6a may add `killed`. */
  stopReason: z.string().min(1).max(SUBAGENT_STOP_REASON_MAX_CHARS),
  report: z.string().max(SUBAGENT_REPORT_MAX_CHARS).optional(),
});

/** Every entry type this protocol version knows, parsed strictly by its own schema (strip). */
export const KnownLogEntrySchema = z.discriminatedUnion("type", [
  LogBaseEntrySchema,
  LogMessageEntrySchema,
  LogMediaMessageEntrySchema,
  LogReplaceEntrySchema,
  LogMediaReplaceEntrySchema,
  LogTruncateEntrySchema,
  LogTitleEntrySchema,
  LogCheckpointEntrySchema,
  LogTurnStartEntrySchema,
  LogTurnEndEntrySchema,
  LogCallStartedEntrySchema,
  LogSubagentBackgroundEntrySchema,
  LogSubagentEndEntrySchema,
]);
export type KnownLogEntry = z.infer<typeof KnownLogEntrySchema>;
export type LogMessageEntry = z.infer<typeof LogMessageEntrySchema>;
export type LogMediaMessageEntry = z.infer<typeof LogMediaMessageEntrySchema>;
export type LogReplaceEntry = z.infer<typeof LogReplaceEntrySchema>;
export type LogMediaReplaceEntry = z.infer<typeof LogMediaReplaceEntrySchema>;
export type LogEntryType = KnownLogEntry["type"];

/** The v1 critical table (owner-approved, binding — see the module comment). */
export const LOG_ENTRY_CRITICAL: Readonly<Record<LogEntryType, boolean>> = {
  base: true,
  message: true,
  media_message: true,
  replace: true,
  media_replace: true,
  truncate: true,
  title: false,
  checkpoint: false,
  turn_start: false,
  turn_end: false,
  call_started: false,
  subagent_background: false,
  subagent_end: false,
};

/**
 * True when a message carries image refs: the ONE test every emitter and fold
 * uses to pick the media entry type. No other code compares to the literal
 * `"message"`/`"replace"` for this decision.
 */
export function hasAttachments(m: object): boolean {
  const attachments = (m as { readonly attachments?: readonly unknown[] }).attachments;
  return attachments !== undefined && attachments.length > 0;
}

/** The append entry type for `m`: a message with refs rides `media_message`. */
export function appendEntryType(m: object): "message" | "media_message" {
  return hasAttachments(m) ? "media_message" : "message";
}

/** The replace entry type for `m`: a message with refs rides `media_replace`. */
export function replaceEntryType(m: object): "replace" | "media_replace" {
  return hasAttachments(m) ? "media_replace" : "replace";
}

/** A message as an emitter holds it: core's readonly one, or the wire's parsed one. */
export type AppendableMessage = Readonly<Omit<WireChatMessage, "attachments" | "toolCalls">> & {
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }>;
  readonly attachments?: ReadonlyArray<{
    readonly id: string;
    readonly mimeType: string;
    readonly size: number;
    readonly name?: string | undefined;
  }>;
};

/** An entry without its envelope: what an emitter fills in with `seq`/`id`/`prev`/`ts`. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "seq" | "id" | "prev" | "ts"> : never;

/** The body of an append entry (`message` or `media_message`). */
export type EntryBody = WithoutEnvelope<LogMessageEntry | LogMediaMessageEntry>;
/** The body of a replace entry (`replace` or `media_replace`). */
export type ReplaceEntryBody = WithoutEnvelope<LogReplaceEntry | LogMediaReplaceEntry>;

/**
 * The append entry for `message` (a `media_message` when it carries refs).
 * The one cast: a boolean cannot narrow the message's type to the media
 * schema's REQUIRED `attachments`, and the invariant holds by construction —
 * nothing in this build stores `attachments: []` (`Session.send` refuses it).
 */
export function appendEntryBody(m: AppendableMessage): EntryBody {
  return hasAttachments(m)
    ? { type: "media_message", critical: true, message: m as MessageWithAttachments }
    : {
        type: "message",
        critical: true,
        message: m as unknown as MessageWithoutAttachments,
      };
}

/** The replace entry for `message` (a `media_replace` when it carries refs). See above. */
export function replaceEntryBody(index: number, m: AppendableMessage): ReplaceEntryBody {
  return hasAttachments(m)
    ? { type: "media_replace", critical: true, index, message: m as MessageWithAttachments }
    : {
        type: "replace",
        critical: true,
        index,
        message: m as unknown as MessageWithoutAttachments,
      };
}

/** True for the two entry types that APPEND a message to the projection. */
export function isAppendEntry(
  entry: KnownLogEntry,
): entry is LogMessageEntry | LogMediaMessageEntry {
  return entry.type === "message" || entry.type === "media_message";
}

/**
 * The projection step of ONE entry — the shared fold: the client's reader and
 * the laptop's disk log (docs/feat/session-log-laptop-store.md) both apply it,
 * so the two cannot drift. `base` empties the projection (its `count` messages
 * follow), `message` appends, `replace` sets an index, `truncate` shortens;
 * every other type leaves it as it is. `item` maps a message to what `list`
 * holds (the message itself, or its digest). Mutates `list`; returns why the
 * entry does not fit it (out of range), else `null`.
 */
export function projectEntry<T>(
  list: T[],
  entry: KnownLogEntry,
  item: (message: WireChatMessage) => T,
): string | null {
  switch (entry.type) {
    case "base":
      list.length = 0;
      return null;
    case "message":
    case "media_message":
      list.push(item(entry.message));
      return null;
    case "replace":
    case "media_replace":
      if (entry.index >= list.length) {
        return `replace at ${entry.index} past the end (${list.length})`;
      }
      list[entry.index] = item(entry.message);
      return null;
    case "truncate":
      if (entry.length > list.length) {
        return `truncate to ${entry.length} grows the history (${list.length})`;
      }
      list.length = entry.length;
      return null;
    default:
      return null; // title, checkpoint, turn markers: not part of the projection
  }
}

export const LogParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** The last entry this reader holds. Absent → a cold read from the last `base` (F5). */
  after: LogCursorSchema.optional(),
  /** Char budget of this page (the daemon caps it at `LOG_PAGE_MAX_CHARS`). */
  maxChars: z.number().int().min(1).optional(),
});
export type LogParams = z.infer<typeof LogParamsSchema>;

export const LogResultSchema = z.object({
  /** In `seq` order: after `after`, or from the last `base` when `rebased` / a cold read. */
  entries: z.array(LogEntryEnvelopeSchema),
  /** More entries follow: read again with `after` = the last entry of this page. */
  more: z.boolean(),
  /** The log's newest entry now. */
  tip: LogCursorSchema,
  /**
   * `after` is not in this daemon's retained log (another incarnation, an
   * unknown id, evicted): the entries start at the last `base` instead.
   */
  rebased: z.boolean().optional(),
  /**
   * Present when the entries start at a `base` (a cold or rebased read) AND this
   * daemon incarnation was reseeded from a client's head (`open{logBase}`): that
   * head. A reader that holds exactly it knows this incarnation continues its
   * copy even when the seed segment is no longer retained (a compaction since).
   */
  root: LogCursorSchema.optional(),
});
export type LogResult = z.infer<typeof LogResultSchema>;

/** A sha-256 hex digest of a UTF-8 string, injected (this package stays node-free: mobile imports it). */
export type Sha256 = (text: string) => string;

/** A message as both ends hold it (the wire's parsed object, or core's readonly one). */
export type DigestibleMessage = Readonly<Omit<WireChatMessage, "toolCalls" | "attachments">> & {
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }[];
  readonly attachments?: ReadonlyArray<{
    readonly id: string;
    readonly mimeType: string;
    readonly size: number;
    readonly name?: string | undefined;
  }>;
};

/**
 * The fields of a message this protocol version knows, in a FIXED order (absent
 * → `null`): what both ends hash. A field a newer peer adds is outside it, so
 * it never trips a checkpoint; spread order or schema order give one result.
 *
 * `attachments` is appended ONLY when present, as ONE element: a message
 * without refs must hash byte-identically to a pre-attachments build, so every
 * checkpoint already on disk stays valid.
 */
export function canonicalMessage(m: DigestibleMessage): string {
  const spill = m.spill
    ? [m.spill.chars, m.spill.path ?? null, m.spill.head, m.spill.tail, m.spill.omitted]
    : null;
  return JSON.stringify([
    m.role,
    m.content,
    m.toolCalls ? m.toolCalls.map((c) => [c.id, c.name, c.arguments]) : null,
    m.toolCallId ?? null,
    spill,
    m.durationMs ?? null,
    m.denialReply ?? null,
    m.contextUsage ? [m.contextUsage.used, m.contextUsage.window] : null,
    ...(hasAttachments(m)
      ? [m.attachments?.map((a) => [a.id, a.mimeType, a.size, a.name ?? null])]
      : []),
  ]);
}

/** One message's digest (`sha256(canonicalMessage)`). */
export function messageDigest(m: DigestibleMessage, sha256: Sha256): string {
  return sha256(canonicalMessage(m));
}

/** The projection's digest from its messages' digests, in order. */
export function digestOfDigests(digests: readonly string[], sha256: Sha256): string {
  return sha256(digests.join(""));
}

/** `sha256(concat(sha256(canonicalMessage(m_i))))`: a checkpoint's `digest`. */
export function projectionDigest(messages: readonly DigestibleMessage[], sha256: Sha256): string {
  return digestOfDigests(
    messages.map((m) => messageDigest(m, sha256)),
    sha256,
  );
}

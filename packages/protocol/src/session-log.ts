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
 *
 * `capabilities` (docs/feat/session-capabilities.md, owner Q2) is NON-critical
 * too: the session's MCP/skill switches; an older build skips it and shows the
 * model everything.
 *
 * `workflow_start` / `workflow_step` / `workflow_end` (docs/feat/agent-workflows.md
 * D4, owner Q1) are NON-critical: a workflow run's terminal facts. The load
 * derivation `workflowLoadNotes` (core) closes a run a crash left open.
 *
 * `unit_end` (docs/feat/a2a.md, Unification §2) is NON-critical: an ENDED unit
 * of work (a turn, a workflow run) carried into a new segment, so its state and
 * result survive a compaction, a reset, a `/clear` and a reload. It projects
 * nothing; an older build skips it and loses only that carry.
 */
import { type ZodTypeAny, z } from "zod";
import {
  ChatMessageSchema,
  type MessageWithAttachments,
  MessageWithAttachmentsSchema,
  type MessageWithoutAttachments,
  MessageWithoutAttachmentsSchema,
  SessionCapabilitiesSchema,
  SessionIdSchema,
  SessionTitleSchema,
  StopReasonSchema,
  TurnIdSchema,
  type WireChatMessage,
  WorkflowInputValueSchema,
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
/** One `usage` entry's model id (docs/feat/token-usage-log.md). */
export const USAGE_MODEL_ID_MAX_CHARS = 200;

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

/**
 * The session's MCP/skill switches (docs/feat/session-capabilities.md S3b): the
 * WHOLE state after a change, the last one of a segment wins (none = everything
 * on). Logged on every change and again after a `base` when something is off,
 * so a segment is self-contained. NOT critical (owner Q2): an older build skips
 * it and loads the session with everything visible — fail-open on visibility
 * only, permissions still gate every call. Not security: a pod writes it.
 */
export const LogCapabilitiesEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("capabilities"),
  capabilities: SessionCapabilitiesSchema,
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

/**
 * One model round's measured token usage (docs/feat/token-usage-log.md), so a
 * run's spend can be analysed afterwards: which round, on which model, how big
 * the context it sent, how much of it the provider served from cache. NOT
 * critical: it projects nothing (a build that does not know it skips it and the
 * history is intact), so `PROTOCOL_VERSION` does not move. An unmeasured value
 * is OMITTED, never 0 — a 0 would read as a measured zero.
 */
export const LogUsageEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("usage"),
  /** The turn it belongs to, when the emitter knows it. */
  turnId: TurnIdSchema.optional(),
  /** 0-based round index inside the turn (absent on the forced final report). */
  round: z.number().int().nonnegative().optional(),
  /** The ONE no-tools report a spent step budget forces, so it has no round. */
  final: z.literal(true).optional(),
  /** The model id, only where this process can know it (never over the pod tunnel). */
  model: z.string().min(1).max(USAGE_MODEL_ID_MAX_CHARS).optional(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** The served-from-cache part of `promptTokens`, when the provider reports it. */
  cachedPromptTokens: z.number().int().nonnegative().optional(),
  /** How many messages the request carried: the context this round sent. */
  messages: z.number().int().nonnegative().optional(),
});
export type LogUsageEntry = z.infer<typeof LogUsageEntrySchema>;
/** A `usage` entry's body: what it says, without the envelope (the emitter fills that in). */
export type UsageEntryBody = Omit<
  LogUsageEntry,
  "type" | "critical" | "seq" | "id" | "prev" | "ts"
>;

// --- workflow runs (docs/feat/agent-workflows.md D4, owner Q1) ---
// Three NON-critical types: the durable TERMINAL facts of a workflow run (it
// started, a step ended, it ended). They project nothing — the run's end note is
// an ordinary message — so a build that does not know them skips them and the
// conversation is intact. `running`/`waiting` live in memory and on the wire
// only. Every state/verdict/`by` is a BOUNDED FREE STRING, never an enum: a
// malformed KNOWN entry is fatal to a reader (it refuses the whole log), so a
// newer build's new state must not poison an older reader (review M4). The
// emitter (`core`'s `workflow-ledger.ts`) caps every text to these bounds.

/** A run's id, `wf-N` (session-scoped). Never `id`: the envelope already has one. */
export const WorkflowRunIdSchema = z
  .string()
  .max(32)
  .regex(/^wf-[1-9][0-9]*$/);
/** A step id as the workflow file declares it (`[a-z0-9-]`, ≤ 64). */
export const WorkflowStepIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
/** A workflow's content hash (sha-256 hex). */
export const WorkflowHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** A state / verdict / stop reason / `by`: a bounded free word (see above). */
export const WorkflowWordSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const WORKFLOW_NAME_MAX_CHARS = 64;
export const WORKFLOW_PATH_MAX_CHARS = 512;
// (`WORKFLOW_INPUTS_MAX_CHARS` / `WORKFLOW_INPUT_NAME_MAX_CHARS`: session.ts, beside the input schema.)
export const WORKFLOW_REASON_MAX_CHARS = 2 * 1024;
/** A step's resolved prompt (an agent step) or command (a run step) / title (approve). */
export const WORKFLOW_PROMPT_MAX_CHARS = 16 * 1024;
export const WORKFLOW_MODEL_MAX_CHARS = 128;
/** `local`, `docker:<name>` or `docker:<name>/<container>`. */
export const WORKFLOW_WHERE_MAX_CHARS = 256;

/** A run started: which file, which version, which content hash, by whom. */
export const LogWorkflowStartEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("workflow_start"),
  runId: WorkflowRunIdSchema,
  name: z.string().min(1).max(WORKFLOW_NAME_MAX_CHARS),
  version: z.number().int().nonnegative(),
  hash: WorkflowHashSchema,
  path: z.string().min(1).max(WORKFLOW_PATH_MAX_CHARS),
  /** `{name, value}` in name order (a list: the JSON-schema export has no record). */
  inputs: z.array(WorkflowInputValueSchema),
  /** `user` (the `session/workflow` RPC) or `model` (the `workflow` tool); free word. */
  by: WorkflowWordSchema,
  /** The turn the run's asks are attributed to (A2). */
  turnId: TurnIdSchema.optional(),
  /** The schedule that started it (`by: schedule`, slice 10); additive. */
  scheduleId: z.string().min(1).max(64).optional(),
});

/** One step execution ended (a retry or a goto round is another entry). */
export const LogWorkflowStepEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("workflow_step"),
  runId: WorkflowRunIdSchema,
  stepId: WorkflowStepIdSchema,
  attempt: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  /** `ok` | `error` | `stopped` today; free word. */
  state: WorkflowWordSchema,
  /** `pass` | `fail` today; free word. Absent when the step never reached one. */
  verdict: WorkflowWordSchema.optional(),
  reason: z.string().max(WORKFLOW_REASON_MAX_CHARS),
  model: z.string().min(1).max(WORKFLOW_MODEL_MAX_CHARS).optional(),
  where: z.string().min(1).max(WORKFLOW_WHERE_MAX_CHARS),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  prompt: z.string().max(WORKFLOW_PROMPT_MAX_CHARS).optional(),
  report: z.string().max(SUBAGENT_REPORT_MAX_CHARS).optional(),
});

/** The run ended (`state` + the machine's one sentence). */
export const LogWorkflowEndEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("workflow_end"),
  runId: WorkflowRunIdSchema,
  /** `ok` | `error` | `stopped` today; free word. */
  state: WorkflowWordSchema,
  /** With `stopped`: `budget` | `timeout` | `cancelled` | `interrupted` | `changed` today. */
  stopReason: WorkflowWordSchema.optional(),
  reason: z.string().max(WORKFLOW_REASON_MAX_CHARS),
});
export type LogWorkflowStartEntry = z.infer<typeof LogWorkflowStartEntrySchema>;
export type LogWorkflowStepEntry = z.infer<typeof LogWorkflowStepEntrySchema>;
export type LogWorkflowEndEntry = z.infer<typeof LogWorkflowEndEntrySchema>;

// --- ended units of work, carried across segments (docs/feat/a2a.md, Unification §2) ---
// Written ONLY when a new segment starts (the carry), never at a unit's end:
// inside a segment the native entries (`turn_*`, `workflow_*`) are the record.
// Every word is a BOUNDED FREE STRING, never an enum (the workflow entries'
// rule): `native` can be `stopped:<why>`, so not `WorkflowWordSchema`. The
// emitter (`core`'s `unitEndBody`) caps every text to these bounds and judges
// the body by this schema.

/** A carried unit's `kind` / `state` / `native` word. */
export const UNIT_END_WORD_MAX_CHARS = 128;
/** A unit's id: a `turnId` (≤ 128) or a run's `wf-N`. */
export const UNIT_END_ID_MAX_CHARS = 128;
/** One line: why it ended. */
export const UNIT_END_REASON_MAX_CHARS = 2 * 1024;
/** A unit's result (a turn's final round text; a run's end reason + last step report). */
export const UNIT_END_RESULT_MAX_CHARS = 16 * 1024;

const unitWord = () => z.string().min(1).max(UNIT_END_WORD_MAX_CHARS);

/** An ended unit of work, carried into a new segment. Never `id`: the envelope already has one. */
export const LogUnitEndEntrySchema = z.object({
  ...envelopeShape(),
  ...skippable(),
  type: z.literal("unit_end"),
  /** `turn` | `workflow` today; free word (a reader skips a kind it does not know). */
  kind: unitWord(),
  unitId: z.string().min(1).max(UNIT_END_ID_MAX_CHARS),
  /** The `turnId` that started it (`workflow_start.turnId`). */
  origin: TurnIdSchema.optional(),
  /** `completed` | `failed` | `canceled` today; free word. */
  state: unitWord(),
  /** The unit's own word: a stop reason, a run state, `stopped:<why>`. */
  native: unitWord(),
  reason: z.string().max(UNIT_END_REASON_MAX_CHARS).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative(),
  result: z.string().max(UNIT_END_RESULT_MAX_CHARS).optional(),
  /** The unit had a result that no longer fits the retained budget. */
  resultDropped: z.literal(true).optional(),
});
export type LogUnitEndEntry = z.infer<typeof LogUnitEndEntrySchema>;

/**
 * `session/workflow_step` (docs/feat/workflows-ui.md D1): ONE step execution's
 * `prompt`/`report` — what a `workflow_step` entry carries and the `workflows`
 * update deliberately does not (that is a live row, not history). Additive: an
 * older daemon answers `MethodNotFound` and the client says "update tentacle".
 *
 * It lives HERE, beside the entry it reads, because it is bounded by the entry's
 * own constants and shares its `WorkflowWordSchema`; `session.ts` cannot host it
 * without a `session.ts ⇄ session-log.ts` import cycle (which breaks module init
 * at `TurnIdSchema`). The task doc lists `session.ts` — that is the drift.
 *
 * `attempt`/`round` pick WHICH execution when a step ran more than once (a
 * `retry`, a `goto` round); omitted means the newest. The daemon answers from
 * its retained log (the current segment and the previous one), so a step whose
 * entry compaction dropped is `detail` absent — "no longer available", never a
 * throw and never another step's text.
 */
export const WorkflowStepParamsSchema = z.object({
  sessionId: SessionIdSchema,
  runId: WorkflowRunIdSchema,
  stepId: WorkflowStepIdSchema,
  /** 0 for the first attempt, 1.. after a retry. Omitted: the newest. */
  attempt: z.number().int().nonnegative().optional(),
  /** The `goto` round it ran in. Omitted: the newest. */
  round: z.number().int().nonnegative().optional(),
});
export type WorkflowStepParams = z.infer<typeof WorkflowStepParamsSchema>;

/**
 * One step execution as the ledger recorded it, capped exactly as the entry is
 * (`reason` 2 KiB, `prompt` 16 KiB, `report` 64 KiB): the reader on the other
 * side of the wire paints it, and a UI row is never unbounded free text.
 */
export const WorkflowStepDetailSchema = z.object({
  attempt: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  /** The step is running NOW and was asked: its live text stands in for the report. */
  live: z.boolean(),
  state: WorkflowWordSchema.optional(),
  verdict: WorkflowWordSchema.optional(),
  reason: z.string().max(WORKFLOW_REASON_MAX_CHARS).optional(),
  /** An agent step's resolved prompt, a run step's command, an approve step's title. */
  prompt: z.string().max(WORKFLOW_PROMPT_MAX_CHARS).optional(),
  report: z.string().max(SUBAGENT_REPORT_MAX_CHARS).optional(),
  tokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type WorkflowStepDetail = z.infer<typeof WorkflowStepDetailSchema>;

export const WorkflowStepResultSchema = z.object({
  /**
   * ABSENT means "not available": the step never ran, or its entry left the
   * retained log (compaction, a `serve` reload). The UI says so; it never
   * substitutes another step's text.
   */
  detail: WorkflowStepDetailSchema.optional(),
});
export type WorkflowStepResult = z.infer<typeof WorkflowStepResultSchema>;

/**
 * The emitter's own guard: the `usage` fields its schema ACCEPTS, from a body
 * that may carry anything (a provider's raw JSON), or `null` when nothing
 * measurable is left.
 *
 * A malformed KNOWN entry is fatal to a reader — it refuses the whole file
 * (`session-log-file.ts`) — so a single unexpected number from a server would
 * poison that session's log for good (docs/feat/token-usage-log.md, fix round
 * 1). Providers guard their own numbers (`core`'s `tokenCount`); this is the
 * second net, at the ONE place an entry is built, and it judges with the schema
 * itself so there is no second copy of the rules. A field it refuses is
 * dropped, never replaced by a 0 (an unmeasured value stays absent).
 */
export function sanitizeUsageBody(body: Readonly<Record<string, unknown>>): UsageEntryBody | null {
  const shape = LogUsageEntrySchema.shape as unknown as Readonly<Record<string, ZodTypeAny>>;
  const envelope = new Set(Object.keys(envelopeShape()));
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    // The envelope is the emitter's: a body never sets it, and a stray
    // `critical: true` must not survive the spread below.
    if (envelope.has(key)) {
      continue;
    }
    const value = body[key];
    if (value !== undefined && field.safeParse(value).success) {
      kept[key] = value;
    }
  }
  // The two counts ARE the row: without both there is nothing to record (never a 0/0 row).
  if (typeof kept.promptTokens !== "number" || typeof kept.completionTokens !== "number") {
    return null;
  }
  return kept as UsageEntryBody;
}

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
  LogCapabilitiesEntrySchema,
  LogUsageEntrySchema,
  LogWorkflowStartEntrySchema,
  LogWorkflowStepEntrySchema,
  LogWorkflowEndEntrySchema,
  LogUnitEndEntrySchema,
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
  usage: false,
  capabilities: false,
  // docs/feat/agent-workflows.md owner Q1: terminal facts only, they project nothing.
  workflow_start: false,
  workflow_step: false,
  workflow_end: false,
  // docs/feat/a2a.md: a carried ended unit; it projects nothing.
  unit_end: false,
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
export type AppendableMessage = Readonly<
  Omit<WireChatMessage, "attachments" | "toolCalls" | "media">
> & {
  readonly media?: ReadonlyArray<Readonly<NonNullable<WireChatMessage["media"]>[number]>>;
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
export type DigestibleMessage = Readonly<
  Omit<WireChatMessage, "toolCalls" | "attachments" | "media">
> & {
  /** Display only, never hashed (like `note`): core's readonly array is accepted. */
  readonly media?: ReadonlyArray<Readonly<NonNullable<WireChatMessage["media"]>[number]>>;
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

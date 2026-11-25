/**
 * Wire schemas for the model reverse-tunnel (F4.d).
 *
 * When the agent runs in a pod but the model endpoint is only reachable from the
 * laptop, the pod daemon tunnels each model call back to the client over the
 * existing RPC channel: a `model/stream` request carries a `ChatRequest`, and
 * the client replies with the collected `StreamEvent`s (non-streaming first cut;
 * token-by-token streaming over the tunnel is a later slice). These schemas
 * mirror the core model types (minus the non-serialisable `AbortSignal`).
 */
import { z } from "zod";
import { AttachmentsSchema } from "./attachment.ts";

export const ModelToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

// --- the model's own reasoning (docs/fix/reasoning-echo.md D1/D8) -----------
// Mirrors core's `ReasoningRecord`. Defined HERE (not in session.ts) because
// both the pod model wire below and `chatMessageShape` (session.ts, which
// imports this file) carry it. The bounds guard against malformed or hostile
// input; they are NOT a cap (owner Q3 A): every carrier wraps the record
// FAIL-SOFT (`.optional().catch(undefined)`), so a value over a bound is
// dropped WHOLE — never cut — and the critical `message` entry still loads.

/** Bound on one reasoning text / redacted blob / signature (chars). */
export const REASONING_TEXT_MAX = 1024 * 1024;
/** Bound on the reasoning blocks of one Anthropic message. */
export const REASONING_BLOCKS_MAX = 64;

/** One Anthropic reasoning block, verbatim. A `thinking` block is stored only when signed. */
export const AnthropicReasoningBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thinking"),
    // `display: "omitted"` sends an EMPTY thinking with its signature: kept.
    thinking: z.string().max(REASONING_TEXT_MAX),
    signature: z.string().min(1).max(REASONING_TEXT_MAX),
  }),
  z.object({
    type: z.literal("redacted_thinking"),
    data: z.string().min(1).max(REASONING_TEXT_MAX),
  }),
]);

/** A reasoning record's body, in its provider's own format. */
export const ReasoningBodySchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("openai"),
    /** The field the text arrived in, sent back in the same one. */
    field: z.enum(["reasoning_content", "reasoning"]),
    text: z.string().min(1).max(REASONING_TEXT_MAX),
  }),
  z.object({
    format: z.literal("anthropic"),
    blocks: z.array(AnthropicReasoningBlockSchema).min(1).max(REASONING_BLOCKS_MAX),
  }),
]);

/** An assistant message's reasoning; `source` is the producing provider's id (D5). */
export const ReasoningRecordSchema = z.object({
  source: z.string().min(1).max(256),
  body: ReasoningBodySchema,
});
export type WireReasoningRecord = z.infer<typeof ReasoningRecordSchema>;

export const WireChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(ModelToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  /** User messages only; refs, never bytes (docs/feat/attachments-core.md). */
  attachments: AttachmentsSchema.optional(),
  /**
   * Assistant messages only: the model's own reasoning, for the laptop's
   * provider to echo (docs/fix/reasoning-echo.md P3). Optional and FAIL-SOFT:
   * an older laptop strips it, a malformed one is dropped — no echo, never a
   * failed turn (AGENTS §7: additive, no `protocol.d` note).
   */
  reasoning: ReasoningRecordSchema.optional().catch(undefined),
});

export const WireToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.unknown(),
});

export const WireChatRequestSchema = z.object({
  messages: z.array(WireChatMessageSchema),
  tools: z.array(WireToolDefinitionSchema).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  /**
   * The requesting turn is a voice turn with reasoning off
   * (docs/feat/voice-conversation.md §4, C3): a pod (`run`/`attach`) runs the
   * agent loop but the model call comes back HERE, so the daemon's wish not to
   * reason must ride the wire. Optional: an older laptop drops it (the turn
   * reasons as configured — a slower reply, never a failed one), an older pod
   * never sends it (AGENTS §7: additive, no `protocol.d` note).
   */
  reasoning: z.literal("off").optional(),
});
export type WireChatRequest = z.infer<typeof WireChatRequestSchema>;

export const WireUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});

/**
 * Why a streamed reply ended, as the LAPTOP's provider saw it
 * (docs/fix/truncated-reply-silent.md). Mirrors core's `ModelStopReason`, which
 * cannot be imported here (protocol must not depend on core). Optional: an
 * older laptop leaves it out, and the pod's loop then behaves exactly as it did
 * before — an absent value is `undefined`, never a failed turn (AGENTS §7:
 * adding an optional field is free, so `PROTOCOL_VERSION` does not bump).
 *
 * It must be ON THE WIRE: the pod-side agent runs the loop and decides from this
 * fact alone, so stripping it made `run`/`attach` accept a cut reply as
 * complete (Review HIGH-1).
 */
export const WireStopReasonSchema = z.enum(["stop", "length", "tool_calls", "other"]);

export const WireStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("reasoning"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), toolCall: ModelToolCallSchema }),
  z.object({
    type: z.literal("done"),
    usage: WireUsageSchema.optional(),
    stopReason: WireStopReasonSchema.optional(),
    /**
     * The laptop provider's reasoning record for this reply, for the POD's
     * loop to store (docs/fix/reasoning-echo.md D2/P3). Optional and FAIL-SOFT,
     * like the request's field: dropped means no echo, never a failed turn.
     */
    reasoning: ReasoningRecordSchema.optional().catch(undefined),
  }),
]);
export type WireStreamEvent = z.infer<typeof WireStreamEventSchema>;

/**
 * What a tunnelled model call is for. Absent: an agent turn (the main model).
 * `"title"`: the session's title (docs/feat/session-titles.md) — the LAPTOP
 * picks the model that serves it (`model.titleModel`, else the main one) and
 * refuses it when its `model.autoTitle` is off. A title call names no model.
 * A new value is breaking for an older laptop (refused at parse, loudly).
 */
export const ModelPurposeSchema = z.enum(["title"]);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

/**
 * A `models` name on the tunnel (docs/feat/models-map-pod.md): never a model
 * id, an endpoint or a key. The shape the config gives a name (`MODEL_NAME`).
 */
export const ModelNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `model/stream` request: the daemon asks the client to run a model turn. */
export const ModelStreamParamsSchema = z.object({
  request: WireChatRequestSchema,
  purpose: ModelPurposeSchema.optional(),
  /**
   * Absent → the laptop's main model (no name means it). A name the laptop did
   * not publish itself is refused there. Exclusive with `purpose`.
   */
  model: ModelNameSchema.optional(),
});
export type ModelStreamParams = z.infer<typeof ModelStreamParamsSchema>;

/** The collected events of that turn (first cut: delivered as one batch). */
export const ModelStreamResultSchema = z.object({ events: z.array(WireStreamEventSchema) });
export type ModelStreamResult = z.infer<typeof ModelStreamResultSchema>;

// --- model/streamChunked (streaming cut) ---------------------------------
//
// The same turn, streamed: the daemon sends one `model/streamChunked` request,
// the client forwards each local-provider event as a `$/progress`
// notification tied to the request id, and the response carries only a count.
// The event payloads cross as `$/progress`, so the result never re-sends them.
// All three schemas below are NEW (additive); `model/stream` is untouched, so
// an old peer never parses them and a new peer ignores an old peer's lack of
// them (MethodNotFound → the daemon falls back to `model/stream`).

/**
 * `model/streamChunked`'s `$/progress` value: a non-empty BATCH of wire events,
 * in order (the laptop coalesces a burst into one frame). Validated by the
 * daemon's model tunnel — the generic `$/progress` envelope does not know it.
 */
export const ModelStreamProgressValueSchema = z.array(WireStreamEventSchema).min(1);
export type ModelStreamProgressValue = z.infer<typeof ModelStreamProgressValueSchema>;

/** `model/streamChunked` request: the same shape as `model/stream`. */
export const ModelStreamChunkedParamsSchema = z.object({
  request: WireChatRequestSchema,
  purpose: ModelPurposeSchema.optional(),
  /** As on `model/stream`. */
  model: ModelNameSchema.optional(),
});
export type ModelStreamChunkedParams = z.infer<typeof ModelStreamChunkedParamsSchema>;

/**
 * `model/streamChunked` result: `chunks` is the exact number of `$/progress`
 * FRAMES sent for this request (not events: a frame carries a batch). The
 * daemon verifies it against the frames it received — a mismatch is a loud
 * error, never a silent truncation. No `usage`: it rides the in-stream `done`
 * event (a redundant field would be permanent once shipped).
 */
export const ModelStreamChunkedResultSchema = z.object({ chunks: z.number().int().nonnegative() });
export type ModelStreamChunkedResult = z.infer<typeof ModelStreamChunkedResultSchema>;

// --- model/countTokens (docs/feat/tui-target-badge.md) ---------------------
// The daemon asks the client's LOCAL provider how many tokens a request's
// prompt is, without generating (Anthropic `count_tokens`, llama.cpp
// `/tokenize`). The pod reaches the model only through the laptop; the answer
// is one number. Additive: an older client answers `MethodNotFound`, a
// provider that cannot count omits `tokens` — the daemon estimates.

export const ModelCountTokensParamsSchema = z.object({ request: WireChatRequestSchema });
export type ModelCountTokensParams = z.infer<typeof ModelCountTokensParamsSchema>;

export const ModelCountTokensResultSchema = z.object({
  /** Absent: this provider cannot count (an optional field is omitted, never null). */
  tokens: z.number().int().nonnegative().optional(),
});
export type ModelCountTokensResult = z.infer<typeof ModelCountTokensResultSchema>;

// --- $/progress / $/cancelRequest (generic peer primitives) ---------------
//
// Two generic, method-agnostic notifications the peer understands: a responder
// streams partial values tied to an in-flight REQUEST id ($/progress), and a
// caller cancels one ($/cancelRequest). They are the reusable base that the
// model tunnel, tool-result flow control, and remote tool calls build on.

/**
 * `$/progress` params: one partial value for an in-flight request, in `seq`
 * order. GENERIC: the envelope checks only `id` + `seq`; each method that
 * streams validates its own `value` shape (e.g. `ModelStreamProgressValueSchema`),
 * so new streaming methods reuse this notification without a schema change.
 */
export const ProgressParamsSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  value: z.unknown(),
});
export type ProgressParams = z.infer<typeof ProgressParamsSchema>;

/** `$/cancelRequest` params: cancel one in-flight request by its id. */
export const CancelRequestParamsSchema = z.object({ id: z.string().min(1) });
export type CancelRequestParams = z.infer<typeof CancelRequestParamsSchema>;

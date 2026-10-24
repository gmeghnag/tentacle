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

export const ModelToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const WireChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(ModelToolCallSchema).optional(),
  toolCallId: z.string().optional(),
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
});
export type WireChatRequest = z.infer<typeof WireChatRequestSchema>;

export const WireUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});

export const WireStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("reasoning"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), toolCall: ModelToolCallSchema }),
  z.object({ type: z.literal("done"), usage: WireUsageSchema.optional() }),
]);
export type WireStreamEvent = z.infer<typeof WireStreamEventSchema>;

/**
 * What a tunnelled model call is for. Absent: an agent turn (the main model).
 * `"title"`: the session's title (docs/feat/session-titles.md) — the LAPTOP
 * picks the model that serves it (`model.titleModel`, else the main one) and
 * refuses it when its `model.autoTitle` is off. The pod never names a model.
 * A new value is breaking for an older laptop (refused at parse, loudly).
 */
export const ModelPurposeSchema = z.enum(["title"]);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

/** `model/stream` request: the daemon asks the client to run a model turn. */
export const ModelStreamParamsSchema = z.object({
  request: WireChatRequestSchema,
  purpose: ModelPurposeSchema.optional(),
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

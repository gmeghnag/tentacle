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

/** `model/stream` request: the daemon asks the client to run a model turn. */
export const ModelStreamParamsSchema = z.object({ request: WireChatRequestSchema }).strict();
export type ModelStreamParams = z.infer<typeof ModelStreamParamsSchema>;

/** The collected events of that turn (first cut: delivered as one batch). */
export const ModelStreamResultSchema = z
  .object({ events: z.array(WireStreamEventSchema) })
  .strict();
export type ModelStreamResult = z.infer<typeof ModelStreamResultSchema>;

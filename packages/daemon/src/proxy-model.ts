/**
 * A `ModelProvider` that tunnels each model call to the connected client over
 * the RPC channel (the pod reverse-tunnel, F4.d). The daemon runs the agent
 * loop locally but asks the client — the laptop — to actually reach the model,
 * so the model endpoint and API key never leave the laptop. First cut: the
 * client returns the whole turn's events in one batch (no token streaming over
 * the tunnel yet).
 */
import type { ChatRequest, ModelProvider, StreamEvent } from "@agent-harness/core";
import type { ModelStreamResult, WireChatRequest } from "@agent-harness/protocol";

/** Sends a `model/stream` request to the client and resolves with its events. */
export type ModelStreamSender = (request: WireChatRequest) => Promise<ModelStreamResult>;

function toWireRequest(request: ChatRequest): WireChatRequest {
  return {
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            toolCalls: m.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          }
        : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
  };
}

export class ProxyModelProvider implements ModelProvider {
  readonly id = "proxy";

  constructor(private readonly send: ModelStreamSender) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const { events } = await this.send(toWireRequest(request));
    for (const event of events) {
      yield event as StreamEvent;
    }
  }
}

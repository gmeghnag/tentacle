/**
 * Model provider contract.
 *
 * Concrete adapters each target one wire format and normalise its streaming
 * and tool-calling quirks behind this single interface: the OpenAI-compatible
 * `/v1/chat/completions` endpoint (local llama.cpp / vLLM / cloud) and the
 * native Anthropic Messages API (`/v1/messages`). See ADR-003.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool advertised to the model (parameters are JSON Schema, derived from Zod). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** A tool invocation emitted by the model. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON arguments string exactly as produced by the model. */
  readonly arguments: string;
}

export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
  /** Present on assistant messages that call tools. */
  readonly toolCalls?: readonly ToolCall[];
  /** Present on `role: "tool"` messages, linking a result to its call. */
  readonly toolCallId?: string;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** A single event in the model's streamed response. */
export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "tool_call"; readonly toolCall: ToolCall }
  | { readonly type: "done"; readonly usage?: Usage };

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  /** Stable identifier for logging / routing. */
  readonly id: string;
  /** Stream a completion as a sequence of events, ending with a `done` event. */
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}

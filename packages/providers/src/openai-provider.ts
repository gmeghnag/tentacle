/**
 * OpenAI-compatible model provider.
 *
 * Implements `ModelProvider` against any `/v1/chat/completions` endpoint
 * (local llama.cpp / vLLM / cloud). Streams via `fetch` + SSE and normalises
 * quirks behind the core `StreamEvent` contract:
 *   - visible text              → `text`
 *   - reasoning (`reasoning_content` or `reasoning`) → `reasoning`
 *   - incrementally-streamed tool calls, reassembled per index → `tool_call`
 *   - usage (when the server reports it)             → `done`
 */
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@tentacle/core";
import { parseSSE } from "./sse.ts";

export interface OpenAIProviderConfig {
  /** Base URL including the API version, e.g. `http://host:8080/v1`. */
  readonly baseURL: string;
  /** Model id passed to the endpoint. */
  readonly model: string;
  readonly apiKey?: string;
  /** `max_tokens` when the request sets none; unset → omitted (server default). */
  readonly maxTokens?: number;
  /** Overrides the derived `id`. */
  readonly id?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Thrown when the endpoint returns a non-2xx response. */
export class ModelRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** An actionable next step (e.g. which config key to set), appended to the message. */
    readonly hint?: string,
    /** The server's `retry-after` (ms), when it sent a usable one. */
    readonly retryAfterMs?: number,
  ) {
    super(
      `model request failed with status ${status}: ${body.slice(0, 200)}${hint ? ` — ${hint}` : ""}`,
    );
    this.name = "ModelRequestError";
  }
}

/** A `retry-after` header (delta-seconds or HTTP-date) in ms; `undefined` if absent or unusable. */
export function parseRetryAfter(
  headers: { get(name: string): string | null },
  now: number = Date.now(),
): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) {
    return undefined;
  }
  // An HTTP-date always names a weekday/month; this keeps "-3" from parsing as a year.
  const ms = /^\d+(\.\d+)?$/.test(raw)
    ? Number(raw) * 1000
    : /[a-z]/i.test(raw)
      ? Date.parse(raw) - now
      : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
}

interface WireToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface WireChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly reasoning?: string | null;
      readonly tool_calls?: ReadonlyArray<WireToolCallDelta>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number } | null;
}

/** Reassembles tool calls streamed incrementally across chunks, keyed by index. */
class ToolCallAssembler {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: ReadonlyArray<WireToolCallDelta>): void {
    for (const d of deltas) {
      const cur = this.calls.get(d.index) ?? { id: "", name: "", args: "" };
      if (d.id) {
        cur.id = d.id;
      }
      if (d.function?.name) {
        cur.name += d.function.name;
      }
      if (d.function?.arguments) {
        cur.args += d.function.arguments;
      }
      this.calls.set(d.index, cur);
    }
  }

  drain(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const c of this.calls.values()) {
      out.push({ id: c.id || crypto.randomUUID(), name: c.name, arguments: c.args });
    }
    this.calls.clear();
    return out;
  }

  get size(): number {
    return this.calls.size;
  }
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly config: OpenAIProviderConfig;
  private readonly doFetch: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.id = config.id ?? `openai:${config.model}`;
    this.doFetch = config.fetch ?? fetch;
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(this.config.model, request, this.config.maxTokens)),
    };
    if (request.signal) {
      init.signal = request.signal;
    }

    const res = await this.doFetch(`${this.config.baseURL}/chat/completions`, init);
    if (!res.ok || !res.body) {
      throw new ModelRequestError(
        res.status,
        await safeText(res),
        undefined,
        parseRetryAfter(res.headers),
      );
    }

    const tools = new ToolCallAssembler();
    let usage: Usage | undefined;

    for await (const data of parseSSE(res.body, request.signal)) {
      if (data === "[DONE]" || data.length === 0) {
        if (data === "[DONE]") {
          break;
        }
        continue;
      }

      const chunk = parseChunk(data);
      if (!chunk) {
        continue;
      }

      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "text", delta: delta.content };
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        yield { type: "reasoning", delta: reasoning };
      }
      if (delta?.tool_calls) {
        tools.add(delta.tool_calls);
      }
      if (choice.finish_reason) {
        for (const call of tools.drain()) {
          yield { type: "tool_call", toolCall: call };
        }
      }
    }

    // Flush tool calls if the stream ended without a finish_reason.
    if (tools.size > 0) {
      for (const call of tools.drain()) {
        yield { type: "tool_call", toolCall: call };
      }
    }

    yield usage ? { type: "done", usage } : { type: "done" };
  }
}

function buildPayload(
  model: string,
  req: ChatRequest,
  defaultMaxTokens?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: req.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map(toWireTool);
  }
  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  const maxTokens = req.maxTokens ?? defaultMaxTokens;
  if (maxTokens !== undefined) {
    payload.max_tokens = maxTokens;
  }
  return payload;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (message.toolCallId) {
    wire.tool_call_id = message.toolCallId;
  }
  return wire;
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function parseChunk(data: string): WireChunk | null {
  try {
    return JSON.parse(data) as WireChunk;
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

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
 *   - `finish_reason` (`stop`/`length`/`tool_calls`) → `done.stopReason`
 */
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  ModelStopReason,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "@tentacle/core";
import { DsmlToolCallLeakError, hasDsmlToolCallMarkup, wireArguments } from "@tentacle/core";
import {
  type ImageBuildOptions,
  MAX_INLINE_IMAGES,
  NO_IMAGES,
  OPENAI_MAX_IMAGE_BYTES,
  effectiveMaxImageBytes,
  resolveImages,
  selectInlineIds,
  strayRefsText,
  userParts,
} from "./images.ts";
import { parseSSE } from "./sse.ts";
import { ToolCallAssembler, type WireToolCallDelta } from "./tool-call-stream.ts";
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
  /**
   * Whether this model takes images at all (docs/feat/attachments-core.md, Q5).
   * Default FALSE: an OpenAI-COMPATIBLE endpoint here is usually a local
   * llama.cpp/vLLM server whose model may not be multimodal, and sending an
   * unknown model an image block is a 400. `model.images: true` opts in.
   */
  readonly images?: boolean;
  /**
   * The most raw bytes ONE image may have on this endpoint. Defaults to
   * `OPENAI_MAX_IMAGE_BYTES`, deliberately conservative: the model behind an
   * OpenAI-compatible URL is unknown (a local llama.cpp may take less than any
   * documented cloud cap). An image over it is never read or sent.
   */
  readonly maxImageBytes?: number;
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

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly config: OpenAIProviderConfig;
  private readonly doFetch: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.id = config.id ?? `openai:${config.model}`;
    this.doFetch = config.fetch ?? fetch;
  }

  /**
   * The exact prompt size on a llama.cpp server, without generating: the chat
   * is rendered by the model's own template (`POST /apply-template`) and the
   * resulting prompt tokenized (`POST /tokenize`), both at the server ROOT
   * (`baseURL` minus its `/v1`). Any other OpenAI-compatible server lacks them
   * (404) → `undefined`, and the caller estimates.
   */
  async countTokens(request: ChatRequest): Promise<number | undefined> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const root = this.config.baseURL.replace(/\/v1\/?$/, "");
    const post = async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
      const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
      if (request.signal) {
        init.signal = request.signal;
      }
      const res = await this.doFetch(`${root}${path}`, init);
      if (!res.ok) {
        return null;
      }
      return (await res.json().catch(() => null)) as Record<string, unknown> | null;
    };
    const payload = buildPayload(
      this.config.model,
      request,
      undefined,
      await this.imageOptions(request),
    );
    const templated = await post("/apply-template", {
      messages: payload.messages,
      ...(payload.tools ? { tools: payload.tools } : {}),
    });
    const prompt = templated?.prompt;
    if (typeof prompt !== "string") {
      return undefined;
    }
    // The template already carries its special tokens (BOS…): add none.
    const tokenized = await post("/tokenize", { content: prompt, add_special: false });
    const tokens = tokenized?.tokens;
    return Array.isArray(tokens) ? tokens.length : undefined;
  }

  /**
   * What this request may inline. `images: false` (the default) reads NOTHING:
   * a model with no vision must not cost a byte read, and its placeholders say
   * why no image was sent.
   */
  private async imageOptions(request: ChatRequest): Promise<ImageBuildOptions> {
    const vision = this.config.images ?? false;
    const inlined = selectInlineIds(request.messages);
    const maxImageBytes = effectiveMaxImageBytes(
      this.config.maxImageBytes ?? OPENAI_MAX_IMAGE_BYTES,
    );
    return vision
      ? {
          images: await resolveImages(request, MAX_INLINE_IMAGES, maxImageBytes),
          vision,
          inlined,
          maxImageBytes,
        }
      : { images: new Map(), vision, inlined, maxImageBytes };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildPayload(
          this.config.model,
          request,
          this.config.maxTokens,
          await this.imageOptions(request),
        ),
      ),
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
    /** The visible text, accumulated only to check it for leaked DSML markup. */
    let answer = "";
    let sawToolCall = false;
    /**
     * The last `finish_reason` the server sent, normalised. Absent from the
     * body's end means the stream was CUT, not finished (docs/fix/
     * truncated-reply-silent.md): the caller must not present it as an answer.
     */
    let finishReason: ModelStopReason | undefined;

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
        if (!sawToolCall) {
          // Kept only to check for leaked DSML markup at the end of the reply.
          answer += delta.content;
        }
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
        finishReason = normalizeFinishReason(choice.finish_reason);
        for (const call of tools.drain()) {
          sawToolCall = true;
          yield { type: "tool_call", toolCall: call };
        }
      }
    }

    // Flush tool calls if the stream ended without a finish_reason.
    if (tools.size > 0) {
      for (const call of tools.drain()) {
        sawToolCall = true;
        yield { type: "tool_call", toolCall: call };
      }
    }

    // A reply that is a DSML tool call in TEXT form is not an answer: the tool
    // never ran, so accepting it ends the turn as if the work were done. The
    // check runs only when the server streamed no real call — a mixed reply
    // (text quoting markup AND a real call) is a genuine answer.
    if (!sawToolCall && hasDsmlToolCallMarkup(answer)) {
      throw new DsmlToolCallLeakError(new TextEncoder().encode(answer).length);
    }

    // No `finish_reason` at all: the body ended mid-reply (`parseSSE` returns
    // quietly on EOF, `sse.ts`), which is missing data, not an answer — report
    // it as "other" rather than letting it look like a finished one.
    yield doneEvent(usage, finishReason ?? "other");
  }
}

/**
 * The wire's `finish_reason` as the shared vocabulary. Anything unknown (a
 * gateway's own value) is `"stop"`: it named a reason, so the body was not
 * cut, and only `length`/`other` change what the loop does.
 */
function normalizeFinishReason(reason: string): ModelStopReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** `done` with its optional fields only when they were measured. */
function doneEvent(usage: Usage | undefined, stopReason: ModelStopReason): StreamEvent {
  return usage ? { type: "done", usage, stopReason } : { type: "done", stopReason };
}

function buildPayload(
  model: string,
  req: ChatRequest,
  defaultMaxTokens?: number,
  options: ImageBuildOptions = NO_IMAGES,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: req.messages.map((m) => toWireMessage(m, options)),
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

function toWireMessage(
  message: ChatMessage,
  options: ImageBuildOptions = NO_IMAGES,
): Record<string, unknown> {
  // A user message with refs: images first, then its text (docs/feat/attachments-core.md,
  // D10). `image_url` wants a data URL; an image-only prompt keeps its message.
  if (message.role === "user" && (message.attachments?.length ?? 0) > 0) {
    const parts = userParts(message, options);
    const wire: Record<string, unknown> = {
      role: "user",
      content: parts.map((part) =>
        part.kind === "image"
          ? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.base64}` } }
          : { type: "text", text: part.text },
      ),
    };
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire.tool_calls = message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: wireArguments(tc.arguments) },
      }));
    }
    return wire;
  }
  const stray = strayRefsText(message, options);
  const wire: Record<string, unknown> = {
    role: message.role,
    content: `${message.content}${stray}`,
  };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: wireArguments(tc.arguments) },
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

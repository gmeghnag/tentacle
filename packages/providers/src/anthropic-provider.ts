/**
 * Anthropic Messages API provider.
 *
 * Implements `ModelProvider` against `POST {baseURL}/messages` and normalises
 * the Messages wire format behind the core `StreamEvent` contract, mirroring
 * `openai-provider.ts`:
 *   - `text_delta`            → `text`
 *   - `thinking_delta`        → `reasoning`
 *   - `tool_use` blocks (id/name from `content_block_start`, `input` JSON
 *     accumulated from `input_json_delta`) → one `tool_call` per block, emitted
 *     once the message completes — never for a call cut short (`max_tokens`,
 *     `refusal`, or a stream that ends mid-block): those throw instead
 *   - `message_start`/`message_delta` usage → `done`
 *
 * Request mapping is the reverse: the top-level `system` field, `tool_use`
 * content blocks on assistant turns, and `tool_result` user messages for tool
 * results.
 */
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  ModelStopReason,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@tentacle/core";
import { wireArguments } from "@tentacle/core";
import {
  type ImageBuildOptions,
  MAX_INLINE_IMAGES,
  NO_IMAGES,
  imageLimits,
  resolveImages,
  selectInlineIds,
  strayRefsText,
  userParts,
} from "./images.ts";
import { ModelRequestError, parseRetryAfter } from "./openai-provider.ts";
import { parseSSE } from "./sse.ts";

/** Default Messages API version header (overridable for gateways). */
export const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
/**
 * `max_tokens` is required by the API; the default when the request omits it.
 * Requests always stream, so this can be generous: a low cap truncates large
 * tool inputs (a whole-file write) mid-JSON.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 64000;
/** Stop reasons that mean a `tool_use` in the message may be partial. */
const TRUNCATING_STOP_REASONS = new Set(["max_tokens", "refusal"]);

export interface AnthropicProviderConfig {
  /** Base URL including the API version, e.g. `https://api.anthropic.com/v1`. */
  readonly baseURL: string;
  /** Model id passed to the endpoint. */
  readonly model: string;
  readonly apiKey?: string;
  /** `max_tokens` when the request sets none. Defaults to `ANTHROPIC_DEFAULT_MAX_TOKENS`. */
  readonly maxTokens?: number;
  /** `anthropic-version` header. Defaults to `ANTHROPIC_DEFAULT_VERSION`. */
  readonly anthropicVersion?: string;
  /** Overrides the derived `id`. */
  readonly id?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Whether this model takes images at all (docs/feat/attachments-core.md, Q5).
   * Default TRUE (every current Claude model does). When false, an image ref is
   * never read and the model sees a text placeholder instead.
   */
  readonly images?: boolean;
  /**
   * The most raw bytes ONE image may have on this model's wire. Defaults to
   * `ANTHROPIC_MAX_IMAGE_BYTES` (5 MB of base64, the documented cap). An image
   * over it is never read and never sent — a placeholder naming the limit takes
   * its place, so it can never become a 400 on every later turn of the session.
   */
  readonly maxImageBytes?: number;
}

/** A content block while streaming: text/thinking accumulate, tool_use buffers JSON. */
interface OpenBlock {
  readonly type: string;
  /** tool_use only: the block id from `content_block_start`. */
  readonly id: string;
  /** tool_use only: the tool name from `content_block_start`. */
  readonly name: string;
  /** tool_use only: accumulated `input_json_delta` partials. */
  args: string;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly config: AnthropicProviderConfig;
  private readonly doFetch: typeof fetch;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.id = config.id ?? `anthropic:${config.model}`;
    this.doFetch = config.fetch ?? fetch;
  }

  /**
   * The exact prompt size via `POST /messages/count_tokens` — no generation, no
   * charge. `undefined` on any non-2xx or unexpected shape (the caller falls
   * back to an estimate); a transport failure rejects (same fallback).
   */
  async countTokens(request: ChatRequest): Promise<number | undefined> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.config.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION,
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    // The stream payload minus what only generation uses.
    const options = await this.imageOptions(request);
    const {
      max_tokens: _m,
      stream: _s,
      temperature: _t,
      ...body
    } = buildPayload(this.config.model, request, this.config.maxTokens, options);
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
    if (request.signal) {
      init.signal = request.signal;
    }
    const res = await this.doFetch(`${this.config.baseURL}/messages/count_tokens`, init);
    if (!res.ok) {
      return undefined;
    }
    const json = (await res.json().catch(() => null)) as { input_tokens?: unknown } | null;
    const n = json?.input_tokens;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  /**
   * What this request may inline. `images: false` reads NOTHING (a model with
   * no vision must not cost a byte read); the refs still reach the model as
   * text placeholders.
   */
  private async imageOptions(request: ChatRequest): Promise<ImageBuildOptions> {
    const { vision, maxBytes: maxImageBytes } = imageLimits("anthropic", this.config);
    const inlined = selectInlineIds(request.messages);
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
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.config.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION,
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
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

    const res = await this.doFetch(`${this.config.baseURL}/messages`, init);
    if (!res.ok || !res.body) {
      const body = await safeText(res);
      throw new ModelRequestError(
        res.status,
        body,
        anthropicErrorHint(res.status, body),
        parseRetryAfter(res.headers),
      );
    }

    const blocks = new Map<number, OpenBlock>();
    // Completed tool calls are held until the message's stop reason is known:
    // a call cut by `max_tokens` must never reach the agent loop as if whole.
    const toolCalls: StreamEvent[] = [];
    let stopReason: string | undefined;
    let usage: Usage | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    for await (const data of parseSSE(res.body, request.signal)) {
      if (data.length === 0) {
        continue;
      }
      const event = parseEvent(data);
      if (!event) {
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const start = event.message?.usage;
          // With prompt caching `input_tokens` is only the uncached tail: the
          // prompt's size adds what was written to and read from the cache
          // (docs/feat/context-awareness.md; it feeds the context count).
          if (start?.input_tokens !== undefined) {
            promptTokens =
              start.input_tokens +
              (start.cache_creation_input_tokens ?? 0) +
              (start.cache_read_input_tokens ?? 0);
          }
          break;
        }
        case "content_block_start":
        case "content_block_delta":
        case "content_block_stop": {
          // Content-block events always carry a block index; skip a malformed one.
          if (event.index === undefined) {
            continue;
          }
          const index = event.index;
          if (event.type === "content_block_start") {
            const block = event.content_block;
            blocks.set(index, {
              type: block?.type ?? "",
              id: block?.id ?? "",
              name: block?.name ?? "",
              args: "",
            });
          } else if (event.type === "content_block_delta") {
            const block = blocks.get(index);
            const delta = event.delta;
            if (!block || !delta) {
              continue;
            }
            switch (delta.type) {
              case "text_delta":
                if (delta.text) {
                  yield { type: "text", delta: delta.text };
                }
                break;
              case "thinking_delta":
                if (delta.thinking) {
                  yield { type: "reasoning", delta: delta.thinking };
                }
                break;
              case "input_json_delta":
                if (delta.partial_json) {
                  block.args += delta.partial_json;
                }
                break;
              // `signature_delta` (thinking integrity) is not surfaced to the harness.
              default:
                break;
            }
          } else {
            const block = blocks.get(index);
            blocks.delete(index);
            if (block?.type === "tool_use") {
              toolCalls.push(toolCallEvent(block));
            }
          }
          break;
        }
        case "message_delta": {
          const delta = event.usage;
          if (delta?.output_tokens !== undefined) {
            completionTokens = delta.output_tokens;
          }
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          break;
        }
        case "message_stop":
          break;
        // In-band errors arrive as `type: "error"`, the kind in `error.type`.
        case "error":
          throw new ModelRequestError(0, JSON.stringify(event.error ?? event).slice(0, 200));
        default:
          break;
      }
    }

    // A tool_use block still open at end-of-stream (no `content_block_stop`)
    // holds truncated JSON. Emitting it would put an invalid call into the
    // history (docs/eval/sse-abort-truncated-toolcall.md), so fail loud.
    for (const block of blocks.values()) {
      if (block.type === "tool_use") {
        throw new ModelRequestError(
          0,
          `stream ended inside a tool_use block (${block.name}); the partial call was not run`,
        );
      }
    }
    if (
      toolCalls.length > 0 &&
      stopReason !== undefined &&
      TRUNCATING_STOP_REASONS.has(stopReason)
    ) {
      const cap =
        stopReason === "max_tokens"
          ? ` (max_tokens=${payloadMaxTokens(request, this.config.maxTokens)})`
          : "";
      throw new ModelRequestError(
        0,
        `response stopped on ${stopReason} while emitting a tool call; the call was not run${cap}`,
      );
    }
    for (const call of toolCalls) {
      yield call;
    }

    if (promptTokens !== undefined || completionTokens !== undefined) {
      usage = {
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
      };
    }
    // A cut TEXT reply is reported, not refused here (the call refusal above is
    // the provider's own, because a partial call must never enter the history):
    // the agent loop re-asks once and shows the notice
    // (docs/fix/truncated-reply-silent.md). No `stop_reason` at all means the
    // body was cut mid-stream, which the loop fails the turn on.
    yield doneEvent(usage, stopReason === undefined ? "other" : normalizeStopReason(stopReason));
  }
}

/**
 * Anthropic's `stop_reason` in the shared vocabulary: `max_tokens`/`refusal`
 * CUT the reply (`TRUNCATING_STOP_REASONS`), `tool_use` asked for tools, and
 * everything else (`end_turn`, `stop_sequence`, …) finished on its own.
 */
function normalizeStopReason(reason: string): ModelStopReason {
  if (TRUNCATING_STOP_REASONS.has(reason)) {
    return "length";
  }
  return reason === "tool_use" ? "tool_calls" : "stop";
}

/** `done` with its optional fields only when they were measured. */
function doneEvent(usage: Usage | undefined, stopReason: ModelStopReason): StreamEvent {
  return usage ? { type: "done", usage, stopReason } : { type: "done", stopReason };
}

/** A complete `tool_call` event from an accumulated (or flushed) tool_use block. */
function toolCallEvent(block: OpenBlock): StreamEvent {
  return {
    type: "tool_call",
    toolCall: {
      id: block.id || crypto.randomUUID(),
      name: block.name,
      arguments: block.args.trim() === "" ? "{}" : block.args,
    },
  };
}

interface AnthropicEvent {
  readonly type: string;
  readonly index?: number;
  readonly message?: {
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_creation_input_tokens?: number;
      readonly cache_read_input_tokens?: number;
    };
  };
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
  };
  readonly delta?: {
    readonly type?: string;
    readonly stop_reason?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly partial_json?: string;
  };
  readonly usage?: { readonly output_tokens?: number };
  readonly error?: unknown;
}

function parseEvent(data: string): AnthropicEvent | null {
  try {
    return JSON.parse(data) as AnthropicEvent;
  } catch {
    return null;
  }
}

/**
 * Build the Messages API payload. The system prompt (a `role:"system"` message
 * in the harness history) becomes the top-level `system` field; assistant tool
 * calls become `tool_use` content blocks; runs of `role:"tool"` results become
 * single `user` messages of `tool_result` blocks.
 *
 * A user message that carries image refs becomes a content-block array with the
 * images FIRST, then its text — never dropped, even when the text is empty (an
 * image-only prompt). `options` is the resolved bytes (default: none, so every
 * existing caller compiles and behaves exactly as before).
 */
export function buildPayload(
  model: string,
  req: ChatRequest,
  defaultMaxTokens?: number,
  options: ImageBuildOptions = NO_IMAGES,
): Record<string, unknown> {
  const systems: string[] = [];
  const messages: Record<string, unknown>[] = [];
  // The user messages this build created FOR tool results: the ONLY ones a
  // later tool result may merge into (a multimodal user turn must stay its own
  // message — merging a `tool_result` block into images is a 400).
  const toolTurns = new Set<Record<string, unknown>>();
  for (const message of req.messages) {
    if (message.role === "system") {
      if (message.content !== "") {
        systems.push(message.content);
      }
      continue;
    }
    if (message.role === "tool") {
      // Collapse consecutive tool results into one user turn: parallel results
      // belong in a single message (the harness emits one tool message per
      // call, in order).
      const prev = messages.at(-1);
      if (
        prev !== undefined &&
        prev.role === "user" &&
        Array.isArray(prev.content) &&
        toolTurns.has(prev)
      ) {
        (prev.content as Record<string, unknown>[]).push({
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content,
        });
      } else {
        const turn: Record<string, unknown> = {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId ?? "",
              content: message.content,
            },
          ],
        };
        toolTurns.add(turn);
        messages.push(turn);
      }
      continue;
    }
    // A user message with refs: images first, then its text (D10).
    if (message.role === "user" && (message.attachments?.length ?? 0) > 0) {
      const parts = userParts(message, options);
      messages.push({
        role: "user",
        content: parts.map((part) =>
          part.kind === "image"
            ? {
                type: "image",
                source: { type: "base64", media_type: part.mimeType, data: part.base64 },
              }
            : { type: "text", text: part.text },
        ),
      });
      continue;
    }
    // user / assistant. Plain text stays a string (the simplest valid form);
    // only a tool-bearing assistant turn needs content blocks (text + tool_use).
    const stray = strayRefsText(message, options);
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) {
      // The API rejects empty content; the loop can persist an empty assistant
      // turn (a stalled round). Dropping it is safe: consecutive same-role
      // turns are merged by the API.
      if (message.content === "" && stray === "") {
        continue;
      }
      messages.push({ role: message.role, content: `${message.content}${stray}` });
      continue;
    }
    const content: Record<string, unknown>[] = [];
    if (message.content !== "" || stray !== "") {
      content.push({ type: "text", text: `${message.content}${stray}` });
    }
    for (const call of calls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: parseArgs(call) });
    }
    messages.push({ role: message.role, content });
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: payloadMaxTokens(req, defaultMaxTokens),
    stream: true,
  };
  if (systems.length > 0) {
    payload.system = systems.join("\n\n");
  }
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map(toWireTool);
  }
  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  return payload;
}

function payloadMaxTokens(req: ChatRequest, defaultMaxTokens?: number): number {
  return req.maxTokens ?? defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
}

function parseArgs(call: ToolCall): unknown {
  const trimmed = call.arguments.trim();
  if (trimmed === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // `tool_use.input` must be an object: the model's copy is repaired
    // agent-side (`wireArguments`); this catches a request built elsewhere (a
    // pod relay; docs/feat/history-validity-invariant.md).
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A broken body degrades to an empty input rather than breaking the whole request.
    return {};
  }
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

/**
 * An actionable hint for the non-2xx errors a misconfiguration produces, so the
 * TUI says which setting to fix instead of only echoing the API's error body.
 * Returns undefined when there is nothing specific to suggest.
 */
export function anthropicErrorHint(status: number, body: string): string | undefined {
  let type: unknown;
  try {
    type = (JSON.parse(body) as { error?: { type?: unknown } }).error?.type;
  } catch {
    return undefined;
  }
  if (status === 404 && type === "not_found_error") {
    return "check the model id: set model.model in config.jsonc, TENTACLE_MODEL, or --model on the command that starts the session (e.g. claude-opus-5-5)";
  }
  if ((status === 401 || status === 403) && type === "authentication_error") {
    return "check the API key: set model.apiKeyCommand / model.apiKey in config.jsonc or TENTACLE_MODEL_API_KEY";
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

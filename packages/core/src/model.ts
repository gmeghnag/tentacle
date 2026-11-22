/**
 * Model provider contract.
 *
 * Concrete adapters each target one wire format and normalise its streaming
 * and tool-calling quirks behind this single interface: the OpenAI-compatible
 * `/v1/chat/completions` endpoint (local llama.cpp / vLLM / cloud) and the
 * native Anthropic Messages API (`/v1/messages`). See ADR-003.
 */
import type { AttachmentRef } from "@tentacle/protocol";
import type { DateStamp } from "./current-date.ts";
import type { ScheduledFire } from "./scheduled-fire.ts";
import type { ToolResultSpill } from "./tool.ts";

export type { AttachmentRef };

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
  /**
   * On a `role: "tool"` message whose result was spilled: the spill as data,
   * for display only (provider mappers copy field by field, so the model
   * never sees it; `content` is what it sees).
   */
  readonly spill?: ToolResultSpill;
  /**
   * On a `role: "tool"` message whose tool actually ran: how long the run took
   * (ms, measured agent-side on a monotonic clock; docs/fix/tool-duration.md).
   * Display only, like `spill`: the model never sees it.
   */
  readonly durationMs?: number;
  /**
   * On a `role: "tool"` message of a call the person refused with a reply:
   * the reply (docs/feat/permission-reply.md). Display only, like `spill`:
   * the model sees it inside `content`.
   */
  readonly denialReply?: string;
  /**
   * On a `role: "tool"` message whose result was an error (`ToolResult.isError`):
   * `true`, else absent (docs/fix/mobile-qa-1117.md, bug 2). Display only, like
   * `durationMs`: the model reads the failure in `content`; a reload uses this to
   * draw the step as failed, as the live `tool_result` did.
   */
  readonly isError?: true;
  /**
   * On a `user` or `tool` message that crossed a new step of context fill: how
   * full the context was (docs/feat/context-awareness.md). NOT display-only,
   * unlike `spill`/`durationMs`: the agent loop renders it into `content` as a
   * `[context: …]` line on every request (`renderForModel`), so the model sees
   * it while the stored `content` stays clean. The TUI ignores it.
   */
  readonly contextUsage?: ContextUsage;
  /**
   * On a user message whose turn needed one (docs/fix/prompt-current-date.md):
   * when it was sent, and the LAPTOP's zone to render it in. NOT display-only,
   * like `contextUsage`: the agent loop prepends its `[Fri 2026-11-20 13:42 CET]`
   * line to the model's copy of `content` (`renderForModel`) on every request,
   * so a stamp the model once saw stays byte-identical (the prompt cache) while
   * `content` itself stays clean for every other reader.
   */
  readonly dateStamp?: DateStamp;
  /**
   * On a tentacle-written `user` message: what kind of note it is and what it is
   * about (docs/feat/subagent-ledger-log.md). Display only, like `spill`: the
   * provider mappers copy field by field, so the model sees only `content`. The
   * load derivation keys on it (structural, idempotent), and a resume renders
   * such a message as a notice, not as a row the person typed.
   */
  readonly note?: MessageNote;
  /**
   * On a USER message: image refs to send with it (docs/feat/attachments-core.md).
   * Refs, never bytes: the bytes live behind an `AttachmentSource` on the side
   * trusted to read them, and non-empty when present. A message without refs
   * has no key (never `[]`), so it hashes and serialises as it always did.
   */
  readonly attachments?: readonly AttachmentRef[];
  /**
   * On a USER message: the files attached to it, for the chip
   * (docs/feat/pdf-read.md D4). Display only for the renderers — the text is in
   * `content` as `<file>` blocks; the agent loop adds one "this is data" line to
   * the model's copy (`renderForModel`). Non-empty when present.
   */
  readonly media?: readonly MessageMedia[];
  /**
   * ONLY on the summary `user` message a compaction writes: the context size
   * before and after it (docs/feat/harness-notices.md S1). Display only, like
   * `spill`: the provider mappers copy field by field, so the model never sees
   * it. Rides the critical `message` log entry fail-soft (a malformed value is
   * dropped, the entry still loads), so every replay path draws the separator.
   */
  readonly compacted?: CompactionFact;
  /**
   * ONLY on the user message a fired scheduled wake writes: which wake, its
   * ordinal and the instant it fired (docs/feat/scheduled-fire-row.md). Display
   * only, like `compacted`: the model reads the `[scheduled …]` prefix in
   * `content`, never this. Rides the critical `message` entry fail-soft, so a
   * reload draws the same `Wake 15:54` row as live.
   */
  readonly scheduled?: ScheduledFire;
  /**
   * On an ASSISTANT message whose round streamed reasoning: how long the model
   * thought (ms, agent-side monotonic clock, summed over the round's reasoning
   * runs) — a PLACEHOLDER, never the reasoning text (docs/fix/thought-placeholder.md,
   * owner option 3). Display only, like `scheduled`: the provider mappers copy
   * field by field, so the model never sees it. A reload draws `Thought · 12 s`.
   */
  readonly thought?: ThoughtFact;
}

/** A round's thinking, as a placeholder: its duration only (docs/fix/thought-placeholder.md). */
export interface ThoughtFact {
  readonly ms: number;
}

/** A compaction's context sizes, in tokens. `toExact` only when the provider counted. */
export interface CompactionFact {
  readonly fromTokens: number;
  readonly toTokens: number;
  readonly toExact?: true;
}

/** One attached file on a user message (the wire's `MessageMediaSchema`; `kind` is a free string). */
export interface MessageMedia {
  readonly kind: string;
  readonly name: string;
  readonly pages?: number;
  readonly chars?: number;
}

/**
 * A tentacle-written note's kind and subject. `kind` is a bounded free string on
 * the wire (an enum would refuse a newer build's kind inside a CRITICAL entry);
 * the known ones are `NOTE_KIND` constants below.
 */
export interface MessageNote {
  readonly kind: string;
  /** The job (`sh-N`) or sub-agent (`sa-N`) it is about. */
  readonly id?: string;
}

/** The `note.kind` values this build writes. They are constants, never a schema enum. */
export const NOTE_KIND = {
  /** A shell job exited (agent.ts's flush). */
  backgroundExit: "background_exit",
  /** A finished background sub-agent's report, delivered. */
  subagentReport: "subagent_report",
  /** A running background sub-agent's `agent_notify` text, delivered mid-run. */
  subagentMessage: "subagent_message",
  /** A background sub-agent a restart found unfinished: its work product is gone. */
  subagentLost: "subagent_lost",
  /** What was still running when the chat was cleared (`/clear`'s head note). */
  stillRunning: "still_running",
  /**
   * The USER wrote directly to a background child (`session/subagent_message`,
   * docs/feat/subagent-panel.md): the parent agent is told, and asked for nothing.
   */
  userToSubagent: "user_to_subagent",
  /** A workflow run ended (`wf-N`): the live end note (docs/feat/agent-workflows.md D3). */
  workflowEnd: "workflow_end",
  /** A workflow run a restart found unfinished, closed `stopped: interrupted` at load (D4). */
  workflowInterrupted: "workflow_interrupted",
} as const;

/** How full the model's context was: `used` tokens of a `window` (both tokens). */
export interface ContextUsage {
  readonly used: number;
  readonly window: number;
}

export interface Usage {
  /** The whole prompt, cache hits included (what the context count uses). */
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * The part of `promptTokens` the provider served from its prompt cache
   * (Anthropic's `cache_read_input_tokens`, an OpenAI-compatible server's
   * `prompt_tokens_details.cached_tokens`). Absent when the server does not
   * report it — never 0, which would claim a full cache miss
   * (docs/feat/token-usage-log.md).
   */
  readonly cachedPromptTokens?: number;
}

/**
 * A token count from a provider's raw JSON, or `undefined` when it is not one.
 * Providers must pass every usage field through this: the same field is
 * `null` on some servers (LiteLLM-style proxies send
 * `prompt_tokens_details: {cached_tokens: null}`; the Anthropic API types its
 * cache counts nullable), and a `null` reaching the log writes an entry every
 * reader REFUSES — which poisons the whole session log, not just that field
 * (docs/feat/token-usage-log.md, fix round 1).
 */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Why a model's streamed reply ended, as the provider's own stop reason reads
 * (docs/fix/truncated-reply-silent.md). `length`: the reply was CUT at the
 * model's output limit (`finish_reason: "length"`, `max_tokens`, `refusal`);
 * `stop`: it finished on its own; `tool_calls`: it asked for tools;
 * `other`: the stream produced no stop reason at all — the body was cut, so
 * the reply is incomplete data, not a short answer.
 */
export type ModelStopReason = "stop" | "length" | "tool_calls" | "other";

/** A single event in the model's streamed response. */
export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "tool_call"; readonly toolCall: ToolCall }
  | { readonly type: "done"; readonly usage?: Usage; readonly stopReason?: ModelStopReason };

/**
 * The voice-turn profile of one request (docs/feat/voice-conversation.md §4,
 * C3). `off`: reason for no more than this turn's rounds BEFORE its first tool
 * call (a spoken reply is wanted now, not a long think); `keep`: reason as
 * configured. Both are a VOICE turn, which always gets the spoken-style line.
 */
export type VoiceReasoning = "off" | "keep";

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /**
   * Where this side reads an image ref's bytes from (docs/feat/attachments-core.md).
   * Non-serialisable, like `signal` — it is NOT on the wire: a pod sends refs,
   * and the laptop's request carries whatever the laptop itself is allowed to read.
   */
  readonly attachments?: AttachmentSource;
  /**
   * `"off"`: do not reason on this request (a voice turn, C3). A provider that
   * cannot honour it ignores it — never an error, never a failed turn.
   */
  readonly reasoning?: "off";
}

/**
 * The bytes behind an image ref, or `null` when this source does not hold them
 * (absent is not an error: the provider shows a placeholder). Throw only for a
 * transient failure — the stream then rejects before any bytes reach a provider.
 */
export interface AttachmentSource {
  read(ref: AttachmentRef, signal?: AbortSignal): Promise<Uint8Array | null>;
}

export interface ModelProvider {
  /** Stable identifier for logging / routing. */
  readonly id: string;
  /** Stream a completion as a sequence of events, ending with a `done` event. */
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  /**
   * The EXACT prompt size of `request` in tokens, counted by the provider
   * WITHOUT generating (Anthropic `count_tokens`, llama.cpp `/tokenize`).
   * `undefined`: this provider cannot — the caller falls back to an estimate.
   * Best effort: rejects on a transport failure, the caller treats it alike.
   * Optional (docs/feat/tui-target-badge.md).
   */
  countTokens?(request: ChatRequest): Promise<number | undefined>;
}

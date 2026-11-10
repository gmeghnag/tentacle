/**
 * Model provider contract.
 *
 * Concrete adapters each target one wire format and normalise its streaming
 * and tool-calling quirks behind this single interface: the OpenAI-compatible
 * `/v1/chat/completions` endpoint (local llama.cpp / vLLM / cloud) and the
 * native Anthropic Messages API (`/v1/messages`). See ADR-003.
 */
import type { ToolResultSpill } from "./tool.ts";

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
   * On a `user` or `tool` message that crossed a new step of context fill: how
   * full the context was (docs/feat/context-awareness.md). NOT display-only,
   * unlike `spill`/`durationMs`: the agent loop renders it into `content` as a
   * `[context: …]` line on every request (`renderForModel`), so the model sees
   * it while the stored `content` stays clean. The TUI ignores it.
   */
  readonly contextUsage?: ContextUsage;
  /**
   * On a tentacle-written `user` message: what kind of note it is and what it is
   * about (docs/feat/subagent-ledger-log.md). Display only, like `spill`: the
   * provider mappers copy field by field, so the model sees only `content`. The
   * load derivation keys on it (structural, idempotent), and a resume renders
   * such a message as a notice, not as a row the person typed.
   */
  readonly note?: MessageNote;
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
} as const;

/** How full the model's context was: `used` tokens of a `window` (both tokens). */
export interface ContextUsage {
  readonly used: number;
  readonly window: number;
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
  /**
   * The EXACT prompt size of `request` in tokens, counted by the provider
   * WITHOUT generating (Anthropic `count_tokens`, llama.cpp `/tokenize`).
   * `undefined`: this provider cannot — the caller falls back to an estimate.
   * Best effort: rejects on a transport failure, the caller treats it alike.
   * Optional (docs/feat/tui-target-badge.md).
   */
  countTokens?(request: ChatRequest): Promise<number | undefined>;
}

/**
 * A multi-turn conversation.
 *
 * Owns the message history and feeds it back to the agent on every `send`, so
 * the model sees prior turns (and their tool results). This is what turns the
 * one-shot loop into an interactive assistant.
 */
import type { ChatMessage } from "@agent-harness/core";
import type { Agent, AgentEvent } from "./agent.ts";
import { type CompactResult, compactedHistory } from "./compact.ts";

/** A serialisable view of a session's durable state (for persistence/resume). */
export interface SessionSnapshot {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
}

export interface SessionOptions {
  /** Seed the history (resume): used verbatim instead of a fresh system prompt. */
  readonly messages?: readonly ChatMessage[];
  /** Called after every turn and every compaction, with the current snapshot. */
  readonly onPersist?: (snapshot: SessionSnapshot) => void;
}

export class Session {
  readonly id: string;
  /** The running conversation history (read-only view for callers). */
  readonly messages: ChatMessage[];
  private readonly agent: Agent;
  private readonly onPersist?: (snapshot: SessionSnapshot) => void;
  /** User messages queued mid-turn, drained into the loop at each boundary. */
  private steering: string[] = [];

  constructor(agent: Agent, id?: string, options: SessionOptions = {}) {
    this.agent = agent;
    this.id = id ?? crypto.randomUUID();
    // Resume seeds the full history; otherwise start a fresh conversation.
    this.messages =
      options.messages && options.messages.length > 0
        ? [...options.messages]
        : agent.startConversation();
    this.onPersist = options.onPersist;
  }

  /** A snapshot of durable state, for persisting or inspecting the session. */
  snapshot(): SessionSnapshot {
    return { id: this.id, messages: [...this.messages] };
  }

  private persist(): void {
    this.onPersist?.(this.snapshot());
  }

  /**
   * Append a user turn and drive the agent over the full history.
   *
   * An EMPTY `text` is a continuation: no user message is appended and the agent
   * runs over the existing history, reacting to whatever was injected at turn
   * start (e.g. a background-job exit note). This is how an autonomous wake
   * resumes the conversation without a synthetic user prompt.
   */
  async *send(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    // A fresh turn starts with an empty steering queue (abort may have left
    // undrained items from a previous turn).
    this.steering = [];
    if (text !== "") {
      this.messages.push({ role: "user", content: text });
    }
    try {
      yield* this.agent.runMessages(this.messages, this.id, signal, () => this.steering.splice(0));
    } finally {
      // Persist once the turn settles (normal end, error, or abort), so a
      // crash/exit mid-session still leaves the latest history on disk.
      this.persist();
    }
  }

  /**
   * Queue a user message to be injected into the turn currently running, at the
   * next model-round boundary ("steering"). A no-op shape when nothing is
   * running — the message simply waits in the queue until the next `send`.
   */
  enqueue(text: string): void {
    this.steering.push(text);
  }

  /**
   * Compact the conversation: summarise it, then replace the history with the
   * system prompt + that summary. Returns the summary and the message counts.
   */
  async compact(signal?: AbortSignal): Promise<CompactResult> {
    const before = this.messages.length;
    const summary = await this.agent.summarize(this.messages, signal);
    const next = compactedHistory(this.messages, summary);
    this.messages.length = 0;
    this.messages.push(...next);
    this.persist();
    return { summary, before, after: this.messages.length };
  }
}

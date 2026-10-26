/**
 * A multi-turn conversation.
 *
 * Owns the message history and feeds it back to the agent on every `send`, so
 * the model sees prior turns (and their tool results). This is what turns the
 * one-shot loop into an interactive assistant.
 */
import type { ChatMessage } from "@tentacle/core";
import { type Agent, type AgentEvent, UnknownSkillError } from "./agent.ts";
import { type CompactResult, carryOverSkills, compactedHistory } from "./compact.ts";
import type { AskHooksTrust } from "./hooks.ts";

/** A serialisable view of a session's durable state (for persistence/resume). */
export interface SessionSnapshot {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
}

/** Per-turn options of `send`. */
export interface SendOptions {
  /** The user activates this skill (`/name`) with this turn (see `RunOptions.skill`). */
  readonly skill?: string;
  /** Asks the prompting client whether to run the project's hooks (see `RunOptions.askHooksTrust`). */
  readonly askHooksTrust?: AskHooksTrust;
  /**
   * The turn's steering queue at its start (copied), drained at its first
   * boundary like any steer: the daemon's send-now carries a cancelled turn's
   * undrained steers over (docs/feat/send-now-a.md). Absent → empty.
   */
  readonly steering?: readonly string[];
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
   *
   * `opts.skill` activates a skill for the user (`/name`) right after `text`;
   * one the agent cannot activate for the user, or with an empty `text`,
   * rejects (`UnknownSkillError`) before anything is pushed.
   */
  async *send(
    text: string,
    signal?: AbortSignal,
    opts: SendOptions = {},
  ): AsyncGenerator<AgentEvent> {
    if (opts.skill !== undefined && (text === "" || !this.canActivateSkill(opts.skill))) {
      throw new UnknownSkillError(opts.skill);
    }
    // A fresh turn starts with its seed only (abort may have left undrained
    // items from a previous turn; a caller that keeps them passes them).
    this.steering = [...(opts.steering ?? [])];
    // What this turn adds starts here (its context line may ride on it).
    const newFrom = this.messages.length;
    if (text !== "") {
      this.messages.push({ role: "user", content: text });
    }
    try {
      yield* this.agent.runMessages(this.messages, this.id, signal, () => this.steering.splice(0), {
        newFrom,
        ...(opts.skill !== undefined ? { skill: opts.skill } : {}),
        ...(opts.askHooksTrust !== undefined ? { askHooksTrust: opts.askHooksTrust } : {}),
      });
    } finally {
      // Persist once the turn settles (normal end, error, or abort), so a
      // crash/exit mid-session still leaves the latest history on disk.
      this.persist();
    }
  }

  /** Whether the user may activate `name` (`/name`) in this session — synchronous, for a pre-ack check. */
  canActivateSkill(name: string): boolean {
    return this.agent.canActivateForUser(name);
  }

  /**
   * Continue the turn the history is suspended in, before tool call
   * `toolCallId` (a `serve` restart rebuilt it): that call and the rest of its
   * round go through the permission gate again, then the loop goes on as
   * usual. Unlike `send`, it appends nothing and KEEPS the steering queue —
   * the caller seeds it (`enqueue`) with the steers the suspended turn had
   * accepted. A history not suspended there rejects (`ResumeShapeError`)
   * before anything runs.
   */
  async *resume(toolCallId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    try {
      yield* this.agent.runMessages(this.messages, this.id, signal, () => this.steering.splice(0), {
        resumeFrom: toolCallId,
      });
    } finally {
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

  /** The messages queued and not yet drained, in order (a copy, for persisting). */
  pendingSteering(): readonly string[] {
    return [...this.steering];
  }

  /**
   * Compact the conversation: summarise it, then replace the history with the
   * system prompt + that summary + the skills that were active, read again
   * (docs/feat/skills-compaction.md). Returns the summary and the message
   * counts. Everything is read before the history is replaced; an abort wins
   * over a read or a summary that lands after it (a provider may ignore the
   * signal): the history is then left untouched and the call rejects.
   *
   * `onReplaced` runs synchronously right after the replacement — no microtask
   * where the history is new and an observer's view of it still old (the
   * daemon's stream barrier). It must not throw.
   */
  async compact(signal?: AbortSignal, onReplaced?: () => void): Promise<CompactResult> {
    const before = this.messages.length;
    const skills = carryOverSkills(await this.agent.reloadSkills(this.id, this.messages, signal));
    signal?.throwIfAborted();
    const summary = await this.agent.summarize(this.messages, signal, skills.kept);
    signal?.throwIfAborted();
    const next = compactedHistory(this.messages, summary, skills);
    this.messages.length = 0;
    this.messages.push(...next);
    onReplaced?.();
    this.persist();
    return { summary, before, after: this.messages.length };
  }
}

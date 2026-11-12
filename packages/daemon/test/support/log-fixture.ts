/**
 * Hand-made `session/log` entries and a client-like reader, for the laptop
 * log store's tests (docs/feat/session-log-laptop-store.md). Entries carry the
 * real envelope (`seq`/`id`/`prev`/`ts`, the fixed `critical` values); the
 * reader folds them with the shared `projectEntry` and builds the `LogWrite`
 * a `ReadBack` would (`read.from` = the head the read continued).
 */
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  type LogCursor,
  appendEntryBody,
  projectEntry,
  replaceEntryBody,
} from "@tentacle/protocol";
import type { LogMeta, LogWrite } from "../../src/session-log-store.ts";

export const META: LogMeta = { cwd: "/w", model: "m", createdAt: 1 };

/** One daemon incarnation's log: each call mints the next entry of the chain. */
export class FakeLog {
  private seq: number;
  private prev: string | undefined;
  constructor(
    readonly inc: string,
    from?: LogCursor,
  ) {
    this.seq = from?.seq ?? 0;
    this.prev = from?.id;
  }
  private next(body: Record<string, unknown>): KnownLogEntry {
    this.seq++;
    const id = `${this.inc}/${this.seq}`;
    const entry = { ...body, seq: this.seq, id, ...(this.prev ? { prev: this.prev } : {}), ts: 1 };
    this.prev = id;
    return entry as KnownLogEntry;
  }
  base(
    messages: readonly ChatMessage[],
    reason: "create" | "seed" | "reload" | "compact" | "context_reset" = "create",
    turn?: string,
  ): KnownLogEntry[] {
    return [
      this.next({
        type: "base",
        critical: true,
        inc: this.inc,
        reason,
        count: messages.length,
        ...(turn ? { turn } : {}),
      }),
      ...messages.map((m) => this.msg(m)),
    ];
  }
  msg(message: ChatMessage): KnownLogEntry {
    // The real emitter's choice: a message carrying image refs rides
    // `media_message` (docs/feat/attachments-core.md); the fixture follows it.
    return this.next(appendEntryBody(message));
  }
  replace(index: number, message: ChatMessage): KnownLogEntry {
    return this.next(replaceEntryBody(index, message));
  }
  title(text: string, source: "auto" | "model" | "user" = "user"): KnownLogEntry {
    return this.next({ type: "title", title: { text, source } });
  }
  turnStart(turnId: string): KnownLogEntry {
    return this.next({ type: "turn_start", turnId });
  }
  turnEnd(turnId: string): KnownLogEntry {
    return this.next({ type: "turn_end", turnId, stopReason: "end_turn" });
  }
  callStarted(callId: string): KnownLogEntry {
    return this.next({ type: "call_started", callId });
  }
  /** A background sub-agent marker (docs/feat/subagent-ledger-log.md; non-critical). */
  subagentBackground(agentId: string, callId = `c-${agentId}`): KnownLogEntry {
    return this.next({
      type: "subagent_background",
      critical: false,
      agentId,
      callId,
      agentType: "explore",
      description: "map the repo",
    });
  }
  subagentEnd(agentId: string, report?: string): KnownLogEntry {
    return this.next({
      type: "subagent_end",
      critical: false,
      agentId,
      stopReason: "end_turn",
      ...(report !== undefined ? { report } : {}),
    });
  }
}

/** A client's view of one session: its head and projection, and the `LogWrite` of each read. */
export class FakeReader {
  head: LogCursor | undefined;
  messages: ChatMessage[] = [];
  constructor(readonly id: string) {}
  /** A read of `entries`: `linear` continues the head; anything else restarts at the entries' last base. */
  read(
    entries: readonly KnownLogEntry[],
    outcome: "cold" | "linear" | "fork" = "linear",
  ): LogWrite {
    const from = outcome === "linear" ? this.head : undefined;
    if (outcome !== "linear") this.messages = [];
    for (const e of entries) projectEntry(this.messages, e, (m) => m as ChatMessage);
    const last = entries.at(-1);
    if (last) this.head = { seq: last.seq, id: last.id };
    return {
      id: this.id,
      meta: META,
      entries,
      messages: [...this.messages],
      read: {
        ...(from ? { from } : {}),
        head: this.head ?? { seq: 1, id: "none" },
        outcome,
      },
    };
  }
}

export const user = (content: string): ChatMessage => ({ role: "user", content });
export const asst = (content: string, calls: string[] = []): ChatMessage => ({
  role: "assistant",
  content,
  ...(calls.length > 0
    ? { toolCalls: calls.map((id) => ({ id, name: "shell", arguments: "{}" })) }
    : {}),
});
export const tool = (id: string, content = "ok"): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: id,
});

/**
 * `/clear` keeps the chat it drops as a NEW session, a "fork"
 * (docs/feat/clear-fork-history.md). Pure: no I/O, no clock. The fork is built
 * from messages ONLY (a base, one message each, a chosen title): no job or
 * sub-agent marker travels with it, the work belongs to the live session.
 */
import { randomUUID } from "node:crypto";
import type { TitleState } from "@tentacle/agent";
import { type ChatMessage, NOTE_KIND } from "@tentacle/core";
import type { LogCursor, SessionTitle } from "@tentacle/protocol";
import { segmentFromMessages } from "./session-log-file.ts";
import type { LogMeta, LogWrite } from "./session-log-store.ts";

/** The chat worth keeping as a fork, without "still running" notes; null: nothing to keep. */
export function forkableMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] | null {
  const kept = messages.filter((m) => m.note?.kind !== NOTE_KIND.stillRunning);
  return kept.some((m) => m.role === "assistant" || (m.role === "user" && m.note === undefined))
    ? kept
    : null;
}

/** The ordinary, cold write of a new session holding `messages`. Mint it ONCE: a retry resends the same entries. */
export function forkWrite(input: {
  readonly id: string;
  readonly meta: LogMeta;
  readonly messages: readonly ChatMessage[];
  readonly title: TitleState;
  readonly ts: number;
}): LogWrite & { readonly read: { readonly head: LogCursor; readonly outcome: string } } {
  const chosen: SessionTitle | undefined =
    input.title.source === "auto"
      ? undefined
      : { text: input.title.text, source: input.title.source };
  const entries = segmentFromMessages(input.messages, chosen, `fork-${randomUUID()}`, input.ts);
  const last = entries.at(-1);
  if (last === undefined) throw new Error("a segment has at least its base");
  return {
    id: input.id,
    meta: input.meta,
    entries,
    messages: input.messages,
    read: { head: { seq: last.seq, id: last.id }, outcome: "cold" },
  };
}

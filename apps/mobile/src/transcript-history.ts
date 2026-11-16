/**
 * The daemon's history (`ChatMessage[]`) as transcript rows — the same view the
 * TUI's `messagesToItems` builds (`packages/tui/src/resume.ts`), for the phone.
 *
 * Why a copy instead of an import: the TUI's resume pulls `@tentacle/agent` at
 * runtime (`restartPromptOf`), which the app bundle must not carry (plan P8 /
 * Owner Q5). The ONE format string this repeats — the context-reset header — is
 * pinned to the real function by `test/transcript-parity.test.ts`.
 */
import type { ChatMessage } from "@tentacle/core";
import { toolLabel } from "@tentacle/core";
import { type ImageRef, type Row, imageRef } from "./transcript-rows.ts";

/** The context reset's header (mirrors `agent/src/context-reset.ts`; pinned by a test). */
export const CONTEXT_RESET_HEADER =
  "[context reset] You renewed your own context with context_reset.\nEverything before it was discarded. Your restart prompt:";

const OPEN = "\n<restart_prompt>\n";
const CLOSE = "\n</restart_prompt>";

/** The separator a context reset draws before its restart prompt (decision 9). */
export const CONTEXT_RESET_SEPARATOR = "↻ context reset by the model";

/**
 * The restart prompt a context reset's first user message carries, or null for
 * any other content (`restartPromptOf`, duplicated — see the module comment).
 */
export function restartPromptOf(content: string): string | null {
  const head = `${CONTEXT_RESET_HEADER}${OPEN}`;
  if (!content.startsWith(head)) {
    return null;
  }
  const end = content.lastIndexOf(CLOSE);
  return end < head.length ? null : content.slice(head.length, end);
}

/** A tentacle-written note (a job's exit, a sub-agent's report): a notice, never a user row. */
function noteRow(key: string, m: ChatMessage): Row {
  const [first = "", ...rest] = m.content.split("\n");
  const body = rest.join("\n").trim();
  return {
    kind: "notice",
    key,
    text: first,
    ...(body === "" ? {} : { body }),
    ...(m.note === undefined ? {} : { note: m.note }),
  };
}

/** Rows for `messages`; `nextKey` mints one key per row (the fold's own counter). */
export function historyRows(
  messages: readonly ChatMessage[],
  nextKey: () => string,
): readonly Row[] {
  const rows: Row[] = [];
  /** toolCallId → index in `rows` (a result lands on its call's row). */
  const toolAt = new Map<string, number>();
  for (const m of messages) {
    if (m.role === "system") {
      continue; // the system prompt is not visible
    }
    if (m.role === "user") {
      const restart = restartPromptOf(m.content);
      if (restart !== null) {
        rows.push({
          kind: "notice",
          key: nextKey(),
          text: CONTEXT_RESET_SEPARATOR,
          separator: true,
        });
        rows.push({ kind: "user", key: nextKey(), text: restart, images: [], restart: true });
      } else if (m.note !== undefined) {
        rows.push(noteRow(nextKey(), m));
      } else {
        rows.push({
          kind: "user",
          key: nextKey(),
          text: m.content,
          images: (m.attachments ?? []).map((ref): ImageRef => imageRef(ref)),
        });
      }
    } else if (m.role === "assistant") {
      if (m.content.trim() !== "") {
        rows.push({
          kind: "assistant",
          key: nextKey(),
          text: m.content,
          version: m.content.length,
        });
      }
      for (const call of m.toolCalls ?? []) {
        toolAt.set(call.id, rows.length);
        rows.push({
          kind: "tool",
          key: nextKey(),
          id: call.id,
          name: call.name,
          label: toolLabel(call.name),
          args: call.arguments,
          status: "ok", // historical: the call already ran
        });
      }
    } else if (m.role === "tool") {
      const at = m.toolCallId !== undefined ? toolAt.get(m.toolCallId) : undefined;
      const tool = at !== undefined ? rows[at] : undefined;
      if (at !== undefined && tool?.kind === "tool") {
        rows[at] = {
          ...tool,
          output: m.content,
          // A refused call is known from its reply; any other error flag is not stored.
          status: m.denialReply !== undefined ? "denied" : "ok",
          ...(m.spill !== undefined ? { spill: m.spill } : {}),
          ...(m.denialReply !== undefined ? { denialReply: m.denialReply } : {}),
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        };
      } else {
        // A result with no matching call (a truncated history): shown plainly.
        rows.push({ kind: "notice", key: nextKey(), text: m.content });
      }
    }
  }
  return rows;
}

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
import { compactionOf, compactionSeparatorText, splitFileBlocks, toolLabel } from "@tentacle/core";
import { type ImageRef, type Row, imageRef, mediaRowText } from "./transcript-rows.ts";

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

/**
 * A compaction as ONE separator (docs/fix/mobile-qa-1117.md, bug 4; the TUI's
 * `compactionItem`, docs/feat/harness-notices.md S3.4): `compacted · ctx A → B`
 * from the summary's `compacted` figures, `compacted` alone for a legacy one.
 * The SAME row whether the compaction is seen live from another device or after
 * a reopen. The brief is NOT shown: it is the model's note to itself, which the
 * TUI keeps behind Ctrl+O — and a phone notice has no expand.
 */
export function compactionSeparatorRow(key: string, messages: readonly ChatMessage[]): Row {
  const summary = messages.find((m) => compactionOf(m) !== null);
  const view = summary === undefined ? {} : (compactionOf(summary) ?? {});
  return { kind: "notice", key, text: compactionSeparatorText(view), separator: true };
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

/**
 * The arrival time of message `index`, as a spreadable row property: `{}` when
 * nothing is known (no `times`, a short array, or `0` — a message a reload or
 * compaction re-logged was not received now, docs/fix/mobile-open-at-end.md).
 */
function atOf(times: readonly number[] | undefined, index: number): { at?: number } {
  const at = times?.[index];
  return at !== undefined && at > 0 ? { at } : {};
}

/**
 * A stored user message's text and its document rows (D5, the TUI's
 * `userMessageView`): WITH `media` the `<file …>` blocks are stripped — the
 * model has that text, the person has the file it came from — and each entry
 * becomes one row. WITHOUT `media` (an older log, a build that dropped the
 * field) the content is shown RAW: honest degradation, never a guess about
 * which `<file>` block was a PDF.
 */
function userMessageOf(m: ChatMessage): { text: string; documents?: readonly string[] } {
  const media = m.media;
  if (media === undefined || media.length === 0) {
    return { text: m.content };
  }
  return { text: splitFileBlocks(m.content).text, documents: media.map(mediaRowText) };
}

/**
 * Rows for `messages`; `nextKey` mints one key per row (the fold's own counter).
 * `times` is the daemon's `SnapshotResult.times`, index-aligned with `messages`
 * (docs/fix/mobile-open-at-end.md, slice B): a row whose time is `0` (not known
 * — a message a reload or compaction re-logged) carries none at all.
 */
export function historyRows(
  messages: readonly ChatMessage[],
  nextKey: () => string,
  times?: readonly number[],
): readonly Row[] {
  const rows: Row[] = [];
  /** toolCallId → index in `rows` (a result lands on its call's row). */
  const toolAt = new Map<string, number>();
  for (const [index, m] of messages.entries()) {
    const at = atOf(times, index);
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
        rows.push({
          kind: "user",
          key: nextKey(),
          text: restart,
          images: [],
          restart: true,
          ...at,
        });
      } else if (compactionOf(m) !== null) {
        rows.push(compactionSeparatorRow(nextKey(), [m]));
      } else if (m.note !== undefined) {
        rows.push(noteRow(nextKey(), m));
      } else {
        const own = userMessageOf(m);
        rows.push({
          kind: "user",
          key: nextKey(),
          text: own.text,
          images: (m.attachments ?? []).map((ref): ImageRef => imageRef(ref)),
          ...(own.documents === undefined ? {} : { documents: own.documents }),
          ...at,
        });
      }
    } else if (m.role === "assistant") {
      if (m.content.trim() !== "") {
        rows.push({
          kind: "assistant",
          key: nextKey(),
          text: m.content,
          version: m.content.length,
          ...at,
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
          ...at,
        });
      }
    } else if (m.role === "tool") {
      const at = m.toolCallId !== undefined ? toolAt.get(m.toolCallId) : undefined;
      const tool = at !== undefined ? rows[at] : undefined;
      if (at !== undefined && tool?.kind === "tool") {
        rows[at] = {
          ...tool,
          output: m.content,
          // A refused call is known from its reply, a failed one from its stored
          // flag (docs/fix/mobile-qa-1117.md, bug 2): the status live showed.
          status: m.denialReply !== undefined ? "denied" : m.isError === true ? "error" : "ok",
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

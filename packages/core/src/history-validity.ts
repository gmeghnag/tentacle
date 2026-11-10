/**
 * The history well-formedness invariant
 * (docs/feat/history-validity-invariant.md): the MODEL's copy of a
 * conversation is always valid for an OpenAI-compatible endpoint, while the
 * STORED history is never touched.
 *
 * "Valid" is what a chat endpoint's template needs: every assistant
 * `toolCalls[i]` is answered by exactly one following `tool` message before the
 * next non-tool message, no `tool` message answers nothing, and every
 * `toolCalls[i].arguments` parses to a JSON object. A server that applies the
 * template parses those arguments on EVERY later request, so one bad string
 * poisons the whole session (llama.cpp 500 "Failed to parse tool call arguments
 * as JSON"). Consecutive `user` messages are left alone: the servers in use
 * accept them.
 *
 * Repair only the copy, never the record (AGENTS §7: history content is never
 * silently lost; and a suspended turn's dangling calls must stay dangling in
 * storage so it can resume). Pure, React-free, I/O-free.
 */
import type { ChatMessage, ToolCall } from "./model.ts";

/** What a repair changed, and where (`index` is the position in the INPUT). */
export type HistoryIssue =
  | { readonly kind: "empty_arguments"; readonly index: number; readonly callId: string }
  | {
      readonly kind: "invalid_arguments";
      readonly index: number;
      readonly callId: string;
      readonly bytes: number;
    }
  | { readonly kind: "unanswered_call"; readonly index: number; readonly callId: string }
  | {
      readonly kind: "orphan_tool_result";
      readonly index: number;
      readonly toolCallId: string | undefined;
    };

const encoder = new TextEncoder();

/**
 * What stands in for arguments that are not a JSON object (owner Q1 (b)): a
 * plain JSON object, so the repaired request is valid and the repair is
 * idempotent. Key order is fixed — `_invalid_arguments`, then `bytes`.
 */
export function invalidArgumentsMarker(bytes: number): string {
  return JSON.stringify({ _invalid_arguments: true, bytes });
}

type ArgumentsClass =
  | { readonly kind: "ok"; readonly wire: string }
  | { readonly kind: "empty"; readonly wire: string }
  | { readonly kind: "invalid"; readonly wire: string; readonly bytes: number };

/** `raw` kept, `"{}"` for an empty string, or the marker. */
function classifyArguments(raw: string): ArgumentsClass {
  if (raw.trim() === "") {
    return { kind: "empty", wire: "{}" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { kind: "ok", wire: raw };
    }
  } catch {
    // Not JSON at all: the marker below.
  }
  const bytes = encoder.encode(raw).length;
  return { kind: "invalid", wire: invalidArgumentsMarker(bytes), bytes };
}

/**
 * The arguments actually sent for a call: `raw` when it is a JSON object, `"{}"`
 * when it is empty (the registry and the Anthropic provider already read it that
 * way), the marker otherwise. Idempotent: the marker is a plain object, so
 * `wireArguments(wireArguments(x)) === wireArguments(x)`.
 */
export function wireArguments(raw: string): string {
  return classifyArguments(raw).wire;
}

/** What the model is told about a replacement, on the call's paired result. */
export function invalidArgumentsNote(bytes: number): string {
  return `[history: this call's original arguments (${bytes} bytes) were not a valid JSON object, so this copy of the conversation shows ${invalidArgumentsMarker(bytes)} in their place. That marker is not a tool input: never send it as arguments.]`;
}

/**
 * The synthesized answer to a call no result was recorded for. Wording matched
 * to `persisted-session.ts`'s `INTERRUPTED_NOTE` (core cannot import from
 * daemon, so this is its own constant). Never phrased like a success: the call
 * may or may not have run.
 */
export const UNANSWERED_CALL_NOTE =
  "Interrupted: no result was recorded for this call; it may or may not have run. Check before retrying.";

/** What the user is told (Part C): the counts that change what the model sees. */
export interface RepairCounts {
  readonly invalidArguments: number;
  readonly unansweredCalls: number;
  readonly orphanResults: number;
}

/** The repaired copy + what was repaired. */
export interface HistoryRepair {
  /** The INPUT array itself when there is nothing to repair (the payload stays byte-identical). */
  readonly messages: readonly ChatMessage[];
  readonly issues: readonly HistoryIssue[];
}

/** The ids `calls` names, for answering membership questions. */
function callIds(calls: readonly ToolCall[]): Set<string> {
  return new Set(calls.map((call) => call.id));
}

/** `message` with `suffix` appended to its `content`. */
function withContent(message: ChatMessage, suffix: string): ChatMessage {
  return { ...message, content: `${message.content}${suffix}` };
}

/**
 * The repaired copy of `messages` and what was repaired. The input array and
 * its message objects are never mutated. Rules (exact, in the doc):
 *   1. every call's arguments go through `wireArguments`;
 *   2. an invalid call's paired result says so (`invalidArgumentsNote`);
 *   3. an unanswered call gets a synthesized result at the END of its block;
 *   4. a `tool` message that answers nothing is left out of the copy;
 *   5. consecutive same-role messages are left alone;
 *   6. idempotent, and byte-identical (the same array) when nothing is wrong.
 */
export function repairHistory(messages: readonly ChatMessage[]): HistoryRepair {
  const issues: HistoryIssue[] = [];
  const out: ChatMessage[] = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) {
      i++;
      continue;
    }
    // A `tool` message before any block (or after a non-assistant one): it
    // answers nothing, so it is left out of the copy.
    if (message.role === "tool") {
      issues.push({ kind: "orphan_tool_result", index: i, toolCallId: message.toolCallId });
      changed = true;
      i++;
      continue;
    }
    const calls = message.toolCalls ?? [];
    if (message.role !== "assistant" || calls.length === 0) {
      out.push(message);
      i++;
      continue;
    }

    // The block: this assistant message plus the maximal run of `tool`
    // messages right after it (every producer's shape).
    let end = i + 1;
    while (messages[end]?.role === "tool") {
      end++;
    }
    const classes = calls.map((call) => classifyArguments(call.arguments));
    for (const [k, call] of calls.entries()) {
      const cls = classes[k];
      if (cls === undefined) {
        continue;
      }
      if (cls.kind === "empty") {
        issues.push({ kind: "empty_arguments", index: i, callId: call.id });
      } else if (cls.kind === "invalid") {
        issues.push({ kind: "invalid_arguments", index: i, callId: call.id, bytes: cls.bytes });
      }
    }
    const rewritten = calls.map((call, k) => {
      const cls = classes[k];
      return cls === undefined || cls.wire === call.arguments
        ? call
        : { ...call, arguments: cls.wire };
    });
    if (rewritten.some((call, k) => call !== calls[k])) {
      changed = true;
      out.push({ ...message, toolCalls: rewritten });
    } else {
      out.push(message);
    }

    // The block's own result messages, in order, minus the ones that answer
    // nothing (an undefined id, an unknown id, a second answer to the same id).
    const ids = callIds(calls);
    const answered = new Map<string, ChatMessage>();
    for (let j = i + 1; j < end; j++) {
      const result = messages[j];
      if (result === undefined) {
        continue;
      }
      const id = result.toolCallId;
      if (id === undefined || !ids.has(id) || answered.has(id)) {
        issues.push({ kind: "orphan_tool_result", index: j, toolCallId: id });
        changed = true;
        continue;
      }
      answered.set(id, result);
    }
    // The recorded results, in their order, each told about a replacement —
    // then the answers nobody wrote, at the end of the block, in call order.
    const notes = new Map<string, number>();
    for (const [k, call] of calls.entries()) {
      const cls = classes[k];
      if (cls?.kind === "invalid") {
        notes.set(call.id, cls.bytes);
      }
    }
    for (const result of answered.values()) {
      const bytes = result.toolCallId === undefined ? undefined : notes.get(result.toolCallId);
      if (bytes === undefined) {
        out.push(result);
      } else {
        out.push(withContent(result, `\n\n${invalidArgumentsNote(bytes)}`));
        changed = true;
      }
    }
    for (const call of calls) {
      if (answered.has(call.id)) {
        continue;
      }
      issues.push({ kind: "unanswered_call", index: i, callId: call.id });
      changed = true;
      const bytes = notes.get(call.id);
      out.push({
        role: "tool",
        content:
          bytes === undefined
            ? UNANSWERED_CALL_NOTE
            : `${UNANSWERED_CALL_NOTE}\n\n${invalidArgumentsNote(bytes)}`,
        toolCallId: call.id,
      });
    }
    i = end;
  }
  return { messages: changed ? out : messages, issues };
}

/** What is wrong with `messages` for the wire. `repairHistory` is the one implementation. */
export function validateHistory(messages: readonly ChatMessage[]): readonly HistoryIssue[] {
  return repairHistory(messages).issues;
}

/**
 * What the user is told: the issue counts that change what the model sees.
 * `null` when there is nothing to say — `empty_arguments` is NOT counted (the
 * registry already reads `""` as `{}`, so it is no error).
 */
export function repairCounts(issues: readonly HistoryIssue[]): RepairCounts | null {
  let invalidArguments = 0;
  let unansweredCalls = 0;
  let orphanResults = 0;
  for (const issue of issues) {
    switch (issue.kind) {
      case "invalid_arguments":
        invalidArguments++;
        break;
      case "unanswered_call":
        unansweredCalls++;
        break;
      case "orphan_tool_result":
        orphanResults++;
        break;
      case "empty_arguments":
        break;
    }
  }
  if (invalidArguments === 0 && unansweredCalls === 0 && orphanResults === 0) {
    return null;
  }
  return { invalidArguments, unansweredCalls, orphanResults };
}

/** `1 tool call` / `2 tool calls`. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The one notice line, shared by the TUI and the plain CLI renderer. */
export function describeRepairs(counts: RepairCounts): string {
  const parts: string[] = [];
  if (counts.invalidArguments > 0) {
    parts.push(
      plural(
        counts.invalidArguments,
        "tool call with invalid arguments",
        "tool calls with invalid arguments",
      ),
    );
  }
  if (counts.unansweredCalls > 0) {
    parts.push(plural(counts.unansweredCalls, "unanswered tool call", "unanswered tool calls"));
  }
  if (counts.orphanResults > 0) {
    parts.push(plural(counts.orphanResults, "stray tool result", "stray tool results"));
  }
  return `history repaired for the model: ${parts.join(", ")} — the saved session is unchanged`;
}

/**
 * Part B (the exception-safe tool loop): the `tool` messages that answer every
 * call of `calls` still unanswered in `owner`'s block, in call order, with
 * `noteFor(call)` as content. `[]` when `owner` is no longer in `messages` (a
 * context reset replaced the history) or when anything other than its results
 * follows its block — answers are only ever appended, never spliced in.
 */
export function answerOutstandingCalls(
  messages: readonly ChatMessage[],
  owner: ChatMessage,
  calls: readonly ToolCall[],
  noteFor: (call: ToolCall) => string,
): ChatMessage[] {
  const at = messages.lastIndexOf(owner);
  if (at === -1) {
    return [];
  }
  let end = at + 1;
  const answered = new Set<string>();
  while (messages[end]?.role === "tool") {
    const id = messages[end]?.toolCallId;
    if (id !== undefined) {
      answered.add(id);
    }
    end++;
  }
  if (end < messages.length) {
    return [];
  }
  const answers: ChatMessage[] = [];
  for (const call of calls) {
    if (answered.has(call.id)) {
      continue;
    }
    answered.add(call.id);
    answers.push({ role: "tool", content: noteFor(call), toolCallId: call.id });
  }
  return answers;
}

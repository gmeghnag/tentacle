/**
 * What "a turn suspended before a tool call" looks like in the history — the
 * one definition shared by the agent's resume seam (`runMessages` with
 * `resumeFrom`) and the daemon that records and reloads a suspension
 * (docs/feat/suspended-turn-resume.md). Pure.
 */
import type { ChatMessage, ToolCall } from "@tentacle/core";

/**
 * The calls still to run when the history is EXACTLY suspended before
 * `toolCallId`: the last `assistant` message calls it, and every message after
 * that assistant is a `tool` result answering — in order — exactly the calls
 * before it. Returns the calls from `toolCallId` on; `null` for any other shape
 * (unknown or answered id, an earlier call unanswered, a stray message).
 *
 * Strict on purpose: only this shape means "never started" (calls run in order
 * and a result is pushed before the next call starts). A history that merely
 * has unanswered calls may have one that was RUNNING — re-running it would
 * repeat its side effects.
 */
export function suspendedCalls(
  messages: readonly ChatMessage[],
  toolCallId: string,
): readonly ToolCall[] | null {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const calls = last >= 0 ? messages[last]?.toolCalls : undefined;
  if (!calls) {
    return null;
  }
  const index = calls.findIndex((c) => c.id === toolCallId);
  if (index < 0) {
    return null;
  }
  const after = messages.slice(last + 1);
  if (after.length !== index) {
    return null;
  }
  for (const [i, message] of after.entries()) {
    if (message.role !== "tool" || message.toolCallId !== calls[i]?.id) {
      return null;
    }
  }
  return calls.slice(index);
}

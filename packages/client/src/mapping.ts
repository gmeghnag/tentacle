/**
 * Reverse mapping: the wire `SessionUpdate` stream back into the local
 * `AgentEvent`s the Ink TUI already knows how to render, plus the `StopReason`
 * back into an `AgentStopReason`. The inverse of the daemon's `mapping.ts`.
 *
 * A remote `tool_call_update` carries only the diff *text* (not the add/remove
 * counts), so those are recomputed here from the patch — keeping the remote
 * diff render identical to a local one. Pure and unit-tested.
 */
import type { AgentEvent, AgentStopReason } from "@agent-harness/agent";
import type { ToolResultDetail } from "@agent-harness/core";
import type { ContentBlock, SessionUpdate, StopReason } from "@agent-harness/protocol";
import { DIFF_SCHEME } from "./constants.ts";

export function stopReasonFromProtocol(reason: StopReason): AgentStopReason {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "max_iterations":
      return "max_iterations";
    default:
      // end_turn / max_tokens / error all just end the turn for the TUI;
      // any error detail arrived as a prior update.
      return "end_turn";
  }
}

function textOf(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

function countDiff(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

/** Rebuild a tool result (with any diff detail) from update content blocks. */
function toolResultFromContent(
  content: readonly ContentBlock[] | undefined,
  isError: boolean,
): { content: string; isError?: boolean; details?: ToolResultDetail } {
  const texts: string[] = [];
  let details: ToolResultDetail | undefined;
  for (const block of content ?? []) {
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "resource" && block.uri.startsWith(DIFF_SCHEME) && block.text) {
      const { added, removed } = countDiff(block.text);
      details = {
        kind: "diff",
        path: block.uri.slice(DIFF_SCHEME.length),
        patch: block.text,
        added,
        removed,
      };
    }
  }
  return {
    content: texts.join("\n"),
    ...(isError ? { isError: true } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * Translate one `SessionUpdate` into an `AgentEvent`. `toolNames` carries the
 * tool name announced by a prior `tool_call` so a later `tool_call_update` can
 * reuse it (the wire update omits the name).
 */
export function updateToEvent(
  update: SessionUpdate,
  toolNames: Map<string, string>,
): AgentEvent | null {
  switch (update.type) {
    case "agent_message_chunk":
      return { type: "text", delta: textOf(update.content) };
    case "agent_thought_chunk":
      return { type: "reasoning", delta: textOf(update.content) };
    case "tool_call":
      toolNames.set(update.toolCallId, update.title);
      return {
        type: "tool_start",
        id: update.toolCallId,
        name: update.title,
        arguments:
          typeof update.rawInput === "string"
            ? update.rawInput
            : JSON.stringify(update.rawInput ?? {}),
      };
    case "tool_call_update":
      return {
        type: "tool_result",
        id: update.toolCallId,
        name: toolNames.get(update.toolCallId) ?? "tool",
        result: toolResultFromContent(update.content, update.status === "failed"),
      };
    case "agent_usage":
      return {
        type: "usage",
        usage: { promptTokens: update.promptTokens, completionTokens: update.completionTokens },
      };
    case "background_exit":
      return {
        type: "background_exit",
        jobId: update.jobId,
        command: update.command,
        status: update.status,
        exitCode: update.exitCode,
      };
    case "plan":
      return null;
  }
}

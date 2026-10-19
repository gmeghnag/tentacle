/**
 * Pure mapping from the agent's local `AgentEvent` stream to the wire
 * `SessionUpdate` vocabulary (and the turn's `StopReason`). Kept pure and
 * table-ish so it can be unit-tested without sockets or an agent.
 */
import type { AgentEvent, AgentStopReason } from "@tentacle/agent";
import type { ToolResult } from "@tentacle/core";
import {
  type ContentBlock,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type SessionUpdate,
  type StopReason,
  UPDATE_CLASS,
  type UpdateClass,
  text,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** MIME type used for the embedded unified-diff resource block. */
export const DIFF_MIME = "text/x-diff";

/** Flatten a prompt's content blocks to the plain-text the agent loop consumes. */
export function contentToText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Reject a prompt with any non-text block. The agent loop is text-only until
 * attachments land; dropping the block silently would let the model answer as
 * if it had seen the image (parent `session-reattach` point 18).
 */
export function assertTextOnly(content: readonly ContentBlock[]): void {
  const other = content.find((b) => b.type !== "text");
  if (other) {
    throw new RpcError(
      JsonRpcErrorCode.InvalidParams,
      `only text content is supported (got ${other.type}); see docs/eval/attachments.md`,
    );
  }
}

/** One `session/update` frame: `mandatory: true` iff the update's class is mandatory, else omitted. */
export function toUpdateParams(
  sessionId: string,
  seq: number,
  update: SessionUpdate,
  classes: Readonly<Record<SessionUpdate["type"], UpdateClass>> = UPDATE_CLASS,
): KnownSessionUpdateParams {
  return classes[update.type] === "mandatory"
    ? { sessionId, seq, mandatory: true, update }
    : { sessionId, seq, update };
}

export function stopReasonToProtocol(reason: AgentStopReason): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "max_iterations":
      return "max_iterations";
  }
}

function safeParseArgs(args: string): unknown {
  if (args.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Content blocks for a completed tool result. A structured diff rides as a
 * `resource` block (`text/x-diff`) so a remote client can render the same
 * git-style diff the local TUI does.
 */
export function toolResultContent(result: ToolResult): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (result.content.trim() !== "") {
    blocks.push(text(result.content));
  }
  if (result.details?.kind === "diff") {
    blocks.push({
      type: "resource",
      uri: `diff://${result.details.path}`,
      mimeType: DIFF_MIME,
      text: result.details.patch,
    });
  }
  return blocks;
}

/**
 * Map one `AgentEvent` to a `SessionUpdate`, or `null` for `turn_end` (whose
 * stop reason resolves the pending `session/prompt` instead of streaming).
 */
export function eventToUpdate(event: AgentEvent): SessionUpdate | null {
  switch (event.type) {
    case "text":
      return { type: "agent_message_chunk", content: text(event.delta) };
    case "reasoning":
      return { type: "agent_thought_chunk", content: text(event.delta) };
    case "tool_start":
      return {
        type: "tool_call",
        toolCallId: event.id,
        title: event.name,
        status: "in_progress",
        rawInput: safeParseArgs(event.arguments),
      };
    case "tool_result":
      return {
        type: "tool_call_update",
        toolCallId: event.id,
        status: event.result.isError ? "failed" : "completed",
        content: toolResultContent(event.result),
      };
    case "usage":
      return {
        type: "agent_usage",
        promptTokens: event.usage.promptTokens,
        completionTokens: event.usage.completionTokens,
      };
    // A steering message was injected into the running turn; the client drops
    // the matching optimistic ⏳ entry FIFO. Covers both injection points in
    // the agent loop (the per-round drain and the late-steer before turn_end).
    case "steer":
      return { type: "steer", text: event.text };
    // Nested sub-agent progress is a local-TUI nicety; remote clients see the
    // `agent_task` tool opaquely (its final report rides the tool_call_update).
    // A background-job exit likewise isn't streamed to remote clients yet (the
    // model still gets its injected note server-side, so behaviour is correct).
    case "subagent_start":
    case "subagent_tool":
    case "subagent_end":
    case "background_exit":
    case "turn_end":
      return null;
  }
}

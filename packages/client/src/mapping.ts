/**
 * Reverse mapping: the wire `SessionUpdate` stream back into the local
 * `AgentEvent`s the Ink TUI already knows how to render, plus the `StopReason`
 * back into an `AgentStopReason`. The inverse of the daemon's `mapping.ts`.
 *
 * A remote `tool_call_update` carries only the diff *text* (not the add/remove
 * counts), so those are recomputed here from the patch — keeping the remote
 * diff render identical to a local one. Pure and unit-tested.
 */
import type { AgentEvent, AgentStopReason } from "@tentacle/agent";
import type { ChatMessage, ToolResult, ToolResultDetail } from "@tentacle/core";
import {
  type ContentBlock,
  type SessionUpdate,
  type SessionUpdateParams,
  SessionUpdateSchema,
  type StopReason,
  isKnownUpdateType,
} from "@tentacle/protocol";
import { DIFF_SCHEME, HOOK_SCHEME } from "./constants.ts";

/**
 * What a frontend folds from a remote turn: the agent's events, plus two that
 * only a reconnect produces — replace everything shown with `messages` (a
 * resync), and the turn's own prompt re-delivered after such a reset.
 * Structurally identical to the TUI's `SessionEvent` (the TUI does not depend
 * on this package).
 */
export type SessionEvent =
  | AgentEvent
  | { readonly type: "history_reset"; readonly messages: readonly ChatMessage[] }
  | { readonly type: "user_message"; readonly text: string }
  /**
   * The daemon sent an update type this client does not know (a newer
   * daemon's, display class): shown once per type per session, then skipped.
   */
  | { readonly type: "unsupported"; readonly kind: string };

/** What the client does with one `session/update` frame. */
export type ClassifiedUpdate =
  | { readonly kind: "update"; readonly update: SessionUpdate }
  | { readonly kind: "unsupported"; readonly type: string }
  | { readonly kind: "error"; readonly error: Error };

/**
 * Apply the event-class rule (parent `session-reattach` §14, decision E) to a
 * frame the peer already validated against the catch-all union: a known valid
 * update is handled; a known type that fails its member is malformed; an
 * unknown one is `unsupported` (skipped, and the user is told once per type —
 * docs/feat/protocol-v10-forward-compat.md) unless the frame says it is
 * mandatory. Never silent on anything a client must act on.
 */
export function classifyUpdate(params: SessionUpdateParams): ClassifiedUpdate {
  const known = SessionUpdateSchema.safeParse(params.update);
  if (known.success) return { kind: "update", update: known.data };
  const { type } = params.update;
  if (isKnownUpdateType(type)) {
    return { kind: "error", error: new Error(`malformed ${type} update from the daemon`) };
  }
  if (params.mandatory) {
    return {
      kind: "error",
      error: new Error(
        `unknown mandatory update "${type}": the daemon is newer than this client — update tentacle`,
      ),
    };
  }
  return { kind: "unsupported", type };
}

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
): ToolResult {
  const texts: string[] = [];
  let details: ToolResultDetail | undefined;
  let hook: ToolResult["hook"];
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
    } else if (block.type === "resource" && block.uri.startsWith(HOOK_SCHEME)) {
      hook = parseHookResource(block.uri.slice(HOOK_SCHEME.length), block.text) ?? hook;
    }
  }
  return {
    content: texts.join("\n"),
    ...(isError ? { isError: true } : {}),
    ...(details ? { details } : {}),
    ...(hook ? { hook } : {}),
  };
}

/** `<action>/<name>` (the name may contain `/`: split on the first one only). */
function parseHookResource(rest: string, reason: string | undefined): ToolResult["hook"] {
  const slash = rest.indexOf("/");
  const action = slash < 0 ? rest : rest.slice(0, slash);
  const name = slash < 0 ? "" : rest.slice(slash + 1);
  if ((action !== "blocked" && action !== "modified") || name === "") {
    return undefined;
  }
  return { action, name, ...(reason !== undefined && reason !== "" ? { reason } : {}) };
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
    // A steering message was injected; the TUI drops the matching ⏳ entry FIFO.
    case "steer":
      return { type: "steer", text: update.text };
    case "context_note":
      return { type: "context_note", text: update.text, reason: update.reason };
    // The turn bracket is consumed by `RemoteSession` (it ends the turn by
    // `turnId`); it is not an `AgentEvent` of its own. `history_replaced`
    // cannot arrive inside a turn (a compaction is exclusive with one), and the
    // client that compacted reads the new history back itself. `session_closed`
    // is consumed by `RemoteClient`/`RemoteSession` (it ends the session). The
    // permission events are consumed by `RemoteClient`'s `PermissionRouter`;
    // `session_title` by its title listeners (it is not turn-scoped).
    case "session_title":
    case "plan":
    case "turn_start":
    case "turn_end":
    case "history_replaced":
    case "session_closed":
    case "permission_request":
    case "permission_resolved":
      return null;
  }
}

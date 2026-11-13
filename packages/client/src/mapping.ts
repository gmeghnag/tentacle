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
import type { AttachmentRef, ChatMessage, ToolResult, ToolResultDetail } from "@tentacle/core";
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
  /**
   * The turn's prompt, re-delivered after a reset (or another device's, on a
   * turn this client attached to). `attachments`: the image refs it named
   * (docs/feat/attachments-tui.md D3) — absent for a text-only prompt.
   */
  | {
      readonly type: "user_message";
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
    }
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
    case "max_token_budget":
      return "max_token_budget";
    default:
      // end_turn / max_tokens / error all just end the turn for the TUI;
      // any error detail arrived as a prior update.
      return "end_turn";
  }
}

const PROGRESS_TEXT_MAX = 200;

/**
 * Text from a daemon that may be a pod (not trusted): control characters
 * (terminal escapes, newlines) become spaces and the length is capped.
 */
export function progressText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return clean.length > PROGRESS_TEXT_MAX ? `${clean.slice(0, PROGRESS_TEXT_MAX - 1)}…` : clean;
}

/**
 * A `background_exit`'s TWO pod-supplied strings (Review 5, fix round 1): the id
 * and the command reach the transcript's notice and the dock's pill, so both take
 * the SAME treatment a job's row does — control chars gone, the invisible format
 * classes stripped, one line, bounded. ONE function for both doors
 * (`remote-client`'s `deliver` and `updateToEvent`), so they cannot drift.
 *
 * The format classes are stripped, not spaced: `\u202e` reorders a line without
 * being a control char, and a space in its place would be a lie about the width.
 */
export function gateExitText(
  jobId: string,
  command: string,
  cap: number = PROGRESS_TEXT_MAX,
): { jobId: string; command: string } {
  return { jobId: gateLabel(jobId, cap), command: gateLabel(command, cap) };
}

function gateLabel(value: string, cap: number): string {
  const clean = progressText(value).replace(INVISIBLE_TEXT, "").trim();
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** The bidi overrides and zero-width spaces: invisible, and reorderable. */
const INVISIBLE_TEXT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Reverse of the daemon's `subagent_*` mapping. A progress frame is a label:
 * an unknown kind (a newer daemon's) or a known kind missing its fields is
 * ignored, never a thrown error that would fail the turn.
 */
function progressToEvent(
  update: Extract<SessionUpdate, { type: "tool_progress" }>,
): AgentEvent | null {
  const id = update.toolCallId;
  switch (update.kind) {
    case "subagent_start":
      return update.agentType !== undefined && update.description !== undefined
        ? {
            type: "subagent_start",
            id,
            agentType: progressText(update.agentType),
            description: progressText(update.description),
          }
        : null;
    case "subagent_tool":
      return update.label !== undefined
        ? { type: "subagent_tool", id, label: progressText(update.label) }
        : null;
    case "subagent_usage":
      return update.promptTokens !== undefined && update.completionTokens !== undefined
        ? {
            type: "subagent_usage",
            id,
            promptTokens: update.promptTokens,
            completionTokens: update.completionTokens,
          }
        : null;
    case "subagent_end":
      return update.toolUses !== undefined && update.stopReason !== undefined
        ? {
            type: "subagent_end",
            id,
            toolUses: update.toolUses,
            stopReason: progressText(update.stopReason),
            ...(update.agentId !== undefined ? { agentId: progressText(update.agentId) } : {}),
          }
        : null;
    default:
      return null;
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
        result: {
          ...toolResultFromContent(update.content, update.status === "failed"),
          // The field only, never derived from the banner text (docs/feat/tui-spill-note.md).
          ...(update.spill ? { spill: update.spill } : {}),
          // Likewise: the field only, never parsed from the denial text (docs/feat/permission-reply.md).
          ...(update.denialReply !== undefined ? { denialReply: update.denialReply } : {}),
        },
        // Beside the result, never inside it: a tool cannot set it (docs/fix/tool-duration.md).
        ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      };
    case "agent_usage":
      return {
        type: "usage",
        usage: { promptTokens: update.promptTokens, completionTokens: update.completionTokens },
      };
    case "background_exit":
      return {
        type: "background_exit",
        // Gated HERE too (Review 5): this is the second door a pod's strings can
        // take out of a frame, and both must agree (`gateExitText`).
        ...gateExitText(update.jobId, update.command),
        status: update.status,
        exitCode: update.exitCode,
        ...(update.agent ? { agent: update.agent } : {}),
      };
    // A steering message was injected; the TUI drops the ⏳ entry of that id
    // (FIFO only for an older daemon, which names none).
    case "steer":
      return { type: "steer", text: update.text, ...(update.id ? { id: update.id } : {}) };
    case "context_note":
      return { type: "context_note", text: update.text, reason: update.reason };
    case "dsml_leak":
      // Its own kind, so an older client skips it (docs/fix/deepseek-dsml-leak.md).
      return { type: "dsml_leak", text: update.text };
    case "truncated_reply":
      // A cut reply / an empty turn: notices only (docs/fix/truncated-reply-silent.md).
      // `retrying` is the LOOP's fact, never re-derived from the reason here (that
      // guess is the bug: it promised a continuation the loop had no budget for,
      // Review MEDIUM-2). A daemon too old to send it means `false`: the notice
      // never claims a re-ask that this client cannot verify.
      return {
        type: "truncated_reply",
        reason: update.reason,
        retrying: update.retrying ?? false,
      };
    case "empty_turn":
      return { type: "empty_turn" };
    case "history_repaired":
      return {
        type: "history_repaired",
        invalidArguments: update.invalidArguments,
        unansweredCalls: update.unansweredCalls,
        orphanResults: update.orphanResults,
      };
    case "tool_progress":
      return progressToEvent(update);
    // A call's phase in its round: an unknown (newer) phase is skipped.
    case "tool_call_phase":
      return update.phase === "queued" || update.phase === "running"
        ? { type: "tool_phase", id: update.toolCallId, phase: update.phase }
        : null;
    // The turn bracket is consumed by `RemoteSession` (it ends the turn by
    // `turnId`); it is not an `AgentEvent` of its own. `history_replaced` is
    // the barrier the reducer resyncs on; `RemoteSession` turns the snapshot
    // into the event: a compaction's (between turns) replaces what is shown, a
    // `context_reset`'s (INSIDE a turn) becomes that turn's `context_reset`
    // event (the screen is kept, the turn goes on). `session_closed`
    // is consumed by `RemoteClient`/`RemoteSession` (it ends the session). The
    // permission events are consumed by `RemoteClient`'s `PermissionRouter`;
    // `session_title` by its title listeners (it is not turn-scoped), and
    // `queued` by its queue listeners (`RemoteClient`, not turn-scoped either),
    // `subagents` by its own (likewise), `jobs` by its own (a shell job's list,
    // likewise), `subagent_notify` by its notify
    // listeners (a child's message to the agent, likewise), `subagent_message`
    // by its own (the USER's message to a child, likewise), `session_settings`
    // by its settings-change listeners (likewise).
    case "session_title":
    case "queued":
    case "subagents":
    case "jobs":
    case "subagent_notify":
    case "subagent_message":
    case "session_settings":
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

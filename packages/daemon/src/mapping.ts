/**
 * Pure mapping from the agent's local `AgentEvent` stream to the wire
 * `SessionUpdate` vocabulary (and the turn's `StopReason`). Kept pure and
 * table-ish so it can be unit-tested without sockets or an agent.
 */
import type { AgentEvent, AgentStopReason } from "@tentacle/agent";
import type { ToolResult } from "@tentacle/core";
import {
  BLOCKING_UPDATE_TYPES,
  type ContentBlock,
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  MAX_SKILL_CATALOG,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_LIST,
  MAX_SKILL_PROBLEMS,
  type SessionUpdate,
  type SkillListEntry,
  SkillNameSchema,
  type SkillSummary,
  type SkillsListResult,
  type StopReason,
  UPDATE_CLASS,
  type UpdateClass,
  clientSupportsUpdate,
  text,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** MIME type used for the embedded unified-diff resource block. */
export const DIFF_MIME = "text/x-diff";
/** A user hook's intervention on a call (H1, docs/feat/hooks-core.md): `hook://<action>/<name>`, reason in `text`. */
export const HOOK_MIME = "application/x-tentacle-hook";

/** Control characters (C0, DEL, C1): never in a wire skill description. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * The `initialize` skill catalog from the daemon's `/name` skills: always
 * valid for `SkillSummarySchema` (the client rejects the whole handshake
 * otherwise) — a non-spec name is dropped, a description becomes one line
 * (control characters → a space, whitespace collapsed), cut to the limit;
 * an empty one drops the skill; at most `MAX_SKILL_CATALOG`, in order.
 */
export function toSkillCatalog(
  skills: readonly { readonly name: string; readonly description: string }[],
): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const { name, description } of skills) {
    if (out.length >= MAX_SKILL_CATALOG) {
      break;
    }
    const line = description.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
    const cut = line.slice(0, MAX_SKILL_DESCRIPTION).trimEnd();
    if (SkillNameSchema.safeParse(name).success && cut !== "") {
      out.push({ name, description: cut });
    }
  }
  return out;
}

/** One wire line: control characters → a space, whitespace collapsed, cut to `max`. */
export function wireLine(text: string, max: number): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max).trimEnd();
}

/**
 * The `skills/list` result from the daemon's discovery (docs/feat/skills-panel.md):
 * always valid for `SkillsListResultSchema` (the client rejects the whole
 * result otherwise) — every string one line cut to its cap, an entry left
 * with an empty one dropped; past `MAX_SKILL_LIST` skills one problem says how
 * many were left out; past `MAX_SKILL_PROBLEMS` problems the rest are counted.
 */
export function toSkillList(listing: {
  readonly skills: readonly SkillListEntry[];
  readonly problems: readonly string[];
}): SkillsListResult {
  const skills: SkillListEntry[] = [];
  for (const s of listing.skills.slice(0, MAX_SKILL_LIST)) {
    const name = wireLine(s.name, 256);
    const description = wireLine(s.description, MAX_SKILL_DESCRIPTION);
    const location = wireLine(s.location, 4096);
    if (name !== "" && description !== "" && location !== "") {
      skills.push({ name, description, scope: s.scope, user: s.user, model: s.model, location });
    }
  }
  const left = listing.skills.length - MAX_SKILL_LIST;
  const all = [
    ...(left > 0 ? [`${left} more skills not listed (at most ${MAX_SKILL_LIST})`] : []),
    ...listing.problems.map((p) => wireLine(p, 1000)).filter((p) => p !== ""),
  ];
  const problems = all.slice(0, MAX_SKILL_PROBLEMS);
  return { skills, problems, moreProblems: all.length - problems.length };
}

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

/** One `session/update` frame: `mandatory: true` iff the update's class is mandatory or blocking, else omitted. */
export function toUpdateParams(
  sessionId: string,
  seq: number,
  update: SessionUpdate,
  classes: Readonly<Record<SessionUpdate["type"], UpdateClass>> = UPDATE_CLASS,
): KnownSessionUpdateParams {
  return classes[update.type] !== "display"
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
  if (result.hook) {
    blocks.push({
      type: "resource",
      uri: `hook://${result.hook.action}/${result.hook.name}`,
      mimeType: HOOK_MIME,
      ...(result.hook.reason !== undefined ? { text: result.hook.reason } : {}),
    });
  }
  return blocks;
}

/**
 * Map one `AgentEvent` to a `SessionUpdate`, or `null` for events that are not
 * streamed as-is. `turn_end` is `null` here: `HostedSession` owns the turn
 * bracket (`turn_start`/`turn_end`, tagged with the client's `turnId`), and
 * consumes `history_commit` itself (the snapshot cut).
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
    case "context_note":
      return { type: "context_note", text: event.text, reason: event.reason };
    // Nested sub-agent progress is a local-TUI nicety; remote clients see the
    // `agent_task` tool opaquely (its final report rides the tool_call_update).
    // A background-job exit likewise isn't streamed to remote clients yet (the
    // model still gets its injected note server-side, so behaviour is correct).
    case "subagent_start":
    case "subagent_tool":
    case "subagent_end":
    case "background_exit":
    case "history_commit":
    case "turn_end":
      return null;
  }
}

/**
 * The frame as one client receives it: a BLOCKING update its client did not
 * declare at `initialize` goes WITHOUT `mandatory` (it shows `unsupported` and
 * never fails or cancels the shared turn); `seq` is unchanged, so the stream
 * stays contiguous (docs/feat/protocol-v10-forward-compat.md).
 */
export function frameFor(
  params: KnownSessionUpdateParams,
  declared: readonly string[] | undefined,
): KnownSessionUpdateParams {
  const type = params.update.type;
  if (
    params.mandatory &&
    BLOCKING_UPDATE_TYPES.has(type) &&
    !clientSupportsUpdate(declared, type)
  ) {
    const { mandatory: _drop, ...display } = params;
    return display;
  }
  return params;
}

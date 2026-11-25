/**
 * Bridge between the local permission vocabulary (`PermissionRequest`/
 * `PermissionResponse`, with a `once`/`session` scope) and the wire vocabulary
 * (`PermissionOption`/`PermissionOutcome`). The daemon offers the options; the
 * client's selection maps back to a gate decision. Pure and table-driven.
 */
import {
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  onceOnlyAsk,
} from "@tentacle/core";
import {
  MAX_PERMISSION_REPLY_CHARS,
  MAX_QUESTION_ANSWER_CHARS,
  type PermissionOption,
  type PermissionOutcome,
  type PermissionRequestUpdate,
  QUESTION_ANSWER_OPTION,
  QUESTION_SKIP_OPTION,
  type QuestionRequestUpdate,
} from "@tentacle/protocol";

/** The options the daemon offers for an approval; the "always" label reflects
 * the suggested rule (a command prefix) when one is present. */
export function permissionOptions(req: PermissionRequest): PermissionOption[] {
  const alwaysName = req.suggestion
    ? `Allow \`${req.suggestion.prefix}\` commands for this session`
    : "Allow for the rest of this session";
  // A workflow's hash approval / approve step is allow-once or deny only: a
  // lasting answer would wave through a merge (docs/feat/agent-workflows.md D3).
  // A browser action likewise: each one acts as the user on the web (B5).
  if (onceOnlyAsk(req)) {
    return [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ];
  }
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: alwaysName, kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];
}

/**
 * The stream event for one ask; `requestId` is its nonce (fresh per ask).
 * `agent`: the sub-agent that asked (the requester's `options.agent`).
 */
export function toPermissionRequestUpdate(
  requestId: string,
  toolCallId: string,
  req: PermissionRequest,
  agent?: PermissionRequestOptions["agent"],
): PermissionRequestUpdate {
  return {
    type: "permission_request",
    requestId,
    toolCallId,
    tool: req.tool,
    title: req.title,
    ...(req.detail ? { explanation: req.detail } : {}),
    ...(req.suggestion ? { suggestion: { prefix: req.suggestion.prefix } } : {}),
    options: permissionOptions(req),
    ...(agent
      ? {
          agent: {
            type: agent.type,
            description: agent.description,
            ...(agent.id !== undefined ? { id: agent.id } : {}),
          },
        }
      : {}),
    // This daemon carries a reply with a refusal to the model (docs/feat/permission-reply.md).
    reply: { maxChars: MAX_PERMISSION_REPLY_CHARS },
  };
}

/**
 * The stream event for a remote agent's question (docs/feat/a2a-client.md C6):
 * the request's `detail` is the question, its `reply.maxChars` the answer's
 * bound (never above `MAX_QUESTION_ANSWER_CHARS`).
 */
export function toQuestionRequestUpdate(
  requestId: string,
  toolCallId: string,
  req: PermissionRequest,
  agent?: PermissionRequestOptions["agent"],
): QuestionRequestUpdate {
  return {
    type: "question_request",
    requestId,
    toolCallId,
    title: req.title,
    question: req.detail ?? "",
    ...(agent
      ? {
          agent: {
            type: agent.type,
            description: agent.description,
            ...(agent.id !== undefined ? { id: agent.id } : {}),
          },
        }
      : {}),
    maxChars: Math.min(req.reply?.maxChars ?? MAX_QUESTION_ANSWER_CHARS, MAX_QUESTION_ANSWER_CHARS),
  };
}

/** The update an ask is streamed as: a question, or a permission request. */
export function toAskUpdate(
  requestId: string,
  toolCallId: string,
  req: PermissionRequest,
  agent?: PermissionRequestOptions["agent"],
): PermissionRequestUpdate | QuestionRequestUpdate {
  return req.kind === "question"
    ? toQuestionRequestUpdate(requestId, toolCallId, req, agent)
    : toPermissionRequestUpdate(requestId, toolCallId, req, agent);
}

/** The internal options a question settles with (`answerQuestion`). */
export const QUESTION_OPTIONS: readonly string[] = [QUESTION_ANSWER_OPTION, QUESTION_SKIP_OPTION];

export function outcomeToResponse(outcome: PermissionOutcome): PermissionResponse {
  if (outcome.outcome === "cancelled") {
    return { allowed: false };
  }
  switch (outcome.optionId) {
    // A question answered (its text rides `message`); only a question offers it.
    case QUESTION_ANSWER_OPTION:
      return { allowed: true, scope: "once" };
    case "allow_once":
      return { allowed: true, scope: "once" };
    case "allow_always":
      return { allowed: true, scope: "session" };
    default:
      return { allowed: false };
  }
}

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
  type PermissionOption,
  type PermissionOutcome,
  type PermissionRequestUpdate,
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
 * `workflow`: the workflow step (or run / schedule approval) it belongs to
 * (the requester's `options.workflow`, docs/fix/mobile-ask-surfaces.md D1) —
 * display only, and dropped unless its `name` is a string.
 */
export function toPermissionRequestUpdate(
  requestId: string,
  toolCallId: string,
  req: PermissionRequest,
  agent?: PermissionRequestOptions["agent"],
  workflow?: PermissionRequestOptions["workflow"],
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
    // Field by field, never by spread: the wire carries the five known keys and
    // nothing a requester may have put beside them.
    ...(workflow !== undefined && typeof workflow.name === "string"
      ? {
          workflow: {
            name: workflow.name,
            ...(workflow.runId !== undefined ? { runId: workflow.runId } : {}),
            ...(workflow.stepId !== undefined ? { stepId: workflow.stepId } : {}),
            ...(workflow.index !== undefined ? { index: workflow.index } : {}),
            ...(workflow.count !== undefined ? { count: workflow.count } : {}),
          },
        }
      : {}),
    // This daemon carries a reply with a refusal to the model (docs/feat/permission-reply.md).
    reply: { maxChars: MAX_PERMISSION_REPLY_CHARS },
  };
}

export function outcomeToResponse(outcome: PermissionOutcome): PermissionResponse {
  if (outcome.outcome === "cancelled") {
    return { allowed: false };
  }
  switch (outcome.optionId) {
    case "allow_once":
      return { allowed: true, scope: "once" };
    case "allow_always":
      return { allowed: true, scope: "session" };
    default:
      return { allowed: false };
  }
}

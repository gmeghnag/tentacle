/**
 * Bridge between the local permission vocabulary (`PermissionRequest`/
 * `PermissionResponse`, with a `once`/`session` scope) and the wire vocabulary
 * (`PermissionOption`/`PermissionOutcome`). The daemon offers the options; the
 * client's selection maps back to a gate decision. Pure and table-driven.
 */
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import type {
  PermissionOption,
  PermissionOutcome,
  RequestPermissionParams,
  SessionId,
} from "@tentacle/protocol";

/** The options the daemon offers for an approval; the "always" label reflects
 * the suggested rule (a command prefix) when one is present. */
export function permissionOptions(req: PermissionRequest): PermissionOption[] {
  const alwaysName = req.suggestion
    ? `Allow \`${req.suggestion.prefix}\` commands for this session`
    : "Allow for the rest of this session";
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: alwaysName, kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];
}

export function toRequestPermissionParams(
  sessionId: SessionId,
  toolCallId: string,
  req: PermissionRequest,
): RequestPermissionParams {
  return {
    sessionId,
    toolCallId,
    title: req.title,
    ...(req.detail ? { explanation: req.detail } : {}),
    options: permissionOptions(req),
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

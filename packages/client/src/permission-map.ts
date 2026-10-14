/**
 * Client-side permission bridge: the user's local `PermissionResponse` (from the
 * TUI prompt) → the wire `PermissionOutcome` the daemon expects. Inverse of the
 * daemon's `outcomeToResponse`.
 */
import type { PermissionResponse } from "@agent-harness/core";
import type { PermissionOutcome } from "@agent-harness/protocol";

export function responseToOutcome(response: PermissionResponse): PermissionOutcome {
  if (!response.allowed) {
    return { outcome: "selected", optionId: "reject_once" };
  }
  return {
    outcome: "selected",
    optionId: response.scope === "session" ? "allow_always" : "allow_once",
  };
}

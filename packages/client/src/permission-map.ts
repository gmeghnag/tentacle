/**
 * Client-side permission bridge: the user's local `PermissionResponse` (from the
 * TUI prompt) → the wire `PermissionOutcome` the daemon expects. Inverse of the
 * daemon's `outcomeToResponse`.
 */
import type { AnswerLostCause, PermissionResponse } from "@tentacle/core";
import { MAX_PERMISSION_REPLY_CHARS, type PermissionOutcome } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { SessionLostError } from "./session-lost.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping them is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A reply as it may go on the wire (docs/feat/permission-reply.md), shared by
 * every frontend: CRLF/CR → LF, control characters dropped but `\n` and `\t`,
 * trimmed, clamped to `maxChars` (never above `MAX_PERMISSION_REPLY_CHARS`: a
 * pod may advertise anything). Nothing left → null (a plain No).
 */
export function normalizePermissionReply(text: string, maxChars: number): string | null {
  const limit = Math.max(0, Math.min(Math.floor(maxChars), MAX_PERMISSION_REPLY_CHARS));
  const clean = text.replace(/\r\n?/g, "\n").replace(CONTROLS, "").trim().slice(0, limit).trimEnd();
  return clean === "" ? null : clean;
}

/**
 * Why a sent reply's `session/resolve_permission` failed, as the person is
 * told (`onAnswerLost`): no longer pending → `settled` (another answer won);
 * the session recreated mid-send → `session-lost` (it may have arrived);
 * anything else → `failed`.
 */
export function answerLostCause(error: unknown): AnswerLostCause {
  if (error instanceof SessionLostError) {
    return "session-lost";
  }
  if (error instanceof RpcError && error.code === DomainErrorCode.PermissionNotPending) {
    return "settled";
  }
  return "failed";
}

export function responseToOutcome(response: PermissionResponse): PermissionOutcome {
  if (!response.allowed) {
    return { outcome: "selected", optionId: "reject_once" };
  }
  return {
    outcome: "selected",
    optionId: response.scope === "session" ? "allow_always" : "allow_once",
  };
}

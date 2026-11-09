/**
 * `/clear` (docs/feat/clear-keeps-jobs.md): the pure decision the App executes.
 * `/clear` resets the conversation inside the same session (`session/clear`);
 * background jobs and sub-agents keep running.
 */

export type ClearStep =
  /** The session has no `clear` (the in-process fallback): close it and start a new one. */
  | "legacy"
  /** A `/clear` of this TUI is already in flight. */
  | "busy"
  /** A compaction holds the session. */
  | "compacting"
  /** Our own turn runs: stop it, then clear when it has ended. */
  | "stop_then_clear"
  /** Ask the daemon (another device's running turn is answered `TurnInProgress`). */
  | "clear";

export function clearCommandStep(input: {
  readonly canClear: boolean;
  readonly running: boolean;
  readonly ownTurn: boolean;
  readonly compacting: boolean;
  readonly clearing: boolean;
}): ClearStep {
  if (!input.canClear) {
    return "legacy";
  }
  if (input.clearing) {
    return "busy";
  }
  if (input.compacting) {
    return "compacting";
  }
  if (input.running && input.ownTurn) {
    return "stop_then_clear";
  }
  return "clear";
}

/** A refused or failed `/clear`: nothing changed, the chat is still this session's. */
export function clearFailedNotice(message: string): string {
  return `_/clear failed: ${message} — still in this session_`;
}

/**
 * The notice for a `/clear` that rejected. A dropped link (the client never
 * re-sends a clear: "… not retried") may have landed daemon-side: the screen
 * then follows the daemon's replay or snapshot, so it does not say "still in
 * this session".
 */
export function clearErrorNotice(message: string): string {
  return /not retried/i.test(message)
    ? "_/clear: no answer — the screen follows the daemon when the link is back_"
    : clearFailedNotice(message);
}

/** Another device cleared the shared conversation. */
export const CLEARED_ELSEWHERE_NOTICE = "_the conversation was cleared on another device_";

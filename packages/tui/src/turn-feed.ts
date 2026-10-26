/**
 * What the App does with the session's own activity — a turn another device
 * started, a history the daemon replaced the screen with, the session ending
 * daemon-side (docs/feat/tui-foreign-turns.md C2/C6/C8). Pure, React-free:
 * `App.tsx` only executes these decisions.
 */
import type { ChatMessage } from "@tentacle/core";
import { SendNowErrorCode, errorCode } from "./send-now.ts";
import type { DisplayItem, SessionEvent } from "./state.ts";

/**
 * The session's activity as the controller reports it (structurally
 * `@tentacle/client`'s `SessionActivity`).
 */
export type SessionActivity =
  /** A turn this session did not start (or one already running when it attached). */
  | {
      readonly kind: "turn";
      readonly turnId: string;
      readonly events: AsyncIterable<SessionEvent>;
      /** Stop it, whoever started it. */
      cancel(): void;
    }
  /** The daemon's history replaced what is shown while no turn runs. */
  | {
      readonly kind: "history";
      readonly messages: readonly ChatMessage[];
      readonly compacted: boolean;
    }
  /** The session ended daemon-side (another device's close / delete, the reaper). */
  | { readonly kind: "closed"; readonly reason: "closed" | "deleted" };

export type FeedStep = "consume" | "hold" | "history" | "closed";

/**
 * One activity, now. `inFlight`: one of this TUI's runs is streaming (or a
 * send-now of mine waits for its turn). A turn then is HELD (its events
 * buffer, nothing is lost) and consumed when that run settles: the only
 * overlaps are an own prompt that lost the slot (it will reject) and a
 * hand-off (the old end precedes the new turn's updates). A replacing history
 * waits the same way; a compaction's only adds a notice, so it never waits.
 * During my own `/compact` no run streams: a turn is consumed at once.
 */
export function nextStep(input: {
  readonly inFlight: boolean;
  readonly activity: SessionActivity;
}): FeedStep {
  const { activity, inFlight } = input;
  switch (activity.kind) {
    case "turn":
      return inFlight ? "hold" : "consume";
    case "history":
      return inFlight && !activity.compacted ? "hold" : "history";
    case "closed":
      return "closed";
  }
}

/**
 * A `history` activity: a compaction keeps the transcript (owner QR1), with a
 * notice unless it was mine (`ownCompaction`: a `/compact` of this TUI whose
 * history has not arrived yet — it says "Context compacted" itself). Any other
 * history (eager open, a resync after a gap) replaces the transcript: the
 * daemon's history is the truth, and this TUI may have missed turns.
 */
export function historyAction(input: {
  readonly compacted: boolean;
  readonly ownCompaction: boolean;
}): "replace" | "notice" | "none" {
  if (!input.compacted) {
    return "replace";
  }
  return input.ownCompaction ? "none" : "notice";
}

export const FOREIGN_COMPACTED_NOTICE = "_the conversation was compacted on another device_";

/**
 * The session ended elsewhere: what happened, and that the next prompt starts
 * a fresh session (the App swaps to one; docs/feat/connect-sessions.md). A
 * closed one is archived, so `/sessions` (when the runtime lists) can reopen
 * it; a deleted one cannot come back.
 */
export function closedNotice(reason: "closed" | "deleted", canList = false): string {
  const next = "what you type next starts a new session";
  return reason === "deleted"
    ? `_this session was deleted on another device — ${next}_`
    : `_this session was closed on another device — ${next}${canList ? " (/sessions to reopen it)" : ""}_`;
}

/** An own prompt that lost the slot: its text is back in the input (decision 15). */
export const SLOT_LOST_NOTICE =
  "_another device started a turn — your message is back in the input (Enter now queues it)_";

/**
 * An own prompt's turn failed: did it lose the slot to another device's turn
 * (refused `TurnInProgress` before it streamed anything)? Then it is
 * withdrawn, not failed. Decided by the error CODE, never its text.
 */
export function lostSlot(error: unknown, streamed: boolean): boolean {
  return !streamed && errorCode(error) === SendNowErrorCode.TurnInProgress;
}

/**
 * Past this many items a history is warmed in time-budgeted chunks before it
 * is committed (the resize pattern), so a long history never stalls input.
 * Fixed by T-C8's measurement (the task doc's Execution): ~850 µs per item
 * on heavy content (code, diffs, a spilled result), so 50 items stay under
 * ~50 ms laid out at once; plain text costs ~140 µs per item.
 */
export const WARM_THRESHOLD = 50;

export const needsWarm = (items: number): boolean => items > WARM_THRESHOLD;

export const loadingLabel = (done: number, total: number): string =>
  `loading history (${done}/${total})…`;

/**
 * Commit a warmed history: `next` replaces what was shown when the warm
 * began (`before`); items appended since (a notice during the warm) are kept
 * after it. If the transcript was replaced meanwhile, `next` alone.
 */
export function commitWarmed(
  before: readonly DisplayItem[],
  current: readonly DisplayItem[],
  next: readonly DisplayItem[],
): DisplayItem[] {
  const kept =
    current.length >= before.length && before.every((item, i) => current[i] === item)
      ? current.slice(before.length)
      : [];
  return [...next, ...kept];
}

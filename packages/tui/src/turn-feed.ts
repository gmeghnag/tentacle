/**
 * What the App does with the session's own activity — a turn another device
 * started, a history the daemon replaced the screen with, the session ending
 * daemon-side (docs/feat/tui-foreign-turns.md C2/C6/C8). Pure, React-free:
 * `App.tsx` only executes these decisions.
 */
import type { ChatMessage } from "@tentacle/core";
import { compactionOf, compactionSeparatorText } from "@tentacle/core";
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
  /**
   * The daemon's history replaced what is shown while no turn runs. `reason`:
   * a compaction's or a context reset's barrier (both keep the transcript),
   * a `/clear` (a new, empty chat: it replaces the transcript), null for any
   * other history (it replaces the transcript).
   */
  | {
      readonly kind: "history";
      readonly messages: readonly ChatMessage[];
      readonly reason: "compact" | "context_reset" | "clear" | null;
    }
  /** The session ended daemon-side (another device's close / delete, the reaper). */
  | { readonly kind: "closed"; readonly reason: "closed" | "deleted" | "gone" };

export type FeedStep = "consume" | "hold" | "history" | "closed";

/**
 * One activity, now. `inFlight`: one of this TUI's runs is streaming (or a
 * send-now of mine waits for its turn). A turn then is HELD (its events
 * buffer, nothing is lost) and consumed when that run settles: the only
 * overlaps are an own prompt that lost the slot (it will reject) and a
 * hand-off (the old end precedes the new turn's updates). A replacing history
 * waits the same way, and so does a context reset's (appended after the run
 * it follows); a compaction's only adds a notice, so it never waits. During
 * my own `/compact` no run streams: a turn is consumed at once.
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
      return inFlight && activity.reason !== "compact" ? "hold" : "history";
    case "closed":
      return "closed";
  }
}

/**
 * A `history` activity: a compaction keeps the transcript (owner QR1), and the
 * compaction point is marked with a grey separator rule (docs/feat/harness-notices.md
 * S3) unless it was mine (`ownCompaction`: a `/compact` of this TUI whose history
 * has not arrived yet — its settle already wrote the rule, so a second one would
 * double it). Owner Q6 (override): another device's compaction reads EXACTLY as
 * an own one — no "on another device" wording. A context reset keeps the
 * transcript too and APPENDS the new history (its separator and restart prompt
 * come with it: context-reset decision 9). Any other history (eager open, a
 * resync after a gap) replaces the transcript: the daemon's history is the
 * truth, and this TUI may have missed turns.
 */
export function historyAction(input: {
  readonly reason: "compact" | "context_reset" | "clear" | null;
  readonly ownCompaction: boolean;
}): "replace" | "append" | "separator" | "none" {
  // A `/clear` (own or another device's) is a new, empty chat: the daemon's
  // history replaces the transcript.
  if (input.reason === null || input.reason === "clear") {
    return "replace";
  }
  if (input.reason === "context_reset") {
    return "append";
  }
  return input.ownCompaction ? "none" : "separator";
}

/**
 * The separator's text for a compaction that was NOT mine, read off the history
 * the daemon just sent: its summary message carries the figures (S1's
 * `compacted` field), and a legacy head gives `compacted` alone. Always the one
 * wording (`compactionSeparatorText`, shared with my own compaction's settle and
 * with mobile).
 */
export function compactionSeparatorOf(messages: readonly ChatMessage[]): string {
  const summary = messages.find((m) => m.role === "user" && compactionOf(m) !== null);
  if (summary === undefined) {
    return compactionSeparatorText({});
  }
  return compactionSeparatorText(compactionOf(summary) ?? {});
}
/**
 * The session ended elsewhere: what happened, and that the next prompt starts
 * a fresh session (the App swaps to one; docs/feat/connect-sessions.md). A
 * closed one is archived, so `/sessions` (when the runtime lists) can reopen
 * it; a deleted one cannot come back.
 */
export function closedNotice(reason: "closed" | "deleted" | "gone", canList = false): string {
  const next = "what you type next starts a new session";
  if (reason === "gone") {
    return `_this session ended on the daemon while the link was down — ${next}_`;
  }
  return reason === "deleted"
    ? `_this session was deleted on another device — ${next}_`
    : `_this session was closed on another device — ${next}${canList ? " (/sessions to reopen it)" : ""}_`;
}

/** An own prompt that lost the slot: its text is back in the input (decision 15). */
export const SLOT_LOST_NOTICE =
  "_another device started a turn — your message is back in the input (Enter now queues it)_";

/**
 * A background warm's chunk threw (a resize re-layout or the idle warm, neither
 * of which a turn awaits). Surfaced as a visible system line, so the failure is
 * not only an unhandled rejection (docs/feat/tui-run-chunked.md, Review R1).
 */
export function warmFailureNotice(error: unknown): string {
  return `_a background layout failed: ${String(error)}_`;
}

/**
 * An own prompt's turn failed: did it lose the slot to another device's turn
 * (refused `TurnInProgress` before it streamed anything)? Then it is
 * withdrawn, not failed. Decided by the error CODE, never its text.
 */
export function lostSlot(error: unknown, streamed: boolean): boolean {
  return !streamed && errorCode(error) === SendNowErrorCode.TurnInProgress;
}

/** The daemon refused an image prompt before the turn started (`data.reason`: images_off/invalid_ref/not_uploaded). */
const ATTACHMENT_REFUSED = -32016;

/**
 * My own prompt was refused before the turn started because of its IMAGES
 * (docs/feat/attachments-tui.md D8): the daemon's `AttachmentRefused`
 * (`docs/feat/attachments-prompt.md` D3) — decided by CODE, never its text.
 * Its bubble is withdrawn, the text and the chips come back, and the reason is
 * shown: an image-only prompt must not be mistaken for a wake (P10).
 */
export function refusedBeforeStart(error: unknown, streamed: boolean): boolean {
  return !streamed && errorCode(error) === ATTACHMENT_REFUSED;
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

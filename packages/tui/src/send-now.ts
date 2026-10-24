/**
 * The send-now decisions (docs/feat/send-now-c.md), pure: whether a chord
 * sends, atomically or by the fallback, and what a refusal or a finished old
 * turn leads to. The App only executes them.
 */
import { type QueuedRows, afterRefusal, requeue, takeAll } from "./queued.ts";

/** The error codes it acts on: a copy of `@tentacle/protocol`'s (the TUI does not depend on it). */
export const SendNowErrorCode = {
  MethodNotFound: -32601,
  TurnInProgress: -32004,
  NoTurnRunning: -32008,
  Cancelled: -32010,
} as const;

/** An RPC error's code, or undefined. */
export function errorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/** What the chord does (`planSendNow`). */
export type SendNowPlan =
  | { readonly kind: "none" }
  | { readonly kind: "atomic"; readonly target: "turn" | "compaction" }
  | { readonly kind: "fallback" }
  | { readonly kind: "wait" };

/**
 * What the chord does. `none`: no queued row (D2), no turn nor compaction of
 * ours, or a send-now still pending. `atomic`: `session/send_now`, against
 * the running turn or this TUI's own `/compact` (docs/feat/send-now-d.md).
 * `fallback`: stop the turn, then send the texts as a prompt — the
 * controller has no `sendNow` (the in-process session) or the daemon
 * answered `MethodNotFound` once. `wait`: the same during a compaction —
 * the TUI has no way to cancel it, so the rows go when it ends (D3c).
 */
export function planSendNow(input: {
  readonly hasQueued: boolean;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly pending: boolean;
  readonly canSendNow: boolean;
  readonly latchedUnsupported: boolean;
}): SendNowPlan {
  if (!input.hasQueued || input.pending || !(input.running || input.compacting)) {
    return { kind: "none" };
  }
  const atomic = input.canSendNow && !input.latchedUnsupported;
  if (input.running) {
    return atomic ? { kind: "atomic", target: "turn" } : { kind: "fallback" };
  }
  return atomic ? { kind: "atomic", target: "compaction" } : { kind: "wait" };
}

/** The notice when the chord cannot cancel a compaction (`wait`); `who` cannot. */
export function compactionWaitNotice(who: "daemon" | "session"): string {
  return `_this ${who} can't cancel a compaction to send now — your queued messages go out when it ends_`;
}

/**
 * A refused `sendNow` request, or a send-now turn that failed before it
 * started. The client never guesses (it asks the daemon even when its own
 * turn already ended), so each answer is the daemon's fact.
 * `fallback`: an older daemon (`MethodNotFound`; latch, one notice).
 * `delivered`: `NoTurnRunning` — the daemon already has every text and
 * nothing awaits an answer: nothing to send, nothing to restore.
 * `restore`: anything else (`TurnInProgress`, `CompactInProgress`, a drop):
 * the texts the daemon does not report holding (`heldIds`) come back.
 */
export function onSendNowError(error: unknown): "fallback" | "delivered" | "restore" {
  switch (errorCode(error)) {
    case SendNowErrorCode.MethodNotFound:
      return "fallback";
    case SendNowErrorCode.NoTurnRunning:
      return "delivered";
    default:
      return "restore";
  }
}

/** How this TUI's `/compact` settled: `session.compact()`'s one outcome. */
export type CompactionResult =
  | { readonly ok: true; readonly before: number; readonly after: number }
  | { readonly ok: false; readonly error: unknown };

/**
 * This TUI's `/compact` settled (D3c, docs/feat/send-now-d.md): its notice,
 * and the rows queued meanwhile as ONE joined prompt (D1) — on success or
 * failure alike, the only option that loses nothing. `sendNowOwns`: a
 * send-now of ours took the compaction (in flight or accepted), so its
 * outcome decides the rows: nothing is sent here, and its `Cancelled` is the
 * send-now's doing, not a failure. `turnRunning`: a turn already streams here
 * (one the user started during the compaction): a second prompt cannot start,
 * so the texts go back to the input field instead (`restore`).
 */
export function onCompactionSettled(input: {
  readonly result: CompactionResult;
  readonly rows: QueuedRows;
  readonly sendNowOwns: boolean;
  readonly turnRunning: boolean;
}): { readonly notice: string; readonly send: string | null; readonly restore: string | null } {
  const { result } = input;
  const notice = result.ok
    ? `_Context compacted — ${result.before} → ${result.after} messages._`
    : input.sendNowOwns && errorCode(result.error) === SendNowErrorCode.Cancelled
      ? "_Compaction cancelled — sending now._"
      : `_Compact failed: ${String(result.error)}_`;
  const { text } = takeAll(input.rows);
  if (input.sendNowOwns || text === "") {
    return { notice, send: null, restore: null };
  }
  return input.turnRunning
    ? { notice, send: null, restore: text }
    : { notice, send: text, restore: null };
}

/**
 * A turn this TUI is about to start (a prompt, `/retry`, a skill, a job-exit
 * wake) while its own `/compact` runs: the daemon would refuse it
 * (`CompactInProgress`), and its end would clear the compaction-time rows.
 * So it does not start. `defer`: a wake waits for the compaction's end (the
 * settle fires it, unless the joined rows' turn takes the exits). `refuse`:
 * the user is told (the command stays in ↑ history).
 */
export function planTurnStart(input: {
  readonly compacting: boolean;
  readonly continuation: boolean;
}): "start" | "defer" | "refuse" {
  if (!input.compacting) {
    return "start";
  }
  return input.continuation ? "defer" : "refuse";
}

/** The notice of a turn refused during this TUI's compaction (`planTurnStart`). */
export const COMPACTING_NO_TURN =
  "_A compaction is running — wait for it to end (Enter queues a message meanwhile)._";

/**
 * An older daemon refused a compaction's send-now (`MethodNotFound`): it
 * cannot cancel the compaction, so the rows are queued again for its end
 * (`send: null`) — or, if it already ended meanwhile (its settle left them
 * to the send-now), they go now as one joined prompt.
 */
export function afterCompactionUnsupported(
  rows: QueuedRows,
  compacting: boolean,
): { readonly rows: QueuedRows; readonly send: string | null } {
  if (compacting || rows.length === 0) {
    return { rows: requeue(rows), send: null };
  }
  return { rows: [], send: takeAll(rows).text };
}

/** The keys hint beside the last queued row (like the spinner's "esc/ctrl+c to stop"). */
export const SEND_NOW_HINT = "ctrl+x ctrl+s to send now";

/** The notice when the daemon had nothing left to send (`NoTurnRunning`). */
export const NOTHING_TO_SEND =
  "_send-now: nothing to send — the daemon already has your queued messages_";

/**
 * `error.data.held` of a refused send-now (the protocol's `SendNowRefusal`):
 * the ids the daemon still holds. Null when absent or malformed — an older
 * daemon, or a failure that is not the daemon's answer.
 */
export function heldIds(error: unknown): ReadonlySet<string> | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const held = (data as { held?: unknown }).held;
  if (!Array.isArray(held) || !held.every((id) => typeof id === "string")) {
    return null;
  }
  return new Set(held);
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a refused `sendNow` request does to the rows (`oldRunning`: the old turn still streams here). */
export type RefusalStep =
  | { readonly kind: "fallback" }
  | { readonly kind: "delivered"; readonly rows: QueuedRows }
  | {
      readonly kind: "restore";
      readonly rows: QueuedRows;
      /** The texts for the input field ("" when the daemon holds them all). */
      readonly text: string;
      readonly notice: string;
    };

export function planRefusal(error: unknown, rows: QueuedRows, oldRunning: boolean): RefusalStep {
  const what = onSendNowError(error);
  if (what === "fallback") {
    return { kind: "fallback" };
  }
  if (what === "delivered") {
    // A still-streaming old turn's echoes and end clear the rows as usual.
    return { kind: "delivered", rows: oldRunning ? rows : [] };
  }
  const back = afterRefusal(rows, heldIds(error), oldRunning);
  const notice =
    back.text === ""
      ? `_send-now failed: ${reasonOf(error)} — the daemon holds your queued messages_`
      : `_send-now failed: ${reasonOf(error)} — your queued messages are back in the input_`;
  return { kind: "restore", rows: back.rows, text: back.text, notice };
}

/**
 * The send-now's new turn failed. `Cancelled` before it started (Esc in the
 * window; the daemon's `delivered: false`, read by the client): it delivered
 * nothing — its prompt nor the steers typed for it — so every row comes back.
 * Anything else is an ordinary turn failure.
 */
export function onSuccessorError(
  error: unknown,
  rows: QueuedRows,
):
  | { readonly kind: "fail" }
  | { readonly kind: "restore"; readonly text: string; readonly notice: string } {
  if (errorCode(error) !== SendNowErrorCode.Cancelled) {
    return { kind: "fail" };
  }
  return {
    kind: "restore",
    text: takeAll(rows).text,
    notice: "_send-now cancelled before it started — your queued messages are back in the input_",
  };
}

/**
 * FALLBACK ONLY (an older daemon, which has no `send_now` and so no facts to
 * give): the old turn ended after the fallback's stop; `text`: the rows its
 * `steer` echoes did not drop. `send` them as a prompt; but if a resync
 * replaced the transcript meanwhile, an echo may have been behind the cut,
 * so the texts go back to the input field instead — a visible choice for the
 * user, never a silent duplicate in the history.
 */
export function afterOldTurn(input: {
  readonly text: string;
  readonly resetSeen: boolean;
}): "none" | "send" | "restore" {
  if (input.text === "") {
    return "none";
  }
  return input.resetSeen ? "restore" : "send";
}

/** Restored texts go after whatever the user is typing, a blank line apart. */
export const withRestored = (draft: string, text: string): string =>
  draft === "" ? text : `${draft}\n\n${text}`;

/** The one-time notice of the fallback; `who` cannot send-now atomically. */
export function fallbackNotice(who: "daemon" | "session"): string {
  return `_this ${who} can't send-now atomically — stopping the turn, then sending_`;
}

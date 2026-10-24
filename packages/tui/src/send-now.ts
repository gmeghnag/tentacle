/**
 * The send-now decisions (docs/feat/send-now-c.md), pure: whether a chord
 * sends, atomically or by the fallback, and what a refusal or a finished old
 * turn leads to. The App only executes them.
 */
import { type QueuedRows, afterRefusal, takeAll } from "./queued.ts";

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

/**
 * What the chord does. `none`: no queued row (D2), no turn, or a send-now
 * still pending. `atomic`: `session/send_now`. `fallback`: stop the turn,
 * then send the texts as a prompt — the controller has no `sendNow` (the
 * in-process session) or the daemon answered `MethodNotFound` once.
 */
export function planSendNow(input: {
  readonly hasQueued: boolean;
  readonly running: boolean;
  readonly pending: boolean;
  readonly canSendNow: boolean;
  readonly latchedUnsupported: boolean;
}): "none" | "atomic" | "fallback" {
  if (!input.hasQueued || !input.running || input.pending) {
    return "none";
  }
  return input.canSendNow && !input.latchedUnsupported ? "atomic" : "fallback";
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

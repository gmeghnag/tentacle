/**
 * The composer's truth table (docs/feat/mobile-session-view.md 12c, extended by
 * docs/feat/mobile-compose.md 13d D1): what the buttons under the transcript DO
 * right now — send the text, queue it as a steer, keep it for the link to come
 * back, stop the turn that runs, or nothing (with the reason, which the screen
 * dims on). Pure and React-free (AGENTS §7), so every branch below is tested
 * without a simulator.
 *
 * The rules the plan fixes:
 * - **send** iff the link is `up`, no turn runs (own or another device's) and
 *   there is something to send — text and/or photo chips;
 * - **queue** iff the link is `up`, a turn runs and there is TEXT: it becomes a
 *   steer row (`session/enqueue`), which is what decision 15 makes of typing
 *   while a turn runs (12c kept the text in the field instead);
 * - **Send later** iff the link is down and there is something to send: the
 *   text becomes an outbox item (`waiting`), never a lost tap (decision 16);
 * - **Stop** iff a turn runs, the link is up and the field is empty — Stop
 *   cancels THAT turn (`session/cancel`), the TUI's Esc;
 * - **photos while a turn runs** are refused with a notice (P4: steers are
 *   text-only), so the chips wait for the next prompt;
 * - **Send now** is offered beside the queue only while a turn runs, on a live
 *   link, when there is a queued row of mine or a typed text to take — and
 *   never for a message that carries photos (a send-now cannot carry them).
 */
import type { EndReason } from "@tentacle/client";
import type { TurnRow } from "./transcript-rows.ts";

/** Why the button does nothing (the screen dims it and keeps the text). */
export type ComposerBlocker =
  /** The link is down and there is nothing to keep: sending waits for `up` (F12). */
  | "link"
  /** A turn runs, nothing is typed and no photos: the queue has nothing to take. */
  | "turn"
  /** Nothing typed and no photos. */
  | "blank"
  /** The session ended (closed, deleted, or gone): nothing more is sent (F14). */
  | "ended"
  /** A turn runs and photos are attached: a steer carries text only (P4, Owner Q2). */
  | "photos";

/** What a tap on the composer's button does. */
export type ComposerAction =
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "queue"; readonly text: string }
  | { readonly kind: "send-later"; readonly text: string }
  | { readonly kind: "stop"; readonly turnId: string; readonly own: boolean }
  | { readonly kind: "none"; readonly why: ComposerBlocker };

export interface ComposerInput {
  readonly link: "up" | "down";
  readonly text: string;
  /** The running turn, or null when idle (`transcript.ts`'s state). */
  readonly turn: TurnRow | null;
  /** The session's end, daemon-side; null while it lives. */
  readonly ended: EndReason | null;
  /** How many READY photo chips are attached (13c's `ready` ones). */
  readonly photos?: number;
  /**
   * A chip is still uploading: the item is created at once and goes out when
   * its uploads complete (D1's last row). It never blocks the button.
   */
  readonly uploading?: boolean;
  /** How many waiting rows of MINE the queue shows (Send now's other trigger). */
  readonly ownQueue?: number;
}

/** The notice beside a disabled queue: what happens to the chips (D1 row 4). */
export const PHOTOS_NEXT_PROMPT = "photos go with the next prompt";

/** Whether anything at all would travel if the button were pressed. */
const hasContent = (input: ComposerInput): boolean =>
  input.text.trim() !== "" || (input.photos ?? 0) > 0;

/** The button's action for this state (the whole truth table). */
export function composerAction(input: ComposerInput): ComposerAction {
  if (input.ended !== null) {
    return { kind: "none", why: "ended" };
  }
  if (input.link !== "up") {
    // Stop travels the wire (`session/cancel`): on a dead link the turn keeps
    // running daemon-side whatever this button says.
    if (input.turn !== null && !hasContent(input)) {
      return { kind: "none", why: "turn" };
    }
    if (hasContent(input)) {
      return { kind: "send-later", text: input.text };
    }
    return { kind: "none", why: "link" };
  }
  if (input.turn !== null) {
    if ((input.photos ?? 0) > 0) {
      return { kind: "none", why: "photos" };
    }
    if (input.text.trim() !== "") {
      return { kind: "queue", text: input.text };
    }
    return { kind: "stop", turnId: input.turn.turnId, own: input.turn.own };
  }
  if (!hasContent(input)) {
    return { kind: "none", why: "blank" };
  }
  return { kind: "send", text: input.text };
}

/**
 * Whether **Send now** is offered (D1's secondary button): a turn runs on a live
 * link, and there is a row of mine to take or a text to take with it. A message
 * carrying photos never offers it (P4) unless the QUEUE (text only) does.
 */
export function sendNowOffered(input: ComposerInput): boolean {
  if (input.ended !== null || input.link !== "up" || input.turn === null) {
    return false;
  }
  if ((input.ownQueue ?? 0) > 0) {
    return true;
  }
  return (input.photos ?? 0) === 0 && input.text.trim() !== "";
}

/** A send refused before the daemon's ack: said plainly (F13's notice). */
export const REFUSED_NOTICE = "another device started a turn — your message is back in the field";

/** A send that failed for another reason (a dropped link): the same restore, other words. */
export const FAILED_NOTICE = "that message did not go through — it is back in the field";

/**
 * The field's text after a refused send: the person's words go back, unless
 * something was typed since (then theirs is kept and the refused text follows it
 * on its own line — appended, never silently dropped).
 */
export function restoreAfterFailure(current: string, sent: string): string {
  if (sent === "") {
    return current;
  }
  if (current.trim() === "") {
    return sent;
  }
  return current.endsWith("\n") ? `${current}${sent}` : `${current}\n${sent}`;
}

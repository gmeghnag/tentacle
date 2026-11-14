/**
 * The composer's truth table (docs/feat/mobile-session-view.md 12c): what the
 * one button under the transcript DOES right now — send the text, stop the turn
 * that runs, or nothing (with the reason, which the screen dims on). Pure and
 * React-free (AGENTS §7), so every branch below is tested without a simulator.
 *
 * The rules the plan fixes (decision 15):
 * - **send** iff the link is `up`, no turn runs (own or another device's) and
 *   the text is not blank;
 * - **Stop** iff a turn runs AND the field is empty — Stop cancels THAT turn
 *   (`session/cancel{turnId}`), which is the TUI's Esc for a foreign turn and
 *   the prompt's own `AbortSignal` for this phone's;
 * - text typed while a turn runs STAYS in the field (steer is task 13), so a
 *   typed draft is never consumed by a tap meant to stop;
 * - a send the daemon refused before the ack puts the text BACK (F13): the
 *   person never loses what they wrote.
 */
import type { EndReason } from "@tentacle/client";
import type { TurnRow } from "./transcript-rows.ts";

/** Why the button does nothing (the screen dims it and keeps the text). */
export type ComposerBlocker =
  /** The link is down: the text is kept, and sending waits for `up` (F12). */
  | "link"
  /** A turn runs and the field is not empty: the text waits (steer is task 13). */
  | "turn"
  /** Nothing typed. */
  | "blank"
  /** The session ended (closed, deleted, or gone): nothing more is sent (F14). */
  | "ended";

/** What a tap on the composer's button does. */
export type ComposerAction =
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "stop"; readonly turnId: string; readonly own: boolean }
  | { readonly kind: "none"; readonly why: ComposerBlocker };

export interface ComposerInput {
  readonly link: "up" | "down";
  readonly text: string;
  /** The running turn, or null when idle (`transcript.ts`'s state). */
  readonly turn: TurnRow | null;
  /** The session's end, daemon-side; null while it lives. */
  readonly ended: EndReason | null;
}

/** The button's action for this state (the whole truth table). */
export function composerAction(input: ComposerInput): ComposerAction {
  if (input.ended !== null) {
    return { kind: "none", why: "ended" };
  }
  if (input.turn !== null) {
    // Stop needs the link: `session/cancel` travels it, so a tap on a dead link
    // would be a stop the phone cannot make (the turn runs on daemon-side).
    if (input.text.trim() === "" && input.link === "up") {
      return { kind: "stop", turnId: input.turn.turnId, own: input.turn.own };
    }
    return { kind: "none", why: "turn" };
  }
  if (input.link !== "up") {
    return { kind: "none", why: "link" };
  }
  if (input.text.trim() === "") {
    return { kind: "none", why: "blank" };
  }
  return { kind: "send", text: input.text };
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

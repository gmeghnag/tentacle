/**
 * Copy a message on the phone (docs/feat/mobile-copy-text.md D1): WHAT a row
 * copies, and what the confirmation pill says. Pure and React-free (AGENTS §7)
 * — `SessionScreen.tsx` owns the clipboard, the haptic and the timers, and
 * `CopyFlash.tsx` / `SelectTextSheet.tsx` only paint.
 *
 * The copy is the row's **markdown source**, not its rendered text: pasting into
 * Notes, Slack or an editor keeps the fences, the list markers and the links,
 * and it is the SAME bytes the header menu's "Copy last answer" gives (that menu
 * reads `messageText` too, so the two can never drift).
 *
 * Why not `selectable` on the row: on iOS (RN 0.88, Fabric) it adds a native
 * long-press recognizer that races the row's own, and its one action copies the
 * WHOLE paragraph (`RCTParagraphComponentView.mm:344,386,399`) — never a part,
 * and never across the `View`s a markdown list/table/code block is drawn as.
 * Hence: long-press = the whole message here, "Select text" = a read-only
 * `TextInput` sheet, which is what gives UIKit's real partial selection.
 */
import { firedRowView } from "./schedule-view.ts";
import type { Row } from "./transcript-rows.ts";

/**
 * The text a message row copies: a prompt or an answer (and a context reset's
 * restart prompt), markdown source with its trailing blank lines trimmed; `""`
 * when the message carries no text at all (a photo or a file); `null` when the
 * row is not a message (a tool, a thought, a notice, a compaction step, a fired
 * wake).
 *
 * No `now`: the fired-wake rule needs a clock and lives in `messageCopy`, so
 * `session-menu.ts` can share this text rule without one (a fired wake stays in
 * "Copy conversation", as it is today).
 */
export function messageText(row: Row): string | null {
  switch (row.kind) {
    case "assistant":
      return row.text.trimEnd();
    case "user":
      return row.text.trimEnd();
    case "context":
      // A context reset is ONE timeline step holding the restart prompt — the
      // person's own words, so it copies. A compaction's body is the model's
      // summary of a conversation that is gone: a step, not a message.
      return row.event === "reset" ? row.body.trimEnd() : null;
    default:
      return null;
  }
}

/**
 * What a long-press did: the text was copied, there was none to copy, or the
 * clipboard refused the write (the last one is never produced here — the screen
 * maps a rejected `setStringAsync` onto it, so the failure is never silent).
 */
export type MessageCopy =
  | { readonly kind: "copy"; readonly text: string; readonly label: "Copied" }
  | { readonly kind: "empty"; readonly label: "No text to copy" }
  | { readonly kind: "failed"; readonly label: "Couldn't copy" };

/**
 * What a long-press on `row` does; `null` = the row has no long-press (a tool,
 * a thought, a notice, a compaction step, a fired wake — the wake keeps its own
 * `selectable` body, so a second gesture there would only collide).
 */
export function messageCopy(row: Row, now: number): MessageCopy | null {
  if (row.kind === "user" && firedRowView(row.text, row.schedule, now) !== null) {
    return null;
  }
  const text = messageText(row);
  if (text === null) {
    return null;
  }
  return text.trim() === ""
    ? { kind: "empty", label: "No text to copy" }
    : { kind: "copy", text, label: "Copied" };
}

/** The pill's words when the clipboard itself refused the write (no silent drop). */
export const COPY_FAILED: MessageCopy = { kind: "failed", label: "Couldn't copy" };

/** How long the confirmation pill stays up (the hub's own flash window). */
export const COPY_FLASH_MS = 2500;

/**
 * Whether the pill is still up, half-open like hub-flash: `now - at <
 * COPY_FLASH_MS`. A clock that went backwards (a `Date.now()` that stepped
 * between the press and the paint) hides it rather than pinning it on screen.
 */
export function copyFlashShown(flash: { readonly at: number } | null, now: number): boolean {
  if (flash === null) {
    return false;
  }
  const elapsed = now - flash.at;
  return elapsed >= 0 && elapsed < COPY_FLASH_MS;
}

/**
 * Whether the compose half's rows MOVED between two states (Slice 6's
 * `LayoutAnimation` for the queue): a row arrived, left or changed state. Pure
 * and React-free (AGENTS §7); the screen animates only when this says so.
 */
import type { ComposeBarView } from "./session-view.ts";

/** The rows' identities and states, as one comparable string (text edits do not move a row). */
function shape(view: ComposeBarView): string {
  return [
    view.queued.map((row) => `${row.id}:${row.state}`).join(","),
    view.returnedOthers.map((row) => row.id).join(","),
    view.outbox.map((row) => `${row.itemId}:${row.state}`).join(","),
    view.chips.map((chip) => `${chip.key}:${chip.state}`).join(","),
    view.sendNow ? "now" : "",
    // The editing banner appears and leaves right above the field (D6).
    view.editing === null ? "" : "editing",
  ].join("|");
}

export function composeRowsMoved(prev: ComposeBarView, next: ComposeBarView): boolean {
  return prev !== next && shape(prev) !== shape(next);
}

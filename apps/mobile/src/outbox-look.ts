/**
 * How the outbox rows LOOK (mockup `Offline`, docs/feat/mobile-ui-polish.md
 * Slice 5): each row a right-aligned dashed bubble with a short cue for its
 * state, and one caption under the group. Pure and React-free (AGENTS §7): the
 * row states are `session-view.ts`'s, this only names them; `ComposeBar.tsx`
 * draws the result.
 */
import type { OutboxRowView } from "./session-view.ts";

export type OutboxCue = "none" | "spinner" | "attention";

export interface OutboxRowLook {
  readonly cue: OutboxCue;
  /** A short state line under the bubble (null: the group caption says it). */
  readonly status: string | null;
  /** Draw the "…" options button (opens the decision sheet). */
  readonly options: boolean;
}

export function outboxRowLook(row: OutboxRowView): OutboxRowLook {
  // The sheet opens only for a row the view-model says a person must settle.
  const options = row.decide;
  switch (row.state) {
    case "waiting":
      return { cue: "none", status: null, options };
    case "sending":
      return { cue: "spinner", status: "Sending…", options };
    case "uploading":
      return { cue: "spinner", status: "Uploading photos…", options };
    case "needs-decision":
      return { cue: "attention", status: "Needs your answer", options };
    case "back-to-draft":
      return { cue: "none", status: "Back in the message field", options };
  }
}

/** The line under the group: the mockup's, while any row waits for the network. */
export function outboxCaption(rows: readonly OutboxRowView[]): string | null {
  return rows.some((row) => row.state === "waiting")
    ? "Waiting for network · sent on reconnect if nothing changed"
    : null;
}

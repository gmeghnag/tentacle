/**
 * How the outbox rows LOOK (mockup `Offline`, docs/feat/mobile-ui-polish.md
 * Slice 5; the upload states added by feat/mobile-thinking-images S4): each row a
 * right-aligned dashed bubble with a short cue for its state, and one caption
 * under the group. Pure and React-free (AGENTS §7): the row states are
 * `session-view.ts`'s, this only names them; `ComposeBar.tsx` draws the result.
 */
import type { OutboxRowView } from "./session-view.ts";

export type OutboxCue = "none" | "spinner" | "attention";

export interface OutboxRowLook {
  readonly cue: OutboxCue;
  /** A short state line under the bubble (null: the group caption says it). */
  readonly status: string | null;
  /** Draw the "…" options button (opens the decision sheet). */
  readonly options: boolean;
  /**
   * Offer "Retry" beside the status (S4): a photo upload did not land, and the
   * row's decision sheet's Send is the same act — no second path.
   */
  readonly retry: boolean;
  /**
   * How full the row's progress ring is, 0–100, or null for an indeterminate
   * spinner (nothing has reported yet, and for every row with no upload).
   */
  readonly percent: number | null;
}

/**
 * The fraction as the whole percent a person reads. Clamped, because a daemon
 * may confirm more bytes than the size it was told (a re-sent window) and
 * "Sending… 118 %" is not a thing.
 */
function percentOf(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}

export function outboxRowLook(row: OutboxRowView): OutboxRowLook {
  // The sheet opens only for a row the view-model says a person must settle.
  const options = row.decide;
  // The row's own reading: a percentage belongs to the row whatever state it is
  // in, and only the `uploading` case draws it (a `sending` row has nothing left
  // to measure — its percent is null, because the driver cleared it).
  const percent = percentOf(row.progress);
  /** Nothing about this row is a failed upload, so no Retry. */
  const plain = { options, retry: false, percent };
  switch (row.state) {
    case "waiting":
      return { ...plain, cue: "none", status: null };
    case "sending":
      return { ...plain, cue: "spinner", status: "Sending…" };
    case "uploading":
      // The photos go up first, so the percent is theirs (mockup F: veil + ring
      // + "N%"). No report yet: the indeterminate spinner, never a fake 0 %.
      return percent === null
        ? { ...plain, cue: "spinner", status: "Uploading photos…" }
        : { ...plain, cue: "spinner", status: `Sending… ${percent}%` };
    case "needs-decision":
      // A photo that never reached the daemon is why this needs a person: the
      // owner's "not sent" + Retry (S4), which is the sheet's Send.
      return row.unsentPhotos
        ? { ...plain, cue: "attention", status: "Not sent", retry: true }
        : { ...plain, cue: "attention", status: "Needs your answer" };
    case "back-to-draft":
      return { ...plain, cue: "none", status: "Back in the message field" };
  }
}

/** The line under the group: the mockup's, while any row waits for the network. */
export function outboxCaption(rows: readonly OutboxRowView[]): string | null {
  return rows.some((row) => row.state === "waiting")
    ? "Waiting for network · sent on reconnect if nothing changed"
    : null;
}

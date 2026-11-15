/**
 * Pair's sheet copy (slice-6 visual review N2/N4): the heading for each stage
 * and the fixed sentences, typographic (no straight quotes, `’`, `…`). Pure and
 * React-free (AGENTS §7) so the copy is pinned by a test, not by eye.
 */
import type { PairingView } from "./pairing-flow.ts";

export interface PairSheetHeading {
  readonly title?: string;
  readonly subtitle?: string;
  /** The compare stage is a centred sheet (mockup `Pair` compare). */
  readonly centred?: boolean;
}

export const PAIR_COPY = {
  failedTitle: "Pairing didn’t work",
  mismatch: "Codes don’t match",
  waiting: "Waiting for your answer on the computer…",
  connecting: "Connecting…",
  done: "You can now use this computer from this phone.",
  /** The compare body; the answer key (`y`) is drawn mono by the screen. */
  compareBefore: "Check that your computer shows the same code, then answer ",
  compareKey: "y",
  compareAfter: " there.",
  again: (name: string) => `Pairing again replaces this phone’s entry for “${name}”.`,
  already: (name: string) =>
    `Already paired with “${name}” — pairing again replaces this phone’s key for it.`,
} as const;

export function pairSheetHeading(view: PairingView): PairSheetHeading {
  switch (view.stage) {
    case "review":
      return view.review === undefined
        ? {}
        : {
            title: `Pair with ${view.review.computerName}?`,
            subtitle: `It answers on ${view.review.addressCount} ${
              view.review.addressCount === 1 ? "address" : "addresses"
            }.`,
          };
    case "connecting":
      return { title: "Connecting" };
    case "compare":
      return { title: "Compare the code", centred: true };
    case "done":
      return { title: `Paired with ${view.computerName ?? "your computer"}` };
    default:
      return { title: PAIR_COPY.failedTitle };
  }
}

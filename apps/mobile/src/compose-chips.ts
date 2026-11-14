/**
 * The photo chips of one message (docs/feat/mobile-compose.md 13d): what a pick
 * ADDS, how one chip moves through `uploading → ready | refused`, and what a
 * send takes. Pure — the adapter (`photo-source.ts`) performs the effects and the
 * controller performs the uploads (AGENTS §7).
 *
 * The rules the plan fixes:
 * - a refusal is a CHIP, not a lost pick (`chip-<n>-refused`): the text stays,
 *   nothing is sent, and the person removes the chip or waits (F13–F17, F22);
 * - the cap is `MAX_ATTACHMENTS_PER_MESSAGE` over the chips that are going
 *   somewhere (a refused one holds no slot);
 * - a chip carries what the WIRE needs (13c decided the mime type from the bytes):
 *   its copy's path, that type and its safe name — so a send can build the ref;
 * - a send takes the READY chips and CLEARS them in the same call, so a double
 *   tap cannot send them twice (D1's synchronous clear, F4).
 */
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@tentacle/core";

/** Where one chip is. `refused` carries the person-facing reason (13c's detail). */
export type Chip =
  | {
      readonly key: string;
      readonly state: "uploading";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
    }
  | {
      readonly key: string;
      readonly state: "ready";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
      /** The daemon's blob (content-addressed by 13c's sha256), once uploaded. */
      readonly ref: { readonly id: string; readonly size: number };
    }
  | { readonly key: string; readonly state: "refused"; readonly detail: string };

export type Chips = readonly Chip[];

/** What the app's photo adapter hands back for one pick (`photo-source.ts`). */
export type Picked =
  | {
      readonly kind: "ready";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
    }
  | { readonly kind: "refused"; readonly detail: string };

/** How many chips a message may hold: the protocol's own cap (P5). */
export const CHIP_CAP = MAX_ATTACHMENTS_PER_MESSAGE;

/** The chips that hold a slot: a refused one is not going anywhere. */
export const counted = (chips: Chips): number =>
  chips.filter((chip) => chip.state !== "refused").length;

/** Whether another pick may be taken now (the picker's own `selectionLimit`). */
export const pickRoom = (chips: Chips): number => Math.max(0, CHIP_CAP - counted(chips));

/**
 * Add one pick's photos, in order, as chips. A pick past the cap becomes a
 * `refused` chip (the adapter already refuses it; this is the belt) — never a
 * silent drop. `mint` makes each chip's key (the app passes a counter).
 */
export function addPicks(
  chips: Chips,
  picks: readonly Picked[],
  mint: () => string,
): { readonly chips: Chips; readonly refused: number } {
  let next = chips;
  let refused = 0;
  for (const pick of picks) {
    if (counted(next) >= CHIP_CAP) {
      refused += 1;
      next = [
        ...next,
        { key: mint(), state: "refused", detail: `a message carries at most ${CHIP_CAP} photos` },
      ];
      continue;
    }
    next = [
      ...next,
      pick.kind === "ready"
        ? {
            key: mint(),
            state: "uploading" as const,
            file: pick.file,
            mimeType: pick.mimeType,
            name: pick.name,
          }
        : { key: mint(), state: "refused" as const, detail: pick.detail },
    ];
  }
  return { chips: next, refused };
}

/** The upload of `key` landed: the chip is sendable, with the daemon's ref id. */
export function chipUploaded(chips: Chips, key: string, refId: string, size: number): Chips {
  return chips.map((chip) =>
    chip.key === key && chip.state === "uploading"
      ? {
          key: chip.key,
          state: "ready",
          file: chip.file,
          mimeType: chip.mimeType,
          name: chip.name,
          ref: { id: refId, size },
        }
      : chip,
  );
}

/** The upload of `key` was refused (`too_large`, `images_off`, `not_uploaded`, …). */
export function chipRefused(chips: Chips, key: string, detail: string): Chips {
  return chips.map((chip) =>
    chip.key === key && chip.state === "uploading"
      ? { key: chip.key, state: "refused", detail }
      : chip,
  );
}

/** The person removed a chip (its blob stays daemon-side until the session ends, Q4). */
export const chipRemoved = (chips: Chips, key: string): Chips =>
  chips.filter((chip) => chip.key !== key);

/** A sendable chip, as the item and the prompt's ref need it. */
export interface TakenChip {
  readonly key: string;
  readonly file: string;
  readonly mimeType: string;
  readonly name: string;
  readonly id: string;
  readonly size: number;
}

/**
 * A send takes the sendable chips and CLEARS them in the same call (D1: the field
 * and the chips go in one synchronous step, so a double tap sends once).
 * `taken: []`: nothing sendable — the call must then send text only, never a
 * message naming a ref the daemon does not hold.
 */
export function takeChips(chips: Chips): {
  readonly taken: readonly TakenChip[];
  readonly chips: Chips;
  /** Chips still uploading: their item goes out when they settle (D1's last row). */
  readonly uploading: number;
} {
  const taken = chips.flatMap((chip) =>
    chip.state === "ready"
      ? [
          {
            key: chip.key,
            file: chip.file,
            mimeType: chip.mimeType,
            name: chip.name,
            id: chip.ref.id,
            size: chip.ref.size,
          },
        ]
      : [],
  );
  return {
    taken,
    // Ready ones left with the message; a refused one was never going out (its
    // reason was on screen, and the send clears the bar). Only a chip still
    // UPLOADING survives, to join the NEXT message (F5/F6).
    chips: chips.filter((chip) => chip.state === "uploading"),
    uploading: chips.filter((chip) => chip.state === "uploading").length,
  };
}

/** The chip's testID (the Maestro contract: `chip-<index>-<state>`). */
export const chipTestId = (index: number, chip: Chip): string => `chip-${index}-${chip.state}`;

/** Every chip's copy, for the draft (a chip outlives the screen: D4's draft). */
export const chipFiles = (chips: Chips): readonly string[] =>
  chips.flatMap((chip) => (chip.state === "refused" ? [] : [chip.file]));

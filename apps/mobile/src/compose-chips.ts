/**
 * The attachment chips of one message (docs/feat/mobile-compose.md 13d, extended
 * by docs/feat/pdf-read.md D7): what a pick ADDS, how one chip moves through
 * `uploading → ready | refused`, and what a send takes. Pure — the adapters
 * (`photo-source.ts`, `pdf-source.ts`) perform the effects and the controller
 * performs the uploads (AGENTS §7).
 *
 * The rules the plan fixes:
 * - a refusal is a CHIP, not a lost pick (`chip-<n>-refused`): the text stays,
 *   nothing is sent, and the person removes the chip or waits (F13–F17, F22);
 * - the cap is `MAX_ATTACHMENTS_PER_MESSAGE` over the chips that are going
 *   somewhere (a refused one holds no slot) — and it counts PHOTOS AND FILES
 *   together, because the wire's cap is one cap (`PromptContentBlockSchema`);
 * - a chip carries what the WIRE needs. A photo: its copy's path, its sniffed
 *   mime type and its safe name, so a send can build a ref. A PDF (D7): its
 *   copy's path, its safe name and its size — a document block names a KIND,
 *   never a mime type, and its bytes go up a different path
 *   (`RemoteSession.attachDocument`, which decides upload vs laptop-extract);
 * - a send takes the READY chips and CLEARS them in the same call, so a double
 *   tap cannot send them twice (D1's synchronous clear, F4).
 */
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@tentacle/core";
import type { DocumentContent } from "@tentacle/protocol";

/** What one chip is: an image (`attachment/put` + a ref) or a document (a `document` block). */
export type ChipKind = "image" | "document";

/** Where one chip is. `refused` carries the person-facing reason (13c's detail). */
export type Chip =
  | {
      readonly key: string;
      readonly kind: "image";
      readonly state: "uploading";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
    }
  | {
      readonly key: string;
      readonly kind: "image";
      readonly state: "ready";
      readonly file: string;
      readonly mimeType: string;
      readonly name: string;
      /** The daemon's blob (content-addressed by 13c's sha256), once uploaded. */
      readonly ref: { readonly id: string; readonly size: number };
    }
  | {
      readonly key: string;
      readonly kind: "document";
      readonly state: "uploading";
      readonly file: string;
      readonly name: string;
      /** The picked file's size: the wire's `DocumentSourceSchema` bound is checked on it. */
      readonly size: number;
    }
  | {
      readonly key: string;
      readonly kind: "document";
      readonly state: "ready";
      readonly file: string;
      readonly name: string;
      readonly size: number;
      /** What `attachDocument` answered: the block the prompt names (D6/D7). */
      readonly block: DocumentContent;
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

/**
 * What the PDF adapter hands back for one pick (`pdf-source.ts`, D7).
 *
 * `refused` is a `Picked` (it needs no bytes); a ready pick carries its bytes
 * so the controller can hand them to `attachDocument`, exactly as a photo's are
 * handed to `attachImage`.
 */
export interface PickedDocument {
  readonly kind: "document";
  readonly file: string;
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/**
 * One PDF pick, as `pdf-source.ts` answers it: ready, or refused with the reason
 * a chip shows (`nextPdfStep`'s own sentence). A refusal is never an exception —
 * "the person picked a 30 MB PDF" is not an error — so the adapter's answer is
 * this union, exactly as the photo adapter's is `Picked`.
 */
export type PickedPdf = PickedDocument | Picked;

/** How many chips a message may hold: the protocol's own cap (P5). */ export const CHIP_CAP =
  MAX_ATTACHMENTS_PER_MESSAGE;

/** The chips that hold a slot: a refused one is not going anywhere. */
export const counted = (chips: Chips): number =>
  chips.filter((chip) => chip.state !== "refused").length;

/** Whether another pick may be taken now (the picker's own `selectionLimit`). */
export const pickRoom = (chips: Chips): number => Math.max(0, CHIP_CAP - counted(chips));

/**
 * Add one pick's attachments, in order, as chips. A pick past the cap becomes a
 * `refused` chip (the adapter already refuses it; this is the belt) — never a
 * silent drop. `mint` makes each chip's key (the app passes a counter).
 */
export function addPicks(
  chips: Chips,
  picks: readonly (Picked | PickedDocument)[],
  mint: () => string,
): { readonly chips: Chips; readonly refused: number } {
  let next = chips;
  let refused = 0;
  for (const pick of picks) {
    if (counted(next) >= CHIP_CAP) {
      refused += 1;
      next = [
        ...next,
        {
          key: mint(),
          state: "refused",
          detail: `a message carries at most ${CHIP_CAP} attachments`,
        },
      ];
      continue;
    }
    if (pick.kind === "refused") {
      next = [...next, { key: mint(), state: "refused", detail: pick.detail }];
      continue;
    }
    if (pick.kind === "document") {
      next = [
        ...next,
        {
          key: mint(),
          kind: "document",
          state: "uploading",
          file: pick.file,
          name: pick.name,
          size: pick.size,
        },
      ];
      continue;
    }
    next = [
      ...next,
      {
        key: mint(),
        kind: "image",
        state: "uploading",
        file: pick.file,
        mimeType: pick.mimeType,
        name: pick.name,
      },
    ];
  }
  return { chips: next, refused };
}

/** The upload of an IMAGE chip landed: the chip is sendable, with the daemon's ref id. */
export function chipUploaded(chips: Chips, key: string, refId: string, size: number): Chips {
  return chips.map((chip) =>
    chip.key === key && chip.state === "uploading" && chip.kind === "image"
      ? {
          key: chip.key,
          kind: "image",
          state: "ready",
          file: chip.file,
          mimeType: chip.mimeType,
          name: chip.name,
          ref: { id: refId, size },
        }
      : chip,
  );
}

/**
 * A DOCUMENT chip became sendable: `attachDocument` answered with the block the
 * prompt carries (D6 decides upload-vs-extract; this file only renders it).
 *
 * The block lives on the CHIP because a reply is per pick: a doc block is not
 * derivable from the file alone once the daemon has the bytes.
 */
export function chipDocumentReady(chips: Chips, key: string, block: DocumentContent): Chips {
  return chips.map((chip) =>
    chip.key === key && chip.state === "uploading" && chip.kind === "document"
      ? {
          key: chip.key,
          kind: "document",
          state: "ready",
          file: chip.file,
          name: chip.name,
          size: chip.size,
          block,
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

/** A sendable PHOTO chip, as the item and the prompt's ref need it. */
export interface TakenChip {
  readonly kind: "image";
  readonly key: string;
  readonly file: string;
  readonly mimeType: string;
  readonly name: string;
  readonly id: string;
  readonly size: number;
}

/** A sendable DOCUMENT chip: what the outbox item keeps, block included. */
export interface TakenDocument {
  readonly key: string;
  readonly file: string;
  readonly name: string;
  readonly size: number;
  readonly block: DocumentContent;
}

/** What a send took, still in one list (the order the person picked them). */
export type TakenAttachment = TakenChip | ({ readonly kind: "document" } & TakenDocument);

/**
 * A send takes the sendable chips and CLEARS them in the same call (D1: the field
 * and the chips go in one synchronous step, so a double tap sends once).
 * `taken: []`: nothing sendable — the call must then send text only, never a
 * message naming a ref the daemon does not hold.
 */
export function takeChips(chips: Chips): {
  readonly taken: readonly TakenAttachment[];
  readonly chips: Chips;
  /** Chips still uploading: their item goes out when they settle (D1's last row). */
  readonly uploading: number;
} {
  const taken = chips.flatMap((chip): readonly TakenAttachment[] => {
    if (chip.state !== "ready") {
      return [];
    }
    if (chip.kind === "document") {
      return [
        {
          kind: "document",
          key: chip.key,
          file: chip.file,
          name: chip.name,
          size: chip.size,
          block: chip.block,
        },
      ];
    }
    return [
      {
        kind: "image",
        key: chip.key,
        file: chip.file,
        mimeType: chip.mimeType,
        name: chip.name,
        id: chip.ref.id,
        size: chip.ref.size,
      },
    ];
  });
  return {
    taken,
    // Ready ones left with the message; a refused one was never going out (its
    // reason was on screen, and the send clears the bar). Only a chip still
    // UPLOADING survives, to join the NEXT message (F5/F6).
    chips: chips.filter((chip) => chip.state === "uploading"),
    uploading: chips.filter((chip) => chip.state === "uploading").length,
  };
}

/**
 * The taken chips split into what each of the two paths needs: refs for the
 * images, and the document picks for the outbox item (D7). One list in, two
 * typed lists out, so the controller never re-filters by tag.
 */
export function splitTaken(taken: readonly TakenAttachment[]): {
  readonly photos: readonly TakenChip[];
  readonly documents: readonly TakenDocument[];
} {
  const photos: TakenChip[] = [];
  const documents: TakenDocument[] = [];
  for (const item of taken) {
    if (item.kind === "document") {
      documents.push({
        key: item.key,
        file: item.file,
        name: item.name,
        size: item.size,
        block: item.block,
      });
    } else {
      photos.push(item);
    }
  }
  return { photos, documents };
}

/** The chip's testID (the Maestro contract: `chip-<index>-<state>`). */
export const chipTestId = (index: number, chip: Chip): string => `chip-${index}-${chip.state}`;

/** Every chip's copy, for the draft (a chip outlives the screen: D4's draft). */
export const chipFiles = (chips: Chips): readonly string[] =>
  chips.flatMap((chip) => (chip.state === "refused" ? [] : [chip.file]));

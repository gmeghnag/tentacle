/**
 * The photos this phone SENT, by the ref each became (fix/mobile-qa-1119 row 12).
 *
 * The protocol has no image read-back (`thumbnails.ts`), so a sent photo's only
 * pixels are the phone's own copy. The optimistic row carries it
 * (`own_prompt` → `ImageRef.localUri`), but a resync REBUILDS the rows from the
 * session's history, whose refs carry no file — and every sent photo turned
 * into "Image not available" after a background → foreground, a `serve`
 * restart or a relaunch. This index survives all three (it lives in the outbox
 * store's file) and answers the thumbnail driver's port for those refs.
 *
 * Pure: the store persists the index, the app wires the source.
 */
import { localPhotosOf } from "./outbox.ts";
import type { OutboxItem } from "./outbox.ts";
import { KEEP_DISPLAY_COPIES } from "./photo-copies.ts";
import type { ThumbnailSource } from "./thumbnails.ts";
import type { LocalPhoto } from "./transcript-rows.ts";

/**
 * Entries kept: the copies folder keeps at least its newest `KEEP_DISPLAY_COPIES`
 * (`photo-copies.ts`), so an older entry would mostly name a removed file — and
 * such a file only draws its label (`onError` → `broken`), never a wrong photo.
 */
export const MAX_SENT_PHOTOS = KEEP_DISPLAY_COPIES;

/** Every photo the items hold a ref for, in order. */
export const localPhotosOfItems = (items: readonly OutboxItem[]): readonly LocalPhoto[] =>
  items.flatMap((item) => localPhotosOf(item));

/**
 * `index` with `photos` added (newest last, an id re-added moves to the end),
 * bounded to the newest `max`. Answers the SAME object when nothing changes, so
 * the store's write stays byte-identical for an item with no refs.
 */
export function withSentPhotos(
  index: Readonly<Record<string, string>> | undefined,
  photos: readonly LocalPhoto[],
  max: number = MAX_SENT_PHOTOS,
): Readonly<Record<string, string>> | undefined {
  if (photos.every((photo) => index?.[photo.id] === photo.uri)) {
    return index;
  }
  const entries = Object.entries(index ?? {}).filter(
    ([id]) => !photos.some((photo) => photo.id === id),
  );
  for (const photo of photos) {
    entries.push([photo.id, photo.uri]);
  }
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
}

/**
 * The thumbnail driver's port for a sent photo: its copy, or null (the row then
 * draws its label, as before). Never a dial: nothing else can answer it.
 */
export function sentPhotoSource(
  /** May wait (the store's `load`): a miss is final for the session (`thumbnails.ts`). */
  lookup: (id: string) => string | undefined | Promise<string | undefined>,
  next?: ThumbnailSource,
): ThumbnailSource {
  return {
    async fetch(ref, signal) {
      const uri = await lookup(ref.id);
      if (uri !== undefined) {
        return { id: ref.id, uri };
      }
      return next === undefined ? null : next.fetch(ref, signal);
    },
  };
}

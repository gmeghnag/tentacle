/**
 * What happens to the phone's photo COPIES (fix round 2, Review round 2's R2-1).
 *
 * A copy is two things at once: the bytes the outbox uploads, and the only
 * pixels the transcript has for a photo this phone sent (`thumbnails.ts`: the
 * protocol has no read-back, so `localPhotosOf` → `ImageRef.localUri` is all
 * there is). While the item existed, deleting the copy at the ack was
 * invisible; the ROW that draws it outlives the item, so the same delete left
 * the bubble over a file that no longer existed — the reviewer's finding. It
 * also broke the person's own return path: `backToDraft` puts the item's photos
 * back in the field through the same `finish` that deleted their files.
 *
 * So a copy OUTLIVES its item, and the folder is bounded here instead. A copy is
 * removed only when ALL of these hold:
 * - **not in use** — no live outbox item or draft names it any more (the caller
 *   passes what its store knows; see the note on other computers below);
 * - **older than `COPY_GRACE_MS`** — a week, so anything a person can still see
 *   on a transcript, or compose in a session this store has not opened, is safe;
 * - **past the newest `KEEP_DISPLAY_COPIES`** — the send on screen is always the
 *   newest copy in the folder, so a row's own photo is never in the tail.
 *
 * Not in use + old + past the tail ⇒ nothing can draw it and nothing can upload
 * it. The tail and the grace are what make this safe on the one thing it cannot
 * see: a WAITING item belonging to another computer's store. Such an item is
 * young; when it is not, its upload fails visibly (`readPhoto` throws ⇒ a typed
 * refusal, never a silent drop).
 *
 * Pure: the caller lists the folder and performs the removals.
 */
import type { OutboxData, OutboxFs } from "./outbox-store.ts";

/**
 * Unreferenced copies kept for the transcript, whatever their age. A send is the
 * newest copy in the folder, so the screen's row is always inside this window;
 * the cap exists so the folder cannot grow with every photo ever sent.
 */
export const KEEP_DISPLAY_COPIES = 60;

/**
 * How long an unreferenced copy is kept regardless (one week). Long enough for
 * a transcript left open, an outbox item waiting on another computer, and a
 * draft the store has not loaded yet; short enough that abandoned photos do not
 * live on the phone for ever.
 */
export const COPY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** `photoCopyName`'s leading `<stamp>-<seq>-` (its clock, which orders the folder). */
const COPY_NAME = /^(\d+)-(\d+)-/;

/** The file's name inside its folder (a URI's last segment; a bare name as-is). */
function nameOf(uri: string): string {
  const at = uri.lastIndexOf("/");
  return at === -1 ? uri : uri.slice(at + 1);
}

/** Two URIs naming one file (a `file://` prefix or a re-encoded path must not hide it). */
function samePath(one: string, other: string): boolean {
  return one === other || nameOf(one) === nameOf(other);
}

export interface SweepOptions {
  /** The phone's clock, injected (the stamps are `photoCopyName`'s pick clock). */
  readonly now: number;
  /** Copies still named by a live item or draft: never removed, whatever their age. */
  readonly inUse?: readonly string[];
  readonly keep?: number;
  readonly graceMs?: number;
}

/**
 * The copies that may go, from what the folder holds (`listing` is URIs or bare
 * file names, as the port's `list` answers).
 *
 * An entry whose name is not `photoCopyName`'s own shape is skipped: a foreign
 * file in that folder was not written by us and is never removed.
 */
export function copiesToRemove(
  listing: readonly string[],
  options: SweepOptions,
): readonly string[] {
  // A window of 0 is meaningful (and is how the tests isolate the other rules):
  // it means "no tail protection", never "protect the newest anyway" — the
  // DEFAULT is what a caller gets, and it is `KEEP_DISPLAY_COPIES`.
  const keep = Math.max(0, Math.trunc(options.keep ?? KEEP_DISPLAY_COPIES));
  const graceMs = options.graceMs ?? COPY_GRACE_MS;
  const inUse = options.inUse ?? [];
  const eligible: { readonly uri: string; readonly stamp: number }[] = [];
  for (const uri of listing) {
    if (inUse.some((used) => samePath(used, uri))) {
      continue;
    }
    const match = COPY_NAME.exec(nameOf(uri));
    if (match === null) {
      continue;
    }
    const stamp = Number(match[1]);
    // A pick from before the grace window (and not one of the newest `keep`):
    // the only copies old enough to be abandoned.
    if (Number.isFinite(stamp) && options.now - stamp < graceMs) {
      continue;
    }
    // The ORDER is the composite, not the millisecond: two picks in one
    // millisecond are named by their `seq` (`photoCopyName`), and that is what
    // decides which of them is newer.
    eligible.push({
      uri,
      stamp: Number.isFinite(stamp) ? stamp * 1000 + Number(match[2]) : 0,
    });
  }
  // Newest first: the send on screen is the last copy written.
  eligible.sort((one, other) => other.stamp - one.stamp);
  return eligible.slice(keep).map((entry) => entry.uri);
}

/**
 * Trim `dir` (the rules above), over the store's own port. Answers the paths it
 * removed, for a caller that logs them.
 *
 * A failure to list or to remove is not an error: the folder is disk, and a
 * stray copy costs bytes only — no item's state depends on this.
 */
export async function prunePhotoCopies(
  fs: Pick<OutboxFs, "list" | "remove">,
  dir: string,
  options: SweepOptions,
): Promise<readonly string[]> {
  let listing: readonly string[];
  try {
    listing = await fs.list(dir);
  } catch {
    return [];
  }
  const remove = copiesToRemove(listing, options);
  for (const path of remove) {
    await fs.remove(path).catch(() => {});
  }
  return remove;
}

/**
 * Every copy one computer's store still names: its items' photo files, its items'
 * DOCUMENT files (a PDF pick's copy, docs/feat/pdf-read.md D7) and its drafts'
 * chips. What `prunePhotoCopies` must never remove.
 */
export function inUseCopies(data: OutboxData): readonly string[] {
  return [
    ...data.items.flatMap((item) => item.photos.map((photo) => photo.file)),
    ...data.items.flatMap((item) => (item.documents ?? []).map((document) => document.file)),
    ...data.drafts.flatMap((draft) => draft.photos),
  ];
}

/**
 * The preview cards' kept previews, BOUNDED (docs/feat/mobile-file-preview-cards.md;
 * Review round 1's finding 1): the pure plan for what a `previews/` directory
 * may hold, so a phone that scrolls past a hundred PDF pages does not keep a
 * JPEG for every one of them until it is unpaired.
 *
 * Why this exists at all: a made preview is written BESIDE the artifact cache
 * (`artifact-preview-expo.ts`), deliberately outside `artifact-cache-store.ts`'s
 * 200 MB plan — those bytes are the source a preview is made FROM, and evicting
 * a page because the 200 MB filled up would throw away the cheap result of an
 * expensive read. So the preview store needs its own, smaller bound, and it has
 * to be a PLAN (like `artifact-cache.ts`) rather than a rule scattered in the
 * expo binding: which file to delete is a decision with a trap.
 *
 * The traps, each one a bug this module exists to avoid:
 * 1. **A preview is a PAIR** — `<sha>-w<W>.json` (what was made) and, for a
 *    page, `<sha>-w<W>.jpg` (its pixels). Pruning one half does not bound
 *    anything; it orphans the other (a JSON whose image is gone is remade, so
 *    the bytes come back on the next scroll).
 * 2. **The preview just saved is never the one deleted**, even when its clock
 *    says it is the oldest: two files made in the same millisecond share the
 *    time, and a prune that ran after `save` could otherwise delete the thing
 *    the very card on screen is about to load.
 * 3. **A cap that nothing fits still bounds the store.** "It does not fit, keep
 *    it anyway" is exactly the monotonic growth being fixed.
 * 4. **A file that is not a preview is neither counted nor deleted.** A stray
 *    stranger in the directory would otherwise spend the budget of previews the
 *    plan can never shrink.
 *
 * The OLDEST preview goes first (the directory's modification times), the way
 * the artifact cache drops its least recently used, and it stops as soon as the
 * rest fits.
 */
import { ARTIFACT_CACHE_BYTES } from "./artifact-cache.ts";

/**
 * What all kept previews may occupy, per computer: a quarter of the artifact
 * cache's own 200 MB cap. A preview is a few hundred KB at most (a page JPEG, or
 * 4 KB of text), so this holds well over a hundred cards — far more than a
 * screen ever shows — while a phone that scrolls through a long session still
 * stops growing.
 */
export const PREVIEW_STORE_BYTES = Math.round(ARTIFACT_CACHE_BYTES / 4);

/** One file in the previews directory: its name, its bytes, when it was made. */
export interface PreviewFile {
  readonly name: string;
  readonly size: number;
  /** Modification time (ms); only the ORDER between previews matters. */
  readonly usedAt: number;
}

/** A preview's files share a base name: `<sha256>-w<W>`, then `.json` / `.jpg`. */
const BASE_RE = /^([0-9a-f]{64}-w\d+)\.(?:json|jpg)$/;

/** The preview a file belongs to, or null when its name is not one of ours. */
function previewBase(name: string): string | null {
  return BASE_RE.exec(name)?.[1] ?? null;
}

/**
 * The files to delete so the directory fits `cap`: whole previews, least
 * recently made first, never `keep` (the one just saved). Paths are relative to
 * the previews directory; a file that is not a preview at all is never listed.
 */
export function planPreviewPrune(
  files: readonly PreviewFile[],
  cap: number = PREVIEW_STORE_BYTES,
  keep?: string,
): readonly string[] {
  let total = 0;
  /** One preview's files, and when it counts as made (its oldest file). */
  const previews = new Map<string, { readonly files: string[]; readonly usedAt: number }>();
  for (const file of files) {
    const base = previewBase(file.name);
    // A file that is not a preview is neither counted nor deleted: counting it
    // would make an undeletable stranger force the eviction of previews.
    if (base === null) {
      continue;
    }
    total += file.size;
    const known = previews.get(base);
    if (known === undefined) {
      previews.set(base, { files: [file.name], usedAt: file.usedAt });
    } else {
      known.files.push(file.name);
      // The pair is as old as its OLDER half: a JSON rewritten over its image
      // must not make an old page look new.
      previews.set(base, { files: known.files, usedAt: Math.min(known.usedAt, file.usedAt) });
    }
  }
  if (total <= cap) {
    return [];
  }
  const oldestFirst = [...previews.entries()]
    .filter(([base]) => base !== keep)
    .sort(([aBase, a], [bBase, b]) => a.usedAt - b.usedAt || aBase.localeCompare(bBase));
  const doomed: string[] = [];
  for (const [, preview] of oldestFirst) {
    if (total <= cap) {
      break;
    }
    for (const name of preview.files) {
      doomed.push(name);
      total -= files.find((file) => file.name === name)?.size ?? 0;
    }
  }
  return doomed;
}

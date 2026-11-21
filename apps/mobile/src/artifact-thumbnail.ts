/**
 * A presented file's PREVIEW port, wired (docs/feat/mobile-file-preview-cards.md;
 * the image-only thumbnail of docs/feat/model-artifacts.md D9 grown to every
 * previewable kind). The rules — what is read, made, kept, and what a failure
 * becomes — are `artifact-preview-source.ts`'s; this file only plugs in the
 * phone's real pieces:
 * - the bytes come from the session screen's OWN handle (the feed's published
 *   reader) — never a second `RemoteSession`, which would steal the screen's
 *   stream;
 * - they are kept through the cache's ONE writer (`ARTIFACT_CACHE.put`), so the
 *   200 MB cap sees them like any viewer read;
 * - pages come from QuickLook (`PREVIEW_NATIVE`), kept beside the cache.
 */
import { ARTIFACT_CACHE } from "./artifact-cache-expo.ts";
import type { FeedReader } from "./artifact-feed.ts";
import { previewStore, readTextHead } from "./artifact-preview-expo.ts";
import { createArtifactPreviewSource } from "./artifact-preview-source.ts";
import { PREVIEW_NATIVE } from "./preview-native-expo.ts";
import type { ThumbnailSource } from "./thumbnails.ts";

export function artifactPreviewSource(deps: {
  readonly computerId: string;
  /** The screen's published reader (absent before its attach). */
  readonly reader: () => FeedReader | undefined;
  /** The band's width in points. */
  readonly width: number;
}): ThumbnailSource {
  return createArtifactPreviewSource({
    read: (meta, options) => {
      const read = deps.reader();
      return read === undefined
        ? Promise.reject(new Error("no artifact reader yet"))
        : read(meta, options);
    },
    cached: (meta) => ARTIFACT_CACHE.uriOf(deps.computerId, meta),
    put: (meta, bytes) => ARTIFACT_CACHE.put(deps.computerId, meta, bytes).uri,
    store: previewStore(deps.computerId),
    native: PREVIEW_NATIVE,
    readText: readTextHead,
    width: deps.width,
  });
}

/**
 * A presented IMAGE's thumbnail (docs/feat/model-artifacts.md D9, Owner Q6): the
 * existing driver's port, finally implemented — a card's image is fetched only
 * while its row is on screen, bounded and cancellable exactly as a sent photo's
 * is (`thumbnails.ts` owns those rules; this file owns the bytes).
 *
 * Two decisions live here, both the plan's:
 * - WHICH card images want bytes: images at most 1 MiB (`visibleRefs`' rule).
 *   A bigger one, and every other kind, draws its glyph until it is opened.
 * - WHERE the bytes come from: the session screen's OWN handle
 *   (`SendableHandle.readArtifact`) — never a second `RemoteSession`, which
 *   would steal the screen's stream — then a verified copy in the phone's cache.
 */
import type { ArtifactMeta } from "@tentacle/protocol";
import { ARTIFACT_CACHE } from "./artifact-cache-expo.ts";
import type { ThumbnailSource } from "./thumbnails.ts";

/** The sha256 a card image's `ImageRef.id` is (the meta's content hash, not a title). */
const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * The driver's port over the session screen's handle. `find` resolves a sha back
 * to its meta (the list the screen already published — the driver only knows the
 * ref), and a sha it cannot place is a refusal, never a dial.
 */
export function createArtifactThumbnailSource(deps: {
  readonly find: (sha256: string) => ArtifactMeta | undefined;
  readonly readArtifact: (
    meta: ArtifactMeta,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Uint8Array>;
  readonly computerId: string;
}): ThumbnailSource {
  return {
    async fetch(ref, signal) {
      if (!SHA_RE.test(ref.id)) {
        return null;
      }
      const meta = deps.find(ref.id);
      if (meta === undefined) {
        return null;
      }
      try {
        const bytes = await deps.readArtifact(meta, { signal });
        if (signal.aborted) {
          return null;
        }
        // The SAME one writer as the viewer, so the 200 MB cap sees these bytes
        // too: a thumbnail is a cached version like any other (and a card whose
        // bytes are too big to keep draws its glyph, exactly as before).
        const kept = ARTIFACT_CACHE.put(deps.computerId, meta, bytes);
        return kept.uri === null ? null : { id: ref.id, uri: kept.uri };
      } catch {
        // An abandoned read or a refused one: no thumbnail, and never a throw at
        // the driver (it records the id as failed, which is what this is).
        return null;
      }
    },
  };
}

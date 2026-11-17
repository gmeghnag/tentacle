/**
 * What a tap on an artifact card DOES (docs/feat/model-artifacts.md D9, T7.3):
 * open a viewer, offer Share, or say it is gone — decided purely, so the phone
 * and its tests agree.
 *
 * The rule that matters is `@tentacle/core`'s card action, not the kind: `save`
 * (`other`: a `.zip`, an extension this build does not know) is NEVER handed to
 * a viewer — it is saved/shared and never executed. An unknown wire kind narrows
 * to `other` in `artifactKindOf`, so a newer daemon cannot talk this build into
 * rendering something it does not understand.
 */
import type { ArtifactCardView } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { type CachePlan, type CacheState, planCache } from "./artifact-cache.ts";
import { type ViewerKind, viewerFor } from "./artifact-viewer.ts";

/** What a tap leads to. `unavailable` is said, never silently ignored. */
export type OpenTarget =
  | { readonly kind: "viewer"; readonly viewer: ViewerKind }
  | { readonly kind: "share" }
  | { readonly kind: "unavailable"; readonly note: string };

/** The card's action, as the thing the tap performs. */
export function openTarget(card: ArtifactCardView): OpenTarget {
  if (card.state === "unavailable" || card.action === "none") {
    return { kind: "unavailable", note: "no longer available" };
  }
  if (card.action === "save") {
    return { kind: "share" };
  }
  return { kind: "viewer", viewer: viewerFor({ kind: card.kind }).kind };
}

/**
 * The artifact's bytes as text, when its viewer reads text — `null` for the two
 * whose viewer wants the FILE (an image's pixels, a PDF's pages). Decoding is the
 * platform's UTF-8 (`TextDecoder`), never a hand-rolled one: a pod page with an
 * emoji must render the same text the daemon stored.
 */
export function viewerText(kind: ViewerKind, bytes: Uint8Array): string | null {
  if (kind === "image" || kind === "pdf" || kind === "none") {
    return null;
  }
  return new TextDecoder().decode(bytes);
}

/** One read's cache step: what to write, what to drop, and the note when it cannot fit. */
export interface CacheStep extends CachePlan {
  /** A one-line note for the viewer, or `null` when the file fits. */
  readonly note: string | null;
}

/**
 * Plan one version's arrival in the phone's cache (`planCache`, the LRU that
 * never drops the file a viewer holds). A file too big to keep even with the
 * cache emptied is reported instead of written: the viewer still shows it, it
 * just cannot be shared afterwards.
 */
export function cacheStep(
  state: CacheState,
  meta: ArtifactMeta,
  keep: string | null,
  now: number,
  cap?: number,
): CacheStep {
  const plan =
    cap === undefined ? planCache(state, meta, keep, now) : planCache(state, meta, keep, now, cap);
  return { ...plan, note: plan.wontFit ? tooBigNote(meta) : null };
}

/** The words a too-large file gets: what it is, so the note is not a mystery. */
export function tooBigNote(meta: ArtifactMeta): string {
  return `Too big to keep on this phone (${Math.round(meta.size / (1024 * 1024))} MB)`;
}

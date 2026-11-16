/**
 * How a message's media sits in its bubble (fix/mobile-media-live item 4, the
 * owner's WhatsApp screenshot): the image spans the bubble's full width with the
 * bubble's own radius, and its height follows the photo's shape — clamped, so a
 * tall or absurd ratio never pushes the caption off screen. The caption goes
 * BELOW the image, inside the same bubble; a bubble with no text has no empty
 * text area at all.
 *
 * Pure, and the only place the geometry is decided (AGENTS §7): `TranscriptRow`
 * maps this to elements and owns nothing but colours and glyphs.
 */
import type { ImageRef } from "./transcript-rows.ts";

/**
 * The tallest a bubble's media block may be, as a multiple of its width. A
 * portrait photo is the normal case (an iPhone shoots 3:4), so the clamp cannot
 * be square: a tall photo would be cropped away, which is the opposite of
 * showing the person what they sent. 4/3 lets a 3:4 photo through untrimmed and
 * only bites on panoramas-of-verticals and the missing-ratio fallback.
 */
export const MEDIA_MAX_RATIO = 4 / 3;

/** What one image's box is, in points. */
export interface MediaBox {
  readonly width: number;
  readonly height: number;
  /** The image is drawn at the clamp, so it is cropped to fill (never stretched). */
  readonly cropped: boolean;
}

/**
 * The box for one image at the bubble's `width`.
 *
 * The ratio comes from the ref (its LOCAL copy's measured size); a ref with no
 * ratio — a history row, another device's message, a picker that reported no
 * dimensions — is a square tile, the shape this screen has always drawn for an
 * unknown image and a safe default for one whose bytes it cannot fetch.
 *
 * Never upscales its own height past the clamp and never divides by zero: a
 * nonsense ratio (0, negative, NaN) is treated as missing, because a 0-height
 * box renders as nothing at all.
 */
export function mediaBox(ref: Pick<ImageRef, "aspectRatio">, width: number): MediaBox {
  const safeWidth = Math.max(1, width);
  const ratio = ref.aspectRatio;
  const usable = ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
  const wanted = safeWidth / (usable ?? 1);
  const max = safeWidth * MEDIA_MAX_RATIO;
  if (wanted <= max) {
    return { width: safeWidth, height: Math.max(1, Math.round(wanted)), cropped: false };
  }
  return { width: safeWidth, height: Math.round(max), cropped: true };
}

/** What a bubble draws, in order: its media first, its caption below. */
export interface MediaLayout {
  readonly boxes: readonly MediaBox[];
  /** A caption is drawn only when there is text: never an empty block. */
  readonly captionBelow: boolean;
}

/**
 * The bubble's layout for `refs` at the bubble's `width`.
 *
 * `hasText` is the caller's own "the bubble has words" (it holds the markdown
 * source): with media and no words the bubble is pure image, and the caption
 * slot does not exist — that is the owner's "no empty text area".
 */
export function layoutMedia(
  refs: readonly Pick<ImageRef, "aspectRatio">[],
  options: { readonly width: number; readonly hasText: boolean },
): MediaLayout {
  return {
    boxes: refs.map((ref) => mediaBox(ref, options.width)),
    captionBelow: options.hasText,
  };
}

/**
 * Which URI the bubble may actually draw for one image, or `undefined` when it
 * must draw its label instead (Review round 2, R2-1).
 *
 * The candidate is the local copy, else a fetched thumbnail; `broken` holds the
 * URIs this screen has already been told will not load (`<Image>`'s `onError`).
 * A file can disappear under a row that outlives it — the app trims old photo
 * copies, and a person can delete the phone's data — so the row must be able to
 * say "no pixels" AFTER it started drawing, exactly as it does for a ref it
 * never had bytes for. Without this the bubble is an empty frame, and a tap
 * opens an empty viewer.
 *
 * Pure, because it is a decision (§7): the component only holds the `broken`
 * list and renders whichever answer this gives.
 */
export function displayUri(
  candidate: string | undefined,
  broken: readonly string[],
): string | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  return broken.includes(candidate) ? undefined : candidate;
}

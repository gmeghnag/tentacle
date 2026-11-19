/**
 * How a message's photos are laid out (feat/mobile-thinking-images S3, the
 * owner's mockup F), and whether the message has a bubble at all.
 *
 * A user message's photos are their OWN element, ABOVE the text bubble, right
 * aligned, capped at 200 pt: 1 photo keeps its own shape, 2 sit side by side, 3
 * are one tall tile plus two stacked, 4+ are a 2 × 2 grid whose last tile
 * carries "+N". That is `photoBlock`; `userRowParts` decides whether the bubble
 * exists beside them (a photo-only message has none).
 *
 * The older in-bubble shape — an image spanning the bubble at full width, the
 * caption below it, inside the same bubble (`fix/mobile-media-live` item 4,
 * `mediaBox`/`layoutMedia`) — is still here because `TranscriptRow` still draws
 * it; it goes when S4 wires the photo block in and nothing calls it.
 *
 * Pure, and the only place the geometry is decided (AGENTS §7): `TranscriptRow`
 * maps this to elements and owns nothing but colours and glyphs.
 */
import type { ImageRef, UserRow } from "./transcript-rows.ts";

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

/** The ref's ratio when it can be used, else `undefined` (0, negative, NaN, ∞). */
function usableRatio(ref: Pick<ImageRef, "aspectRatio">): number | undefined {
  const ratio = ref.aspectRatio;
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
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
  const wanted = safeWidth / (usableRatio(ref) ?? 1);
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

/** One tile of a photo block: the photo it draws and the box it fills. */
export interface PhotoTile<T extends Pick<ImageRef, "aspectRatio">> {
  readonly ref: T;
  /** Drawn `cover`, so a box shorter than the photo crops instead of distorting. */
  readonly box: MediaBox;
  /**
   * The tile stands for this many photos — itself and the ones the block hides —
   * drawn as "+N" over it (mockup F: ">4 → +N"). Absent when nothing is hidden,
   * so a tile never says "+1" for itself.
   */
  readonly overflow?: number;
}

/** A message's photo block: the tiles in reading order, and the extent they fill. */
export interface PhotoBlock<T extends Pick<ImageRef, "aspectRatio">> {
  readonly tiles: readonly PhotoTile<T>[];
  readonly width: number;
  readonly height: number;
}

/** The block's shape — the owner's mockup F figures, overridable for a test. */
export interface PhotoBlockOptions {
  /** Never wider than this, in points (mockup F: 200). */
  readonly maxWidth?: number;
  /** The hairline between tiles, in points (mockup F: 4). */
  readonly gap?: number;
  /** How many photos are drawn before the last tile becomes "+N" (mockup F: 4). */
  readonly maxTiles?: number;
}

const PHOTO_MAX_WIDTH = 200;
const PHOTO_GAP = 4;
const PHOTO_MAX_TILES = 4;
/**
 * The shortest a lone photo's box may be. A panorama (the owner's 6:1 case) at
 * 200 pt wide would be 33 pt tall — a hairline strip that shows nothing, so
 * below this the photo is drawn `cover` and cropped instead. This is a floor on
 * ONE photo only: a grid cell keeps its square.
 */
const PHOTO_MIN_HEIGHT = 64;

/**
 * The photo block for `refs` (feat/mobile-thinking-images S3, mockup F).
 *
 * 1 photo keeps its own shape inside the cap; 2 are squares side by side; 3 is
 * one tall tile beside two stacked; 4+ is a 2 × 2 grid whose LAST tile carries
 * `overflow` for the photos it hides. Every box is at least 1 pt and no tile is
 * wider than `maxWidth`, so nothing collapses and nothing is upscaled past the
 * owner's cap. The ratio rules are `mediaBox`'s: a missing or nonsense ratio is
 * a square, a too-tall photo is clamped to `MEDIA_MAX_RATIO` and cropped.
 *
 * Pure (§7): `TranscriptRow` maps the tiles to views and owns only colours and
 * glyphs, including the 16 pt radius, which belongs on the block's OUTER corners
 * and is therefore a drawing concern, not a geometry one.
 */
export function photoBlock<T extends Pick<ImageRef, "aspectRatio">>(
  refs: readonly T[],
  options: PhotoBlockOptions = {},
): PhotoBlock<T> {
  const maxWidth = Math.max(1, options.maxWidth ?? PHOTO_MAX_WIDTH);
  const gap = Math.max(0, options.gap ?? PHOTO_GAP);
  const maxTiles = Math.max(1, options.maxTiles ?? PHOTO_MAX_TILES);

  if (refs.length === 0) {
    return { tiles: [], width: 0, height: 0 };
  }

  // A lone photo: its own shape, up to the cap, with the panorama floor.
  const [only] = refs;
  if (refs.length === 1 && only !== undefined) {
    // The photo's own height (a missing ratio is the square fallback), then the
    // two bounds that keep it drawable: never taller than `MEDIA_MAX_RATIO` and
    // never the panorama strip below `PHOTO_MIN_HEIGHT`.
    const ideal = maxWidth / (usableRatio(only) ?? 1);
    const capped = Math.min(ideal, maxWidth * MEDIA_MAX_RATIO);
    const height = Math.round(Math.max(PHOTO_MIN_HEIGHT, capped));
    // Cropped only when a bound actually bit — a rounding half-point is the
    // photo's own shape, not a crop.
    const cropped = Math.abs(height - ideal) > 0.5;
    const box: MediaBox = { width: maxWidth, height, cropped };
    return { tiles: [{ ref: only, box }], width: box.width, height: box.height };
  }

  // Two or more: equal square cells, `gap` apart, two per row.
  const shown = Math.min(refs.length, maxTiles);
  const cell = Math.max(1, Math.floor((maxWidth - gap) / 2));
  const rows = Math.ceil(shown / 2);
  const width = cell * 2 + gap;
  const height = rows * cell + (rows - 1) * gap;
  /** The last tile stands for one drawn photo plus every one the block hides. */
  const hidden = refs.length - shown;
  const tiles: PhotoTile<T>[] = [];
  for (const [index, ref] of refs.entries()) {
    if (index >= shown) {
      break;
    }
    const isLast = index === shown - 1;
    // 3 photos: the first tile is one tall tile running the block's whole height,
    // the other two stack beside it (mockup F).
    const tall = shown === 3 && index === 0;
    tiles.push({
      ref,
      box: { width: cell, height: tall ? height : cell, cropped: false },
      ...(isLast && hidden > 0 ? { overflow: hidden + 1 } : {}),
    });
  }
  return { tiles, width, height };
}

/**
 * What a user message draws: its photos and/or its bubble.
 *
 * A photo-only message has NO bubble (mockup F: the photo is its own element) —
 * an empty `fill` block under the photos would be a second element saying
 * nothing. The bubble exists iff it holds words, the attached files' lines, or
 * the context-reset caption.
 */
export function userRowParts(row: Pick<UserRow, "text" | "images" | "documents" | "restart">): {
  readonly photos: boolean;
  readonly bubble: boolean;
} {
  return {
    photos: row.images.length > 0,
    bubble: row.text !== "" || (row.documents?.length ?? 0) > 0 || row.restart === true,
  };
}

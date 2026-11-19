/**
 * How a message's photos are laid out (feat/mobile-thinking-images S3, the
 * owner's mockup F), and whether the message has a bubble at all.
 *
 * A user message's photos are their OWN element, ABOVE the text bubble, right
 * aligned, capped at 200 pt: 1 photo keeps its own shape, 2 sit side by side, 3
 * are one tall tile plus two stacked, 4+ are a 2 × 2 grid whose last tile
 * carries "+N". That is `photoBlock`; `userRowParts` decides whether the bubble
 * exists beside them (a photo-only message has none). `viewerPages` is the same
 * block seen full screen: which pages the viewer holds, and which one a tap on a
 * tile opens.
 *
 * The older in-bubble shape (an image spanning the bubble at full width, the
 * caption below it, inside the same bubble — `fix/mobile-media-live` item 4) is
 * GONE since S4: `layoutMedia`/`mediaBox` had no consumer left once
 * `TranscriptRow` drew the block, and a second geometry beside `photoBlock`
 * would only drift from it.
 *
 * Pure, and the only place the geometry is decided (AGENTS §7): `TranscriptRow`
 * maps this to elements and owns nothing but colours and glyphs.
 */
import type { ImageRef, UserRow } from "./transcript-rows.ts";

/**
 * The tallest a lone photo's box may be, as a multiple of its width. A portrait
 * photo is the normal case (an iPhone shoots 3:4), so the clamp cannot be
 * square: a tall photo would be cropped away, which is the opposite of showing
 * the person what they sent. 4/3 lets a 3:4 photo through untrimmed and only
 * bites on panoramas-of-verticals and the missing-ratio fallback.
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
 * owner's cap. A missing or nonsense ratio is a square, and a too-tall lone
 * photo is clamped to `MEDIA_MAX_RATIO` and cropped.
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

/** One page of the full-screen viewer: the pixels to draw, and what they are. */
export interface ViewerItem {
  readonly uri: string;
  readonly label: string;
}

/** A tile as the viewer sees it: its pixels when the row has any, else only a label. */
export interface ViewerTile {
  /** The URI `displayUri` answered for this tile — absent: no pixels to pull up. */
  readonly uri: string | undefined;
  readonly label: string;
}

/** The viewer's pages, and which one it opens on. */
export interface ViewerPages {
  readonly pages: readonly ViewerItem[];
  /** The page the tap opened, or `-1` when there is nothing to show (viewer closed). */
  readonly index: number;
}

/**
 * What the full-screen viewer holds when a person taps tile `tapped` (mockup F:
 * tap → full screen, "2 of 5", swipe, pinch, caption, share).
 *
 * A tile the row is drawing a label for has NO pixels (a history row, another
 * device's message, a file trimmed under the row), so it is skipped rather than
 * opened as an empty page — the same answer `displayUri` gave the tile itself.
 * The index is the tapped photo's own page in the FILTERED list, so a skipped
 * tile before it never shifts the count the header reads. `-1` means "nothing to
 * open": one state, the viewer's own `visible` test, never a parallel flag.
 */
export function viewerPages(tiles: readonly ViewerTile[], tapped: number): ViewerPages {
  const pages: ViewerItem[] = [];
  let index = -1;
  for (const [position, tile] of tiles.entries()) {
    if (tile.uri === undefined) {
      continue;
    }
    if (position === tapped) {
      index = pages.length;
    }
    pages.push({ uri: tile.uri, label: tile.label });
  }
  return { pages, index };
}

/**
 * The page a horizontal pager rests on after a swipe: the nearest whole page to
 * its offset, clamped into `0…count-1` (an iOS bounce reads past either end).
 * `-1` when there is no page at all; the first page while the width is unknown.
 */
export function viewerPageAt(offsetX: number, pageWidth: number, count: number): number {
  if (count <= 0 || !(pageWidth > 0) || !Number.isFinite(offsetX)) {
    return count <= 0 ? -1 : 0;
  }
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / pageWidth)));
}

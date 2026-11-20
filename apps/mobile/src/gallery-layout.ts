/**
 * The Artifacts gallery's two looks (docs/feat/mobile-gallery-polish.md; mockup
 * `.tentacle/mockups/model-artifacts/` section 7: A list, B grid): which one is
 * shown, what the header toggle offers, the grid's cells and the tile sizes —
 * pure and React-free (AGENTS §7). `screens/ArtifactGallery.tsx` only renders.
 */
import type { ArtifactKind } from "@tentacle/protocol";
import type { IconName } from "./ui/Icon.tsx";

export type GalleryLayout = "list" | "grid";

/** The list's default: the look the owner chose on 2026-11-16 (mockup 7 A). */
export const DEFAULT_GALLERY_LAYOUT: GalleryLayout = "list";

/** The list row's tile, in pt (was 40: "un filino più grandi", owner 2026-11-20). */
export const LIST_TILE = 52;
/** The list row's vertical padding: tile + 2 × this = the row's least height. */
export const LIST_ROW_PADDING = 8;
/** The grid's columns and the hairline gap between cells (mockup 7 B). */
export const GRID_COLUMNS = 3;
export const GRID_GAP = 2;

export function otherLayout(layout: GalleryLayout): GalleryLayout {
  return layout === "list" ? "grid" : "list";
}

/**
 * The header toggle: it shows the look a tap SWITCHES TO (the grid symbol over a
 * list, the list symbol over a grid), and says so to VoiceOver.
 */
export function layoutToggle(layout: GalleryLayout): {
  readonly icon: IconName;
  readonly label: string;
} {
  return layout === "list"
    ? { icon: "square.grid.2x2", label: "Show as grid" }
    : { icon: "list.bullet", label: "Show as list" };
}

/**
 * The grid's square cell, in pt, for a content width: three columns, two gaps,
 * whole points (a fraction leaves a seam on one side). `0` before measuring.
 */
export function gridCell(width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.floor((width - (GRID_COLUMNS - 1) * GRID_GAP) / GRID_COLUMNS));
}

/** The items in rows of `GRID_COLUMNS` (the last row may be short). */
export function gridRows<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += GRID_COLUMNS) {
    rows.push(items.slice(i, i + GRID_COLUMNS));
  }
  return rows;
}

/** A kind's symbol — what a tile shows with no drawn thumbnail (thin SF Symbols). */
const KIND_SYMBOL: Readonly<Record<ArtifactKind, IconName>> = {
  image: "photo",
  svg: "scribble",
  html: "globe",
  pdf: "doc.richtext",
  markdown: "doc.text",
  text: "doc.plaintext",
  chart: "chart.bar.xaxis",
  other: "doc",
};

export function kindSymbol(kind: ArtifactKind): IconName {
  return KIND_SYMBOL[kind];
}

/** A kind symbol's point size in a tile: about half the tile (mockup: 20 in 40). */
export function kindSymbolSize(tile: number): number {
  return Math.round(Math.min(32, Math.max(18, tile * 0.42)));
}

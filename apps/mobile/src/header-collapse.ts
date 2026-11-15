/**
 * When a list screen's LARGE title has scrolled under the top bar, the compact
 * bar (inline 17 pt title over blur) takes its place, so scrolled content passes
 * under a bar — never under the raw status-bar text (slice-6 visual review V1).
 * Pure and React-free (AGENTS §7); the screen feeds it the scroll offset.
 */
import { size, typography } from "./theme.ts";

/** The compact bar's own height under the safe-area top (an iOS inline nav bar). */
export const COMPACT_BAR_HEIGHT = 44;

/**
 * The offset (pt, from the content's top) at which the large title has slid
 * fully under the compact bar: the buttons row + the title's line − the bar.
 */
export const COLLAPSE_AT = size.headerList + typography.largeTitle.lineHeight - COMPACT_BAR_HEIGHT;

/** Show the compact bar for this scroll offset? (Rubber-band negatives never do.) */
export function compactTitleShown(offsetY: number): boolean {
  return Number.isFinite(offsetY) && offsetY >= COLLAPSE_AT;
}

/**
 * Pure scroll-buffer math for the virtualized transcript viewport.
 *
 * `offset` is the number of rows hidden *below* the viewport — i.e. the
 * distance from the bottom. `offset === 0` means the viewport is stuck to the
 * tail (follow mode); a positive offset means the user has scrolled up into
 * history. Framework-free and fully testable.
 */
export interface ScrollWindow {
  /** First visible row index (inclusive). */
  readonly start: number;
  /** Last visible row index (exclusive). */
  readonly end: number;
}

export type ScrollAction = "lineUp" | "lineDown" | "pageUp" | "pageDown" | "top" | "bottom";

/** Clamp an offset to the valid range for the given content/viewport. */
export function clampOffset(offset: number, total: number, height: number): number {
  const max = Math.max(0, total - Math.max(0, height));
  if (!Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.min(Math.floor(offset), max);
}

/** The visible row window for a given total/height/offset. */
export function windowFor(total: number, height: number, offset: number): ScrollWindow {
  const h = Math.max(0, height);
  const off = clampOffset(offset, total, h);
  const start = Math.max(0, total - h - off);
  const end = Math.min(total, start + h);
  return { start, end };
}

/** Whether the viewport is scrolled up into history (not following the tail). */
export function isScrolledUp(offset: number, total: number, height: number): boolean {
  return clampOffset(offset, total, height) > 0;
}

/** Apply a scroll action, returning the new (clamped) offset. */
export function applyScroll(
  offset: number,
  action: ScrollAction,
  total: number,
  height: number,
): number {
  const page = Math.max(1, height - 1);
  switch (action) {
    case "lineUp":
      return clampOffset(offset + 1, total, height);
    case "lineDown":
      return clampOffset(offset - 1, total, height);
    case "pageUp":
      return clampOffset(offset + page, total, height);
    case "pageDown":
      return clampOffset(offset - page, total, height);
    case "top":
      return clampOffset(total, total, height);
    case "bottom":
      return 0;
  }
}

/**
 * Keep the viewed content anchored when new rows arrive while scrolled up: grow
 * the offset by the number of new rows so the lines the user is reading stay
 * put. In follow mode (offset 0) the viewport stays at the bottom.
 */
export function anchorOnGrowth(
  offset: number,
  prevTotal: number,
  newTotal: number,
  height: number,
): number {
  if (offset <= 0 || newTotal <= prevTotal) {
    return clampOffset(offset, newTotal, height);
  }
  return clampOffset(offset + (newTotal - prevTotal), newTotal, height);
}

/** The inputs of the App's rows-changed anchor rule (`anchorOffset`). */
export interface AnchorOffsetInput {
  /** The total the previous run saw (`prevRowsRef.current`). */
  readonly prevTotal: number;
  /** The total this render has. */
  readonly total: number;
  /**
   * The offset THIS RENDER saw — the guard's input. Kept apart from the offset
   * the returned updater receives on purpose (App's H3 freshness rule): the
   * effect's guard reads the render value, the updater's arithmetic reads the
   * commit value, and the two disagree exactly inside one batched tick (a scroll
   * key and a row growth with no render between them).
   */
  readonly rendered: number;
  /** A text selection is in progress (`selectionRef.current !== null`). */
  readonly selecting: boolean;
  readonly viewport: number;
}

/**
 * The rows-changed anchor rule: rows grew from `prevTotal` to `total` and the
 * reader is anchored — scrolled up (`rendered > 0`), OR selecting text, so the
 * content being selected (e.g. during a running turn) does not scroll out from
 * under them. Then the offset grows by the new rows so the lines being read stay
 * put.
 *
 * Returns the state UPDATER to hand `setScrollOffset`, or `null` for "leave the
 * offset alone" — which is not the same as "return it unchanged": while nothing
 * anchors the reader the App must not touch the offset at all (no queue entry),
 * exactly as before. The updater reads the offset at COMMIT time, so a scroll
 * key batched in the same tick still counts.
 */
export function anchorOffset(input: AnchorOffsetInput): ((offset: number) => number) | null {
  const { prevTotal, total, rendered, selecting, viewport } = input;
  if (total <= prevTotal || (rendered <= 0 && !selecting)) {
    return null;
  }
  const grow = total - prevTotal;
  return (offset) => clampOffset(offset + grow, total, viewport);
}

/**
 * The E2 row's value decisions (docs/feat/mobile-chrome.md Design 4, S3), pure and
 * React-free so a behaviour is testable in one place (AGENTS §7):
 *
 * - **Which end of a value its ellipsis eats.** The value never truncates to
 *   nothing useful: a path keeps its TAIL (the last directory is what tells two
 *   paths apart), a model id keeps both its family and its quantisation suffix,
 *   prose keeps its head.
 * - **When the value drops below the label** (F10, Dynamic Type). A label is
 *   never truncated (Design 4), so at large sizes the row becomes two lines: the
 *   label on its own, the value under it, still right-aligned.
 *
 * `ui/Row.tsx` is the only caller and it only renders what these return.
 */

/** What a value IS, which decides the end its ellipsis eats. */
export type RowValueKind = "text" | "path" | "model";

/** The `ellipsizeMode` React Native accepts for a one-line value. */
export type ValueEllipsis = "head" | "middle" | "tail";

/**
 * A path keeps its tail (`…/hop-live/proj`), a model both ends (`Qwen3.8…Q6_K`),
 * prose its head. Anything unknown is prose — the safe default, since a `text`
 * value that loses its tail still reads as a sentence, while a path that loses
 * its tail is ambiguous.
 */
export function valueEllipsis(kind: RowValueKind): ValueEllipsis {
  switch (kind) {
    case "path":
      return "head";
    case "model":
      return "middle";
    case "text":
      return "tail";
  }
}

/**
 * From this font scale on, a row's value goes UNDER its label instead of beside
 * it (F10). It is `theme.ts`'s `DENSE_FONT_SCALE`: at the cap the label is at its
 * widest, so one line no longer holds both without truncating one of them.
 */
export const ROW_WRAP_AT = 1.4;

export interface RowLayout {
  /** `row`: label left, value right. `column`: value under the label. */
  readonly direction: "row" | "column";
  readonly valueAlign: "left" | "right";
  /** The value takes the full width of the row (it owns the second line). */
  readonly valueFullWidth: boolean;
  /**
   * Where a trailing control (a switch) sits: `center` beside a one-line label,
   * `top` against a label that is TALLER than one line — a switch floating in the
   * middle of a wrapped paragraph (or of a label with a description under it) is
   * the bug Design 4 names.
   */
  readonly controlAlign: "center" | "top";
}

const ONE_LINE: RowLayout = {
  direction: "row",
  valueAlign: "right",
  valueFullWidth: false,
  controlAlign: "center",
};
const WITH_DESCRIPTION: RowLayout = { ...ONE_LINE, controlAlign: "top" };
const STACKED: RowLayout = {
  direction: "column",
  valueAlign: "right",
  valueFullWidth: true,
  controlAlign: "top",
};

/**
 * The row's layout at a given Dynamic Type scale, and whether the row carries a
 * description under its label. A reading the platform cannot supply (`NaN`,
 * `±Infinity`) falls back to the one-line layout: a broken scale must never
 * leave the label with no width at all.
 */
export function rowLayout(fontScale: number, options: { description?: boolean } = {}): RowLayout {
  const description = options.description === true;
  if (!Number.isFinite(fontScale)) {
    return description ? WITH_DESCRIPTION : ONE_LINE;
  }
  if (fontScale >= ROW_WRAP_AT) {
    return STACKED;
  }
  return description ? WITH_DESCRIPTION : ONE_LINE;
}

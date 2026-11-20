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
 * - **How the label column is sized.** "Never truncated" means the label WRAPS;
 *   it does not mean it may overflow. A column that refuses to shrink takes its
 *   measured width and pushes the chevron/switch off the row (fix round 1,
 *   finding 1), so the sizing is a decision, and it is here.
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
  /**
   * The label column's width rule, which is what keeps a trailing control INSIDE
   * the row:
   *  - `fill` — no value beside it: the label takes the remaining width and wraps
   *    (`flex: 1`), so a long title grows the row's height, never its width;
   *  - `capped` — a value shares the line: the label keeps at most 70% of the row
   *    so the value's own ellipsis has a column;
   *  - `stacked` — the value is under the label, so the label owns the row.
   *
   * In every case the column may SHRINK: refusing to would push a chevron or a
   * switch past the row's edge (measured: 396 pt on a 390 pt row).
   */
  readonly labelSizing: "fill" | "capped" | "stacked";
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
  valueAlign: "right",
  valueFullWidth: false,
  controlAlign: "center",
  labelSizing: "fill",
};
const WITH_DESCRIPTION: RowLayout = { ...ONE_LINE, controlAlign: "top" };
const WITH_VALUE: RowLayout = { ...ONE_LINE, labelSizing: "capped" };
const WITH_DESCRIPTION_AND_VALUE: RowLayout = { ...WITH_VALUE, controlAlign: "top" };
const STACKED: RowLayout = {
  valueAlign: "right",
  valueFullWidth: true,
  controlAlign: "top",
  labelSizing: "stacked",
};

/**
 * The row's layout at a given Dynamic Type scale, whether the row carries a
 * description under its label, and whether a value shares the line. A reading the
 * platform cannot supply (`NaN`, `±Infinity`) falls back to the one-line layout:
 * a broken scale must never leave the label with no width at all.
 */
export function rowLayout(
  fontScale: number,
  options: { description?: boolean; hasValue?: boolean } = {},
): RowLayout {
  const description = options.description === true;
  const hasValue = options.hasValue === true;
  if (Number.isFinite(fontScale) && fontScale >= ROW_WRAP_AT) {
    return STACKED;
  }
  if (!hasValue) {
    return description ? WITH_DESCRIPTION : ONE_LINE;
  }
  return description ? WITH_DESCRIPTION_AND_VALUE : WITH_VALUE;
}

/**
 * What a row's trailing element IS (fix round 1, docs/fix/mobile-e2e-reds.md):
 *  - `none` — nothing is drawn there (`undefined`, or a caller's `null`);
 *  - `value` — a READ, not an action: a state word, a plain value, a reason, a
 *    checkmark. It is part of the row and is read with it;
 *  - `control` — something the person (or XCUITest) acts on: a switch, a
 *    Delete, a Stop/Retry, a confirm's two words.
 *
 * The distinction is the caller's to state, because a `ReactNode` cannot be
 * classified from the outside: Session info's `values` and its `delete` are both
 * a `View`, and Commands' one edge slot is a `<Text>` reason for a dimmed row and
 * a two-button `View` for a running one.
 */
export type RowTrailing = "none" | "value" | "control";

/**
 * What to tell VoiceOver about the element a caller put at the row's edge. An
 * absent one is `none` whatever the caller declared (Commands' `edgeFor`
 * returns `null` for every ready row, Tools' is `null` for a band with no
 * switch): the absence of an edge is never a control. Otherwise the declaration
 * stands, and `control` is the floor — for an undeclared element and for a
 * caller that says `none` while passing one (a contradiction). Swallowing an
 * actionable control is the worse failure (a disabled "Dictation, Dictation"
 * element VoiceOver and XCUITest cannot reach), while a value wrongly called a
 * control only splits a read-only row into two elements.
 */
export function rowTrailing(trailing: unknown, declared: RowTrailing | undefined): RowTrailing {
  if (trailing === undefined || trailing === null) {
    return "none";
  }
  return declared === undefined || declared === "none" ? "control" : declared;
}

/**
 * How a row is exposed to VoiceOver (and so to XCUITest), fix/mobile-e2e-reds.
 * `group`: the row is ONE element — a row with its own action and no control (one
 * button), or a read-only row (label + value read together). A row with a
 * trailing CONTROL never groups: grouped, the control was swallowed — a disabled
 * "Dictation, Dictation" element in Settings, an unreachable server switch in
 * Session info. `textButton`: such a row that also has its own action keeps it,
 * on its label column, so neither the action nor the control is lost.
 *
 * The trailing element is passed as what it IS (`rowTrailing`), never as "is
 * something there": treating every defined `trailing` as a control ungrouped
 * every read-only row that shows a value (fix round 1).
 */
export function rowAccessibility(row: {
  readonly pressable: boolean;
  readonly trailing: RowTrailing;
}): { readonly group: boolean; readonly textButton: boolean } {
  const control = row.trailing === "control";
  return { group: !control, textButton: control && row.pressable };
}

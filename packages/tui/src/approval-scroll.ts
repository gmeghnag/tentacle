/**
 * The `workflow_approve` dialog's detail scroll (docs/fix/workflow-approve-detail.md
 * D2, owner answer Q1): the approval shows the WHOLE step list — every `run`
 * command verbatim, wrapped, never cut — and a list taller than the dialog is
 * scrolled, one window at a time, with a row saying how much is left.
 *
 * Pure and React-free (AGENTS §7): the offset is the only state, `total` and
 * `window` come from the view (`permissionView`), so the layout's row count and
 * the paint read one decision. **Nothing gates the answer**: the owner decided
 * Yes is always allowed, so this decides only what is on screen. The dialog is
 * no taller than it is today (`MAX_DETAIL_ROWS`), so `permissionPromptRows`
 * keeps describing the frame exactly.
 */
import type { Key } from "ink";

/** Where the detail is scrolled to, for ONE request (reset with `shownAt`). */
export interface ApprovalScroll {
  /**
   * The first detail row drawn. The controller stores what the person asked
   * for; the VIEW clamps it (a resize re-wraps the list), so a stale offset can
   * never draw a blank window.
   */
  readonly offset: number;
}

export const NO_APPROVAL_SCROLL: ApprovalScroll = { offset: 0 };

/** Does this key scroll the approval list? */
export function isApprovalScrollKey(char: string, key: Key): boolean {
  return key.pageDown || key.pageUp || char === " " || char === "b";
}

/** One key's scroll step, and whether it was a scroll key at all. */
export interface ApprovalScrollStep {
  readonly scroll: ApprovalScroll;
  /**
   * The key was Space / PgUp / PgDn: consumed even at a clamp, because it means
   * nothing else to the dialog either.
   */
  readonly taken: boolean;
}

/**
 * One key's scroll step: PgDn / Space move one window down, PgUp / `b` one
 * window up, clamped to the last window. Any other key leaves the offset alone
 * and reports `taken: false`, so the caller can pass every key through here
 * first and then to `stepPermissionKey`.
 */
export function stepApprovalScroll(
  state: ApprovalScroll,
  char: string,
  key: Key,
  total: number,
  window: number,
): ApprovalScrollStep {
  const dir = key.pageDown || char === " " ? 1 : key.pageUp || char === "b" ? -1 : 0;
  if (dir === 0) {
    return { scroll: state, taken: false };
  }
  const size = Math.max(1, window);
  const last = Math.max(0, total - size);
  const next = Math.min(last, Math.max(0, state.offset + dir * size));
  return { scroll: next === state.offset ? state : { offset: next }, taken: true };
}

/** The window of `rows` to show at `offset`, where it starts, and what is below it. */
export interface ApprovalRows {
  /** The rows to draw (`offset` clamped to the last window). */
  readonly rows: readonly string[];
  /** The first row drawn, after clamping. */
  readonly start: number;
  /** Rows left BELOW the window (0 = the end is on screen). */
  readonly below: number;
}

export function approvalRows(
  rows: readonly string[],
  offset: number,
  window: number,
): ApprovalRows {
  const size = Math.max(1, window);
  const start = Math.min(Math.max(0, offset), Math.max(0, rows.length - size));
  const shown = rows.slice(start, start + size);
  return { rows: shown, start, below: Math.max(0, rows.length - (start + shown.length)) };
}

/** The row under a scrollable window: how much is left, and which keys scroll. */
export function approvalHint(below: number): string {
  if (below === 0) {
    return "↑ all shown · PgUp back";
  }
  return `↓ ${below} more line${below === 1 ? "" : "s"} below · Space/PgDn`;
}

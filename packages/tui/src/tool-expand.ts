/**
 * Per-call expansion of a tool call's command (docs/feat/tui-tool-expand.md).
 *
 * A tool call's header carries its label and a subtitle (a `shell` command, a
 * path, an `fs_multi_edit` target…). Collapsed, that subtitle is cut to fit the
 * header on ONE row at the current terminal width; expanded, the whole command
 * is shown wrapped under the header. Both the cut and the "which call is
 * expanded" state live here, as does the classification of a mouse report into
 * a click (press and release on the SAME cell, no drag in between).
 *
 * Pure and framework-free: reports/strings in, decisions/strings out — the App
 * only executes them (AGENTS §7).
 */
import stringWidth from "string-width";
import { expandTabs } from "./input-view.ts";
import type { MouseReport } from "./mouse.ts";

/** A cell in the terminal grid, as an SGR report gives it: 1-based col/row. */
export interface ClickCell {
  readonly x: number;
  readonly y: number;
}

/**
 * The click recogniser's state: the cell of the left press that armed it, or
 * null. A drag (any report with the motion bit) or a press at another cell
 * disarms it, so a smeared press→release is never a click.
 */
export interface ClickState {
  readonly armed: ClickCell | null;
}

export const CLICK_IDLE: ClickState = { armed: null };

/** What one report did: the new state, plus a completed click's cell if any. */
export interface ClickStep {
  readonly state: ClickState;
  readonly click: ClickCell | null;
}

// SGR button bits (mouse.ts's `btn`): 64 = wheel, 32 = motion/drag, 3 = button.
const WHEEL_BIT = 64;
const MOTION_BIT = 32;
const BUTTON_MASK = 3;

/**
 * Feed one SGR report to the click recogniser.
 *
 * A click is a left press and a release **on the same cell, with no report in
 * between**. Reports arrive one at a time (the App loops `splitMouseReports`'
 * output in order), so a coalesced press+release chunk — the common case, a
 * terminal writing both in one `read` — is still seen as press then release.
 * Wheel notches and non-left buttons never arm or complete one.
 */
export function nextClick(state: ClickState, report: MouseReport): ClickStep {
  const btn = report.btn & ~WHEEL_BIT; // a wheel report also carries the motion bit
  if ((report.btn & WHEEL_BIT) !== 0 || (btn & BUTTON_MASK) !== 0) {
    return { state, click: null };
  }
  if (!report.press) {
    const armed = state.armed;
    const same = armed !== null && armed.x === report.x && armed.y === report.y;
    return {
      state: CLICK_IDLE,
      click: same && armed ? { x: armed.x, y: armed.y } : null,
    };
  }
  if ((btn & MOTION_BIT) !== 0) {
    // Motion: a drag, which is text selection. It can never end as a click.
    return { state: CLICK_IDLE, click: null };
  }
  return { state: { armed: { x: report.x, y: report.y } }, click: null };
}

/** Whether `id`'s command is shown expanded (ids are the daemon's tool-call ids). */
export function isExpanded(ids: readonly string[], id: string): boolean {
  return ids.includes(id);
}

/**
 * The expanded-id set with `id` toggled. A sorted array rather than a Set: it is
 * a stable, cheaply comparable cache key for the per-item layout, and it never
 * mutates (so a re-render cannot be missed).
 */
export function toggleExpanded(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id)
    ? ids.filter((i) => i !== id)
    : [...ids, id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The subtitle as ONE header row's worth of text, cut to `budget` DISPLAY
 * columns (the owner's rule: measured with `string-width`, not `.length`, so a
 * CJK/emoji command is not cut short or left overflowing). Tabs are expanded
 * and newlines flattened to spaces — the header is one row by construction; a
 * multi-line command's lines are what the EXPANDED view shows.
 */
export function fitSubtitle(subtitle: string, budget: number): string {
  const flat = expandTabs(subtitle)
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
  const b = Math.floor(budget);
  if (b <= 0) {
    return "";
  }
  if (stringWidth(flat) <= b) {
    return flat;
  }
  const room = b - 1; // the ellipsis takes one column
  let out = "";
  let width = 0;
  for (const ch of flat) {
    const w = stringWidth(ch);
    if (width + w > room) {
      break;
    }
    out += ch;
    width += w;
  }
  return `${out.trimEnd()}…`;
}

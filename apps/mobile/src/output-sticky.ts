/**
 * Which open shell output's step row sticks to the top of the transcript
 * (docs/feat/mobile-shell-output-scroll.md, owner 24/11 "b"). Pure: the screen
 * measures the blocks and feeds the scroll offset in; this decides.
 *
 * A block is an OPEN output step: `top` is its step row's top and `bottom` the
 * end of its body, both in the list's content coordinates. It sticks while
 * `top <= scrollY < bottom`. Its end pushes it up (`offsetY`), and the next
 * block's start is the same boundary, so the iOS section-header handover falls
 * out of the one formula — never a text swap. A collapsed step is not a block.
 */
import { type StepCell, isOpen, stepRowView } from "./tool-steps.ts";
import type { Row } from "./transcript-rows.ts";

export interface StickyBlock {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
  /** The step row's height (what sticks). */
  readonly headH: number;
  /** Where the output text starts (content coordinates). */
  readonly bodyTop: number;
  readonly lineH: number;
  /** The output's line count (the "of N"). */
  readonly lines: number;
}

export interface StickyState {
  readonly key: string;
  /** 0, or negative while the block's end pushes the row up. */
  readonly offsetY: number;
  /** The first output line under the sticky row (1-based). */
  readonly line: number;
  readonly total: number;
}

export function stickyState(scrollY: number, blocks: readonly StickyBlock[]): StickyState | null {
  for (const b of blocks) {
    // Never sticks if the block is no taller than its own row.
    if (b.bottom - b.top <= b.headH || scrollY < b.top || scrollY >= b.bottom) {
      continue;
    }
    const first = Math.floor((scrollY + b.headH - b.bodyTop) / b.lineH) + 1;
    return {
      key: b.key,
      offsetY: Math.min(0, b.bottom - b.headH - scrollY),
      line: Math.min(Math.max(first, 1), Math.max(b.lines, 1)),
      total: b.lines,
    };
  }
  return null;
}

/** Equal for rendering: the overlay re-renders only when this changes. */
export function sameSticky(a: StickyState | null, b: StickyState | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.key === b.key && a.line === b.line && a.total === b.total && a.offsetY === b.offsetY;
}

/** An open step the sticky row can show. */
export interface OutputStep {
  /** The command the sticky row names (the step's `$` line, else its subtitle). */
  readonly label: string;
  /** Every output line, the cut head included (the "of N"). */
  readonly total: number;
}

/**
 * The OPEN steps that have an output (a collapsed or output-less step never
 * sticks), by row key. Cheap: it runs when the open/full sets or the rows
 * change, not per scroll frame.
 */
export function openOutputSteps(
  rows: readonly Row[],
  open: readonly string[],
  full: readonly string[],
  cells: ReadonlyMap<string, StepCell>,
  compact: boolean,
): Map<string, OutputStep> {
  const out = new Map<string, OutputStep>();
  for (const row of rows) {
    if (row.kind !== "tool" || !isOpen(open, row.key)) {
      continue;
    }
    const cell = cells.get(row.key);
    const view = stepRowView(
      row,
      cell?.kind === "step" ? cell.thought : null,
      isOpen(full, row.key),
      cell?.kind === "step" && cell.thoughtFirst,
      compact,
    );
    if (view.output === null || view.file !== undefined) {
      continue;
    }
    const shown = view.output.text.split("\n").length;
    out.set(row.key, {
      label: view.subline ?? view.subtitle,
      total: shown + view.output.hidden,
    });
  }
  return out;
}

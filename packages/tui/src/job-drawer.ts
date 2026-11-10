/**
 * A background SHELL job's drawer (docs/feat/shell-jobs-panel.md, Design 6):
 * the tail window, the refresh cadence as a PURE predicate, and the two rules
 * that keep the frame stable.
 *
 * Pure: no React, no I/O, no clock of its own — the App owns the one timer and
 * passes `now` in, so every rule here is testable without waiting a second.
 *
 * Owner answers baked in: Q4 (b) — stdout and stderr are MERGED into ONE array
 * upstream (as the model's `shell_output` sees them), so there is no `stderr`
 * section here; Q5 (b) — the id paints as the wire's own `bg-N`, no `sh-N`
 * alias.
 */
import { truncateCells } from "./cells.ts";

/** How many tail lines the drawer paints (the child drawer's 8-label analogue). */
export const JOB_TAIL_SHOWN = 12;
/** The refresh interval while a job's drawer is open: at most one read a second. */
export const JOB_REFRESH_MS = 1000;
/** What a job with nothing to show yet says: never an empty, zero-height body. */
export const JOB_EMPTY_LINE = "(no output yet)";
/**
 * Ink measures an empty `<Text>` as 0×0, so a blank output line would collapse
 * and the height `dockRows` reserved would stop matching what is painted (the
 * frame shifts — AGENTS §6). A blank line is therefore ONE space; the output
 * grid `trimEnd()`s it back to `""` when it leaves the screen.
 */
export const BLANK_LINE = " ";

/**
 * The lines a job's drawer paints: the last `shown` of the merged output, each
 * cell-cut for the width, and a blank line as `" "` (never `""`).
 */
export function jobTailWindow(
  output: readonly string[] | undefined,
  opts: { readonly shown?: number; readonly width: number },
): string[] {
  const shown = opts.shown ?? JOB_TAIL_SHOWN;
  const lines = (output ?? []).slice(-shown);
  return lines.map((line) => {
    if (line === "") {
      return BLANK_LINE;
    }
    const cut = truncateCells(line, Math.max(1, opts.width));
    return cut === "" ? BLANK_LINE : cut;
  });
}

/** What the drawer's body is: the window, or the one `(no output yet)` row. */
export function jobDrawerTail(
  output: readonly string[] | undefined,
  opts: { readonly shown?: number; readonly width: number },
): string[] {
  const window = jobTailWindow(output, opts);
  return window.length > 0 ? window : [JOB_EMPTY_LINE];
}

/**
 * Is another read due? The App calls this on each tick; `lastAt` is when the
 * last read was issued (or opened). `null` = never read: due at once, so a
 * drawer is never blank while waiting for its first second. Not a job target at
 * all = never due (the timer exists only for an open job's drawer).
 */
export function refreshDue(
  target: "job" | "other",
  lastAt: number | null,
  now: number,
  intervalMs: number = JOB_REFRESH_MS,
): boolean {
  if (target !== "job") {
    return false;
  }
  if (lastAt === null) {
    return true;
  }
  return now - lastAt >= intervalMs;
}

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
import { formatDuration } from "./format.ts";

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
 *
 * `maxLines` is the ROOM the terminal left (review 4, fix round 1): the drawer
 * used to be a fixed 14 rows, so on a short terminal (80×20, 80×16) the frame was
 * taller than the screen and Ink re-cleared it on every repaint (Review H3's
 * flicker class). The caller passes the budget the layout can afford; the tail
 * is cut HERE, in the pure module, where it is testable without a terminal.
 */
export function jobTailWindow(
  output: readonly string[] | undefined,
  opts: { readonly shown?: number; readonly width: number; readonly maxLines?: number },
): string[] {
  const room = opts.maxLines ?? Number.POSITIVE_INFINITY;
  if (room <= 0) {
    return [];
  }
  const shown = Math.min(opts.shown ?? JOB_TAIL_SHOWN, room);
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
  opts: { readonly shown?: number; readonly width: number; readonly maxLines?: number },
): string[] {
  const window = jobTailWindow(output, opts);
  if (window.length > 0) {
    return window;
  }
  // No room at all is the caller's problem (it reserves ≥ 1 row): an empty body
  // would collapse the dock's reservation (AGENTS §6), so say so instead.
  return (opts.maxLines ?? 1) > 0 ? [JOB_EMPTY_LINE] : [];
}

/**
 * How a shell job ended, as its drawer's rule says it (owner B, fix round 1).
 *
 * The EXIT RECORD is the truth (`jobOutcome` builds it from the daemon's own
 * `status`/`exitCode`), never the last read and never the frozen row: a row that
 * left the list still says `running`, and a read issued before the exit answers
 * `running` too, so either would paint the wrong death.
 */
export type JobEnd =
  /** A normal end with the code the daemon reported. */
  | { readonly kind: "exited"; readonly exitCode: number | null; readonly endedAt?: number }
  /** This dock asked for the stop (`ctrl+x` then `ctrl+x`). */
  | { readonly kind: "stopped"; readonly endedAt?: number }
  /** A signal death nobody in the dock asked for. */
  | { readonly kind: "killed"; readonly endedAt?: number };

/**
 * Read a job's exit RECORD into its outcome. `byDock` is the dock's own memory
 * (a `killed` status cannot tell the user's stop from the model's `shell_kill`);
 * a null code is a signal death even when the status says `exited`, because that
 * is how a signal-killed process reports itself.
 */
export function jobOutcome(opts: {
  readonly status: string;
  readonly exitCode: number | null;
  readonly byDock: boolean;
  /**
   * When the run ended — the ONE instant the App stamps in its exit handler
   * (fix round 2). It is read, never re-stamped: `jobEndView`'s duration is the
   * job's TOTAL run time, so a frozen drawer must not measure to `now`.
   */
  readonly endedAt: number;
}): JobEnd {
  const endedAt = opts.endedAt;
  if (opts.byDock) {
    return { kind: "stopped", endedAt };
  }
  if (opts.status === "killed" || opts.exitCode === null) {
    return { kind: "killed", endedAt };
  }
  return { kind: "exited", exitCode: opts.exitCode, endedAt };
}

/**
 * How long a job has run — the figure the drawer paints (fix round 2).
 *
 * Once the job ENDED the run is over, so the figure is `endedAt − startedAt` and
 * it stops moving: measuring to `now` made a frozen drawer's `· 6s` read `· 9s`
 * three seconds later and keep growing for as long as it stayed open. Only while
 * it still runs is `now` the right clock. A record with no `endedAt` (a frozen
 * drawer from a departure nobody named, an older peer) keeps the live clock —
 * the honest answer when the end instant is genuinely unknown.
 */
export function jobElapsedSeconds(
  startedAt: number,
  end: JobEnd | { readonly kind: "finished" } | null,
  now: number,
): number {
  const endedAt = end !== null && "endedAt" in end ? end.endedAt : undefined;
  return Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
}

/** The drawer's rule's answer: the words, and the tone they take. */
export interface JobEndView {
  readonly text: string;
  /** `true` only for a clean exit: the drawer's rule paints ok vs error tone. */
  readonly ok: boolean;
}

/**
 * The drawer's outcome (owner B, fix round 1): `✓ exited (0) · 1m 12s` in the ok
 * tone, `✗ exited (2) · 4s`, `✗ killed · 2m`, `✗ stopped · 30s` — the job's TOTAL
 * run time in every case, and a failure NEVER paints `✓`.
 *
 * `end` may also be a `{kind: "finished"}` (a child's shape, or a frozen drawer
 * from an older path): that is a clean end with no code to quote, so it says
 * `✓ exited · <time>` rather than inventing a `(0)`.
 */
export function jobEndView(opts: {
  readonly end: JobEnd | { readonly kind: "finished" };
  readonly seconds: number;
}): JobEndView {
  const time = formatDuration(opts.seconds);
  switch (opts.end.kind) {
    case "stopped":
      return { text: `✗ stopped · ${time}`, ok: false };
    case "killed":
      return { text: `✗ killed · ${time}`, ok: false };
    case "finished":
      return { text: `✓ exited · ${time}`, ok: true };
    case "exited":
      return opts.end.exitCode === 0
        ? { text: `✓ exited (0) · ${time}`, ok: true }
        : { text: `✗ exited (${opts.end.exitCode ?? "?"}) · ${time}`, ok: false };
  }
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

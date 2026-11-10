/**
 * The laptop's view of a session's background SHELL jobs
 * (docs/feat/shell-jobs-panel.md, Design 4): bounded and sanitized HERE, never
 * in a component, and never in the daemon — a pod's daemon is not trusted
 * (AGENTS §7), so its stripping would be UX only. This module is THE gate for a
 * job's output, the row's command and every label either carries.
 *
 * Pure: no React, no I/O.
 */
import type { JobOutputResult, JobRow } from "@tentacle/protocol";
import { progressText } from "./mapping.ts";

/** How many job rows a client keeps: the dock shows far fewer. */
export const MAX_JOB_ROWS = 32;
/** How long a row's command may be — this module's own cap, not a panel's. */
export const JOB_COMMAND_MAX = 200;
/** How many lines one stream may carry (a hostile daemon may send more). */
export const MAX_JOB_LINES = 200;
/** How long one output line may be: `progressText`'s 200 is a label, not a line. */
export const JOB_LINE_MAX = 512;

/**
 * Every character a terminal must never receive, mapped to ONE space: C0 (so
 * `ESC`'s `\u001b[2J` prints as text), DEL, and the C1 range (so `\u009b31m`
 * cannot become a CSI). One space, not nothing, so a tab keeps its column count
 * and the drawer's cell measurement matches what the terminal would do.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The invisible formatting characters: bidi overrides EMBEDDED (`\u202e` can
 * reorder a line without being a control char) and the zero-width spaces. They
 * are STRIPPED — nothing to show, and one space each would be a lie about the
 * line's width.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One line of a pod's output, safe to render: control chars ⇒ a space, the
 * invisible format classes gone, capped at `JOB_LINE_MAX`. The SAME treatment
 * applies to a command and to the labels, so nothing untrusted reaches the
 * terminal by a side door.
 */
export function sanitizeJobText(value: string, cap: number = JOB_LINE_MAX): string {
  const clean = value.replace(CONTROL, " ").replace(INVISIBLE, "");
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** One row, safe to render: every string one line and bounded, the numbers as sent. */
function boundRow(row: JobRow): JobRow {
  return {
    id: progressText(row.id).trim(),
    command: sanitizeJobText(row.command, JOB_COMMAND_MAX).trim(),
    startedAt: row.startedAt,
    status: progressText(row.status).trim(),
  };
}

/** The list as this client keeps it: at most `MAX_JOB_ROWS`, launch order. */
export function boundJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.slice(0, MAX_JOB_ROWS).map(boundRow);
}

/** A snapshot's list, bounded the same way. Absent (an older daemon) stays absent. */
export function jobsFromSnapshot(rows: readonly JobRow[] | undefined): JobRow[] | undefined {
  return rows === undefined ? undefined : boundJobs(rows);
}

/**
 * A `session/job_output` result from a daemon that may be a pod (AGENTS §7):
 * the only place a job's bytes become safe to paint.
 *
 * ORDER MATTERS: the array is capped BEFORE mapping, so a 300 000-entry array
 * cannot make this function do 300 000 units of work. Then each kept line is
 * sanitized (control + invisible, `JOB_LINE_MAX`), and the command with it —
 * `found: false` keeps its `reason` sanitized too (it is shown as a notice).
 */
export function boundJobOutput(result: JobOutputResult): JobOutputResult {
  return {
    ...result,
    jobId: progressText(result.jobId).trim(),
    ...(result.status === undefined ? {} : { status: progressText(result.status).trim() }),
    ...(result.command === undefined
      ? {}
      : { command: sanitizeJobText(result.command, JOB_COMMAND_MAX).trim() }),
    ...(result.reason === undefined ? {} : { reason: sanitizeJobText(result.reason) }),
    ...(result.output === undefined
      ? {}
      : { output: result.output.slice(0, MAX_JOB_LINES).map((line) => sanitizeJobText(line)) }),
  };
}

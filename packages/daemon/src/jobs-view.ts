/**
 * The wire view of a session's running background SHELL jobs
 * (docs/feat/shell-jobs-panel.md, Design 3): a pure projection of
 * `JobController.list()` into `JobRow`s, one line and a bounded length each.
 *
 * A pod's daemon is not trusted (AGENTS §7), so the command text — a pod's own
 * bytes — is made ONE line and cut here, before it ever reaches the wire, and
 * the schema bounds nothing (the client cuts the labels again, and is the real
 * gate for the output).
 *
 * The rows are NEVER capped here: the frame is the authoritative full state, so
 * the count a relay derives from it (`jobCount`) is true. The client keeps only
 * the first `MAX_JOB_ROWS` of them, which is exactly why it must not compute the
 * count itself.
 */
import type { BackgroundJob } from "@tentacle/core";
import type { JobRow } from "@tentacle/protocol";
import { wireLine } from "./mapping.ts";

/** One command label's cap: a panel row, never a log line. */
export const JOB_COMMAND_MAX = 200;

/** The rows as the wire carries them: running jobs only, one line, bounded. */
export function jobRows(jobs: readonly BackgroundJob[]): JobRow[] {
  return jobs
    .filter((job) => job.status === "running")
    .map((job) => ({
      id: wireLine(job.id, 64),
      command: wireLine(job.command, JOB_COMMAND_MAX),
      startedAt: job.startedAt,
      status: wireLine(job.status, 32),
    }));
}

/**
 * How many jobs are running — the frame's `n`, taken BEFORE any cap. It exists
 * beside `jobRows` so the count and the list cannot drift apart if one of them
 * ever gains a cap.
 */
export function jobCount(jobs: readonly BackgroundJob[]): number {
  return jobs.filter((job) => job.status === "running").length;
}

/** The same list, member by member: what makes a frame unnecessary. */
export function sameJobs(a: readonly JobRow[], b: readonly JobRow[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.command === other.command &&
      row.startedAt === other.startedAt &&
      row.status === other.status
    );
  });
}

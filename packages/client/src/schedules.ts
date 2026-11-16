/**
 * The laptop's view of a session's scheduled wakes (docs/feat/cron-tool.md D5,
 * slice S2): bounded and sanitized HERE, never in a component — and never
 * trusted from upstream. A `serve` daemon writes these rows itself, but the
 * `spec` and `prompt` they carry came from a MODEL, so they are untrusted text
 * on their way to a terminal (AGENTS §7, the same rule `jobs.ts` applies).
 *
 * Pure: no React, no I/O.
 */
import type { ScheduleRow } from "@tentacle/protocol";
import { progressText } from "./mapping.ts";

/** How many schedule rows a client keeps: the dock and the panel show far fewer (the daemon caps 10). */
export const MAX_SCHEDULE_ROWS = 32;
/** How long a row's `spec`/`prompt` label may be on screen — this module's own cap, not a panel's. */
export const SCHEDULE_LABEL_CLIENT_MAX = 200;
/** Shown when the daemon cannot delete a schedule: it predates the method. */
export const SCHEDULE_OLD_DAEMON = "this daemon cannot delete a scheduled wake (older version)";
/** A client that must not act on a schedule at all (a pod, `run`/`attach`): its daemon is not trusted. */
export const SCHEDULE_UNTRUSTED_DAEMON = "this client does not trust its daemon to schedule wakes";

/**
 * Every character a terminal must never receive, mapped to ONE space: C0 (so
 * `ESC`'s `\u001b[2J` prints as text), DEL and the C1 range (so `\u009b31m`
 * cannot become a CSI). One space, not nothing, so a tab keeps its column count.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** The invisible reordering/zero-width classes: STRIPPED (a space would lie about the width). */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One label, safe to paint: one line, no escapes, bounded. */
export function sanitizeScheduleText(
  value: string,
  cap: number = SCHEDULE_LABEL_CLIENT_MAX,
): string {
  const clean = value.replace(CONTROL, " ").replace(INVISIBLE, "").trim();
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** One row, safe to render: every string a bounded label, the numbers as sent. */
function boundRow(row: ScheduleRow): ScheduleRow {
  return {
    id: progressText(row.id).trim(),
    kind: progressText(row.kind).trim(),
    spec: sanitizeScheduleText(row.spec),
    prompt: sanitizeScheduleText(row.prompt),
    nextAt: row.nextAt,
    fires: row.fires,
    createdAt: row.createdAt,
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  };
}

/** The list as this client keeps it: at most `MAX_SCHEDULE_ROWS`, the daemon's order. */
export function boundSchedules(rows: readonly ScheduleRow[]): ScheduleRow[] {
  return rows.slice(0, MAX_SCHEDULE_ROWS).map(boundRow);
}

/** A snapshot's list, bounded the same way. Absent (an older daemon) stays absent. */
export function schedulesFromSnapshot(
  rows: readonly ScheduleRow[] | undefined,
): ScheduleRow[] | undefined {
  return rows === undefined ? undefined : boundSchedules(rows);
}

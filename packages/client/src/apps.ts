/**
 * The laptop's view of a session's published apps
 * (docs/feat/session-apps-publish.md D7/D12): bounded and sanitized HERE, never
 * in a component. A `serve` writes these rows itself, but a title came from a
 * model and a reason from the host's operator, so they are untrusted text on
 * their way to a screen (AGENTS §7).
 *
 * Pure: no React, no I/O.
 */
import type { AppRow } from "@tentacle/protocol";
import { sanitizeScheduleText as sanitize } from "./schedules.ts";

/** How many rows a client keeps (the host allows 5 live per computer). */
export const MAX_APP_ROWS = 32;
const LABEL_MAX = 200;
const REASON_MAX = 500;
const ID_MAX = 64;

/** Shown when the daemon cannot stop an app: it predates the method. */
export const APPS_OLD_DAEMON = "this daemon cannot stop an app (older version)";
/** A client that must not act on an app at all (a pod, `run`/`attach`). */
export const APPS_UNTRUSTED_DAEMON = "this client does not trust its daemon to publish apps";

export type AppViewState = "up" | "renewing" | "down" | "removed" | "unknown";

/** The wire's free string, narrowed: a newer daemon's word is `unknown`, never `up`. */
export function appStateOf(state: string): AppViewState {
  return state === "up" || state === "renewing" || state === "down" || state === "removed"
    ? state
    : "unknown";
}

function boundRow(row: AppRow): AppRow {
  return {
    app: sanitize(row.app, ID_MAX),
    url: sanitize(row.url, LABEL_MAX),
    artifactId: sanitize(row.artifactId, ID_MAX),
    version: row.version,
    title: sanitize(row.title, LABEL_MAX),
    state: sanitize(row.state, ID_MAX),
    ...(row.reason === undefined ? {} : { reason: sanitize(row.reason, REASON_MAX) }),
    since: row.since,
    publishedAt: row.publishedAt,
  };
}

/** The list as this client keeps it: at most `MAX_APP_ROWS`, the daemon's order. */
export function boundApps(rows: readonly AppRow[]): AppRow[] {
  return rows.slice(0, MAX_APP_ROWS).map(boundRow);
}

/**
 * The laptop's view of a session's container previews
 * (docs/feat/session-apps-container-ports.md S4): bounded and sanitized HERE,
 * never in a component. A name and an image come from a container engine: they
 * are untrusted text on their way to a screen (AGENTS §7). Pure.
 */
import type { PreviewRow } from "@tentacle/protocol";
import { sanitizeScheduleText as sanitize } from "./schedules.ts";

/** How many rows a client keeps (a session has at most 8). */
export const MAX_PREVIEW_ROWS = 32;
const LABEL_MAX = 200;
const URL_MAX = 2048;

export const PREVIEWS_OLD_DAEMON = "this daemon cannot do that (older version)";
export const PREVIEWS_UNTRUSTED_DAEMON =
  "this client does not trust its daemon to share containers";
export const PREVIEWS_BAD_LINK = "the daemon answered with something that is not a web link";

/**
 * A link as it may be copied: one `https://` URL with no space or control
 * character. `undefined`: it is not one.
 */
export function copyableLink(url: string): string | undefined {
  return url.length <= URL_MAX && /^https:\/\/[^\s\p{Cc}\p{Cf}]+$/u.test(url) ? url : undefined;
}

function boundRow(row: PreviewRow): PreviewRow {
  const { link } = row;
  return {
    id: row.id,
    containerId: sanitize(row.containerId, LABEL_MAX),
    engine: sanitize(row.engine, LABEL_MAX),
    name: sanitize(row.name, LABEL_MAX),
    image: sanitize(row.image, LABEL_MAX),
    containerPort: row.containerPort,
    createdAt: row.createdAt,
    ...(link === undefined
      ? {}
      : { link: { url: sanitize(link.url, URL_MAX), state: link.state, public: link.public } }),
  };
}

/** The list as this client keeps it: at most `MAX_PREVIEW_ROWS`, the daemon's order. */
export function boundPreviews(rows: readonly PreviewRow[]): PreviewRow[] {
  return rows.slice(0, MAX_PREVIEW_ROWS).map(boundRow);
}

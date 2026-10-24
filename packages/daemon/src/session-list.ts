/**
 * The `session/list` result from the registry's summaries
 * (docs/feat/session-list.md). Pure: no I/O, no clock. Always valid for
 * `SessionListResultSchema` (the client rejects the whole page otherwise):
 * every string one line cut to its cap, never empty.
 *
 * Order: `updatedAt` desc, then `sessionId` asc. Paging is keyset: the cursor
 * is `"<updatedAt>:<sessionId>"` of a page's last entry, and the next page is
 * every entry strictly after that key. A session's `updatedAt` is a stored
 * stamp (never the clock at the request) that only grows while the daemon's
 * clock does, so no entry is skipped or returned twice across pages.
 */
import {
  JsonRpcErrorCode,
  MAX_SESSION_LIST,
  MAX_SESSION_TITLE,
  type SessionListEntry,
  type SessionListParams,
  type SessionListResult,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { wireLine } from "./mapping.ts";

/** What the registry knows of one session (`HostedSession.summary`, or an archived entry). */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: number;
  /** The last conversation change: a turn's start or end, a successful compaction, creation. */
  readonly lastChangeAt: number;
  readonly running: boolean;
  readonly attached: number;
  readonly title: string;
  /** The session's own directory (an archived one: its record's). */
  readonly cwd: string;
  /** Ended and kept, not loaded (`running: false`, `attached: 0`). */
  readonly archived: boolean;
}

/** A position in the order: the sort key of one entry. */
export interface ListCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

export function encodeListCursor(key: ListCursor): string {
  return `${key.updatedAt}:${key.sessionId}`;
}

/** Split at the FIRST `:` (an id may hold one, `updatedAt` never does). */
export function parseListCursor(cursor: string): ListCursor {
  const at = cursor.indexOf(":");
  const prefix = at > 0 ? cursor.slice(0, at) : "";
  const sessionId = cursor.slice(at + 1);
  const updatedAt = Number(prefix);
  if (!/^\d+$/.test(prefix) || !Number.isSafeInteger(updatedAt) || sessionId === "") {
    throw new RpcError(JsonRpcErrorCode.InvalidParams, "invalid session list cursor");
  }
  return { updatedAt, sessionId };
}

/** Negative iff `a` comes first: `updatedAt` desc, then `sessionId` asc. */
function compare(a: ListCursor, b: ListCursor): number {
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

export function toSessionList(
  summaries: Iterable<SessionSummary>,
  params: SessionListParams,
): SessionListResult {
  const after = params.cursor !== undefined ? parseListCursor(params.cursor) : undefined;
  const limit = params.limit ?? MAX_SESSION_LIST;
  const entries: SessionListEntry[] = [];
  for (const s of summaries) {
    const entry: SessionListEntry = {
      sessionId: s.id,
      title: wireLine(s.title, MAX_SESSION_TITLE) || "(empty)",
      cwd: wireLine(s.cwd, 4096) || "(unknown)",
      createdAt: s.createdAt,
      // Never the clock, even while running: a key that moved between two
      // requests would make the cursor skip entries (Review finding 1).
      // Archived: the record's `updatedAt`, the same stamp — one order.
      updatedAt: s.lastChangeAt,
      running: s.running,
      attached: s.attached,
      archived: s.archived,
    };
    if (after === undefined || compare(entry, after) > 0) {
      entries.push(entry);
    }
  }
  entries.sort(compare);
  const page = entries.slice(0, limit);
  const last = page[page.length - 1];
  return entries.length > limit && last
    ? { sessions: page, cursor: encodeListCursor(last) }
    : { sessions: page };
}

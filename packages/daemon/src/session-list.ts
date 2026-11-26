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
  MAX_PINNED_SESSIONS,
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
  /** Background jobs running now; absent for an archived entry. */
  readonly jobs?: number;
  /**
   * Armed scheduled wakes (docs/feat/cron-tool.md D5): a live session on a host
   * that schedules. Absent for an archived entry (its wakes are frozen and do
   * not fire) and where the host never schedules (a pod daemon).
   */
  readonly schedules?: number;
  /**
   * Unanswered permission asks right now (docs/fix/mobile-ask-surfaces.md D5):
   * the drawer's `hand.raised`. A live session: 0 is a fact. Absent for an
   * archived entry (it holds no ask: nothing is loaded to ask).
   */
  readonly asks?: number;
  /**
   * Workflow runs live or waiting on the user (D5): the drawer's curvepath.
   * Absent where the session runs no workflows at all (a tunnelled session, a
   * pod daemon) — which is not the same claim as 0.
   */
  readonly workflows?: number;
  /** When it was pinned (`session/pin`); absent = not pinned. */
  readonly pinnedAt?: number;
}

/** A position in the order: the sort key of one entry. */
export interface ListCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

export function encodeListCursor(key: ListCursor): string {
  return `${key.updatedAt}:${key.sessionId}`;
}

/**
 * How many of a session's workflow runs are live or waiting on the user — what
 * the drawer's curvepath means (docs/fix/mobile-ask-surfaces.md D5). A run is
 * over iff its state says so; an unknown state counts as live, because a run
 * this build cannot judge must not look finished.
 */
export function liveRunCount(rows: readonly { state: string }[]): number {
  return rows.filter((row) => !FINISHED_RUN_STATES.has(row.state)).length;
}

/** The run states that are OVER (`WorkflowRowSchema.state`'s documented set). */
const FINISHED_RUN_STATES: ReadonlySet<string> = new Set(["ok", "error", "stopped"]);

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
  // Every pinned session, whatever the cursor: the first page carries them all
  // (docs/feat/mobile-session-actions.md), so a pin older than the loaded
  // pages still shows. They ALSO stay in `entries`: paging is unchanged.
  const pinned: SessionListEntry[] = [];
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
      ...(s.jobs !== undefined ? { jobs: s.jobs } : {}),
      ...(s.schedules !== undefined ? { schedules: s.schedules } : {}),
      ...(s.asks !== undefined ? { asks: s.asks } : {}),
      ...(s.workflows !== undefined ? { workflows: s.workflows } : {}),
      ...(s.pinnedAt !== undefined ? { pinned: true as const } : {}),
    };
    if (after === undefined || compare(entry, after) > 0) {
      entries.push(entry);
    }
    if (entry.pinned) {
      pinned.push(entry);
    }
  }
  entries.sort(compare);
  const page = entries.slice(0, limit);
  const last = page[page.length - 1];
  // The host caps pins at MAX_PINNED_SESSIONS; the slice keeps the page valid
  // for the schema even if a store were to hold more.
  const pins =
    after === undefined && pinned.length > 0
      ? { pinned: pinned.sort(compare).slice(0, MAX_PINNED_SESSIONS) }
      : {};
  return entries.length > limit && last
    ? { sessions: page, cursor: encodeListCursor(last), ...pins }
    : { sessions: page, ...pins };
}

/**
 * The session list's whole decision surface (docs/feat/mobile-app-shell.md):
 * a reducer over `session/list` pages, the row view-model, and error wording.
 * Pure and React-free (AGENTS §7) — the screen only maps this to elements, so
 * every branch below is unit-tested without a simulator.
 *
 * Two rules earn their keep here:
 * - a **generation counter** drops a late page of a superseded request (the
 *   user refreshed, or navigated away mid-page), so a stale answer can never
 *   overwrite a fresh list;
 * - pages merge **deduped by `sessionId`, keeping the newer** (`updatedAt`): a
 *   session updated between two pages moves above the cursor and shows up in
 *   the next listing, so it would otherwise appear twice.
 */
import { ChannelError } from "@tentacle/client";
import { DomainErrorCode, JsonRpcErrorCode, type SessionListEntry } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** One page as the network layer hands it back (the reducer never awaits). */
export interface SessionPage {
  readonly sessions: readonly SessionListEntry[];
  /** Present iff more entries follow. */
  readonly cursor?: string;
}

/** What the in-flight request will deliver: the first page, or one more page. */
export type PendingPage = "first" | "next";

export interface SessionListState {
  readonly status: "idle" | "loading" | "loaded" | "failed";
  readonly entries: readonly SessionListEntry[];
  /** The page after the loaded ones; absent → the end is reached. */
  readonly cursor?: string;
  /** The link is down: the list stays visible but is marked stale. */
  readonly stale: boolean;
  readonly error?: string;
  /** Bumped by every `refresh`/`more`; a result of another generation is dropped. */
  readonly generation: number;
  /** Null when nothing is in flight. */
  readonly pending: PendingPage | null;
}

export type SessionListAction =
  | { readonly type: "refresh" }
  | { readonly type: "more" }
  | {
      readonly type: "page";
      readonly page: SessionPage;
      readonly generation: number;
    }
  | { readonly type: "fail"; readonly error: string; readonly generation: number }
  | { readonly type: "link"; readonly up: boolean };

export const initialSessionList: SessionListState = {
  status: "idle",
  entries: [],
  stale: false,
  generation: 0,
  pending: null,
};

/** The newer of two records of the same session. */
function newer(a: SessionListEntry, b: SessionListEntry): SessionListEntry {
  return a.updatedAt > b.updatedAt ? a : b;
}

/**
 * Merge a page into what is already loaded, deduped by `sessionId`. A first
 * page REPLACES — a refresh restarts from the top, so an entry that moved above
 * the cursor is not duplicated — and a later page APPENDS. Either way the order
 * is the daemon's.
 */
function merge(
  existing: readonly SessionListEntry[],
  incoming: readonly SessionListEntry[],
  mode: PendingPage,
): readonly SessionListEntry[] {
  const byId = new Map<string, SessionListEntry>();
  const order: string[] = [];
  for (const entry of mode === "first" ? incoming : [...existing, ...incoming]) {
    const seen = byId.get(entry.sessionId);
    if (seen === undefined) {
      order.push(entry.sessionId);
    }
    byId.set(entry.sessionId, seen === undefined ? entry : newer(seen, entry));
  }
  const merged: SessionListEntry[] = [];
  for (const id of order) {
    const entry = byId.get(id);
    if (entry !== undefined) {
      merged.push(entry);
    }
  }
  return merged;
}

export function reduce(state: SessionListState, action: SessionListAction): SessionListState {
  switch (action.type) {
    case "refresh":
      // The rows already read stay visible while page one is re-read.
      return {
        ...state,
        status: state.entries.length > 0 ? "loaded" : "loading",
        error: undefined,
        generation: state.generation + 1,
        pending: "first",
      };
    case "more":
      if (state.cursor === undefined || state.pending !== null) {
        return state;
      }
      return {
        ...state,
        status: state.entries.length > 0 ? "loaded" : "loading",
        error: undefined,
        generation: state.generation + 1,
        pending: "next",
      };
    case "page": {
      // A superseded request (a newer refresh/more, or a screen gone) is dropped,
      // and so is one whose mode no longer matches what is in flight.
      if (state.pending === null || action.generation !== state.generation) {
        return state;
      }
      const { cursor, ...rest } = state;
      const next: SessionListState = {
        ...rest,
        status: "loaded",
        entries: merge(state.entries, action.page.sessions, state.pending),
        error: undefined,
        // A page arrived, so the link is up and the rows are the daemon's
        // current truth: the "Reconnecting…" mark a failed refresh set is over.
        // (Review round 1 finding 1: without this the notice never went away on
        // a link that never dropped — no `link(up)` ever follows.)
        stale: false,
        pending: null,
      };
      // Absent cursor = the end of the list: clear the old one so "load more"
      // does not re-ask for a page that no longer exists.
      return action.page.cursor === undefined ? next : { ...next, cursor: action.page.cursor };
    }
    case "fail":
      if (action.generation !== state.generation) {
        return state;
      }
      // A failed refresh keeps what was already read: those rows are still the
      // last truth the daemon gave us, so they stay (marked stale, with the
      // message), and only an empty list becomes a full-screen failure.
      return {
        ...state,
        status: state.entries.length > 0 ? "loaded" : "failed",
        stale: true,
        error: action.error,
        pending: null,
      };
    case "link":
      // Down: the rows stay, marked stale. Up: the caller asks for a refresh;
      // this only clears the mark.
      return { ...state, stale: !action.up };
    default:
      return state;
  }
}

/** One row the screen renders. Strings pass through untouched (plain `Text`). */
export interface SessionRow {
  readonly sessionId: string;
  readonly title: string;
  /** Relative time from `updatedAt`, e.g. "3m ago". */
  readonly subtitle: string;
  readonly badges: readonly string[];
  readonly archived: boolean;
}

export interface SessionSections {
  readonly active: readonly SessionRow[];
  readonly archived: readonly SessionRow[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A relative stamp from the daemon's clock. `updatedAt` in the future (a
 * skewed clock, or one that stepped back) is clamped to "now" — never
 * "in 3 minutes", which would read as a bug.
 */
export function relativeTime(updatedAt: number, now: number): string {
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  return `${Math.floor(elapsed / DAY)}d ago`;
}

/** The badges a row shows, most urgent first; empty when nothing is happening. */
function badgesFor(entry: SessionListEntry): readonly string[] {
  const badges: string[] = [];
  if (entry.running) {
    badges.push("running");
  }
  if (entry.attached > 0) {
    badges.push(entry.attached === 1 ? "attached" : `attached ${entry.attached}`);
  }
  if (entry.jobs !== undefined && entry.jobs > 0) {
    badges.push(entry.jobs === 1 ? "1 job" : `${entry.jobs} jobs`);
  }
  return badges;
}

/**
 * The view-model the list screen renders: rows split into the Active and
 * Archived sections the mockups show, in the daemon's order (most recent
 * first). Nothing here interprets a daemon string.
 */
export function rows(entries: readonly SessionListEntry[], now: number): SessionSections {
  const active: SessionRow[] = [];
  const archived: SessionRow[] = [];
  for (const entry of entries) {
    const row: SessionRow = {
      sessionId: entry.sessionId,
      title: entry.title,
      subtitle: relativeTime(entry.updatedAt, now),
      badges: badgesFor(entry),
      archived: entry.archived,
    };
    (entry.archived ? archived : active).push(row);
  }
  return { active, archived };
}

/**
 * The one project row a computer shows in 11a (one `serve` = one project;
 * sibling discovery is task 10): the basename of the most recent session's
 * `cwd`, else the computer's own name when it has no sessions.
 */
export function projectLabel(entries: readonly SessionListEntry[], fallback: string): string {
  let latest: SessionListEntry | undefined;
  for (const entry of entries) {
    if (latest === undefined || entry.updatedAt > latest.updatedAt) {
      latest = entry;
    }
  }
  if (latest === undefined) {
    return fallback;
  }
  const trimmed = latest.cwd.replace(/\/+$/, "");
  // The filesystem root (or an all-slash path): the basename of "/" is "/".
  if (trimmed === "") {
    return "/";
  }
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base === "" ? fallback : base;
}

export interface ErrorDescription {
  readonly message: string;
  /** False for a condition a retry cannot fix (an old daemon). */
  readonly retry: boolean;
}

/** "Can't connect" — the one wording for every dial/upgrade failure (see below). */
const UNREACHABLE = "Can't connect — the computer is unreachable or refused this app";

/**
 * What to show for a failed `session/list`.
 *
 * iOS reports BOTH a bad token and an Origin rejection as close 1006 (spike
 * Review finding 3), so a `ChannelError` is never classified by kind or by its
 * close code: every kind gets the same honest wording, and the 401/origin split
 * waits for task 9. The message is never inspected for "401" either — a close
 * reason we do not trust must not become a claim we make.
 */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof RpcError) {
    if (error.code === JsonRpcErrorCode.MethodNotFound) {
      return {
        message: "This computer's tentacle is too old — update it",
        retry: false,
      };
    }
    if (error.code === DomainErrorCode.Unauthorized) {
      return { message: "This app is not authorized on that computer", retry: false };
    }
    return {
      message: error.message === "" ? "The computer refused the request" : error.message,
      retry: true,
    };
  }
  if (error instanceof ChannelError) {
    return { message: UNREACHABLE, retry: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not connected to the daemon")) {
    return { message: "Reconnecting…", retry: true };
  }
  return { message: message === "" ? "Something went wrong" : message, retry: true };
}

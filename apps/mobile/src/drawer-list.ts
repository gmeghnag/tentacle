/**
 * The sessions drawer's list and title (docs/feat/mobile-chrome.md Design 3,
 * mockup C1). Pure and React-free (AGENTS §7): the drawer component only maps
 * this to elements.
 *
 * No new data: the list is the Sessions screen's own `viewModel` output
 * (`session-list-controller.ts`) for the computer the drawer shows, and the
 * title is the Computers screen's `ComputerRow` + `computerStatus` wording.
 *
 * - **Running** / **Recent** / **Archived · n** — the daemon's order is kept
 *   (`session/list` is newest first); Archived is collapsed unless the person
 *   opened it, or the open session is itself archived (so its highlight is
 *   never hidden, F5) and the person did not explicitly collapse it.
 * - The current row is matched by id, never by position (F3).
 * - A failed or stale read is never "no sessions" (F2): `empty` is true only
 *   for a fresh, successful, empty read.
 */
import type { ComputerRecordLike, ComputerRow } from "./computer-rows.ts";
import { type ComputerTone, computerStatus } from "./computer-status.ts";
import { sessionLine } from "./session-groups.ts";
import type { SessionListState, SessionRow, SessionSections } from "./session-list.ts";

/** What the drawer reads: `viewModel(state, now)` of the selected computer's controller. */
export interface DrawerSource {
  readonly status: SessionListState["status"];
  readonly stale: boolean;
  readonly error?: string;
  readonly empty: boolean;
  readonly sections: SessionSections;
  readonly canLoadMore: boolean;
}

/** One drawer row. Title/meta are daemon strings, drawn as plain `Text`. */
export interface DrawerRow {
  readonly id: string;
  readonly title: string;
  /** The visible meta line (`sessionLine`: "Running · 2 attached · 3m ago" / "3m ago"). */
  readonly meta: string;
  readonly tone: "running" | "idle" | "archived";
  /** Navigates with `archived: true` (Owner Q4: browsing never revives). */
  readonly archived: boolean;
  /** The open session: highlighted with `fill`. */
  readonly current: boolean;
}

export type DrawerSection = "running" | "recent" | "archived";

export interface DrawerList {
  readonly running: readonly DrawerRow[];
  readonly recent: readonly DrawerRow[];
  /** `rows` is null while the section is collapsed (the "Archived · n" row only). */
  readonly archived: { readonly count: number; readonly rows: readonly DrawerRow[] | null };
  /** Where the open session is in the LOADED pages; null if it is not there (F5). */
  readonly currentIn: DrawerSection | null;
  readonly status: SessionListState["status"];
  readonly stale: boolean;
  readonly error?: string;
  /** A fresh, successful read with no sessions — the only case for "No sessions". */
  readonly empty: boolean;
  readonly canLoadMore: boolean;
}

export interface DrawerListOptions {
  /** The open session's id, when the drawer lists that session's computer. */
  readonly currentId: string | null;
  /** The person's archived toggle: null = automatic (open iff the current is archived). */
  readonly archivedOpen: boolean | null;
}

function toRow(row: SessionRow, currentId: string | null): DrawerRow {
  return {
    id: row.sessionId,
    title: row.title,
    meta: sessionLine(row),
    tone: row.archived ? "archived" : row.running ? "running" : "idle",
    archived: row.archived,
    current: currentId !== null && row.sessionId === currentId,
  };
}

export function drawerList(source: DrawerSource, options: DrawerListOptions): DrawerList {
  const { currentId } = options;
  const running = source.sections.active
    .filter((row) => row.running)
    .map((row) => toRow(row, currentId));
  const recent = source.sections.active
    .filter((row) => !row.running)
    .map((row) => toRow(row, currentId));
  const archivedRows = source.sections.archived.map((row) => toRow(row, currentId));
  const currentIn: DrawerSection | null = running.some((row) => row.current)
    ? "running"
    : recent.some((row) => row.current)
      ? "recent"
      : archivedRows.some((row) => row.current)
        ? "archived"
        : null;
  const archivedShown = options.archivedOpen ?? currentIn === "archived";
  return {
    running,
    recent,
    archived: {
      count: archivedRows.length,
      rows: archivedShown && archivedRows.length > 0 ? archivedRows : null,
    },
    currentIn,
    status: source.status,
    stale: source.stale,
    ...(source.error === undefined ? {} : { error: source.error }),
    empty: source.empty && !source.stale && source.error === undefined,
    canLoadMore: source.canLoadMore,
  };
}

/** The drawer's title block: the computer it lists, its status line, the switcher. */
export interface DrawerTitle {
  readonly name: string;
  readonly tone: ComputerTone;
  /** The short word next to the dot (`computerStatus`), or "Connecting…" before the first probe. */
  readonly status: string;
  /** The daemon's project label; empty before the first probe. */
  readonly project: string;
  /** More than one paired computer: the title opens the computer menu. */
  readonly switchable: boolean;
  /** New session is offered only on an online computer (F2/F8). */
  readonly canCreate: boolean;
}

/**
 * `records` = every paired computer (named, synchronous); `rows` = the
 * Computers screen's probed rows (`computerRows`), possibly not there yet.
 * A selected id no longer paired → null (the drawer shows no title, never an
 * invented one).
 */
export function drawerTitle(
  records: readonly ComputerRecordLike[],
  rows: readonly ComputerRow[],
  selectedId: string,
): DrawerTitle | null {
  const record = records.find((r) => r.id === selectedId);
  if (record === undefined) {
    return null;
  }
  const switchable = records.length > 1;
  const row = rows.find((r) => r.id === selectedId);
  if (row === undefined) {
    return {
      name: record.name,
      tone: "offline",
      status: "Connecting…",
      project: "",
      switchable,
      canCreate: false,
    };
  }
  const status = computerStatus(row);
  return {
    name: record.name,
    tone: status.tone,
    status: status.text,
    project: row.project,
    switchable,
    canCreate: status.tone === "online",
  };
}

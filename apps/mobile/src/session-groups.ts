/**
 * The Sessions screen's sections (mockup `Sessions`, plan Design 3): the active
 * rows split into **Running** and **Idle**, **Archived** kept, filtered by the
 * search field (owner decision 2: the search only filters the list on the
 * phone); plus each row's inline meta line (`Running · 2 attached · 5m ago`)
 * in place of filled badges.
 *
 * Pure and React-free (AGENTS §7): a regroup of `session-list.ts`'s rows, no new
 * data. Titles are daemon strings: matched as plain text, never interpreted.
 */
import { wakesMeta } from "./schedule-view.ts";
import type { SessionRow, SessionSections } from "./session-list.ts";

export interface SessionGroups {
  readonly running: readonly SessionRow[];
  readonly idle: readonly SessionRow[];
  readonly archived: readonly SessionRow[];
  /** A search is typed and nothing matches it (the screen says so). */
  readonly noMatch: boolean;
}

function matcher(query: string): (row: SessionRow) => boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" ? () => true : (row) => row.title.toLowerCase().includes(needle);
}

export function groupSessions(sections: SessionSections, query: string): SessionGroups {
  const keep = matcher(query);
  const active = sections.active.filter(keep);
  const running = active.filter((row) => row.running);
  const idle = active.filter((row) => !row.running);
  const archived = sections.archived.filter(keep);
  const total = sections.active.length + sections.archived.length;
  return {
    running,
    idle,
    archived,
    noMatch: query.trim() !== "" && total > 0 && active.length + archived.length === 0,
  };
}

/** The line under a row's title: state, who is attached, armed wakes, and how long ago. */
export function sessionMeta(row: SessionRow): string {
  const state = row.archived ? "Archived" : row.running ? "Running" : "Idle";
  const parts = [state];
  if (!row.archived && row.attached > 0) {
    parts.push(`${row.attached} attached`);
  }
  // Armed wakes (docs/feat/cron-tool.md S6, M8's `◷ 2`): an archived session's
  // are frozen and never fire, so they earn no word there.
  const wakes = row.archived ? "" : wakesMeta(row.wakes);
  if (wakes !== "") {
    parts.push(wakes);
  }
  parts.push(row.subtitle);
  return parts.join(" · ");
}

/**
 * The VISIBLE line: under an "Idle" or "Archived" header the state word only
 * repeats the header (visual review N8), so it is dropped there; "Running" stays,
 * next to its accent dot. VoiceOver keeps the full `sessionMeta`.
 */
export function sessionLine(row: SessionRow): string {
  const meta = sessionMeta(row);
  return row.running && !row.archived ? meta : meta.slice(meta.indexOf(" · ") + 3);
}

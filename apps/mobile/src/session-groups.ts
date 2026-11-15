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

/** The line under a row's title: state, who is attached, and how long ago. */
export function sessionMeta(row: SessionRow): string {
  const state = row.archived ? "Archived" : row.running ? "Running" : "Idle";
  const parts = [state];
  if (!row.archived && row.attached > 0) {
    parts.push(`${row.attached} attached`);
  }
  parts.push(row.subtitle);
  return parts.join(" · ");
}

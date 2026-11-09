/**
 * The status line's background sub-agent count
 * (docs/feat/subagent-background-ui.md, Design 6). Pure: the component paints
 * the string this returns.
 *
 * `undefined` means the daemon does not report the list (an older one): that is
 * "nothing to say", never `0 sub-agents` — a claim needs a report.
 */

/**
 * What this module reads of a row: its id, for the quit confirmation. The TUI
 * does not depend on `@tentacle/protocol` (its wire types are mirrored, as the
 * queue's are), and the count needs nothing more.
 */
export interface BackgroundAgentRow {
  readonly id: string;
}

/** How many are running now; 0 when there is nothing to report. */
export function backgroundCount(rows: readonly BackgroundAgentRow[] | undefined): number {
  return rows?.length ?? 0;
}

/** The status line's suffix: `""` at zero, ` · 2 sub-agents` otherwise. */
export function backgroundSuffix(count: number): string {
  if (count <= 0) {
    return "";
  }
  return count === 1 ? " · 1 sub-agent" : ` · ${count} sub-agents`;
}

/** The running children's ids, in launch order: what the quit confirmation names. */
export function backgroundNames(rows: readonly BackgroundAgentRow[] | undefined): string[] {
  return (rows ?? []).map((row) => row.id);
}

/**
 * Whether two reports name the same children, in the same order. The daemon
 * sends a full state up to 4×/s and the TUI reads only the count and the ids,
 * so an unchanged set must not re-render the whole `App` (LOW-4). A row's other
 * fields are not read here, so they cannot make this false.
 */
export function sameIds(
  a: readonly BackgroundAgentRow[] | undefined,
  b: readonly BackgroundAgentRow[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => row.id === b[i]?.id);
}

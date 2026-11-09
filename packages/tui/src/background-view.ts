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

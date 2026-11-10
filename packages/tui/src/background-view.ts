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
  /**
   * The rendered fields (docs/feat/subagent-panel.md): absent on a bare id-only
   * report (a test's fake, a listener that only counts), so the dock treats a
   * row without them as "nothing to say yet" rather than inventing figures.
   */
  readonly agentType?: string;
  readonly description?: string;
  readonly state?: string;
  readonly toolUses?: number;
  readonly tokens?: number;
  readonly startedAt?: number;
  readonly tail?: readonly string[];
  /**
   * The child's `models` NAME when it runs a different model than the main agent
   * (`SubagentRow.model`, docs/feat/subagent-panel.md). Absent = the main one.
   */
  readonly model?: string;
  /**
   * How many of the USER's messages this child has read (`SubagentRow.userRead`):
   * compared with a `subagent_message`'s own `n`, so the drawer can say
   * `✓ read` (docs/fix/autoaccept-wake-turns.md, part B). Absent = an older daemon.
   */
  readonly userRead?: number;
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
 * Whether two reports name the same shell jobs, in the same order. Same reason as
 * `sameIds`: the daemon sends the full list on every start/exit, and the TUI reads
 * only the ids and the rows it paints — an unchanged set must not re-render.
 */
export function sameJobIds(
  a: readonly { readonly id: string }[] | undefined,
  b: readonly { readonly id: string }[] | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => row.id === b[i]?.id);
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

/**
 * Whether the same children report the same READ COUNTS. `sameIds` alone drops a
 * report whose only change is a read, so the frame never repaints and the
 * drawer keeps saying `read before its next step` (docs/fix/autoaccept-wake-turns.md
 * part B — the TUI half of the daemon's `sameRows` fix). A read happens once per
 * message, never four times a second, so this does not undo LOW-4: it adds a
 * render exactly when the drawer's own state moved.
 */
export function sameReads(
  a: readonly BackgroundAgentRow[] | undefined,
  b: readonly BackgroundAgentRow[] | undefined,
): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => row.userRead === b[i]?.userRead);
}

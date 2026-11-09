/**
 * The laptop's view of a session's background sub-agents
 * (docs/feat/subagent-background-ui.md, Design 4): bounded and sanitized HERE,
 * never in a component — a pod's daemon is not trusted (AGENTS §7), so a row
 * count and every label are cut before anything renders them.
 *
 * Pure: no React, no I/O.
 */
import type { SubagentRow } from "@tentacle/protocol";
import { progressText } from "./mapping.ts";

/** How many rows a client keeps: a panel can show this many, not a thousand. */
export const MAX_SUBAGENT_ROWS = 32;
/** How many tool labels a row keeps (the daemon sends 8; a hostile one may send more). */
export const MAX_SUBAGENT_TAIL = 8;

/** One row, safe to render: every string one line and bounded, the numbers as sent. */
function boundRow(row: SubagentRow): SubagentRow {
  // `progressText` turns a control character into a space, so a stripped
  // newline/tab leaves padding: trimmed here, never inside a label.
  const clean = (value: string): string => progressText(value).trim();
  return {
    id: clean(row.id),
    callId: clean(row.callId),
    agentType: clean(row.agentType),
    description: clean(row.description),
    state: clean(row.state),
    toolUses: row.toolUses,
    tokens: row.tokens,
    startedAt: row.startedAt,
    tail: row.tail.slice(-MAX_SUBAGENT_TAIL).map(clean),
  };
}

/** The list as this client keeps it: at most `MAX_SUBAGENT_ROWS`, launch order. */
export function boundSubagents(rows: readonly SubagentRow[]): SubagentRow[] {
  return rows.slice(0, MAX_SUBAGENT_ROWS).map(boundRow);
}

/** A snapshot's list, bounded the same way. Absent (an older daemon) stays absent. */
export function subagentsFromSnapshot(
  rows: readonly SubagentRow[] | undefined,
): SubagentRow[] | undefined {
  return rows === undefined ? undefined : boundSubagents(rows);
}

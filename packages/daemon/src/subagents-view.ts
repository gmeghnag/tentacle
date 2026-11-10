/**
 * The wire view of a session's background sub-agents
 * (docs/feat/subagent-background-ui.md, Design 3): a pure projection of
 * `AgentJobs.rows()` into `SubagentRow`s, one line and a bounded length each.
 *
 * A pod's daemon is not trusted (AGENTS §7), so every string a child's owner
 * chose (its description, a tool's label) is made ONE line and cut here — before
 * it ever reaches the wire — and the schema bounds nothing (the client cuts the
 * row count and the labels again).
 */
import type { AgentJobRow } from "@tentacle/core";
import type { SubagentRow } from "@tentacle/protocol";
import { wireLine } from "./mapping.ts";

/** One label's cap: a panel row, never a log line. */
export const SUBAGENT_TAIL_MAX_CHARS = 200;

/** The rows as the wire carries them: every string one line, bounded. */
export function subagentRows(rows: readonly AgentJobRow[]): SubagentRow[] {
  return rows.map((row) => ({
    id: wireLine(row.id, 64),
    callId: wireLine(row.callId, 128),
    agentType: wireLine(row.agentType, 64),
    description: wireLine(row.description, SUBAGENT_TAIL_MAX_CHARS),
    state: wireLine(row.state, 32),
    toolUses: row.toolUses,
    tokens: row.tokens,
    startedAt: row.startedAt,
    tail: row.tail.map((label) => wireLine(label, SUBAGENT_TAIL_MAX_CHARS)),
    // Only when the child really runs another model (the resolver left it out
    // otherwise): absent = the main agent's own model, the common case.
    ...(row.model !== undefined ? { model: wireLine(row.model, 64) } : {}),
  }));
}

/** The same list, member by member: what makes a frame unnecessary. */
export function sameRows(a: readonly SubagentRow[], b: readonly SubagentRow[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.callId === other.callId &&
      row.agentType === other.agentType &&
      row.description === other.description &&
      row.state === other.state &&
      row.toolUses === other.toolUses &&
      row.tokens === other.tokens &&
      row.startedAt === other.startedAt &&
      row.tail.length === other.tail.length &&
      row.tail.every((label, j) => label === other.tail[j]) &&
      row.model === other.model
    );
  });
}

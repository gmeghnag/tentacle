/**
 * The wire view of a session's background sub-agents
 * (docs/feat/subagent-background-ui.md, Design 3): a pure projection of
 * `AgentJobs.rows()` into `SubagentRow`s, one line and a bounded length each.
 *
 * A pod's daemon is not trusted (AGENTS §7), so every string a child's owner
 * chose (its description, a tool's label) is made ONE line and cut here — before
 * it ever reaches the wire — and the schema bounds nothing (the client cuts the
 * row count and the labels again).
 *
 * THE MODEL LABEL is decided HERE, on every publish (docs/feat/subagent-panel.md,
 * Review round 3 M2): the owner's rule is "show the child's model only when it
 * differs from the main agent's", and the main agent's model can change under a
 * running child (a `/model` → a settings sync). So the row's `model` is a
 * function of the child's resolved id (daemon-side, never on the wire) and the
 * main model's id RIGHT NOW — not a verdict frozen when the child started.
 */
import type { AgentJobRow } from "@tentacle/core";
import type { SubagentRow } from "@tentacle/protocol";
import { wireLine } from "./mapping.ts";

/** One label's cap: a panel row, never a log line. */
export const SUBAGENT_TAIL_MAX_CHARS = 200;

/**
 * The rows as the wire carries them: every string one line, bounded.
 *
 * `mainModelId` is the session's main agent's model id at this moment, when this
 * process knows it: `undefined` over the pod model tunnel, where the main model
 * is the laptop's and a pod cannot name it (AGENTS §7) — then the pick's own
 * verdict stands (the tunnel resolver names every entry, so it is already right).
 */
export function subagentRows(
  rows: readonly AgentJobRow[],
  mainModelId?: string | undefined,
): SubagentRow[] {
  return rows.map((row) => {
    const model = shownModel(row, mainModelId);
    return {
      id: wireLine(row.id, 64),
      callId: wireLine(row.callId, 128),
      agentType: wireLine(row.agentType, 64),
      description: wireLine(row.description, SUBAGENT_TAIL_MAX_CHARS),
      state: wireLine(row.state, 32),
      toolUses: row.toolUses,
      tokens: row.tokens,
      startedAt: row.startedAt,
      tail: row.tail.map((label) => wireLine(label, SUBAGENT_TAIL_MAX_CHARS)),
      ...(model !== undefined ? { model: wireLine(model, 64) } : {}),
    };
  });
}

/**
 * The `models` NAME a row shows, or `undefined` (= "same as the main agent").
 * A name only ever comes from the child's own pick: a bare model id is not a
 * name and never reaches the wire (AGENTS §7). With the main id known, the name
 * is dropped the moment the two are the same — and reappears if they diverge
 * again.
 */
function shownModel(row: AgentJobRow, mainModelId: string | undefined): string | undefined {
  if (row.model === undefined) {
    return undefined;
  }
  if (mainModelId === undefined || row.modelId === undefined) {
    // Nothing to compare against in this process: the pick's verdict is all
    // there is (and it is a NAME, never an id).
    return row.model;
  }
  return row.modelId === mainModelId ? undefined : row.model;
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

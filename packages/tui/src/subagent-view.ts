/**
 * The view-model a sub-agent block renders (docs/feat/subagent-tail-view.md).
 *
 * AGENTS §7: the branching decision (which steps are shown, and how many are
 * not) lives here, pure and React-free; `render-lines.ts` only colours and fits
 * it. The four keys are the ones the later surfaces reuse unchanged — the
 * footbar list, the openable panel and the focus view (eval A5 L4), so nothing
 * here may depend on how the transcript draws it.
 */
import type { SubAgentProgress } from "./state.ts";

/** How many recent steps a FOREGROUND sub-agent shows (owner question Q17, recommended 5). */
export const SUBAGENT_TAIL_ROWS = 5;

/** The head line: the sub-agent's type and the description the model gave it. */
export interface SubAgentHead {
  readonly agentType: string;
  readonly description: string;
  readonly toolUses: number;
  readonly tokens: number;
}

/** A finished child — and why (its stop reason; absent from an older daemon's frame). */
export interface SubAgentOutcome {
  readonly stopReason?: string;
}

export interface SubAgentView {
  /** The type + description line. */
  readonly head: SubAgentHead;
  /** How many earlier steps are NOT shown: rendered `… +<hidden> earlier`. */
  readonly hidden: number;
  /** The shown activity labels, oldest first. */
  readonly rows: readonly string[];
  /** Null while the child runs; its outcome once it finished. */
  readonly done: SubAgentOutcome | null;
}

export interface SubAgentViewOptions {
  /** Steps shown (default `SUBAGENT_TAIL_ROWS`); floored, and never negative. */
  readonly maxRows?: number;
}

/**
 * The sub-agent's view-model: its head, the LAST `maxRows` steps (a rolling
 * tail — the newest is what the person watching wants, not the first call), how
 * many earlier steps that hides, and the outcome.
 */
export function subAgentView(sub: SubAgentProgress, opts: SubAgentViewOptions = {}): SubAgentView {
  const max = Math.max(0, Math.floor(opts.maxRows ?? SUBAGENT_TAIL_ROWS));
  // The LAST `max` steps: a rolling tail, so a busy child shows what it is doing
  // NOW, not the first call it ever made (owner 2026-11-07).
  const rows = max === 0 ? [] : sub.activities.slice(-max);
  return {
    head: {
      agentType: sub.agentType,
      description: sub.description,
      toolUses: sub.toolUses,
      tokens: sub.tokens,
    },
    hidden: sub.activities.length - rows.length,
    rows,
    done: sub.done ? (sub.stopReason === undefined ? {} : { stopReason: sub.stopReason }) : null,
  };
}

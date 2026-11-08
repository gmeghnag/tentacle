/**
 * The view-model a sub-agent block renders (docs/feat/subagent-tail-view.md).
 *
 * AGENTS §7: the branching decisions (which steps are shown, how many are not,
 * what the head says when the type is long, and what a non-clean end closes
 * with) live here, pure and React-free; `render-lines.ts` only colours and
 * indents it. The four keys are the ones the later surfaces reuse unchanged —
 * the footbar list, the openable panel and the focus view (eval A5 L4), so
 * nothing here may depend on how the transcript draws it.
 */
import { cellWidth, truncateCells } from "./cells.ts";
import { formatTokens } from "./format.ts";
import type { SubAgentProgress } from "./state.ts";
import { EXPAND_HINT } from "./tool-expand.ts";

/** How many recent steps a FOREGROUND sub-agent shows (owner question Q17, recommended 5). */
export const SUBAGENT_TAIL_ROWS = 5;

/** The head line: the sub-agent's type and the description the model gave it. */
export interface SubAgentHead {
  readonly agentType: string;
  readonly description: string;
  readonly toolUses: number;
  readonly tokens: number;
}

/** A finished child — and, when it did not finish cleanly, how it ended. */
export interface SubAgentOutcome {
  /**
   * Why it stopped (`end_turn`, `cancelled`, `error`, `max_iterations`). Always
   * present on the wire: `AgentEvent.stopReason` is required and the client
   * DROPS a `subagent_end` without one (review L1). Optional only so a
   * hand-built `SubAgentProgress` (`{ done: true }` in a test) still types.
   */
  readonly stopReason?: string;
  /**
   * The one closing row a NON-clean end shows, e.g. `✗ cancelled` — absent for
   * `end_turn`, which closes on its last step. `agent_task` returns no
   * `isError` for a cancelled child (`packages/tools/src/task.ts:118-125`), so
   * without this row a cancelled child looked exactly like a clean one
   * (review M3 / owner Q2).
   */
  readonly closing?: string;
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
  // The ONE step count the block is drawn from: the child's own counter, or the
  // labels state kept when that is the larger of the two. They are equal on a
  // real stream (each `subagent_tool` increments both, `state.ts:427-430`), so
  // this only matters past the 50-label cap (`state.ts:198` SUB_ACTIVITY_CAP) —
  // where counting off the labels alone made the block contradict itself
  // (`60 tool uses` over `… +45 earlier`, review M1) — and for a hand-built
  // state where the two disagree, which must not describe itself two ways.
  const counted = Math.max(sub.toolUses, sub.activities.length);
  return {
    head: {
      agentType: sub.agentType,
      description: sub.description,
      toolUses: counted,
      tokens: sub.tokens,
    },
    hidden: Math.max(0, counted - rows.length),
    rows,
    done: sub.done
      ? {
          ...(sub.stopReason !== undefined ? { stopReason: sub.stopReason } : {}),
          ...closingRow(sub.stopReason),
        }
      : null,
  };
}

/** The closing row a stop reason earns: one for anything but a clean `end_turn`. */
function closingRow(stopReason: string | undefined): { closing?: string } {
  if (stopReason === undefined || stopReason === "end_turn") {
    return {};
  }
  return { closing: `✗ ${stopReason}` };
}

/**
 * The head as displayed: `<type> · <n> tool uses[ · <tokens>]`, with the TYPE cut
 * to whatever room the counts leave — cutting the joined row from the right ate
 * the counts first (`7 tool…`, and at 46 columns only the type survived), which
 * are the numbers the row exists to show (review L4). `width` is the body's; the
 * `◆ ` glyph the renderer puts in front takes its 2 cells.
 */
export function subAgentHeadRow(head: SubAgentHead, width: number): string {
  const uses = `${head.toolUses} tool ${head.toolUses === 1 ? "use" : "uses"}`;
  const tokens = head.tokens > 0 ? ` · ${formatTokens(head.tokens)}` : "";
  const counts = ` · ${uses}${tokens}`;
  const room = Math.max(0, width - 2);
  // A pathological width that cannot hold the counts alone: cut the whole row.
  if (room <= cellWidth(counts)) {
    return truncateCells(`${head.agentType}${counts}`, room);
  }
  return `${truncateCells(head.agentType, room - cellWidth(counts))}${counts}`;
}

/**
 * The earlier-steps row, or null when every step fits: `… +N earlier · ctrl+o to
 * expand` (review Q3 — one grammar with the transcript's other cut markers). In
 * the expanded view the hint is dropped: Ctrl+O is already on, and past the state
 * cap it could not show the labels state no longer keeps.
 */
export function subAgentEarlierRow(hidden: number, expanded: boolean): string | null {
  if (hidden <= 0) {
    return null;
  }
  return expanded ? `… +${hidden} earlier` : `… +${hidden} earlier · ${EXPAND_HINT}`;
}

/** One step row's text: cut by CELLS when collapsed, whole (and wrapped) when expanded. */
export function subAgentRow(label: string, width: number, expanded: boolean): string {
  // `├─ `/`└─ ` take 3 cells of the body's width.
  return expanded ? label : truncateCells(label, width - 3);
}

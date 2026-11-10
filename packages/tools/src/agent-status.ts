/**
 * The status answer of `agent_control` (`action: "status"`,
 * docs/feat/agent-status.md): the MAIN agent's read-only view of its background
 * sub-agents — state, tool uses, tokens, elapsed, the actions it took last, and
 * how many of the parent's messages it has not read yet.
 *
 * The data is already there: `AgentJobs.rows()` folds each child's own progress
 * events (`packages/core/src/agent-jobs.ts`), the same rows the `subagents`
 * display update projects for the TUI. This module adds nothing to them — it is
 * a pure formatter, called by `agent-control.ts`.
 *
 * Bounded and untrusted by construction (AGENTS §7): a pod's child chose its own
 * description and every tool label, so each string is made ONE line and cut
 * before it enters the text, the row count and the total length are capped, and
 * nothing is phrased as an instruction from the child. A label reads as data.
 */
import type { AgentJobRow } from "@tentacle/core";

/**
 * The name the model USED to be offered for this answer. No longer a tool — the
 * merge into `agent_control` (docs/feat/agent-status.md) replaced it. The
 * constant stays for the child filter / `readOnlyType` (an old `agents/*.md` may
 * name it) and for old sessions' logs, which still contain its calls.
 */
export const AGENT_STATUS_TOOL_NAME = "agent_status";

/** How many of a child's last actions the tool shows when the call names none. */
export const AGENT_STATUS_ACTIONS_DEFAULT = 3;
/** The most it will show: a tail, never a transcript. */
export const AGENT_STATUS_ACTIONS_MAX = 5;
/** The most children one answer lists; the rest is one closing count. */
export const AGENT_STATUS_MAX_CHILDREN = 10;
/** The whole answer's cap: a tool result, never a dump. */
export const AGENT_STATUS_MAX_CHARS = 3_000;
/** One description or tool label as it may appear: a column, never a paragraph. */
export const AGENT_STATUS_TEXT_MAX = 60;

/** Control characters (C0, DEL, C1): never in a line a model reads. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** One bounded single-line string: control chars → space, whitespace collapsed, cut. */
export function oneLine(text: string, max = AGENT_STATUS_TEXT_MAX): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max).trimEnd();
}

function compact(n: number, unit: number, suffix: string): string {
  const v = n / unit;
  const one = v.toFixed(1);
  return Number(one) < 10
    ? `${one.endsWith(".0") ? one.slice(0, -2) : one}${suffix}`
    : `${Math.round(v)}${suffix}`;
}

/** 999 → "999", 1000 → "1k", 1234 → "1.2k", 18_400_000 → "18M". */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) {
    return String(v);
  }
  return Math.round(v / 1000) < 1000 ? compact(v, 1000, "k") : compact(v, 1_000_000, "M");
}

/** Whole seconds, the TUI's own wording: 45 → "45s", 84 → "1m 24s", 3900 → "1h 5m". */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export interface AgentStatusInput {
  /** The live rows (`AgentJobs.rows()`), in launch order. */
  readonly rows: readonly AgentJobRow[];
  /** How many unread parent texts a child holds (`AgentJobs.pending`). */
  readonly pending: (agentId: string) => number;
  /** Now, for the elapsed column: the tool passes `Date.now()`. */
  readonly now: number;
  /** `subagents.maxParallel` when the caller knows it; left out otherwise. */
  readonly maxParallel?: number;
  /** One child by id; absent → every running one. */
  readonly agentId?: string;
  /** How many of its last actions to show (already clamped 1..MAX). */
  readonly actions?: number;
}

/**
 * The whole answer as text, or `undefined` when `agentId` names no running
 * child: a miss is the tool's error to phrase, not a silent empty answer.
 */
export function formatAgentStatus(input: AgentStatusInput): string | undefined {
  const selected =
    input.agentId === undefined ? input.rows : input.rows.filter((r) => r.id === input.agentId);
  if (input.agentId !== undefined && selected.length === 0) {
    return undefined;
  }
  const cap = input.maxParallel !== undefined ? ` (of ${input.maxParallel} allowed)` : "";
  if (selected.length === 0) {
    const limit =
      input.maxParallel !== undefined ? ` (subagents.maxParallel = ${input.maxParallel})` : "";
    return `no background sub-agents are running${limit}. A [background] note arrives when one finishes.`;
  }
  const actions = Math.min(
    AGENT_STATUS_ACTIONS_MAX,
    Math.max(1, input.actions ?? AGENT_STATUS_ACTIONS_DEFAULT),
  );
  const shown = selected.slice(0, AGENT_STATUS_MAX_CHILDREN);
  const lines = [
    `${selected.length} background sub-agent${selected.length === 1 ? "" : "s"}${cap}`,
    ...shown.map((row) => childBlock(row, input, actions)),
  ];
  const hidden = selected.length - shown.length;
  if (hidden > 0) {
    lines.push(`… +${hidden} more (name one with agent_id)`);
  }
  // The cap is the last resort: a full 10 children at 60-char labels still fits,
  // so reaching it means unusually long descriptions — cut, with a hint that
  // names the way to get a full answer. The hint counts against the cap.
  const text = lines.join("\n");
  if (text.length <= AGENT_STATUS_MAX_CHARS) {
    return text;
  }
  const hint = "\n… (cut: name one child with agent_id)";
  return text.slice(0, AGENT_STATUS_MAX_CHARS - hint.length).trimEnd() + hint;
}

/** One child: a facts line and a `last N:` line (or `no tool calls yet`). */
function childBlock(row: AgentJobRow, input: AgentStatusInput, actions: number): string {
  const elapsed = formatElapsed((input.now - row.startedAt) / 1000);
  const head = [
    row.id,
    oneLine(row.agentType, 24),
    oneLine(row.description) || "(no description)",
    `running ${elapsed}`,
    `${formatCount(row.toolUses)} tool${row.toolUses === 1 ? "" : "s"}`,
    `${formatCount(row.tokens)} tokens`,
    `${input.pending(row.id)} unread`,
  ].join(" · ");
  return `${head}\n  ${actionsLine(row, actions)}`;
}

/** The tail line: the TUI's own labels, oldest first, plus how much is not here. */
function actionsLine(row: AgentJobRow, actions: number): string {
  if (row.tail.length === 0) {
    return "no tool calls yet";
  }
  const shown = row.tail.slice(-actions).map((label) => oneLine(label));
  const earlier = Math.max(0, row.toolUses - shown.length);
  return `last ${shown.length}: ${shown.join(" · ")}${earlier > 0 ? ` (+${earlier} earlier)` : ""}`;
}

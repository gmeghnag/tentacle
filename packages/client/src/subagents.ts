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

/** What a client keeps of a child's message to the agent (`subagent_notify`). */
export interface SubagentNotify {
  readonly agentId: string;
  readonly text: string;
  readonly wake: boolean;
}

/** The id a child may be named by: a bounded, one-line label. */
const NOTIFY_ID_MAX = 64;
/** The text as sent, cut: the note itself arrives in the conversation. */
const NOTIFY_TEXT_MAX = 8_000;

/**
 * A `subagent_notify` frame from a daemon that may be a pod (AGENTS §7):
 * bounded and sanitized HERE, before anything renders it. Control characters
 * (terminal escapes) become spaces as `progressText` does, but the NEWLINES are
 * kept — a child's message is prose, and the notice shows its first line.
 */
export function boundSubagentNotify(n: {
  readonly agentId: string;
  readonly text: string;
  readonly wake: boolean;
}): SubagentNotify {
  return {
    agentId: progressText(n.agentId).slice(0, NOTIFY_ID_MAX),
    text: boundNotifyText(n.text),
    wake: n.wake,
  };
}

/** Strip the control characters a terminal must never receive, keep `\n`, cap the length. */
function boundNotifyText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
  return clean.length > NOTIFY_TEXT_MAX ? `${clean.slice(0, NOTIFY_TEXT_MAX - 1)}…` : clean;
}

/** What a client keeps of the user's own message to a child (`subagent_message`). */
export interface SubagentMessageView {
  readonly agentId: string;
  readonly text: string;
}

/**
 * A `subagent_message` frame (the USER wrote to a background child,
 * docs/feat/subagent-panel.md) from a daemon that may be a pod (AGENTS §7):
 * bounded and sanitized HERE, before anything renders it. The same rule as the
 * child's own notice — control characters become spaces, the NEWLINES are kept
 * (a message is prose, and the notice shows its first line) — and both fields
 * are capped, so a hostile daemon can at most print one bounded line.
 */
export function boundSubagentMessage(n: {
  readonly agentId: string;
  readonly text: string;
}): SubagentMessageView {
  return {
    agentId: progressText(n.agentId).slice(0, NOTIFY_ID_MAX),
    text: boundNotifyText(n.text),
  };
}

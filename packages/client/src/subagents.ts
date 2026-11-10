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
/** How long a row's model label may be (a `models` name is ≤ 64 by config). */
export const MODEL_LABEL_MAX = 64;

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
    // The read count, bounded to a nonnegative safe integer: a pod's daemon is
    // not trusted (AGENTS §7), and this is a display figure only. Absent stays
    // absent (an older daemon: the drawer keeps today's text).
    ...(boundCount(row.userRead) === undefined ? {} : { userRead: boundCount(row.userRead) }),
    // A `models` name, bounded like every other label (a pod's daemon is not
    // trusted: AGENTS §7). Absent stays absent (the main agent's own model).
    ...(row.model === undefined ? {} : { model: clean(row.model).slice(0, MODEL_LABEL_MAX) }),
  };
}

/**
 * A count a daemon sent, kept only when it is a nonnegative safe integer: a
 * hostile (or buggy) daemon can then at most print a wrong figure — never a
 * negative, a float or an `Infinity` in the drawer.
 */
function boundCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
  /**
   * Its place among the user's messages to this child (1-based, cumulative):
   * the drawer compares it with a row's `userRead` for `✓ read`. Absent from an
   * older daemon (docs/fix/autoaccept-wake-turns.md, part B).
   */
  readonly n?: number;
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
  readonly n?: number;
}): SubagentMessageView {
  const index = boundIndex(n.n);
  return {
    agentId: progressText(n.agentId).slice(0, NOTIFY_ID_MAX),
    text: boundNotifyText(n.text),
    ...(index === undefined ? {} : { n: index }),
  };
}

/** A message's index, kept only when it is a POSITIVE safe integer (the schema's rule). */
function boundIndex(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The phone's memory of FINISHED background sub-agents (docs/feat/mobile-chrome.md
 * Design 5, slice S8). The daemon's `subagents` update is the full live list and a
 * finished child LEAVES it at once (owner P5), so "finished" exists only here: a
 * row that was in the previous list and is not in the next one. Per screen, never
 * persisted (F13) — the report itself stays in the conversation.
 *
 * Pure, React-free (AGENTS §7).
 */
import type { SubagentRow } from "@tentacle/protocol";
import type { Row } from "./transcript-rows.ts";

/** Finished children kept per screen (F18). */
export const FINISHED_CAP = 20;

/**
 * The note kinds that carry a child's outcome: core's `NOTE_KIND.subagentReport`
 * and `NOTE_KIND.subagentLost` (pinned equal by `activity-memory.test.ts`; spelt
 * out here so the phone's bundle does not pull core's runtime for two strings).
 */
export const REPORT_NOTE_KINDS: ReadonlySet<string> = new Set(["subagent_report", "subagent_lost"]);

export interface FinishedChild {
  /** Its last row before it left the list. */
  readonly row: SubagentRow;
  /** The client's clock when the leave was seen. */
  readonly endedAt: number;
}

export interface ActivityMemory {
  /** The last live list seen; `null` before the first one (so the first is never a finish). */
  readonly live: readonly SubagentRow[] | null;
  /** Newest first, at most `FINISHED_CAP`. */
  readonly finished: readonly FinishedChild[];
  /** The ids whose report the person opened (the badge's "unread"). */
  readonly opened: readonly string[];
}

export const emptyMemory: ActivityMemory = { live: null, finished: [], opened: [] };

/** A `subagents` replace: rows that left become Finished; rows back in the list leave Finished. */
export function onSubagents(
  memory: ActivityMemory,
  rows: readonly SubagentRow[],
  now: number,
): ActivityMemory {
  const liveIds = new Set(rows.map((row) => row.id));
  const kept = memory.finished.filter((f) => !liveIds.has(f.row.id));
  // A row of the previous list is never already Finished (the step that listed
  // it took it out of Finished), so a re-sent list cannot duplicate one.
  const left: FinishedChild[] = (memory.live ?? [])
    .filter((row) => !liveIds.has(row.id))
    .map((row) => ({ row, endedAt: now }));
  return {
    live: rows,
    finished: [...left.reverse(), ...kept].slice(0, FINISHED_CAP),
    opened: memory.opened,
  };
}

/** The person opened `id`'s report. */
export function markOpened(memory: ActivityMemory, id: string): ActivityMemory {
  return memory.opened.includes(id) ? memory : { ...memory, opened: [...memory.opened, id] };
}

export interface ChildReport {
  /** The note as markdown: its first line, then its body. */
  readonly text: string;
  /** A `subagent_lost` note: the child's work is gone. */
  readonly lost: boolean;
  /** The transcript row that holds it. */
  readonly key: string;
}

/**
 * The reports in the transcript, by the note's `id` (`sa-N`). Joined at view time,
 * so a report that arrives before or after the child leaves the list joins alike.
 * The last note for an id wins.
 */
export function reportsOf(rows: readonly Row[]): ReadonlyMap<string, ChildReport> {
  const out = new Map<string, ChildReport>();
  for (const row of rows) {
    if (row.kind !== "notice" || row.note === undefined || row.note.id === undefined) {
      continue;
    }
    if (!REPORT_NOTE_KINDS.has(row.note.kind)) {
      continue;
    }
    out.set(row.note.id, {
      text: row.body === undefined ? row.text : `${row.text}\n${row.body}`,
      lost: row.note.kind === "subagent_lost",
      key: row.key,
    });
  }
  return out;
}

/**
 * The phone's Finished memory (docs/feat/mobile-chrome.md Design 5, slice S8):
 * a child that LEAVES the `subagents` list becomes Finished with its last row;
 * its report joins by the note's `id`, in either order; bounded; a reconnect's
 * snapshot never duplicates.
 */
import { describe, expect, test } from "bun:test";
import { NOTE_KIND } from "@tentacle/core";
import type { SubagentRow } from "@tentacle/protocol";
import {
  FINISHED_CAP,
  REPORT_NOTE_KINDS,
  emptyMemory,
  markOpened,
  onSubagents,
  reportsOf,
} from "../src/activity-memory.ts";
import { historyRows } from "../src/transcript-history.ts";
import type { Row } from "../src/transcript-rows.ts";

function child(id: string, over: Partial<SubagentRow> = {}): SubagentRow {
  return {
    id,
    callId: `call-${id}`,
    agentType: "explore",
    description: `task ${id}`,
    state: "running",
    toolUses: 3,
    tokens: 1000,
    startedAt: 1_000,
    tail: ["read a.ts", "grep foo"],
    ...over,
  };
}

function note(key: string, kind: string, id: string, text: string, body?: string): Row {
  return {
    kind: "notice",
    key,
    text,
    note: { kind, id },
    ...(body === undefined ? {} : { body }),
  };
}

describe("onSubagents: leaving the list is finishing", () => {
  test("a row that leaves becomes Finished with its LAST row and the end time", () => {
    let m = onSubagents(emptyMemory, [child("sa-1"), child("sa-2")], 2_000);
    m = onSubagents(m, [child("sa-1", { toolUses: 9 }), child("sa-2")], 3_000);
    m = onSubagents(m, [child("sa-2")], 4_000);
    expect(m.finished.map((f) => f.row.id)).toEqual(["sa-1"]);
    expect(m.finished[0]?.row.toolUses).toBe(9);
    expect(m.finished[0]?.endedAt).toBe(4_000);
  });

  test("the first list is not a finish (nothing was known before it)", () => {
    const m = onSubagents(emptyMemory, [child("sa-1")], 2_000);
    expect(m.finished).toEqual([]);
  });

  test("a reconnect's snapshot re-listing the same rows does not duplicate", () => {
    let m = onSubagents(emptyMemory, [child("sa-1")], 2_000);
    m = onSubagents(m, [], 3_000);
    m = onSubagents(m, [], 3_500); // the reconnect's snapshot: still empty
    expect(m.finished.map((f) => f.row.id)).toEqual(["sa-1"]);
  });

  test("an id back in the live list leaves Finished (never both)", () => {
    let m = onSubagents(emptyMemory, [child("sa-1")], 2_000);
    m = onSubagents(m, [], 3_000);
    m = onSubagents(m, [child("sa-1")], 4_000);
    expect(m.finished).toEqual([]);
  });

  test("newest Finished first, capped at FINISHED_CAP", () => {
    let m = emptyMemory;
    for (let i = 0; i < FINISHED_CAP + 5; i += 1) {
      m = onSubagents(m, [child(`sa-${i}`)], i * 10);
      m = onSubagents(m, [], i * 10 + 5);
    }
    expect(m.finished.length).toBe(FINISHED_CAP);
    expect(m.finished[0]?.row.id).toBe(`sa-${FINISHED_CAP + 4}`);
  });

  test("markOpened records a report as read, once", () => {
    const m = markOpened(markOpened(emptyMemory, "sa-1"), "sa-1");
    expect(m.opened).toEqual(["sa-1"]);
  });
});

describe("reportsOf: the join by note.id", () => {
  test("the report's markdown is its first line + body, keyed by the note's id", () => {
    const reports = reportsOf([
      note("r1", NOTE_KIND.subagentReport, "sa-1", "Report sa-1", "all good"),
    ]);
    expect(reports.get("sa-1")).toEqual({ text: "Report sa-1\nall good", lost: false, key: "r1" });
  });

  test("a lost child's note joins as lost", () => {
    const reports = reportsOf([note("r1", NOTE_KIND.subagentLost, "sa-3", "sa-3 was lost")]);
    expect(reports.get("sa-3")?.lost).toBe(true);
  });

  test("other notes (a shell exit, a message) are not reports", () => {
    const reports = reportsOf([
      note("a", NOTE_KIND.backgroundExit, "bg-1", "exited"),
      note("b", NOTE_KIND.subagentMessage, "sa-1", "hi"),
      { kind: "notice", key: "c", text: "plain" },
    ]);
    expect(reports.size).toBe(0);
  });

  test("the report kinds are core's own (one truth)", () => {
    expect([...REPORT_NOTE_KINDS].sort()).toEqual(
      [NOTE_KIND.subagentReport, NOTE_KIND.subagentLost].sort(),
    );
  });

  test("a report message from the history keeps its note id through historyRows", () => {
    let n = 0;
    const rows = historyRows(
      [
        {
          role: "user",
          content: "[sub-agent sa-4 finished]\nfound 3 call sites",
          note: { kind: NOTE_KIND.subagentReport, id: "sa-4" },
        },
      ],
      () => {
        n += 1;
        return `k${n}`;
      },
    );
    expect(reportsOf(rows).get("sa-4")?.text).toBe("[sub-agent sa-4 finished]\nfound 3 call sites");
  });

  test("either order: the join is by id, not arrival", () => {
    const rows = [note("r1", NOTE_KIND.subagentReport, "sa-1", "Report")];
    // note BEFORE the list update
    const early = reportsOf(rows);
    let m = onSubagents(emptyMemory, [child("sa-1")], 1);
    m = onSubagents(m, [], 2);
    expect(early.get(m.finished[0]?.row.id ?? "")?.text).toBe("Report");
  });
});

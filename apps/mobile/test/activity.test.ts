/**
 * The Activity sheet's view (docs/feat/mobile-chrome.md Design 5, slice S8):
 * count, badge rule, groups (running first, empty live groups hidden, Scheduled
 * the real wakes or an empty state), elapsed from `startedAt` with an injected clock, a free `state`
 * shown as is, and the agent card's target.
 */
import { describe, expect, test } from "bun:test";
import type { JobRow, ScheduleRow, SubagentRow } from "@tentacle/protocol";
import type { ChildReport, FinishedChild } from "../src/activity-memory.ts";
import {
  type ActivityInput,
  activityView,
  agentCardTarget,
  elapsed,
  reportRow,
} from "../src/activity.ts";
import { scheduleMetaText } from "../src/schedule-view.ts";

function child(id: string, over: Partial<SubagentRow> = {}): SubagentRow {
  return {
    id,
    callId: `call-${id}`,
    agentType: "explore",
    description: `task ${id}`,
    state: "running",
    toolUses: 4,
    tokens: 1000,
    startedAt: 0,
    tail: ["read a.ts", "grep foo"],
    ...over,
  };
}

function job(id: string, over: Partial<JobRow> = {}): JobRow {
  return { id, command: "npm test", startedAt: 0, status: "running", ...over };
}

const NONE: ActivityInput = {
  subagents: null,
  jobs: null,
  finished: [],
  reports: new Map(),
  opened: [],
  schedules: [],
};

describe("count and badge", () => {
  test("count = live sub-agents + running shell jobs; the badge shows", () => {
    const v = activityView(
      {
        ...NONE,
        subagents: [child("sa-1"), child("sa-2")],
        jobs: { rows: [job("bg-1")], count: 1 },
      },
      60_000,
    );
    expect(v.count).toBe(3);
    expect(v.badge).toBe(true);
    expect(v.badgeLabel).toBe("3");
    expect(v.accessibilityLabel).toBe("Activity, 3 running");
  });

  test("the daemon's job count wins over the client-capped rows (H1)", () => {
    const v = activityView({ ...NONE, jobs: { rows: [job("bg-1")], count: 4 } }, 0);
    expect(v.count).toBe(4);
  });

  test("nothing running and nothing unread: no badge", () => {
    const v = activityView({ ...NONE, subagents: [], jobs: { rows: [], count: 0 } }, 0);
    expect(v.count).toBe(0);
    expect(v.badge).toBe(false);
  });

  test("an older daemon (no frames at all): no badge (F15)", () => {
    expect(activityView(NONE, 0).badge).toBe(false);
  });

  test("an unread report keeps the badge at zero running; opening it clears it", () => {
    const finished: FinishedChild[] = [{ row: child("sa-1"), endedAt: 5 }];
    const reports = new Map<string, ChildReport>([
      ["sa-1", { text: "done", lost: false, key: "r" }],
    ]);
    const unread = activityView({ ...NONE, subagents: [], finished, reports }, 0);
    expect(unread.badge).toBe(true);
    expect(unread.unread).toBe(1);
    expect(unread.badgeLabel).toBe("1 new");
    const read = activityView({ ...NONE, subagents: [], finished, reports, opened: ["sa-1"] }, 0);
    expect(read.badge).toBe(false);
  });

  test("a finished child with no report yet is not 'unread'", () => {
    const v = activityView({ ...NONE, finished: [{ row: child("sa-1"), endedAt: 5 }] }, 0);
    expect(v.unread).toBe(0);
    expect(v.badge).toBe(false);
  });
});

describe("groups", () => {
  test("running first: sub-agents, shell jobs, then Finished, then Scheduled", () => {
    const v = activityView(
      {
        ...NONE,
        subagents: [child("sa-2")],
        jobs: { rows: [job("bg-1")], count: 1 },
        finished: [{ row: child("sa-1"), endedAt: 5 }],
      },
      0,
    );
    expect(v.groups.map((g) => g.kind)).toEqual(["subagents", "jobs", "finished", "scheduled"]);
    expect(v.groups[0]?.title).toBe("Sub-agents · 1 running");
    expect(v.groups[1]?.title).toBe("Shell jobs · 1 running");
  });

  test("a live group with nothing in it is hidden; Scheduled with no wakes is an empty state", () => {
    const v = activityView(
      { ...NONE, subagents: [], jobs: { rows: [], count: 0 }, schedules: [] },
      0,
    );
    expect(v.groups.map((g) => g.kind)).toEqual(["scheduled"]);
    expect(v.groups[0]?.rows).toEqual([]);
    expect(v.groups[0]?.empty).toBe("No scheduled wakes");
  });

  test("a daemon with no wake feed (never reported) draws no Scheduled group, never a fake one", () => {
    const v = activityView({ ...NONE, schedules: undefined }, 0);
    expect(v.groups.map((g) => g.kind)).toEqual([]);
  });

  test("no groups at all (no wake feed, nothing running) → a sheet-level empty state, never a blank sheet", () => {
    const v = activityView({ ...NONE, schedules: undefined }, 0);
    expect(v.groups).toEqual([]);
    expect(v.empty).toBe("Nothing running");
  });

  test("`nothingRunning`: only Scheduled's EMPTY state is nothing — the hub's Activity stays dimmed (fix/mobile-e2e-reds, flow 33)", () => {
    // The wake feed made an empty Scheduled group, so `groups.length === 0` was
    // never true again and the hub opened a sheet holding only "No scheduled wakes".
    expect(activityView({ ...NONE, schedules: [] }, 0).nothingRunning).toBe(true);
    expect(activityView({ ...NONE, schedules: undefined }, 0).nothingRunning).toBe(true);
    expect(activityView({ ...NONE, subagents: [child("sa-1")] }, 0).nothingRunning).toBe(false);
  });

  test("any group present → no sheet-level empty state (Scheduled draws its own)", () => {
    expect(activityView({ ...NONE, schedules: [] }, 0).empty).toBeNull();
    expect(
      activityView({ ...NONE, schedules: undefined, subagents: [child("sa-1")] }, 0).empty,
    ).toBeNull();
  });

  test("Scheduled shows the real wakes: the count and the SOONEST wake, one tappable row", () => {
    const now = Date.UTC(2026, 10, 17, 9, 0);
    const late: ScheduleRow = {
      id: "sc-1",
      kind: "every",
      spec: "every 1h",
      prompt: "check CI",
      nextAt: now + 3_600_000,
      fires: 2,
      createdAt: 0,
    };
    const soon: ScheduleRow = {
      ...late,
      id: "sc-2",
      spec: "every 10m",
      prompt: "poll the deploy",
      nextAt: now + 600_000,
      fires: 4,
    };
    const v = activityView({ ...NONE, schedules: [late, soon] }, now);
    const group = v.groups.find((g) => g.kind === "scheduled");
    expect(group?.title).toBe("Scheduled · 2 wakes");
    expect(group?.empty).toBeNull();
    expect(group?.rows.length).toBe(1);
    const row = group?.rows[0];
    expect(row?.kind).toBe("scheduled");
    expect(row?.title).toBe("poll the deploy");
    expect(row?.meta).toBe(`next · ${scheduleMetaText(soon, now)}`);
    // Scheduled is not "running": it never counts toward the header pill.
    expect(v.count).toBe(0);
    expect(v.badge).toBe(false);
  });

  test("a sub-agent row: description, meta with id · type · model · steps · elapsed, latest step", () => {
    const v = activityView(
      { ...NONE, subagents: [child("sa-3", { model: "haiku", startedAt: 1_000 })] },
      1_000 + 125_000,
    );
    const row = v.groups[0]?.rows[0];
    expect(row?.title).toBe("task sa-3");
    expect(row?.meta).toBe("sa-3 · explore · haiku · 4 steps · 2m 05s");
    expect(row?.step).toBe("grep foo");
    expect(row?.running).toBe(true);
  });

  test("a newer daemon's unknown state is shown as is", () => {
    const v = activityView({ ...NONE, subagents: [child("sa-3", { state: "paused" })] }, 0);
    expect(v.groups[0]?.rows[0]?.meta).toContain("paused");
  });

  test("a multi-line description is one line (plain text, never interpreted — F16)", () => {
    const v = activityView({ ...NONE, subagents: [child("sa-3", { description: "a\nb\tc" })] }, 0);
    expect(v.groups[0]?.rows[0]?.title).toBe("a b c");
  });

  test("a shell job row: the command in mono, bg-N · status · elapsed", () => {
    const v = activityView(
      { ...NONE, jobs: { rows: [job("bg-2", { startedAt: 0 })], count: 1 } },
      9_000,
    );
    const row = v.groups[0]?.rows[0];
    expect(row?.title).toBe("npm test");
    expect(row?.mono).toBe(true);
    expect(row?.meta).toBe("bg-2 · running · 9s");
  });

  test("Finished rows: report flag, lost outcome, unread mark", () => {
    const v = activityView(
      {
        ...NONE,
        finished: [
          { row: child("sa-2"), endedAt: 5 },
          { row: child("sa-1"), endedAt: 4 },
        ],
        reports: new Map<string, ChildReport>([["sa-1", { text: "gone", lost: true, key: "r" }]]),
      },
      0,
    );
    const rows = v.groups[0]?.rows ?? [];
    expect(rows.map((r) => [r.id, r.hasReport, r.unread])).toEqual([
      ["sa-2", false, false],
      ["sa-1", true, true],
    ]);
    expect(rows[1]?.meta).toContain("lost");
    expect(rows[0]?.meta).toContain("report pending");
  });
});

describe("elapsed", () => {
  test.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [3_600_000 + 120_000, "1h 02m"],
    [-5_000, "0s"], // clock skew (the pod's clock): never negative
  ])("%p ms → %p", (ms, label) => {
    expect(elapsed(ms)).toBe(label);
  });
});

describe("reportRow: which report the sheet shows", () => {
  const v = activityView(
    {
      ...NONE,
      subagents: [child("sa-2")],
      finished: [{ row: child("sa-1"), endedAt: 1 }],
    },
    0,
  );
  test("a Finished child's focus is its row", () => {
    expect(reportRow(v, "sa-1")?.kind).toBe("finished");
  });
  test("no focus, a running child, or an unknown id → the list", () => {
    expect(reportRow(v, null)).toBeNull();
    expect(reportRow(v, "sa-2")).toBeNull();
    expect(reportRow(v, "sa-9")).toBeNull();
  });
});

describe("agentCardTarget: the transcript card opens its child", () => {
  test("a background launch matches the live row by callId", () => {
    expect(agentCardTarget("call-sa-1", undefined, [child("sa-1")], [])).toBe("sa-1");
  });
  test("a foreground child moved to the background is its movedTo id", () => {
    expect(agentCardTarget("x", "sa-9", [], [])).toBe("sa-9");
  });
  test("a finished child is found by callId in Finished", () => {
    expect(agentCardTarget("call-sa-2", undefined, [], [{ row: child("sa-2"), endedAt: 1 }])).toBe(
      "sa-2",
    );
  });
  test("an unknown call is no target (a plain tool row, F15)", () => {
    expect(agentCardTarget("nope", undefined, null, [])).toBeNull();
  });
});

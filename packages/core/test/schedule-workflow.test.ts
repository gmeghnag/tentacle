/**
 * Slice 10 of docs/feat/agent-workflows.md — a schedule whose target is a
 * workflow: the `daily HH:MM` kind, eligibility while a turn runs, the 15-min
 * grace instead of catch-up, no time expiry, and the failure stop.
 */
import { describe, expect, test } from "bun:test";
import {
  type ScheduledJob,
  scheduleCheckDelayMs,
  scheduleCreate,
  scheduleRecordFire,
  scheduleStep,
} from "../src/schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T09:00:00Z");
const target = { name: "nightly", inputs: [{ name: "slug", value: "main" }], hash: "3f2a9b" };

function wfJob(
  request: { every?: string; at?: string; daily?: string },
  now = NOW,
  id = "sc-1",
): ScheduledJob {
  const result = scheduleCreate(
    [],
    { ...request, workflow: target },
    {
      id,
      now,
      createdBy: "user",
    },
  );
  if (!result.ok) throw new Error(result.reason);
  return result.job;
}

function promptJob(every: string, id: string): ScheduledJob {
  const result = scheduleCreate(
    [],
    { prompt: "check CI", every },
    {
      id,
      now: NOW,
      createdBy: "turn-1",
    },
  );
  if (!result.ok) throw new Error(result.reason);
  return result.job;
}

function withTz<T>(tz: string, body: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    process.env.TZ = before ?? "";
  }
}

/** Fire a job at its own slot `count` times; the local hour of each slot. */
function fireHours(first: ScheduledJob, count: number): number[] {
  let job = first;
  const hours: number[] = [];
  for (let day = 0; day < count; day++) {
    hours.push(new Date(job.nextAt).getHours());
    const step = scheduleStep([job], job.nextAt, { idle: true });
    if (step.due === null) throw new Error("not due at its own slot");
    job = step.due;
  }
  return hours;
}

describe("daily HH:MM", () => {
  test("fires at local 03:00 across both 2026 DST changes (Europe/Rome)", () => {
    withTz("Europe/Rome", () => {
      const spring = wfJob({ daily: "03:00" }, new Date(2026, 2, 27, 12, 0).getTime());
      const autumn = wfJob({ daily: "03:00" }, new Date(2026, 9, 23, 12, 0).getTime());
      expect([...fireHours(spring, 3), ...fireHours(autumn, 3)]).toEqual([3, 3, 3, 3, 3, 3]);
    });
  });

  test("a local time DST skips → the first valid instant after it, then the next day", () => {
    withTz("Europe/Rome", () => {
      const job = wfJob({ daily: "02:30" }, new Date(2026, 2, 28, 12, 0).getTime());
      const at = new Date(job.nextAt);
      expect([at.getDate(), at.getHours()]).toEqual([29, 3]);
      const step = scheduleStep([job], job.nextAt, { idle: true });
      expect(step.due === null ? 0 : new Date(step.due.nextAt).getDate()).toBe(30);
    });
  });

  test("a repeated hour fires once (the next slot is the next day's)", () => {
    withTz("Europe/Rome", () => {
      const job = wfJob({ daily: "02:30" }, new Date(2026, 9, 24, 12, 0).getTime());
      const step = scheduleStep([job], job.nextAt, { idle: true });
      if (step.due === null) throw new Error("not due");
      expect(step.due.nextAt - job.nextAt).toBeGreaterThan(23 * HOUR);
    });
  });

  test("refuses a malformed time and a second kind; the spec reads `daily HH:MM`", () => {
    const create = (request: { daily?: string; every?: string }) =>
      scheduleCreate([], { prompt: "x", ...request }, { id: "sc-1", now: NOW, createdBy: "t" });
    const bad = create({ daily: "25:00" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("daily");
    expect(create({ daily: "03:00", every: "2h" }).ok).toBe(false);
    expect(wfJob({ daily: "03:00" }).spec).toBe("daily 03:00");
  });

  test("a clock back-jump recomputes the slot (never stalls a day+)", () => {
    const job = wfJob({ daily: "03:00" });
    const back = job.nextAt - 3 * DAY;
    const kept = scheduleStep([job], back, { idle: true }).table[0];
    expect(kept === undefined ? Number.POSITIVE_INFINITY : kept.nextAt - back).toBeLessThanOrEqual(
      DAY,
    );
  });
});

describe("workflow target", () => {
  test("is due while a turn runs; a prompt job is not", () => {
    const wf = wfJob({ every: "2h" }, NOW, "sc-1");
    const prompt = promptJob("2h", "sc-2");
    expect(scheduleStep([prompt, wf], NOW + 2 * HOUR, { idle: false }).due?.id).toBe("sc-1");
    expect(scheduleStep([prompt], NOW + 2 * HOUR, { idle: false }).due).toBeNull();
    // the busy timer re-arms to the workflow slot, not a blind full interval
    expect(scheduleCheckDelayMs([prompt, wf], NOW + 2 * HOUR - 10_000, { idle: false })).toBe(
      10_000,
    );
  });

  test("late 16 min → missed (not due), next slot strictly after now; late 14 min → due", () => {
    const job = wfJob({ every: "2h" });
    const late = job.nextAt + 16 * MINUTE;
    const step = scheduleStep([job], late, { idle: true });
    expect(step.due).toBeNull();
    expect(step.missed.map((row) => row.id)).toEqual(["sc-1"]);
    const kept = step.table[0];
    expect(kept === undefined ? 0 : kept.nextAt).toBeGreaterThan(late);
    expect(kept?.last).toEqual({ at: late, outcome: "missed" });
    expect(kept?.fires).toBe(0);
    const onTime = scheduleStep([job], job.nextAt + 14 * MINUTE, { idle: true });
    expect(onTime.due?.id).toBe("sc-1");
    expect(onTime.missed).toEqual([]);
  });

  test("N missed slots → ONE missed record, never a replay", () => {
    const job = wfJob({ every: "1h" });
    const step = scheduleStep([job], job.nextAt + 10 * HOUR + 30 * MINUTE, { idle: true });
    expect(step.missed).toHaveLength(1);
    expect(step.due).toBeNull();
  });

  test("a missed one-shot leaves the table", () => {
    const job = wfJob({ at: "in 1h" });
    const step = scheduleStep([job], job.nextAt + HOUR, { idle: true });
    expect(step.missed.map((row) => row.id)).toEqual(["sc-1"]);
    expect(step.table).toEqual([]);
  });

  test("a prompt job still catches up once (regression)", () => {
    const job = promptJob("1h", "sc-1");
    const step = scheduleStep([job], job.nextAt + 6 * HOUR, { idle: true });
    expect(step.due?.id).toBe("sc-1");
    expect(step.missed).toEqual([]);
  });

  test("a recurring workflow job never expires (+30 d); a prompt job does", () => {
    const thirty = NOW + 30 * DAY;
    const step = scheduleStep([wfJob({ daily: "03:00" })], thirty, { idle: true });
    expect(step.expired).toEqual([]);
    expect(step.table).toHaveLength(1);
    expect(scheduleStep([promptJob("1h", "sc-2")], thirty, { idle: true }).expired).toHaveLength(1);
  });

  test("failure stop: needs-the-human ×3 removes, skipped/missed never count, a start resets", () => {
    let table: readonly ScheduledJob[] = [wfJob({ every: "2h" })];
    const at = NOW;
    for (const outcome of ["skipped", "missed", "skipped"] as const) {
      table = scheduleRecordFire(table, "sc-1", { at, outcome }).table;
    }
    expect(table[0]?.failures).toBe(0);
    table = scheduleRecordFire(table, "sc-1", { at, outcome: "changed" }).table;
    table = scheduleRecordFire(table, "sc-1", { at, outcome: "invalid" }).table;
    expect(table[0]?.failures).toBe(2);
    table = scheduleRecordFire(table, "sc-1", { at, outcome: "started", runId: "wf-1" }).table;
    expect(table[0]?.failures).toBe(0);
    expect(table[0]?.last).toEqual({ at, outcome: "started", runId: "wf-1" });
    let removed = false;
    for (let index = 0; index < 3; index++) {
      const result = scheduleRecordFire(table, "sc-1", { at, outcome: "unapproved" });
      table = result.table;
      removed = result.removed;
    }
    expect(removed).toBe(true);
    expect(table).toEqual([]);
  });

  test("the row's label names the workflow and its inputs; the hash is pinned", () => {
    const job = wfJob({ every: "2h" });
    expect(job.prompt).toBe("workflow nightly slug=main");
    expect(job.target?.workflow.hash).toBe("3f2a9b");
  });

  test("exactly one of prompt | workflow", () => {
    const both = scheduleCreate(
      [],
      { prompt: "x", workflow: target, every: "2h" },
      {
        id: "sc-1",
        now: NOW,
        createdBy: "t",
      },
    );
    expect(both.ok).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  SCHEDULE_CHECK_INTERVAL_MS,
  type ScheduledJob,
  nextDueAt,
  parseDurationMs,
  parseScheduleSpec,
  scheduleCheckDelayMs,
  scheduleCreate,
  scheduleDelete,
  schedulePromptText,
  scheduleSettled,
  scheduleStep,
} from "../src/schedule.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A fixed instant: every test drives the clock itself (this module has none). */
const NOW = Date.parse("2026-11-16T09:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Every existing call site is an idle check (the session can start a fired turn). */
const idleCheck = (table: readonly ScheduledJob[], now: number) =>
  scheduleStep(table, now, { idle: true });

/** One job through the real create path — a hand-built literal would not prove parsing. */
function created(
  request: { every?: string; at?: string; prompt?: string },
  options: { now?: number; id?: string; table?: readonly ScheduledJob[] } = {},
): ScheduledJob {
  const result = scheduleCreate(
    options.table ?? [],
    {
      prompt: request.prompt ?? "check CI on PR #412",
      ...(request.every === undefined ? {} : { every: request.every }),
      ...(request.at === undefined ? {} : { at: request.at }),
    },
    { id: options.id ?? "sc-1", now: options.now ?? NOW, createdBy: "turn-7" },
  );
  if (!result.ok) throw new Error(`create refused: ${result.reason}`);
  return result.job;
}

describe("parseDurationMs", () => {
  test("a count and m/h/d", () => {
    expect(parseDurationMs("10m")).toBe(10 * MINUTE);
    expect(parseDurationMs("2h")).toBe(2 * 60 * MINUTE);
    expect(parseDurationMs("7d")).toBe(7 * DAY);
    expect(parseDurationMs(" 15M ")).toBe(15 * MINUTE);
  });

  test("seconds are not an interval (D2: `90s` is refused)", () => {
    expect(parseDurationMs("90s")).toBeNull();
    expect(parseDurationMs("0m")).toBeNull();
    expect(parseDurationMs("-10m")).toBeNull();
    expect(parseDurationMs("10")).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
  });
});

describe("parseScheduleSpec", () => {
  const parse = (request: { every?: string; at?: string }) => parseScheduleSpec(request, NOW);

  test("every: interval, first slot one interval out, 7-day expiry", () => {
    const every = parse({ every: "10m" });
    expect(every).toEqual({
      ok: true,
      kind: "every",
      spec: "every 10m",
      intervalMs: 10 * MINUTE,
      nextAt: NOW + 10 * MINUTE,
      expiresAt: NOW + 7 * DAY,
    });
  });

  test("every: the bounds are 1m..7d", () => {
    expect(parse({ every: "1m" }).ok).toBe(true);
    expect(parse({ every: "7d" }).ok).toBe(true);
    expect(parse({ every: "8d" }).ok).toBe(false);
    expect(parse({ every: "90s" }).ok).toBe(false);
  });

  test("at: an ISO time with an offset, and one in the host's local zone", () => {
    const offset = parse({ at: "2026-11-16T17:00:00+01:00" });
    expect(offset).toEqual({
      ok: true,
      kind: "at",
      spec: "at 2026-11-16T17:00:00+01:00",
      nextAt: Date.parse("2026-11-16T16:00:00Z"),
      // A one-shot's record outlives its time by the grace window, so a laptop
      // that was asleep still fires it ONCE (catch-up) rather than dropping it.
      expiresAt: Date.parse("2026-11-16T16:00:00Z") + 7 * DAY,
    });
    // No offset = the daemon host's local zone, which is what the model means.
    const local = parse({ at: "2026-11-16T17:00" });
    expect(local.ok && local.nextAt).toBe(new Date("2026-11-16T17:00").getTime());
  });

  test("at: a bare date is local midnight, a relative `in 20m` is from now", () => {
    const dateOnly = parse({ at: "2026-11-20" });
    expect(dateOnly.ok && dateOnly.nextAt).toBe(new Date("2026-11-20T00:00").getTime());
    const relative = parse({ at: "in 20m" });
    expect(relative.ok && relative.nextAt).toBe(NOW + 20 * MINUTE);
    // A relative time is resolved at creation: the row must not keep saying "in 20m".
    const spec = relative.ok ? relative.spec : "";
    expect(spec).not.toContain("in 20m");
    const resolved = new Date(NOW + 20 * MINUTE);
    const pad = (value: number): string => String(value).padStart(2, "0");
    expect(spec).toBe(
      `at ${resolved.getFullYear()}-${pad(resolved.getMonth() + 1)}-${pad(resolved.getDate())}` +
        `T${pad(resolved.getHours())}:${pad(resolved.getMinutes())}`,
    );
  });

  test("at: the past and more than 7 days ahead are refused with a reason", () => {
    const past = parse({ at: iso(NOW - MINUTE) });
    expect(past.ok).toBe(false);
    expect(past.ok ? "" : past.reason).toContain("past");
    const far = parse({ at: iso(NOW + 8 * DAY) });
    expect(far.ok).toBe(false);
    expect(far.ok ? "" : far.reason).toContain("7d");
    expect(parse({ at: "tomorrow" }).ok).toBe(false);
    expect(parse({ at: "in 90s" }).ok).toBe(false);
  });

  test("exactly one of every/at", () => {
    const both = parse({ every: "10m", at: iso(NOW + MINUTE) });
    expect(both.ok).toBe(false);
    expect(both.ok ? "" : both.reason).toContain("exactly one");
    const neither = parse({});
    expect(neither.ok).toBe(false);
    expect(neither.ok ? "" : neither.reason).toContain("exactly one");
  });
});

describe("scheduleCreate", () => {
  test("the row is the plan's state shape (D3)", () => {
    const job = created({ every: "10m" });
    expect(job).toEqual({
      id: "sc-1",
      kind: "every",
      spec: "every 10m",
      intervalMs: 10 * MINUTE,
      prompt: "check CI on PR #412",
      createdAt: NOW,
      expiresAt: NOW + 7 * DAY,
      nextAt: NOW + 10 * MINUTE,
      fires: 0,
      failures: 0,
      createdBy: "turn-7",
    });
    const oneShot = created({ at: iso(NOW + 60 * MINUTE) }, { id: "sc-2" });
    expect(oneShot.kind).toBe("at");
    expect(oneShot.intervalMs).toBeUndefined();
  });

  test("the table is replaced, never mutated", () => {
    const before: readonly ScheduledJob[] = [];
    const result = scheduleCreate(
      before,
      { prompt: "check CI", every: "10m" },
      { id: "sc-1", now: NOW, createdBy: "turn-7" },
    );
    expect(before).toEqual([]);
    expect(result.ok && result.table.length).toBe(1);
  });

  test("the prompt is required and capped at 2000 chars", () => {
    const empty = scheduleCreate(
      [],
      { prompt: "   ", every: "10m" },
      { id: "sc-1", now: NOW, createdBy: "t" },
    );
    expect(empty.ok).toBe(false);
    const long = scheduleCreate(
      [],
      { prompt: "x".repeat(2001), every: "10m" },
      { id: "sc-1", now: NOW, createdBy: "t" },
    );
    expect(long.ok).toBe(false);
    const atCap = scheduleCreate(
      [],
      { prompt: "x".repeat(2000), every: "10m" },
      { id: "sc-1", now: NOW, createdBy: "t" },
    );
    expect(atCap.ok).toBe(true);
  });

  test("the 11th live job is refused with the cap named", () => {
    let table: readonly ScheduledJob[] = [];
    for (let n = 1; n <= 10; n++) {
      const result = scheduleCreate(
        table,
        { prompt: `wake ${n}`, every: "10m" },
        { id: `sc-${n}`, now: NOW, createdBy: "turn-7" },
      );
      if (!result.ok) throw new Error(result.reason);
      table = result.table;
    }
    expect(table.length).toBe(10);
    const eleventh = scheduleCreate(
      table,
      { prompt: "one too many", every: "10m" },
      { id: "sc-11", now: NOW, createdBy: "turn-7" },
    );
    expect(eleventh.ok).toBe(false);
    expect(eleventh.ok ? "" : eleventh.reason).toContain("10");
  });
});

describe("scheduleStep", () => {
  test("nothing due: no fire, the table is unchanged", () => {
    const job = created({ every: "10m" });
    const step = idleCheck([job], NOW + MINUTE);
    expect(step.due).toBeNull();
    expect(step.table).toEqual([job]);
    expect(step.expired).toEqual([]);
  });

  test("due: fires++ and the next slot moves past now, before it fires (at-most-once)", () => {
    const job = created({ every: "10m" });
    const step = idleCheck([job], NOW + 10 * MINUTE);
    expect(step.due?.fires).toBe(1);
    expect(step.due?.nextAt).toBe(NOW + 20 * MINUTE);
    expect(step.table.length).toBe(1);
    expect(step.table[0]?.nextAt).toBe(NOW + 20 * MINUTE);
    // The same instant cannot fire it twice: the record already moved on.
    expect(idleCheck(step.table, NOW + 10 * MINUTE).due).toBeNull();
  });

  test("catch-up ONCE across N missed slots, then the schedule resumes from now", () => {
    const job = created({ every: "10m" });
    // Down/spinning for three slots and a bit: one fire, and nextAt is the
    // first slot strictly after `now` — the missed slots are NOT replayed.
    const now = NOW + 3 * 10 * MINUTE + 1;
    const step = idleCheck([job], now);
    expect(step.due?.fires).toBe(1);
    expect(step.table[0]?.nextAt).toBe(NOW + 4 * 10 * MINUTE);
    expect(idleCheck(step.table, now).due).toBeNull();
    // One more interval later it is an ordinary fire again.
    expect(idleCheck(step.table, NOW + 4 * 10 * MINUTE).due?.fires).toBe(2);
  });

  test("two due together: the older nextAt fires, one turn each (never merged)", () => {
    const older = created({ every: "10m" }, { id: "sc-1" });
    const newer = created({ every: "15m" }, { id: "sc-2" });
    const now = NOW + 30 * MINUTE;
    const first = idleCheck([older, newer], now);
    expect(first.due?.id).toBe("sc-1");
    const second = idleCheck(first.table, now);
    expect(second.due?.id).toBe("sc-2");
    expect(idleCheck(second.table, now).due).toBeNull();
  });

  test("two due together: the OLDER nextAt fires even when it is not first in the table", () => {
    // Table order (creation order) and nextAt order disagree on purpose: sc-1
    // repeats hourly, so sc-2's slot (created later) comes due first.
    const hourly = created({ every: "1h" }, { id: "sc-1" });
    const fast = created({ every: "5m" }, { id: "sc-2", now: NOW + 3 * MINUTE });
    expect(hourly.nextAt).toBe(NOW + 60 * MINUTE);
    expect(fast.nextAt).toBe(NOW + 8 * MINUTE);
    const step = idleCheck([hourly, fast], NOW + 90 * MINUTE);
    expect(step.due?.id).toBe("sc-2");
  });

  test("a short-interval job does not starve a later, longer one (one turn each)", () => {
    // The starvation shape: sc-1 is due again by the time every turn ends, so a
    // table-order pick would fire sc-1 on every idle check and never sc-2.
    const ticker = created({ every: "1m" }, { id: "sc-1" });
    const reminder = created({ every: "10m" }, { id: "sc-2" });
    let table: readonly ScheduledJob[] = [ticker, reminder];
    const fires: Record<string, number> = {};
    let idle = NOW;
    for (let check = 0; check < 30; check++) {
      idle += 2 * MINUTE; // a fired turn takes about two minutes
      const step = idleCheck(table, idle);
      if (step.due !== null) fires[step.due.id] = (fires[step.due.id] ?? 0) + 1;
      table = step.table;
    }
    expect(fires["sc-2"]).toBeGreaterThan(0);
    expect(fires["sc-1"]).toBeGreaterThan(0);
  });

  test("a busy check sweeps expiry but fires nothing and loses no slot", () => {
    // While a turn holds the slot the daemon must not advance the model: doing
    // so would silently burn the job's slot (D3: a due job STAYS due).
    const gone = created({ every: "10m" }, { id: "sc-1", now: NOW - 8 * DAY });
    const live = created({ every: "10m" }, { id: "sc-2" });
    const busy = scheduleStep([gone, live], NOW + 25 * MINUTE, { idle: false });
    expect(busy.due).toBeNull();
    expect(busy.expired.map((job) => job.id)).toEqual(["sc-1"]);
    expect(busy.table).toEqual([live]);
    // And the slot is still there for the next idle check.
    expect(idleCheck(busy.table, NOW + 25 * MINUTE).due?.id).toBe("sc-2");
  });

  test("the table keeps its creation order (the wire row order)", () => {
    const first = created({ every: "10m" }, { id: "sc-1" });
    const second = created({ every: "20m" }, { id: "sc-2" });
    const step = idleCheck([first, second], NOW + 10 * MINUTE);
    expect(step.table.map((job) => job.id)).toEqual(["sc-1", "sc-2"]);
  });

  test("a one-shot fires once and leaves the table", () => {
    const job = created({ at: iso(NOW + 60 * MINUTE) });
    const step = idleCheck([job], NOW + 60 * MINUTE);
    expect(step.due?.fires).toBe(1);
    expect(step.due?.kind).toBe("at");
    expect(step.table).toEqual([]);
  });

  test("a one-shot overdue while we were down still fires once (within its grace)", () => {
    const job = created({ at: iso(NOW + 60 * MINUTE) });
    const step = idleCheck([job], NOW + 60 * MINUTE + 3 * DAY);
    expect(step.due?.id).toBe("sc-1");
    expect(step.table).toEqual([]);
  });

  test("a recurring job past its 7-day expiry is removed, not fired", () => {
    const job = created({ every: "10m" });
    const step = idleCheck([job], NOW + 7 * DAY + 1);
    expect(step.due).toBeNull();
    expect(step.table).toEqual([]);
    expect(step.expired.map((j) => j.id)).toEqual(["sc-1"]);
  });

  test("a one-shot past its grace is removed without firing", () => {
    const job = created({ at: iso(NOW + 60 * MINUTE) });
    const step = idleCheck([job], NOW + 60 * MINUTE + 7 * DAY);
    expect(step.due).toBeNull();
    expect(step.expired.map((j) => j.id)).toEqual(["sc-1"]);
  });

  test("the clock jumped backwards: `every` is clamped to now + interval", () => {
    const job = created({ every: "10m" });
    // The clock now reads BEFORE the creation, so nextAt is far more than one
    // interval away — unclamped, the wake would stall for hours.
    const now = NOW - 6 * 60 * MINUTE;
    const step = idleCheck([job], now);
    expect(step.due).toBeNull();
    expect(step.table[0]?.nextAt).toBe(now + 10 * MINUTE);
    // And it fires at that clamped slot, once.
    expect(idleCheck(step.table, now + 10 * MINUTE).due?.fires).toBe(1);
  });

  test("a forward jump is an ordinary catch-up, not a stall", () => {
    const job = created({ every: "10m" });
    const step = idleCheck([job], NOW + 5 * DAY);
    expect(step.due?.fires).toBe(1);
    expect(step.table[0]?.nextAt).toBe(NOW + 5 * DAY + 10 * MINUTE);
  });
});

describe("failure stop (a dead model key costs 3 turns, not one per interval)", () => {
  const settled = (table: readonly ScheduledJob[], end: "ok" | "error" | "cancelled") =>
    scheduleSettled(table, "sc-1", end);

  test("three errors in a row remove the job", () => {
    const job = created({ every: "10m" });
    const first = settled([job], "error");
    expect(first.removed).toBe(false);
    expect(first.table[0]?.failures).toBe(1);
    const second = settled(first.table, "error");
    expect(second.table[0]?.failures).toBe(2);
    const third = settled(second.table, "error");
    expect(third.removed).toBe(true);
    expect(third.table).toEqual([]);
  });

  test("a normal end resets the count", () => {
    const job = created({ every: "10m" });
    const oneError = settled([job], "error");
    const reset = settled(oneError.table, "ok");
    expect(reset.table[0]?.failures).toBe(0);
    expect(settled(reset.table, "error").table[0]?.failures).toBe(1);
  });

  test("a cancelled turn does not count (nor reset)", () => {
    const job = created({ every: "10m" });
    const oneError = settled([job], "error");
    const cancelled = settled(oneError.table, "cancelled");
    expect(cancelled.removed).toBe(false);
    expect(cancelled.table[0]?.failures).toBe(1);
  });

  test("an unknown id is a no-op", () => {
    const job = created({ every: "10m" });
    expect(scheduleSettled([job], "sc-9", "error").table).toEqual([job]);
  });
});

describe("scheduleDelete", () => {
  test("deletes by id, reports an unknown one", () => {
    const job = created({ every: "10m" });
    const gone = scheduleDelete([job], "sc-1");
    expect(gone.deleted).toBe(true);
    expect(gone.table).toEqual([]);
    expect(scheduleDelete([job], "sc-2")).toEqual({ table: [job], deleted: false });
  });
});

describe("schedulePromptText (the fired turn's user message, D3)", () => {
  test("the prefix names the job, its spec and the fire ordinal", () => {
    const job = created({ every: "10m" });
    const fired = idleCheck([job], NOW + 10 * MINUTE).due;
    expect(fired === null ? null : schedulePromptText(fired)).toBe(
      "[scheduled sc-1 · every 10m · fire 1] check CI on PR #412",
    );
  });
});

describe("the timer's inputs (the daemon owns the one setTimeout)", () => {
  test("nextDueAt is the earliest nextAt, null for an empty table", () => {
    const a = created({ every: "10m" }, { id: "sc-1" });
    const b = created({ every: "2m" }, { id: "sc-2" });
    expect(nextDueAt([a, b])).toBe(NOW + 2 * MINUTE);
    expect(nextDueAt([])).toBeNull();
  });

  test("the check delay is capped at 60 s so a sleep or clock jump is noticed", () => {
    const job = created({ every: "2h" });
    // Overdue (an idle check is due now) and busy alike: check now, never a
    // negative timeout — nor a `setTimeout(0)` spin on every check while a turn
    // holds the slot (see the "busy" tests).
    expect(scheduleCheckDelayMs([job], NOW, { idle: true })).toBe(SCHEDULE_CHECK_INTERVAL_MS);
    expect(scheduleCheckDelayMs([job], NOW + 119 * MINUTE, { idle: true })).toBe(MINUTE);
    expect(scheduleCheckDelayMs([job], NOW + 5 * 60 * MINUTE, { idle: true })).toBe(0);
    expect(scheduleCheckDelayMs([job], NOW + 5 * 60 * MINUTE, { idle: false })).toBe(
      SCHEDULE_CHECK_INTERVAL_MS,
    );
    // Busy and nothing due: the same 60 s ceiling, so the idle check is noticed.
    expect(scheduleCheckDelayMs([job], NOW, { idle: false })).toBe(SCHEDULE_CHECK_INTERVAL_MS);
    expect(scheduleCheckDelayMs([], NOW, { idle: true })).toBeNull();
    expect(scheduleCheckDelayMs([], NOW, { idle: false })).toBeNull();
  });
});

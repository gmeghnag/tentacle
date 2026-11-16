/**
 * docs/feat/cron-tool.md S5 — the scheduled wakes as the TUI paints them, pure
 * (AGENTS §7: every decision here, so the components only map a row to a colour).
 *
 * The rows carry a MODEL's text (`spec`/`prompt`, and an id a pod could forge on
 * its own daemon), and this TUI writes them into a terminal: each test below
 * that matters for safety asserts the crafted string never survives.
 */
import { describe, expect, test } from "bun:test";
import { scheduleQuitText } from "../src/commands.ts";
import {
  SCHEDULES_START,
  type ScheduleDockRow,
  departedScheduleNotice,
  firedScheduleHead,
  refreshedSchedules,
  scheduleDeleteStep,
  scheduleKey,
  scheduleMeta,
  scheduleTitle,
  schedulesLabel,
  schedulesView,
} from "../src/schedule-view.ts";

const NOW = 1_764_000_000_000; // a fixed clock: nothing here reads the wall clock

const every = (extra: Partial<ScheduleDockRow> = {}): ScheduleDockRow => ({
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: NOW + 9 * 60_000,
  expiresAt: NOW + 7 * 24 * 3_600_000,
  fires: 4,
  createdAt: NOW - 3_600_000,
  ...extra,
});

const at = (extra: Partial<ScheduleDockRow> = {}): ScheduleDockRow => ({
  id: "sc-2",
  kind: "at",
  spec: "at 17:00",
  prompt: "remind: standup notes",
  nextAt: NOW + (2 * 60 + 29) * 60_000,
  fires: 0,
  createdAt: NOW,
  ...extra,
});

describe("S5: a dock row's two columns", () => {
  test("the title is the prompt, one line, cut in cells", () => {
    expect(scheduleTitle(every())).toBe("check CI on PR #412");
    // A newline and a control character are the model's, and a row is ONE row.
    expect(scheduleTitle(every({ prompt: "a\nb\u001b[2Jc" }))).toBe("a b [2Jc");
    // 56 cells, with the cut marked.
    const long = scheduleTitle(every({ prompt: "x".repeat(120) }));
    expect(long.length).toBe(56);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a recurring wake's meta names the interval, the next fire and the count", () => {
    const meta = scheduleMeta(every(), NOW);
    // `next` is the VIEWER's zone: assert its shape, not a host's offset.
    expect(meta).toMatch(/^every 10m · next \d\d:\d\d · 4×$/);
    expect(meta).toContain("4×");
  });

  test("a one-shot names its distance and never a count (mutation: drop the kind branch)", () => {
    const meta = scheduleMeta(at(), NOW);
    expect(meta).toBe("at 17:00 · in 2h 29m");
    // It has fired 0 times and can only fire once: no `0×`.
    expect(meta).not.toContain("×");
    expect(scheduleMeta(at({ nextAt: NOW - 1 }), NOW)).toBe("at 17:00 · now");
  });

  test("the meta's own `spec` is the model's text too: one line", () => {
    expect(scheduleMeta(every({ spec: "every\t10m\nnow" }), NOW)).toMatch(/^every 10m now · /);
  });
});

describe("S5: the pill's word", () => {
  test("nothing armed says nothing (no `0 sched`)", () => {
    expect(schedulesLabel(0)).toBe("");
    expect(schedulesLabel(1)).toBe("1 sched");
    expect(schedulesLabel(2)).toBe("2 sched");
  });
});

describe("S5: the /schedule panel", () => {
  test("each wake is two rows: the summary, then the quoted prompt", () => {
    const view = schedulesView([every(), at()], SCHEDULES_START, NOW, 100, 8);
    expect(view.title).toBe("Scheduled wakes (2)");
    const texts = view.rows.map((r) => r.text);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("sc-1");
    expect(texts[0]).toContain("every 10m");
    expect(texts[0]).toContain("fired 4×");
    // The prompt is QUOTED under its summary, and only the summary is a row the
    // cursor walks (a `child` row, like a tree's).
    expect(texts[1]).toContain('"check CI on PR #412"');
    expect(view.rows[1]?.kind).toBe("child");
    expect(texts[2]).toContain("sc-2");
    expect(texts[2]).toContain("one-shot");
    expect(texts[3]).toContain('"remind: standup notes"');
  });

  test("an expiry names ITS OWN month, never a hardcoded one (fix round 1)", () => {
    // Two LOCAL dates, so the assertion holds in any zone: the clock is 3 Jan
    // and the wake expires on 15 Feb — the bug painted `expires 15 Jan`.
    const now = new Date(2026, 0, 3, 12, 0, 0).getTime();
    const feb = new Date(2026, 1, 15, 12, 0, 0).getTime();
    const view = schedulesView([every({ expiresAt: feb })], SCHEDULES_START, now, 120, 8);
    const summary = view.rows[0]?.text ?? "";
    expect(summary).toContain("expires 15 Feb");
    expect(summary).not.toContain("Jan");
    // Same month, and the year boundary: the month follows the DATE.
    const dec = new Date(2025, 11, 6, 12, 0, 0).getTime();
    const jan = new Date(2026, 0, 2, 12, 0, 0).getTime();
    const crosses = schedulesView([every({ expiresAt: dec })], SCHEDULES_START, jan, 120, 8);
    expect(crosses.rows[0]?.text ?? "").toContain("expires 6 Dec");
  });

  test("the selected wake is marked, and the cursor walks WAKES not lines", () => {
    const view = schedulesView([every(), at()], { cursor: 1, armed: null }, NOW, 100, 8);
    expect(view.rows[0]?.selected).toBe(false);
    expect(view.rows[2]?.selected).toBe(true);
    // Its quoted line is never selected: the cursor never lands between them.
    expect(view.rows[3]?.selected).toBe(false);
  });

  test("an armed row's hint is the confirm, and it names the id", () => {
    const view = schedulesView([every()], { cursor: 0, armed: "sc-1" }, NOW, 100, 8);
    expect(view.hint).toContain("sc-1");
    expect(view.hint).toContain("esc");
  });

  test("no rows and no report are DIFFERENT states, never the same empty list", () => {
    // undefined = the daemon never reported a table (a pod, an older daemon).
    expect(schedulesView(undefined, SCHEDULES_START, NOW, 100, 8).rows[0]?.text).toContain(
      "not supported",
    );
    // An empty list is a real answer: nothing is armed.
    expect(schedulesView([], SCHEDULES_START, NOW, 100, 8).rows[0]?.text).toContain("No scheduled");
  });

  test("a hostile prompt cannot break the panel's ONE row per wake (Low-2's lesson)", () => {
    const hostile = every({ prompt: `${"x".repeat(4_000)}\u001b[2J`, spec: "y".repeat(500) });
    const view = schedulesView([hostile], SCHEDULES_START, NOW, 60, 8);
    // Two rows for one wake, each cut to the panel's width.
    expect(view.rows).toHaveLength(2);
    for (const row of view.rows) {
      expect(row.text.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("S5: /schedule's keys", () => {
  const key = (over: Record<string, unknown> = {}) => ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ...over,
  });

  test("arrows move, esc closes, q closes, x deletes", () => {
    expect(scheduleKey("", key({ upArrow: true }))).toBe("up");
    expect(scheduleKey("", key({ downArrow: true }))).toBe("down");
    expect(scheduleKey("", key({ escape: true }))).toBe("close");
    expect(scheduleKey("q", key())).toBe("close");
    expect(scheduleKey("x", key())).toBe("delete");
  });

  test("Enter does nothing here: there is no second surface to open (mutation: map it to `delete`)", () => {
    expect(scheduleKey("", key({ return: true }))).toBe("none");
  });
});

describe("S5: deleting a wake is an arm, then a delete", () => {
  test("the first x arms, the second deletes, a move disarms", () => {
    const armed = scheduleDeleteStep(SCHEDULES_START, every(), NOW);
    expect(armed.kind).toBe("arm");
    if (armed.kind !== "arm") return;
    expect(armed.state.armed).toBe("sc-1");
    const deleted = scheduleDeleteStep(armed.state, every(), NOW);
    expect(deleted.kind).toBe("delete");
    if (deleted.kind !== "delete") return;
    expect(deleted.id).toBe("sc-1");
    expect(deleted.state.armed).toBeNull();
  });

  test("no row under the cursor is an honest refusal, not a silent no-op", () => {
    const step = scheduleDeleteStep(SCHEDULES_START, undefined, NOW);
    expect(step.kind).toBe("refused");
    if (step.kind !== "refused") return;
    expect(step.text).toContain("schedule");
  });
});

describe("S5: the /schedule panel FOLLOWS the table (fix round 1)", () => {
  test("a report replaces the rows, re-stamps the clock and keeps a live cursor", () => {
    const before = { cursor: 1, armed: null };
    const next = refreshedSchedules(before, [every(), every({ id: "sc-3" })]);
    expect(next.cursor).toBe(1);
    expect(next.armed).toBeNull();
  });

  test("a shrunken table clamps the cursor, and an emptied one goes to 0", () => {
    expect(refreshedSchedules({ cursor: 4, armed: null }, [every()]).cursor).toBe(0);
    expect(refreshedSchedules({ cursor: 3, armed: null }, []).cursor).toBe(0);
    expect(refreshedSchedules({ cursor: 3, armed: null }, undefined).cursor).toBe(0);
  });

  test("an arm on a row the report dropped disarms (it cannot delete a ghost)", () => {
    expect(refreshedSchedules({ cursor: 1, armed: "sc-2" }, [every()]).armed).toBeNull();
    // Still there: the arm survives its own table's report.
    expect(refreshedSchedules({ cursor: 0, armed: "sc-1" }, [every(), at()]).armed).toBe("sc-1");
  });
});

describe("S5: the fired turn's head (M4 option B, degrading to A)", () => {
  test("names the id and the interval, and reads `fire N` out of the durable prefix", () => {
    const head = firedScheduleHead(
      { id: "sc-1", spec: "every 10m" },
      "[scheduled sc-1 · every 10m · fire 5] check CI on PR #412",
    );
    expect(head).toBe("◷ scheduled · sc-1 every 10m · fire 5");
  });

  test("no `fire N` in the text (a reworded daemon): the ordinal leaves, the head stays", () => {
    const head = firedScheduleHead({ id: "sc-1", spec: "every 10m" }, "[scheduled sc-1] go");
    expect(head).toBe("◷ scheduled · sc-1 every 10m");
  });

  test("no ref at all (a reload, an older daemon) paints NOTHING: option A is the row itself", () => {
    expect(firedScheduleHead(undefined, "[scheduled sc-1 · every 10m · fire 5] go")).toBe("");
  });

  test("a hostile ref is one bounded line", () => {
    const head = firedScheduleHead(
      { id: "sc-\u001b[2Jx".repeat(200), spec: "e\n".repeat(400) },
      "",
    );
    expect(head).not.toContain("\u001b");
    expect(head).not.toContain("\n");
    expect(head.length).toBeLessThanOrEqual(120);
  });
});

describe("S5: quitting with armed wakes (M6)", () => {
  test("none armed: no warning at all", () => {
    expect(scheduleQuitText([])).toBeNull();
  });

  test("names the count and the ids, as ONE bounded row", () => {
    expect(scheduleQuitText(["sc-1"])).toBe(
      "1 scheduled wake (sc-1) ends with this session — quit? (y/N)",
    );
    expect(scheduleQuitText(["sc-1", "sc-2"])).toBe(
      "2 scheduled wakes (sc-1, sc-2) end with this session — quit? (y/N)",
    );
  });

  test("a hostile set of ids is bounded, and the count still tells the truth", () => {
    const many = Array.from({ length: 10 }, () => "x".repeat(64));
    const text = scheduleQuitText(many);
    expect(text).not.toBeNull();
    if (text === null) return;
    // One row, whatever the ids: the dialog has no second row to give.
    expect(text.length).toBeLessThan(90);
    // The names yield to the sentence, and the remainder keeps the total honest:
    // 1 shown + `+9` is still 10 wakes.
    expect(text.startsWith("10 scheduled wakes (")).toBe(true);
    expect(text).toContain("+9");
    expect(text).toContain("end with this session");
  });

  test("short ids: three are named, then the remainder (mutation: drop the cap)", () => {
    const text = scheduleQuitText(["sc-1", "sc-2", "sc-3", "sc-4"]);
    expect(text).toBe(
      "4 scheduled wakes (sc-1, sc-2, sc-3 +1) end with this session — quit? (y/N)",
    );
  });
});

describe("S5: a wake that left the table says why (S3 drift 5, derived from the diff)", () => {
  test("past its expiry: `expired`", () => {
    const gone = every({ expiresAt: NOW - 1 });
    expect(departedScheduleNotice([gone], [], NOW)).toBe("Schedule sc-1 expired.");
  });

  test("still in date: it says it is GONE, and never a cause it cannot know", () => {
    // Fix round 1 (finding 1): a row leaving the table proves only that it left.
    // Its cause may be the user's own delete, a phone's, the model's
    // `schedule_control{delete}`, a fire, or 3 failing turns — this TUI sees one
    // shrunk list, so it claims none of them.
    expect(departedScheduleNotice([every()], [], NOW)).toBe(
      "Schedule sc-1 is no longer scheduled.",
    );
  });

  test("a one-shot that left is not claimed as fired (it may have been deleted)", () => {
    expect(departedScheduleNotice([at()], [], NOW)).toBe("Schedule sc-2 is no longer scheduled.");
  });

  test("the ids this TUI deleted ITSELF stay silent (mutation: ignore the set)", () => {
    // Its own `x x` already said `Deleted sc-1.`; a second line about it is noise.
    expect(departedScheduleNotice([every()], [], NOW, new Set(["sc-1"]))).toBeNull();
  });

  test("a suppressed id does not silence another row's departure in the same report", () => {
    expect(departedScheduleNotice([every(), at()], [], NOW, new Set(["sc-1"]))).toBe(
      "Schedule sc-2 is no longer scheduled.",
    );
  });

  test("an expiry is still named for an id that is NOT this TUI's own delete", () => {
    const gone = every({ expiresAt: NOW - 1 });
    expect(departedScheduleNotice([gone], [], NOW, new Set(["sc-9"]))).toBe(
      "Schedule sc-1 expired.",
    );
  });

  test("nothing left, or a row still there: no notice (mutation: diff by LENGTH)", () => {
    expect(departedScheduleNotice([every()], [every()], NOW)).toBeNull();
    expect(departedScheduleNotice([], [], NOW)).toBeNull();
    // A table that gained a row says nothing either: only departures speak here.
    expect(departedScheduleNotice([every()], [every(), at()], NOW)).toBeNull();
  });

  test("two departures are two lines, each honest", () => {
    const text = departedScheduleNotice([every({ expiresAt: NOW - 1 }), at()], [], NOW);
    expect(text).toBe("Schedule sc-1 expired.\nSchedule sc-2 is no longer scheduled.");
  });

  test("a hostile id is bounded into the sentence", () => {
    const text = departedScheduleNotice(
      [every({ id: "x".repeat(300), expiresAt: NOW - 1 })],
      [],
      NOW,
    );
    expect(text).not.toBeNull();
    if (text === null) return;
    expect(text.length).toBeLessThan(80);
    expect(text).toContain("…");
  });
});

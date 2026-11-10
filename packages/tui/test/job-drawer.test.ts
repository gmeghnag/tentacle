/**
 * docs/feat/shell-jobs-panel.md — the job drawer's PURE rules.
 *
 * The refresh cadence is a predicate here (the App owns the one timer), so the
 * ≤ 1/s rule is provable without waiting a second, and the two frame-stability
 * rules (a blank line as `" "`, never an empty body) are pinned by value.
 */
import { describe, expect, test } from "bun:test";
import {
  BLANK_LINE,
  JOB_EMPTY_LINE,
  JOB_REFRESH_MS,
  JOB_TAIL_SHOWN,
  jobDrawerTail,
  jobTailWindow,
  refreshDue,
} from "../src/job-drawer.ts";

describe("refreshDue: at most one read a second, and only for an open job", () => {
  test("never read ⇒ due at once (a drawer is never blank while waiting)", () => {
    expect(refreshDue("job", null, 0)).toBe(true);
  });

  test("one per interval, to the millisecond", () => {
    expect(refreshDue("job", 1000, 1000)).toBe(false);
    expect(refreshDue("job", 1000, 1000 + JOB_REFRESH_MS - 1)).toBe(false);
    expect(refreshDue("job", 1000, 1000 + JOB_REFRESH_MS)).toBe(true);
    // Far past it (a suspended laptop): due, not a burst — the caller issues one.
    expect(refreshDue("job", 1000, 1000 + 60 * JOB_REFRESH_MS)).toBe(true);
  });

  test("a target that is not a job is never due (the timer exists for a job only)", () => {
    expect(refreshDue("other", null, 0)).toBe(false);
    expect(refreshDue("other", 0, 10 ** 9)).toBe(false);
  });

  test("a shortened interval is honoured (the one test seam)", () => {
    expect(refreshDue("job", 0, 49, 50)).toBe(false);
    expect(refreshDue("job", 0, 50, 50)).toBe(true);
  });
});

describe("jobTailWindow: the last lines, cut to the width, blank as ONE space", () => {
  test("the last JOB_TAIL_SHOWN lines, oldest first", () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const shown = jobTailWindow(many, { width: 80 });
    expect(shown).toHaveLength(JOB_TAIL_SHOWN);
    expect(shown.at(-1)).toBe("line 39");
    expect(shown[0]).toBe("line 28");
  });

  test('a blank line is ONE space, never "" (the §6 Ink 0×0 gotcha)', () => {
    const shown = jobTailWindow(["a", "", "b"], { width: 80 });
    expect(shown).toEqual(["a", BLANK_LINE, "b"]);
    // One cell: Ink measures it, so `dockRows`' reservation stays true.
    expect(shown[1]?.length).toBe(1);
  });

  test("each line is cell-cut for the width; nothing survives as empty", () => {
    const shown = jobTailWindow(["x".repeat(200)], { width: 20 });
    expect(shown[0]?.length).toBeLessThanOrEqual(20);
    // A wide glyph cut into one cell is an ellipsis, not an empty row.
    expect(jobTailWindow(["\u4e16\u754c"], { width: 1 })[0]).toBe("…");
  });

  test("no output at all is the ONE (no output yet) row: a non-zero body", () => {
    expect(jobDrawerTail(undefined, { width: 80 })).toEqual([JOB_EMPTY_LINE]);
    expect(jobDrawerTail([], { width: 80 })).toEqual([JOB_EMPTY_LINE]);
    // A single blank line is output, not emptiness: it paints as one space.
    expect(jobDrawerTail([""], { width: 80 })).toEqual([BLANK_LINE]);
  });

  test("an explicit `shown` overrides the default", () => {
    expect(jobTailWindow(["1", "2", "3"], { shown: 2, width: 80 })).toEqual(["2", "3"]);
  });
});

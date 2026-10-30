import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import type { MouseReport } from "../src/mouse.ts";
import { splitMouseReports } from "../src/mouse.ts";
import {
  CLICK_IDLE,
  type ClickState,
  fitSubtitle,
  isExpanded,
  nextClick,
  toggleExpanded,
} from "../src/tool-expand.ts";

// --- fakes -------------------------------------------------------------------
// A report is `ESC [ < btn ; x ; y (M|m)` — the parser's own input form, so the
// click tests drive the REAL report shape, not a hand-built object (mouse.ts).
const pressReport = (x: number, y: number, btn = 0): MouseReport => ({
  btn,
  x,
  y,
  press: true,
});
const releaseReport = (x: number, y: number): MouseReport => ({ btn: 0, x, y, press: false });
const dragReport = (x: number, y: number): MouseReport => ({ btn: 32, x, y, press: true });

/** Feed a whole report stream, returning the clicks it completed. */
function run(reports: readonly MouseReport[]): { clicks: [number, number][]; state: ClickState } {
  let state = CLICK_IDLE;
  const clicks: [number, number][] = [];
  for (const r of reports) {
    const step = nextClick(state, r);
    state = step.state;
    if (step.click) {
      clicks.push([step.click.x, step.click.y]);
    }
  }
  return { clicks, state };
}

describe("nextClick: a click is a press + release on the SAME cell (docs/feat/tui-tool-expand.md)", () => {
  test("a press and a release on one cell is a click", () => {
    expect(run([pressReport(3, 5), releaseReport(3, 5)]).clicks).toEqual([[3, 5]]);
    // …and the recogniser is disarmed afterwards, so a second release is not one.
    expect(run([pressReport(3, 5), releaseReport(3, 5), releaseReport(3, 5)]).clicks).toHaveLength(
      1,
    );
  });

  test("a press, MOTION, then a release is a drag, never a click", () => {
    // The owner's rule: a drag is text selection, exactly as today.
    expect(run([pressReport(3, 5), dragReport(9, 5), releaseReport(3, 5)]).clicks).toEqual([]);
    // Even a drag that comes back to the SAME cell is not a click: something
    // moved in between, so the user was selecting text.
    expect(
      run([pressReport(3, 5), dragReport(9, 5), dragReport(3, 5), releaseReport(3, 5)]).clicks,
    ).toEqual([]);
  });

  test("a press and a release on DIFFERENT cells is not a click", () => {
    expect(run([pressReport(3, 5), releaseReport(9, 5)]).clicks).toEqual([]);
    expect(run([pressReport(3, 5), releaseReport(3, 6)]).clicks).toEqual([]);
  });

  test("a press at one cell, another press, then a release at the second: the second wins", () => {
    // Two presses without a release in between (a dropped release) must not
    // complete a click for the FIRST cell.
    expect(run([pressReport(3, 5), pressReport(9, 5), releaseReport(9, 5)]).clicks).toEqual([
      [9, 5],
    ]);
    expect(run([pressReport(3, 5), pressReport(9, 5), releaseReport(3, 5)]).clicks).toEqual([]);
  });

  test("a coalesced press+release chunk (both reports, in order) is still a click", () => {
    // The common real case: a terminal writes both reports in one read, so the
    // App loops both through the recogniser in order.
    const { reports } = splitMouseReports("\u001B[<0;3;5M\u001B[<0;3;5m");
    expect(reports).toHaveLength(2);
    expect(run(reports).clicks).toEqual([[3, 5]]);
  });

  test("a wheel notch neither arms nor completes a click", () => {
    // A wheel report carries the motion bit too (64 | 32 in some terminals), so
    // it must be excluded explicitly or scrolling would arm a phantom click.
    const wheelUp: MouseReport = { btn: 64, x: 3, y: 5, press: true };
    const wheelDownMasked: MouseReport = { btn: 65, x: 3, y: 5, press: true };
    expect(run([wheelUp, releaseReport(3, 5)]).clicks).toEqual([]);
    expect(run([wheelDownMasked, releaseReport(3, 5)]).clicks).toEqual([]);
    // A wheel report between a press and its release disarms nothing but does
    // not create one either: the cell didn't change, the user scrolled.
    expect(run([pressReport(3, 5), wheelUp, releaseReport(3, 5)]).clicks).toEqual([[3, 5]]);
  });

  test("a right/middle button press never arms a left click", () => {
    expect(run([{ btn: 2, x: 3, y: 5, press: true }, releaseReport(3, 5)]).clicks).toEqual([]);
    expect(run([{ btn: 1, x: 3, y: 5, press: true }, releaseReport(3, 5)]).clicks).toEqual([]);
  });
});

describe("the expanded-id set", () => {
  test("toggleExpanded adds, removes, and never mutates", () => {
    const empty: readonly string[] = [];
    const one = toggleExpanded(empty, "c1");
    expect(one).toEqual(["c1"]);
    expect(empty).toEqual([]); // the input is untouched
    expect(toggleExpanded(one, "c2")).toEqual(["c1", "c2"]); // sorted: a stable cache key
    expect(toggleExpanded(one, "c1")).toEqual([]);
  });

  test("isExpanded reads the set", () => {
    expect(isExpanded([], "c1")).toBe(false);
    expect(isExpanded(["c1"], "c1")).toBe(true);
    expect(isExpanded(["c2"], "c1")).toBe(false);
  });
});

describe("fitSubtitle: the collapsed cut is measured in DISPLAY columns", () => {
  test("a subtitle that fits is returned unchanged", () => {
    expect(fitSubtitle("ls -la", 10)).toBe("ls -la");
    expect(fitSubtitle("ls -la", 6)).toBe("ls -la");
  });

  test("a subtitle that does not fit is cut with an ellipsis, within budget", () => {
    const out = fitSubtitle("0123456789", 6);
    expect(out).toBe("01234…");
    expect(stringWidth(out)).toBe(6);
  });

  test("width, not length: a CJK/emoji command is cut by COLUMNS", () => {
    // 5 CJK chars are 10 display columns: a `.length` cut would overflow.
    expect(stringWidth("中文中文中")).toBe(10);
    const out = fitSubtitle("中文中文中", 10);
    expect(stringWidth(out)).toBeLessThanOrEqual(10);
    // 6 columns leaves room for 2 CJK chars + the ellipsis (4+1=5 cols).
    const tight = fitSubtitle("中文中文中", 6);
    expect(stringWidth(tight)).toBeLessThanOrEqual(6);
    expect(tight).toBe("中文…");
    const emoji = fitSubtitle("😀😀😀😀", 5);
    expect(stringWidth(emoji)).toBeLessThanOrEqual(5);
  });

  test("a multi-line command is flattened onto ONE row (the header is one row)", () => {
    expect(fitSubtitle("make build\nmake test", 40)).toBe("make build make test");
    expect(fitSubtitle("a\r\nb", 40)).toBe("a b");
  });

  test("tabs are expanded, so a header row can never overflow on a tab stop", () => {
    expect(fitSubtitle("a\tb", 40)).toBe("a    b");
    expect(fitSubtitle("a\tb", 40)).not.toContain("\t");
  });

  test("no budget yields the empty string, never a lone ellipsis", () => {
    expect(fitSubtitle("anything", 0)).toBe("");
    expect(fitSubtitle("anything", -5)).toBe("");
    expect(fitSubtitle("anything", 1)).toBe("…");
    expect(fitSubtitle("", 10)).toBe("");
  });
});

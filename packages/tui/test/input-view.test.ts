import { describe, expect, test } from "bun:test";
import { type InputRow, inputRender, inputRowCount, inputView } from "../src/input-view.ts";

describe("inputView", () => {
  test("single line: cursor maps to row 0 and its column", () => {
    const v = inputView("hello", 3, 10);
    expect(v.lines).toEqual(["hello"]);
    expect(v).toMatchObject({ cursorRow: 0, cursorCol: 3, moreAbove: false, moreBelow: false });
    expect(v.totalLines).toBe(1);
  });

  test("multi-line under the cap: all lines shown, cursor on the right row/col", () => {
    // value: "ab\ncd\nef"; offset 4 is the 'd' on row 1 (a b \n c|d) → col 1.
    const v = inputView("ab\ncd\nef", 4, 10);
    expect(v.lines).toEqual(["ab", "cd", "ef"]);
    expect(v).toMatchObject({ cursorRow: 1, cursorCol: 1 });
  });

  test("cursor at a line end lands at col = line length (not the next row)", () => {
    const v = inputView("ab\ncd", 2, 10); // end of "ab"
    expect(v).toMatchObject({ cursorRow: 0, cursorCol: 2 });
  });

  test("cursor just past a newline is col 0 of the next row", () => {
    const v = inputView("ab\ncd", 3, 10); // start of "cd"
    expect(v).toMatchObject({ cursorRow: 1, cursorCol: 0 });
  });

  test("over the cap: windows around the cursor with overflow flags", () => {
    const value = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    // Put the cursor on line 10 (offset = sum of lengths + newlines up to L10).
    const offset = value.indexOf("L10") + 1; // somewhere inside L10
    const v = inputView(value, offset, 5);
    expect(v.lines).toHaveLength(5);
    expect(v.totalLines).toBe(20);
    expect(v.moreAbove).toBe(true);
    expect(v.moreBelow).toBe(true);
    // The cursor's line stays within the visible window.
    expect(v.cursorRow).toBeGreaterThanOrEqual(0);
    expect(v.cursorRow).toBeLessThan(5);
    expect(v.lines[v.cursorRow]).toBe("L10");
  });

  test("over the cap at the end: window is clamped, only moreAbove", () => {
    const value = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
    const v = inputView(value, value.length, 5); // cursor at the very end
    expect(v.lines).toEqual(["L7", "L8", "L9", "L10", "L11"]);
    expect(v.moreAbove).toBe(true);
    expect(v.moreBelow).toBe(false);
  });
});

describe("inputRender", () => {
  const text = (row: InputRow): string => row.segments.map((s) => s.text).join("");
  // An inverse-mask string: "I" where a cell is inverse, "." where it is plain.
  const mask = (row: InputRow): string =>
    row.segments.map((s) => (s.inverse ? "I" : ".").repeat(s.text.length)).join("");

  test("no selection: a single inverse cell marks the block cursor", () => {
    const { rows } = inputRender("Xhello", 1, null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prefix).toBe("❯ ");
    expect(text(rows[0] as InputRow)).toBe("Xhello");
    expect(mask(rows[0] as InputRow)).toBe(".I....");
  });

  test("cursor at end of line renders a trailing inverse space", () => {
    const { rows } = inputRender("abc", 3, null, 10);
    expect(text(rows[0] as InputRow)).toBe("abc ");
    expect(mask(rows[0] as InputRow)).toBe("...I");
  });

  test("a selection highlights its range and draws no separate cursor cell", () => {
    const { rows } = inputRender("abcdef", 3, 0, 10); // anchor 0, cursor 3 → "abc"
    expect(text(rows[0] as InputRow)).toBe("abcdef");
    expect(mask(rows[0] as InputRow)).toBe("III...");
  });

  test("a multi-line selection highlights the right cells per logical row", () => {
    // "ab\ncd\nef", select [1,5): b, then all of cd.
    const { rows } = inputRender("ab\ncd\nef", 5, 1, 10);
    expect(rows.map(text)).toEqual(["ab", "cd", "ef"]);
    expect(rows.map(mask)).toEqual([".I", "II", ".."]);
  });

  test("empty value: one row with the cursor cell and the accent prefix", () => {
    const { rows } = inputRender("", 0, null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prefix).toBe("❯ ");
    expect(mask(rows[0] as InputRow)).toBe("I");
  });

  test("windowing: the cursor row maps through windowStart, with gutter arrows", () => {
    // 5 lines, cap 3, cursor at the end of the last line → window shows l2..l4.
    const { rows } = inputRender("l0\nl1\nl2\nl3\nl4", 14, null, 3);
    expect(rows.map(text)).toEqual(["l2", "l3", "l4 "]); // l4 carries the trailing cursor
    expect(rows.map((r) => r.prefix)).toEqual(["↑ ", "  ", "  "]);
    expect(rows[0]?.gutter).toBe(true); // the ↑ overflow row
    expect(mask(rows[2] as InputRow)).toBe("..I"); // cursor at EOL of l4
  });
});

describe("soft-wrap (width 20 → 18 content cells per row)", () => {
  const W = 20;
  const text = (row: InputRow): string => row.segments.map((s) => s.text).join("");
  const mask = (row: InputRow): string =>
    row.segments.map((s) => (s.inverse ? "I" : ".").repeat(s.text.length)).join("");
  const v30 = "abcdefghijklmnopqrstuvwxyz0123"; // 30 chars → 18 + 12

  test("cursor at the end of a wrapped value is on the LAST visual row", () => {
    const { rows } = inputRender(v30, 30, null, 10, W);
    expect(rows.map(text)).toEqual(["abcdefghijklmnopqr", "stuvwxyz0123 "]);
    expect(rows.map((r) => r.prefix)).toEqual(["❯ ", "  "]);
    expect(mask(rows[0] as InputRow)).toBe("..................");
    expect(mask(rows[1] as InputRow)).toBe("............I");
  });

  test("a mid-text cursor lands on its own visual row and column", () => {
    const view = inputView(v30, 25, 10, W);
    expect(view).toMatchObject({ cursorRow: 1, cursorCol: 7 });
    const { rows } = inputRender(v30, 25, null, 10, W);
    expect(mask(rows[0] as InputRow)).toBe("..................");
    expect(mask(rows[1] as InputRow)).toBe(".......I....");
  });

  test("the cursor at a wrap boundary is the first cell of the NEXT row", () => {
    expect(inputView(v30, 18, 10, W)).toMatchObject({ cursorRow: 1, cursorCol: 0 });
    expect(inputView(v30, 17, 10, W)).toMatchObject({ cursorRow: 0, cursorCol: 17 });
  });

  test("EOL on an exactly full row goes to a fresh row below (pinned)", () => {
    const v18 = v30.slice(0, 18);
    const { rows } = inputRender(v18, 18, null, 10, W);
    expect(rows.map(text)).toEqual([v18, " "]);
    expect(rows.map((r) => r.prefix)).toEqual(["❯ ", "  "]);
    expect(mask(rows[1] as InputRow)).toBe("I");
    // …but only while the cursor is there: moved off, the extra row is gone.
    expect(inputRender(v18, 3, null, 10, W).rows).toHaveLength(1);
    expect(inputRowCount(v18, 18, W, 10)).toBe(2);
    expect(inputRowCount(v18, 3, W, 10)).toBe(1);
  });

  test("a wrapped line after a newline: continuation rows keep the blank gutter", () => {
    const value = `hi\n${v30}`;
    const { rows } = inputRender(value, value.length, null, 10, W);
    expect(rows.map(text)).toEqual(["hi", "abcdefghijklmnopqr", "stuvwxyz0123 "]);
    expect(rows.map((r) => r.prefix)).toEqual(["❯ ", "  ", "  "]);
    expect(mask(rows[2] as InputRow)).toBe("............I");
  });

  test("selection highlight continues across a wrap boundary", () => {
    const { rows } = inputRender(v30, 22, 10, 10, W); // select [10, 22)
    expect(mask(rows[0] as InputRow)).toBe("..........IIIIIIII");
    expect(mask(rows[1] as InputRow)).toBe("IIII........");
  });

  test("a wide character is never split across rows", () => {
    const value = `a${"日".repeat(9)}`; // 1 + 18 cells: the 9th 日 does not fit on row 0
    const { rows } = inputRender(value, value.length, null, 10, W);
    expect(rows.map(text)).toEqual([`a${"日".repeat(8)}`, "日 "]);
  });

  test("an emoji (surrogate pair) stays whole and its cursor cell covers both units", () => {
    const value = "😀".repeat(10); // 20 cells
    expect(inputView(value, value.length, 10, W).lines).toEqual(["😀".repeat(9), "😀"]);
    const { rows } = inputRender(value, 0, null, 10, W);
    expect(mask(rows[0] as InputRow)).toBe(`II${".".repeat(16)}`);
  });

  test("maxRows windows VISUAL rows and keeps the cursor row visible", () => {
    const value = "x".repeat(100); // 6 rows of 18
    const view = inputView(value, value.length, 3, W);
    expect(view.totalLines).toBe(6);
    expect(view.lines).toHaveLength(3);
    expect(view.moreAbove).toBe(true);
    expect(view.moreBelow).toBe(false);
    expect(view.lines[view.cursorRow]).toBe("x".repeat(10)); // the last (partial) row
    const { rows } = inputRender(value, value.length, null, 3, W);
    expect(rows.map((r) => r.prefix)).toEqual(["↑ ", "  ", "  "]);
    expect(inputRowCount(value, value.length, W, 3)).toBe(3);
  });

  test("a tab is displayed as 4 spaces; the buffer rows keep the tab byte", () => {
    const { rows } = inputRender("a\tb", 3, null, 10, W);
    expect(rows.map(text)).toEqual(["a    b "]);
    expect(mask(rows[0] as InputRow)).toBe("......I");
    expect(inputView("a\tb", 3, 10, W).lines).toEqual(["a\tb"]);
  });

  test("the cursor ON a tab is an inverse cell on the first of its 4 cells (pinned)", () => {
    const { rows } = inputRender("a\tb", 1, null, 10, W);
    expect(text(rows[0] as InputRow)).toBe("a    b");
    expect(mask(rows[0] as InputRow)).toBe(".I....");
  });

  test("a selection covering a tab highlights all 4 of its cells", () => {
    const { rows } = inputRender("a\tb", 2, 0, 10, W); // select "a\t"
    expect(mask(rows[0] as InputRow)).toBe("IIIII.");
  });

  test("a tab never splits across a wrap boundary and moves to the next row (pinned)", () => {
    const value = `${"x".repeat(16)}\t`; // 16 + 4 > 18 cells
    const { rows } = inputRender(value, value.length, null, 10, W);
    expect(rows.map(text)).toEqual(["x".repeat(16), "     "]); // tab (4) + cursor cell
    expect(inputView(value, value.length, 10, W).lines).toEqual(["x".repeat(16), "\t"]);
  });

  test("tabs count as 4 cells for the row count (box height)", () => {
    expect(inputRowCount("\t\t\t\t", 0, W, 10)).toBe(1); // 16 cells
    expect(inputRowCount("\t\t\t\t\t", 0, W, 10)).toBe(2); // 20 cells
    expect(inputView("\t\t\t\t\t", 0, 10, W).totalLines).toBe(2);
  });

  test("an empty line stays one row; width Infinity never wraps", () => {
    expect(inputRowCount("", 0, W, 10)).toBe(1);
    expect(inputRowCount("a\n\nb", 0, W, 10)).toBe(3);
    expect(inputView("x".repeat(100), 100, 10).lines).toHaveLength(1);
  });
});

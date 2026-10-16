import { describe, expect, test } from "bun:test";
import { type InputRow, inputRender, inputSelectionSpan, inputView } from "../src/input-view.ts";

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

describe("inputSelectionSpan", () => {
  test("single line: the span is clamped to the row", () => {
    expect(inputSelectionSpan("hello world", 2, 7, 0)).toEqual([2, 7]);
    // Selection starting before the row start / ending past it.
    expect(inputSelectionSpan("hello", 0, 9, 0)).toEqual([0, 5]);
    expect(inputSelectionSpan("hello", -5, 3, 0)).toEqual([0, 3]);
  });

  test("row before or after the selection is null; empty span is null", () => {
    expect(inputSelectionSpan("ab\ncd", 3, 5, 0)).toBeNull(); // row 0, selection on row 1
    expect(inputSelectionSpan("ab\ncd", 0, 2, 1)).toBeNull(); // row 1, selection on row 0
    expect(inputSelectionSpan("abcd", 2, 2, 0)).toBeNull(); // collapsed
  });

  test("multi-line: the start row starts at c0, the end row ends at c1, full rows in between", () => {
    // value "ab\ncdef\ngh"; selection [1,8) = "b\ncdef" →
    // row 0: [1,2), row 1: [0,4), row 2: null.
    expect(inputSelectionSpan("ab\ncdef\ngh", 1, 8, 0)).toEqual([1, 2]);
    expect(inputSelectionSpan("ab\ncdef\ngh", 1, 8, 1)).toEqual([0, 4]);
    expect(inputSelectionSpan("ab\ncdef\ngh", 1, 8, 2)).toBeNull();
  });

  test("a selection spanning three lines: the middle row is fully selected", () => {
    // value "aa\nbb\ncc"; selection [1,7) = "a\nbb\nc" → row 1 fully [0,2).
    expect(inputSelectionSpan("aa\nbb\ncc", 1, 7, 0)).toEqual([1, 2]);
    expect(inputSelectionSpan("aa\nbb\ncc", 1, 7, 1)).toEqual([0, 2]);
    expect(inputSelectionSpan("aa\nbb\ncc", 1, 7, 2)).toEqual([0, 1]);
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

import { describe, expect, test } from "bun:test";
import { inputView } from "../src/input-view.ts";

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

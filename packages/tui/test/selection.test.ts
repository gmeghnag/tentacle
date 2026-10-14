import { describe, expect, test } from "bun:test";
import {
  type Selection,
  extractSelection,
  isNonEmpty,
  orderPoints,
  rowSelectionRange,
} from "../src/selection.ts";

const rows = ["hello world", "second line", "third row here"];

describe("orderPoints", () => {
  test("orders by row then column", () => {
    expect(orderPoints({ row: 2, col: 1 }, { row: 0, col: 9 }).start).toEqual({ row: 0, col: 9 });
    expect(orderPoints({ row: 1, col: 8 }, { row: 1, col: 2 }).start).toEqual({ row: 1, col: 2 });
  });
});

describe("extractSelection", () => {
  test("single row substring", () => {
    const sel: Selection = { anchor: { row: 0, col: 0 }, head: { row: 0, col: 5 } };
    expect(extractSelection(rows, sel)).toBe("hello");
  });

  test("reversed anchor/head yields the same text", () => {
    const sel: Selection = { anchor: { row: 0, col: 5 }, head: { row: 0, col: 0 } };
    expect(extractSelection(rows, sel)).toBe("hello");
  });

  test("multi-row join keeps first tail, middle whole, last head", () => {
    const sel: Selection = { anchor: { row: 0, col: 6 }, head: { row: 2, col: 5 } };
    expect(extractSelection(rows, sel)).toBe("world\nsecond line\nthird");
  });
});

describe("rowSelectionRange", () => {
  const sel: Selection = { anchor: { row: 0, col: 6 }, head: { row: 2, col: 5 } };
  test("first row selects from the anchor to end", () => {
    expect(rowSelectionRange(sel, 0, (rows[0] ?? "").length)).toEqual([6, 11]);
  });
  test("middle row selects the whole row", () => {
    expect(rowSelectionRange(sel, 1, (rows[1] ?? "").length)).toEqual([0, 11]);
  });
  test("last row selects up to the head", () => {
    expect(rowSelectionRange(sel, 2, (rows[2] ?? "").length)).toEqual([0, 5]);
  });
  test("rows outside the span are not selected", () => {
    expect(rowSelectionRange(sel, 3, 10)).toBeNull();
  });
});

describe("isNonEmpty", () => {
  test("false for a zero-width selection (a click)", () => {
    expect(isNonEmpty({ anchor: { row: 1, col: 3 }, head: { row: 1, col: 3 } })).toBe(false);
  });
  test("true once it spans a character", () => {
    expect(isNonEmpty({ anchor: { row: 1, col: 3 }, head: { row: 1, col: 4 } })).toBe(true);
  });
});

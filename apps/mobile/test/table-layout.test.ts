/**
 * Slice-6 visual review V4: a transcript table's columns share the full width,
 * and a numeric column is right-aligned (its digits line up).
 */
import { describe, expect, test } from "bun:test";
import { columnAlign } from "../src/table-layout.ts";

describe("columnAlign", () => {
  test("a column whose body cells are all numbers is right-aligned", () => {
    const table = {
      header: ["File", "Lines", "Δ"],
      rows: [
        ["a.ts", "1,204", "+12"],
        ["b.ts", "88", "-3.5%"],
      ],
    };
    expect(columnAlign(table)).toEqual(["left", "right", "right"]);
  });

  test("one word in a column keeps it left; an empty cell does not count", () => {
    const table = {
      header: ["Name", "Size", "Note"],
      rows: [
        ["x", "12 KB", ""],
        ["y", "", "—"],
      ],
    };
    expect(columnAlign(table)).toEqual(["left", "left", "left"]);
    expect(columnAlign({ header: ["n"], rows: [["1"], [""]] })).toEqual(["right"]);
  });

  test("a header-only table, or an all-empty column, is left", () => {
    expect(columnAlign({ header: ["a", "b"], rows: [] })).toEqual(["left", "left"]);
    expect(columnAlign({ header: ["a"], rows: [[""]] })).toEqual(["left"]);
  });
});

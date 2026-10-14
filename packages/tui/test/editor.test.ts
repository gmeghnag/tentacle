import { describe, expect, test } from "bun:test";
import { EMPTY_EDITOR, deleteBack, insert, moveCursor, setValue } from "../src/editor.ts";

describe("editor", () => {
  test("insert at the cursor advances past the inserted text", () => {
    const s = insert({ value: "ac", cursor: 1 }, "b");
    expect(s).toEqual({ value: "abc", cursor: 2 });
  });

  test("insert handles multi-char (paste) and multi-line text", () => {
    const s = insert(EMPTY_EDITOR, "line1\nline2");
    expect(s).toEqual({ value: "line1\nline2", cursor: 11 });
  });

  test("deleteBack removes the char before the cursor; no-op at the start", () => {
    expect(deleteBack({ value: "abc", cursor: 2 })).toEqual({ value: "ac", cursor: 1 });
    expect(deleteBack({ value: "abc", cursor: 0 })).toEqual({ value: "abc", cursor: 0 });
  });

  test("moveCursor clamps to the value bounds", () => {
    expect(moveCursor({ value: "abc", cursor: 1 }, 1).cursor).toBe(2);
    expect(moveCursor({ value: "abc", cursor: 0 }, -5).cursor).toBe(0);
    expect(moveCursor({ value: "abc", cursor: 3 }, 9).cursor).toBe(3);
  });

  test("setValue defaults the cursor to the end and clamps an explicit one", () => {
    expect(setValue("hello")).toEqual({ value: "hello", cursor: 5 });
    expect(setValue("hello", 2)).toEqual({ value: "hello", cursor: 2 });
    expect(setValue("hi", 99)).toEqual({ value: "hi", cursor: 2 });
  });

  test("operations never mutate the input state", () => {
    const original = { value: "abc", cursor: 1 };
    insert(original, "x");
    deleteBack(original);
    moveCursor(original, 1);
    expect(original).toEqual({ value: "abc", cursor: 1 });
  });
});

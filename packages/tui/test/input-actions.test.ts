import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { type InputAction, resolveLineInput } from "../src/input-actions.ts";

// A Key with every flag off; override the ones a case needs.
const key = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...over,
});

const resolve = (char: string, k: Partial<Key>, value = "", cursor = 0): InputAction =>
  resolveLineInput(char, key(k), { value, cursor });

describe("resolveLineInput", () => {
  describe("Up/Down: vertical move vs history at the edge", () => {
    test("Up on the only line → history (older)", () => {
      expect(resolve("", { upArrow: true }, "hello", 2)).toEqual({ kind: "history", dir: -1 });
    });
    test("Up when not on the first line → moveVertical, no history", () => {
      // "a\nb", cursor on the second line.
      expect(resolve("", { upArrow: true }, "a\nb", 3)).toEqual({
        kind: "moveVertical",
        dir: -1,
        extend: false,
      });
    });
    test("Shift+Up never recalls history — it extends the selection", () => {
      expect(resolve("", { upArrow: true, shift: true }, "hello", 2)).toEqual({
        kind: "moveVertical",
        dir: -1,
        extend: true,
      });
    });
    test("Down on the last line → history (newer)", () => {
      expect(resolve("", { downArrow: true }, "a\nb", 0)).toEqual({
        kind: "moveVertical",
        dir: 1,
        extend: false,
      });
      // On the actual last line it falls back to history.
      expect(resolve("", { downArrow: true }, "hello", 2)).toEqual({ kind: "history", dir: 1 });
    });
    test("Shift+Down extends the selection down", () => {
      expect(resolve("", { downArrow: true, shift: true }, "hello", 2)).toEqual({
        kind: "moveVertical",
        dir: 1,
        extend: true,
      });
    });
  });

  test("PageUp / PageDown scroll the transcript", () => {
    expect(resolve("", { pageUp: true })).toEqual({ kind: "scroll", dir: "pageUp" });
    expect(resolve("", { pageDown: true })).toEqual({ kind: "scroll", dir: "pageDown" });
  });

  test("Ctrl+V requests a clipboard paste", () => {
    expect(resolve("v", { ctrl: true })).toEqual({ kind: "pasteClipboard" });
  });

  describe("Enter: newline on a trailing backslash, else submit", () => {
    test("a `\\` immediately before the cursor → newline", () => {
      expect(resolve("", { return: true }, "foo\\", 4)).toEqual({ kind: "newline" });
    });
    test("otherwise → submit", () => {
      expect(resolve("", { return: true }, "foo", 3)).toEqual({ kind: "submit" });
    });
    test("a `\\` not adjacent to the cursor still submits", () => {
      expect(resolve("", { return: true }, "a\\b", 3)).toEqual({ kind: "submit" });
    });
  });

  describe("word jump", () => {
    test("Ctrl+Left / Ctrl+Right", () => {
      expect(resolve("", { ctrl: true, leftArrow: true })).toEqual({
        kind: "moveWord",
        dir: -1,
        extend: false,
      });
      expect(resolve("", { ctrl: true, rightArrow: true })).toEqual({
        kind: "moveWord",
        dir: 1,
        extend: false,
      });
    });
    test("Alt/Option (meta) + arrows, and the ESC b / ESC f fallback", () => {
      expect(resolve("", { meta: true, leftArrow: true })).toMatchObject({
        kind: "moveWord",
        dir: -1,
      });
      expect(resolve("b", { meta: true })).toEqual({ kind: "moveWord", dir: -1, extend: false });
      expect(resolve("f", { meta: true })).toEqual({ kind: "moveWord", dir: 1, extend: false });
    });
    test("Shift carries through to extend the selection by word", () => {
      expect(resolve("", { ctrl: true, rightArrow: true, shift: true })).toEqual({
        kind: "moveWord",
        dir: 1,
        extend: true,
      });
    });
  });

  describe("arrows: shift selects, plain moves", () => {
    test("Shift+Left / Shift+Right extend", () => {
      expect(resolve("", { shift: true, leftArrow: true })).toEqual({
        kind: "moveCursor",
        delta: -1,
        extend: true,
      });
      expect(resolve("", { shift: true, rightArrow: true })).toEqual({
        kind: "moveCursor",
        delta: 1,
        extend: true,
      });
    });
    test("plain Left / Right move without extending", () => {
      expect(resolve("", { leftArrow: true })).toEqual({
        kind: "moveCursor",
        delta: -1,
        extend: false,
      });
      expect(resolve("", { rightArrow: true })).toEqual({
        kind: "moveCursor",
        delta: 1,
        extend: false,
      });
    });
  });

  test("Ctrl+A / Ctrl+E jump to line start / end", () => {
    expect(resolve("a", { ctrl: true })).toEqual({
      kind: "moveLine",
      edge: "start",
      extend: false,
    });
    expect(resolve("e", { ctrl: true })).toEqual({ kind: "moveLine", edge: "end", extend: false });
    expect(resolve("a", { ctrl: true, shift: true })).toEqual({
      kind: "moveLine",
      edge: "start",
      extend: true,
    });
  });

  test("Backspace / Delete delete back", () => {
    expect(resolve("", { backspace: true })).toEqual({ kind: "deleteBack" });
    expect(resolve("", { delete: true })).toEqual({ kind: "deleteBack" });
  });

  describe("insert", () => {
    test("a printable character inserts itself", () => {
      expect(resolve("x", {})).toEqual({ kind: "insert", text: "x" });
    });
    test("a lone control byte inserts nothing", () => {
      expect(resolve("\u0001", {})).toEqual({ kind: "none" });
    });
    test("a multi-char paste chunk is sanitised (CRLF→LF, markers stripped)", () => {
      expect(resolve("a\r\nb", {})).toEqual({ kind: "insert", text: "a\nb" });
    });
    test("a modified key is never inserted as text", () => {
      expect(resolve("x", { ctrl: true })).toEqual({ kind: "none" });
      expect(resolve("x", { meta: true })).toEqual({ kind: "none" });
    });
  });

  test("an unhandled key resolves to none", () => {
    expect(resolve("", { escape: true })).toEqual({ kind: "none" });
    expect(resolve("", { tab: true })).toEqual({ kind: "none" });
  });
});

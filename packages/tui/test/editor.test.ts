import { describe, expect, test } from "bun:test";
import {
  EMPTY_EDITOR,
  type EditorState,
  deleteBack,
  deleteWord,
  insert,
  moveCursor,
  moveLine,
  moveVertical,
  moveWord,
  selectionRange,
  setValue,
} from "../src/editor.ts";

// With a selection active, `anchor` is set; this builder makes the state
// explicit instead of spelling the object each time.
const sel = (value: string, anchor: number, cursor: number): EditorState => ({
  value,
  cursor,
  anchor,
});

describe("editor", () => {
  test("insert at the cursor advances past the inserted text", () => {
    const s = insert({ value: "ac", cursor: 1, anchor: null }, "b");
    expect(s).toEqual({ value: "abc", cursor: 2, anchor: null, desiredCol: null });
  });

  test("insert handles multi-char (paste) and multi-line text", () => {
    const s = insert(EMPTY_EDITOR, "line1\nline2");
    expect(s).toEqual({ value: "line1\nline2", cursor: 11, anchor: null, desiredCol: null });
  });

  test("deleteBack removes the char before the cursor; no-op at the start", () => {
    expect(deleteBack({ value: "abc", cursor: 2, anchor: null })).toEqual({
      value: "ac",
      cursor: 1,
      anchor: null,
      desiredCol: null,
    });
    // At the start the state is returned as-is (the input has no desiredCol key).
    expect(deleteBack({ value: "abc", cursor: 0, anchor: null })).toEqual({
      value: "abc",
      cursor: 0,
      anchor: null,
    });
  });

  test("moveCursor clamps to the value bounds", () => {
    expect(moveCursor({ value: "abc", cursor: 1, anchor: null }, 1).cursor).toBe(2);
    expect(moveCursor({ value: "abc", cursor: 0, anchor: null }, -5).cursor).toBe(0);
    expect(moveCursor({ value: "abc", cursor: 3, anchor: null }, 9).cursor).toBe(3);
  });

  test("setValue defaults the cursor to the end and clamps an explicit one", () => {
    expect(setValue("hello")).toEqual({
      value: "hello",
      cursor: 5,
      anchor: null,
      desiredCol: null,
    });
    expect(setValue("hello", 2)).toEqual({
      value: "hello",
      cursor: 2,
      anchor: null,
      desiredCol: null,
    });
    expect(setValue("hi", 99)).toEqual({ value: "hi", cursor: 2, anchor: null, desiredCol: null });
  });

  test("operations never mutate the input state", () => {
    const original = { value: "abc", cursor: 1, anchor: null };
    insert(original, "x");
    deleteBack(original);
    moveCursor(original, 1);
    moveWord(original, 1);
    moveLine(original, "start");
    moveVertical(original, -1);
    expect(original).toEqual({ value: "abc", cursor: 1, anchor: null });
  });
});

describe("selection", () => {
  test("selectionRange is null without an anchor or when collapsed", () => {
    expect(selectionRange({ value: "abc", cursor: 2, anchor: null })).toBeNull();
    expect(selectionRange({ value: "abc", cursor: 2, anchor: 2 })).toBeNull();
  });

  test("selectionRange returns [min, max) in reading order regardless of drag direction", () => {
    expect(selectionRange({ value: "abcdef", cursor: 5, anchor: 2 })).toEqual([2, 5]);
    expect(selectionRange({ value: "abcdef", cursor: 2, anchor: 5 })).toEqual([2, 5]);
  });

  test("shift-move (extend) starts the selection from the cursor", () => {
    let s = moveCursor({ value: "abc", cursor: 1, anchor: null }, 1, true);
    expect(s).toMatchObject({ cursor: 2, anchor: 1 });
    s = moveCursor(s, 1, true);
    expect(s).toMatchObject({ cursor: 3, anchor: 1 });
    expect(selectionRange(s)).toEqual([1, 3]);
  });

  test("extend can drag backwards (anchor stays where it was set)", () => {
    let s = moveCursor({ value: "abc", cursor: 1, anchor: null }, 1, true); // anchor 1, cursor 2
    s = moveCursor(s, -2, true); // drag back past the anchor to the buffer start
    expect(s).toMatchObject({ cursor: 0, anchor: 1 });
    expect(selectionRange(s)).toEqual([0, 1]);
  });

  test("a plain move collapses the selection at the travelled edge", () => {
    // Selection [1,3); moving right → collapse to the max edge.
    let s = moveCursor(sel("abcdef", 1, 3), 1);
    expect(s).toMatchObject({ cursor: 3, anchor: null });
    expect(selectionRange(s)).toBeNull();
    // Selection [1,3); moving left → collapse to the min edge.
    s = moveCursor(sel("abcdef", 1, 3), -1);
    expect(s).toMatchObject({ cursor: 1, anchor: null });
    expect(selectionRange(s)).toBeNull();
  });

  test("deleteBack deletes the whole selection, cursor at its start", () => {
    let s = deleteBack(sel("abcdef", 1, 3));
    expect(s).toEqual({ value: "adef", cursor: 1, anchor: null, desiredCol: null });
    // Reverse-dragged selection (cursor < anchor) deletes the same range.
    s = deleteBack(sel("abcdef", 3, 1));
    expect(s).toEqual({ value: "adef", cursor: 1, anchor: null, desiredCol: null });
  });

  test("insert replaces the selection, cursor after the inserted text", () => {
    const s = insert(sel("abcdef", 1, 3), "XY");
    expect(s).toEqual({ value: "aXYdef", cursor: 3, anchor: null, desiredCol: null });
  });

  test("insert/deleteBack on a collapsed anchor behave as before", () => {
    expect(deleteBack(sel("abc", 2, 2))).toEqual({
      value: "ac",
      cursor: 1,
      anchor: null,
      desiredCol: null,
    });
    expect(insert(sel("ac", 1, 1), "b")).toEqual({
      value: "abc",
      cursor: 2,
      anchor: null,
      desiredCol: null,
    });
  });

  test("word/line/vertical moves with an active selection collapse it at the edge", () => {
    let s = moveWord(sel("one two", 0, 3), 1); // selection [0,3) "one" → collapse right → 3
    expect(s).toMatchObject({ cursor: 3, anchor: null });
    s = moveWord(sel("one two", 0, 3), 1, true); // extend instead: keep anchor, jump to next boundary
    expect(s).toMatchObject({ cursor: 7, anchor: 0 });
    s = moveLine(sel("ab\ncd", 0, 4), "start"); // collapse at the min edge
    expect(s).toMatchObject({ cursor: 0, anchor: null });
    s = moveVertical(sel("ab\ncd", 0, 4), -1); // collapse at the min edge
    expect(s).toMatchObject({ cursor: 0, anchor: null });
  });

  test("setValue clears any active selection", () => {
    const s = setValue("hi", 1);
    expect(s.anchor).toBeNull();
  });
});

describe("moveWord", () => {
  test("forwards: past a word to its end, then across a gap to the next word's end", () => {
    let s = moveWord({ value: "hello world", cursor: 0, anchor: null }, 1);
    expect(s.cursor).toBe(5); // "hello" → end of the word
    s = moveWord(s, 1);
    expect(s.cursor).toBe(11); // space + "world"
    s = moveWord(s, 1);
    expect(s.cursor).toBe(11); // already at the end: no-op
  });

  test("backwards: from inside a word to its start, then past a gap to the previous word's start", () => {
    let s = moveWord({ value: "hello world", cursor: 11, anchor: null }, -1);
    expect(s.cursor).toBe(6); // "world" → its start
    s = moveWord(s, -1);
    expect(s.cursor).toBe(0); // space + "hello"
    s = moveWord(s, -1);
    expect(s.cursor).toBe(0); // already at the start: no-op
  });

  test("punctuation is not a word char: it is skipped with the surrounding gap", () => {
    // "foo,bar": from 0 forward lands at the end of "foo" (3).
    let s = moveWord({ value: "foo,bar", cursor: 0, anchor: null }, 1);
    expect(s.cursor).toBe(3);
    // From there forward: skip "," then "bar" → 7.
    s = moveWord(s, 1);
    expect(s.cursor).toBe(7);
    // Backwards from 7: to the start of "bar" (4); again: skip "," and "foo" → 0.
    s = moveWord({ value: "foo,bar", cursor: 7, anchor: null }, -1);
    expect(s.cursor).toBe(4);
    s = moveWord(s, -1);
    expect(s.cursor).toBe(0);
  });

  test("underscores and digits are word chars (readline-style)", () => {
    let s = moveWord({ value: "a_1 b", cursor: 0, anchor: null }, 1);
    expect(s.cursor).toBe(3);
    s = moveWord({ value: "a_1 b", cursor: 4, anchor: null }, -1);
    expect(s.cursor).toBe(0);
  });

  test("unicode word chars are handled", () => {
    const s = moveWord({ value: "ciao mondo", cursor: 0, anchor: null }, 1);
    expect(s.cursor).toBe(4);
    const back = moveWord({ value: "ciao mondo", cursor: 10, anchor: null }, -1);
    expect(back.cursor).toBe(5);
  });

  test("multi-newline values: newlines are non-word, jumps never land past a line end", () => {
    // "ab\n\ncd": forward from 0 → 2 (end of "ab"); then the two newlines are
    // a gap and "cd" a word → 6 in one jump.
    let s = moveWord({ value: "ab\n\ncd", cursor: 0, anchor: null }, 1);
    expect(s.cursor).toBe(2);
    s = moveWord(s, 1);
    expect(s.cursor).toBe(6);
    // Backwards mirrors: 6 → 4 (start of "cd") → 0 (across the blank line).
    s = moveWord({ value: "ab\n\ncd", cursor: 6, anchor: null }, -1);
    expect(s.cursor).toBe(4);
    s = moveWord(s, -1);
    expect(s.cursor).toBe(0);
  });

  test("cursor inside a word jumps to the boundary, not a full word past it", () => {
    const s = moveWord({ value: "hello world", cursor: 3, anchor: null }, 1);
    expect(s.cursor).toBe(5);
  });
});

describe("deleteWord", () => {
  const at = (value: string, cursor: number): EditorState => ({ value, cursor, anchor: null });

  test("backward deletes the word before the cursor", () => {
    expect(deleteWord(at("hello world", 11), -1)).toEqual({
      value: "hello ",
      cursor: 6,
      anchor: null,
      desiredCol: null,
    });
  });

  test("backward skips the gap, then the word (same boundary as moveWord)", () => {
    const s = deleteWord(at("hello   world  ", 15), -1);
    expect(s.value).toBe("hello   ");
    expect(s.cursor).toBe(8);
    expect(s.cursor).toBe(moveWord(at("hello   world  ", 15), -1).cursor);
  });

  test("backward from inside a word deletes up to the word start only", () => {
    expect(deleteWord(at("hello world", 8), -1)).toMatchObject({ value: "hello rld", cursor: 6 });
  });

  test("punctuation is gap: backward over `foo,bar` at the end takes only `bar`", () => {
    expect(deleteWord(at("foo,bar", 7), -1)).toMatchObject({ value: "foo,", cursor: 4 });
    expect(deleteWord(at("foo,", 4), -1)).toMatchObject({ value: "", cursor: 0 });
  });

  test("at the start of the buffer it is a no-op", () => {
    const s = at("hello", 0);
    expect(deleteWord(s, -1)).toEqual(s);
  });

  test("backward crosses a newline like moveWord does", () => {
    // "ab\ncd" cursor at the start of "cd": the gap is the `\n`, then "ab".
    expect(deleteWord(at("ab\ncd", 3), -1)).toMatchObject({ value: "cd", cursor: 0 });
    expect(deleteWord(at("ab\n\ncd", 6), -1)).toMatchObject({ value: "ab\n\n", cursor: 4 });
  });

  test("unicode letters and digits are word characters", () => {
    expect(deleteWord(at("caffè 42ù", 9), -1)).toMatchObject({ value: "caffè ", cursor: 6 });
    expect(deleteWord(at("日本語 テスト", 7), -1)).toMatchObject({ value: "日本語 ", cursor: 4 });
  });

  test("combining marks are part of the word: NFD é, both directions, no orphan mark", () => {
    const nfd = "café"; // 5 UTF-16 units
    expect(moveWord(at(nfd, 0), 1).cursor).toBe(5);
    expect(moveWord(at(nfd, 5), -1).cursor).toBe(0);
    expect(deleteWord(at(`${nfd} bar`, 0), 1)).toMatchObject({ value: " bar", cursor: 0 });
    expect(deleteWord(at(`${nfd} bar`, 5), -1)).toMatchObject({ value: " bar", cursor: 0 });
  });

  test("a Devanagari word with vowel signs / virama is one word", () => {
    const word = "नमस्ते";
    expect(deleteWord(at(word, word.length), -1)).toMatchObject({ value: "", cursor: 0 });
    expect(deleteWord(at(`${word} x`, 0), 1)).toMatchObject({ value: " x", cursor: 0 });
    expect(moveWord(at(word, 0), 1).cursor).toBe(word.length);
  });

  test("a keycap (digit + VS16 + enclosing mark) is not split", () => {
    expect(deleteWord(at("1️⃣ z", 0), 1)).toMatchObject({ value: " z", cursor: 0 });
  });

  test("with a selection it deletes the selection, in both directions", () => {
    expect(deleteWord(sel("hello world", 2, 8), -1)).toEqual({
      value: "herld",
      cursor: 2,
      anchor: null,
      desiredCol: null,
    });
    expect(deleteWord(sel("hello world", 8, 2), 1)).toMatchObject({ value: "herld", cursor: 2 });
  });

  test("forward deletes the gap then the next word; no-op at the end", () => {
    expect(deleteWord(at("hello world", 0), 1)).toMatchObject({ value: " world", cursor: 0 });
    expect(deleteWord(at("hello world", 5), 1)).toMatchObject({ value: "hello", cursor: 5 });
    const end = at("hello", 5);
    expect(deleteWord(end, 1)).toEqual(end);
  });

  test("clears the vertical-move memory", () => {
    const s = deleteWord({ value: "ab cd", cursor: 5, anchor: null, desiredCol: 7 }, -1);
    expect(s.desiredCol).toBeNull();
  });
});

describe("moveLine", () => {
  test("start/end land on the current logical line's edges", () => {
    // "ab\ncd\nef": offsets a0 b1 \n2 c3 d4 \n5 e6 f7.
    let s = moveLine({ value: "ab\ncd\nef", cursor: 5, anchor: null }, "start"); // on "cd"
    expect(s.cursor).toBe(3);
    s = moveLine(s, "end");
    expect(s.cursor).toBe(5);
    // Line 0.
    s = moveLine({ value: "ab\ncd", cursor: 1, anchor: null }, "end");
    expect(s.cursor).toBe(2);
    // Last line, no trailing newline.
    s = moveLine({ value: "ab\ncd", cursor: 4, anchor: null }, "start");
    expect(s.cursor).toBe(3);
  });

  test("extend selects from the cursor to the line edge", () => {
    let s = moveLine({ value: "abcd\nef", cursor: 2, anchor: null }, "end", true);
    expect(s).toMatchObject({ cursor: 4, anchor: 2 });
    expect(selectionRange(s)).toEqual([2, 4]);
    s = moveLine({ value: "abcd\nef", cursor: 3, anchor: null }, "start", true);
    expect(s).toMatchObject({ cursor: 0, anchor: 3 });
    expect(selectionRange(s)).toEqual([0, 3]);
  });
});

describe("moveVertical", () => {
  // "abcd\nef": a0 b1 c2 d3 \n4 e5 f6.
  test("up: one logical line up, column preserved", () => {
    const s = moveVertical({ value: "abcd\nef", cursor: 5, anchor: null }, -1);
    expect(s.cursor).toBe(0); // col 0 of "abcd"
  });

  test("up clamps the column when the line above is shorter", () => {
    // "ab\ncdef": a0 b1 \n2 c3 d4 e5 f6. Cursor 6 = line 1, col 3.
    const s = moveVertical({ value: "ab\ncdef", cursor: 6, anchor: null }, -1);
    expect(s.cursor).toBe(2); // col 3 clamped to the end of "ab"
  });

  test("down: one logical line down, column preserved / clamped", () => {
    let s = moveVertical({ value: "abcd\nef", cursor: 3, anchor: null }, 1);
    expect(s.cursor).toBe(7); // col 3 clamped to the end of "ef"
    s = moveVertical({ value: "abcd\nef", cursor: 1, anchor: null }, 1);
    expect(s.cursor).toBe(6);
  });

  test("at the first line, up is a no-op; at the last line, down is a no-op", () => {
    expect(moveVertical({ value: "a\nb", cursor: 0, anchor: null }, -1).cursor).toBe(0);
    expect(moveVertical({ value: "a\nb", cursor: 2, anchor: null }, 1).cursor).toBe(2);
  });

  test("desiredCol persists across short lines (long → short → long)", () => {
    // "abcde\nx\nfgh": a0..e4 \n5 x6 \n7 f8 g9 h10.
    let s = moveVertical({ value: "abcde\nx\nfgh", cursor: 9, anchor: null }, -1);
    expect(s.cursor).toBe(7); // "x": desired col 1 clamps to the end of the line
    s = moveVertical(s, -1);
    expect(s.cursor).toBe(1); // back to the original column on "abcde"
  });

  test("the remembered column is the requested one, not the clamped one", () => {
    // "abcd\ne\nfgh": a0..d3 \n4 e5 \n6 f7 g8 h9. Cursor at line 2, col 2 (offset 9).
    let s = moveVertical({ value: "abcd\ne\nfgh", cursor: 9, anchor: null }, -1);
    expect(s.cursor).toBe(6); // "e": desired col 2 clamps to its end (col 1)
    s = moveVertical(s, -1);
    expect(s.cursor).toBe(2); // "abcd": col 2 fits — the requested col, not the clamped 1
  });

  test("extend selects from the cursor to the target position", () => {
    const s = moveVertical({ value: "abcd\nef", cursor: 5, anchor: null }, -1, true);
    expect(s).toMatchObject({ cursor: 0, anchor: 5 });
    expect(selectionRange(s)).toEqual([0, 5]);
  });

  test("shift at the buffer edge extends to the boundary (0 / end)", () => {
    // "ab\ncd": a0 b1 \n2 c3 d4. First line, shift+up → position 0.
    let s = moveVertical({ value: "ab\ncd", cursor: 1, anchor: null }, -1, true);
    expect(s).toMatchObject({ cursor: 0, anchor: 1 });
    // Last line, shift+down → end of buffer (past the last char).
    s = moveVertical({ value: "ab\ncd", cursor: 4, anchor: null }, 1, true);
    expect(s).toMatchObject({ cursor: 5, anchor: 4 });
    expect(selectionRange(s)).toEqual([4, 5]);
  });

  test("a plain vertical move with no selection does not set an anchor", () => {
    const s = moveVertical({ value: "abcd\nef", cursor: 5, anchor: null }, -1);
    expect(s.anchor).toBeNull();
    expect(selectionRange(s)).toBeNull();
  });
});

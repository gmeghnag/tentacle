/**
 * The ask card's command box (docs/fix/mobile-ask-surfaces.md D3, S4).
 */
import { describe, expect, test } from "bun:test";
import { commandPreview } from "../src/command-preview.ts";

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("commandPreview", () => {
  test("3 lines: nothing hidden, no footer", () => {
    const p = commandPreview(lines(3), { cols: 40 });
    expect(p.shown).toEqual(["line 0", "line 1", "line 2"]);
    expect(p.more).toBe(0);
    expect(p.expandedCut).toBe(0);
  });

  test("23 lines: 4 shown + 19 more", () => {
    const p = commandPreview(lines(23), { cols: 40 });
    expect(p.shown).toHaveLength(4);
    expect(p.more).toBe(19);
    expect(p.expandedRows).toHaveLength(23);
  });

  test("one 50 KB line wraps; collapsed stays 4 rows of `cols`", () => {
    const p = commandPreview("x".repeat(50_000), { cols: 40 });
    expect(p.shown).toHaveLength(4);
    expect(p.shown.every((r) => r.length === 40)).toBe(true);
    expect(p.more).toBe(1250 - 4);
    expect(p.expandedRows).toHaveLength(400);
    expect(p.expandedCut).toBe(1250 - 400);
  });

  test("5000 lines expanded: 400 rows and the cut count", () => {
    const p = commandPreview(lines(5000), { cols: 80 });
    expect(p.expandedRows).toHaveLength(400);
    expect(p.expandedCut).toBe(4600);
    expect(p.more).toBe(4996);
  });

  test("ANSI, control characters and tabs are cleaned", () => {
    const p = commandPreview("\u001b[31mred\u001b[0m\u0007\tx\r\nnext\n\n", { cols: 40 });
    expect(p.shown).toEqual(["red  x", "next"]);
  });

  test("cols < 1 is clamped, an empty text has no rows beyond one blank", () => {
    expect(commandPreview("abc", { cols: 0 }).shown).toEqual(["a", "b", "c"]);
    expect(commandPreview("", { cols: 10 })).toMatchObject({ shown: [""], more: 0 });
  });

  test("a blank line inside the text is kept as a row", () => {
    expect(commandPreview("a\n\nb", { cols: 10 }).shown).toEqual(["a", "", "b"]);
  });
});

/**
 * S2 (feat/harness-notices): harness lines group into ONE block — a glyph at the
 * head, no blank row between them, and the glyph only where the level changes.
 *
 * The decisions live here, React-free and pure: `transcriptLines` (logical rows)
 * and `layoutTranscript` (the wrapped, scrollable layout) BOTH ask this module,
 * because the two must agree — the scroll/selection maths reads the second while
 * the rows come from the first, and a disagreement is an off-by-N-row bug
 * (AGENTS §6).
 *
 * RED before the fix: this module did not exist; `transcriptLines` put a blank
 * row before EVERY item and `noticeLines` drew `●` on every notice.
 */
import { describe, expect, test } from "bun:test";
import { isHarness, showsGlyph } from "../src/harness-group.ts";
import type { DisplayItem } from "../src/state.ts";

const info = (text: string): DisplayItem => ({ kind: "notice", text });
const warn = (text: string): DisplayItem => ({ kind: "notice", text, level: "warn" });
const rule = (text: string): DisplayItem => ({ kind: "notice", text, separator: true });
const reply = (text: string): DisplayItem => ({ kind: "assistant", text });

/** What the plan's table pins: a glyph or a two-space hang, per item. */
function glyphs(items: readonly DisplayItem[]): string[] {
  return items.map((item, i) => {
    if (!isHarness(item)) {
      return "n/a";
    }
    return showsGlyph(items[i - 1], item) ? "glyph" : "-";
  });
}

describe("isHarness", () => {
  test("every non-separator notice is a harness line; nothing else is", () => {
    expect(isHarness(info("a"))).toBe(true);
    expect(isHarness(warn("a"))).toBe(true);
    expect(isHarness(rule("a"))).toBe(false);
    expect(isHarness(reply("a"))).toBe(false);
    expect(isHarness({ kind: "assistant", text: "a", notice: true })).toBe(false);
    expect(isHarness(undefined)).toBe(false);
  });
});

describe("showsGlyph: a glyph at the head, and only where the level changes", () => {
  test("the plan's table: [info, info, warn, info, separator, info]", () => {
    const items = [info("a"), info("b"), warn("c"), info("d"), rule("x"), info("e")];
    // Mutation: compare `item.level` only against a remembered "first" level →
    // `d` loses its ◇ (its neighbour is a ▲), and only 5 entries would differ.
    expect(glyphs(items)).toEqual(["glyph", "-", "glyph", "glyph", "n/a", "glyph"]);
  });

  test("a warn after a warn hangs too; two warns running keep one ▲", () => {
    expect(glyphs([warn("a"), warn("b")])).toEqual(["glyph", "-"]);
  });

  test("a non-harness item between two notices restarts the glyph", () => {
    expect(glyphs([info("a"), reply("r"), info("b")])).toEqual(["glyph", "n/a", "glyph"]);
  });

  test("the first harness item after anything still shows its glyph", () => {
    expect(glyphs([reply("r"), info("a")])).toEqual(["n/a", "glyph"]);
    expect(glyphs([info("a")])).toEqual(["glyph"]);
  });
});

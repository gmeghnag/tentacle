/**
 * The phone's harness-line grouping (docs/feat/mobile-harness-notices.md S1):
 * `◇`/`▲` glyphs, consecutive lines as ONE block, a glyph re-opened only where
 * the level changes — the TUI's rule (`packages/tui/src/harness-group.ts`) over
 * the mobile `Row`. Pure, so it is tested here and the component only draws it.
 */
import { describe, expect, test } from "bun:test";
import {
  NOTICE_GLYPHS,
  harnessLevel,
  isHarness,
  joinsPrevious,
  noticeLooks,
  showsGlyph,
} from "../src/notice-group.ts";
import type { Row } from "../src/transcript-rows.ts";

const info = (key: string): Row => ({ kind: "notice", key, text: "an info line" });
const warn = (key: string): Row => ({ kind: "notice", key, text: "a warning", level: "warn" });
const separator = (key: string): Row => ({
  kind: "notice",
  key,
  text: "compacted · ctx 1k → ~1k",
  separator: true,
});

/** The looks as `[glyph, joined]` pairs, in row order (only the ones drawn). */
function looksOf(rows: readonly Row[], cells?: ReadonlyMap<string, { kind: string }>) {
  const looks = noticeLooks(rows, cells);
  return rows.flatMap((row) => {
    const look = looks.get(row.key);
    return look === undefined ? [] : [[look.glyph, look.joined] as const];
  });
}

describe("a harness line is a notice that is not a separator rule", () => {
  test("info, warn and a continuation are harness lines; a separator is not", () => {
    expect(isHarness(info("a"))).toBe(true);
    expect(isHarness(warn("a"))).toBe(true);
    expect(isHarness(separator("a"))).toBe(false);
    expect(isHarness(undefined)).toBe(false);
    expect(isHarness({ kind: "user", key: "u", text: "hi", images: [] } as Row)).toBe(false);
  });

  test("a level is warn only when it says so", () => {
    expect(harnessLevel(warn("a"))).toBe("warn");
    expect(harnessLevel(info("a"))).toBe("info");
    expect(harnessLevel(separator("a"))).toBe("info");
  });
});

describe("grouping: the S1 acceptance sequence", () => {
  // The plan's own case: `◇ ◇ ▲ ◇` → glyphs `◇ null ▲ ◇`, all but the first joined.
  test("`◇ ◇ ▲ ◇` → one block, two glyphs, three joined", () => {
    expect(looksOf([info("a"), info("b"), warn("c"), info("d")])).toEqual([
      [NOTICE_GLYPHS.info, false],
      [null, true],
      [NOTICE_GLYPHS.warn, true],
      [NOTICE_GLYPHS.info, true],
    ]);
  });

  test("`showsGlyph` re-opens on a level CHANGE, not at the block's first level", () => {
    const rows = [info("a"), info("b"), warn("c"), info("d")];
    expect(showsGlyph(undefined, rows[0] as Row)).toBe(true);
    expect(showsGlyph(rows[0], rows[1] as Row)).toBe(false);
    expect(showsGlyph(rows[1], rows[2] as Row)).toBe(true);
    // Back to info: a NEW `◇`, because the predecessor is a warn.
    expect(showsGlyph(rows[2], rows[3] as Row)).toBe(true);
  });

  test("a separator breaks a block: the line after it opens with its glyph, unjoined", () => {
    expect(looksOf([info("a"), separator("sep"), info("b")])).toEqual([
      [NOTICE_GLYPHS.info, false],
      [NOTICE_GLYPHS.info, false],
    ]);
    expect(joinsPrevious(separator("sep"), info("b"))).toBe(false);
  });

  test("a non-notice row breaks a block", () => {
    const user: Row = { kind: "user", key: "u", text: "a question", images: [] };
    expect(looksOf([info("a"), user, info("b")])).toEqual([
      [NOTICE_GLYPHS.info, false],
      [NOTICE_GLYPHS.info, false],
    ]);
    expect(joinsPrevious(user, info("b"))).toBe(false);
  });
});

describe("grouping over the VISIBLE rows (Owner Q5)", () => {
  /** What `stepLayout` puts in `cells` for a row it folds away. */
  const hidden = (keys: readonly string[]) => new Map(keys.map((key) => [key, { kind: "hidden" }]));

  // The bug this rule exists for: a reasoning row folded into a step is not
  // drawn, so the two notices either side of it ARE neighbours on screen. With
  // the raw array as "previous", the glyph re-opens mid-block for no reason.
  test("a hidden cell is transparent: `◇ [hidden] ◇` stays ONE block", () => {
    const reasoning: Row = { kind: "reasoning", key: "think", text: "hmm", version: 4 };
    const rows = [info("a"), reasoning, info("b")];
    expect(looksOf(rows, hidden(["think"]))).toEqual([
      [NOTICE_GLYPHS.info, false],
      [null, true],
    ]);
  });

  test("a hidden cell is not given a look at all (it draws nothing)", () => {
    const reasoning: Row = { kind: "reasoning", key: "think", text: "hmm", version: 4 };
    const looks = noticeLooks([reasoning, info("a")], hidden(["think"]));
    expect(looks.has("think")).toBe(false);
    expect(looks.get("a")).toEqual({ glyph: NOTICE_GLYPHS.info, joined: false });
  });

  test("a VISIBLE tool cell still breaks the block", () => {
    const tool: Row = {
      kind: "tool",
      key: "t",
      id: "c1",
      name: "fs_read",
      label: "Read",
      args: "{}",
      status: "ok",
    };
    expect(looksOf([info("a"), tool, info("b")], new Map([["t", { kind: "step" }]]))).toEqual([
      [NOTICE_GLYPHS.info, false],
      [NOTICE_GLYPHS.info, false],
    ]);
  });
});

test("no look for any row that is not a harness line", () => {
  const rows: readonly Row[] = [
    { kind: "user", key: "u", text: "q", images: [] },
    separator("s"),
    info("n"),
  ];
  expect([...noticeLooks(rows).keys()]).toEqual(["n"]);
});

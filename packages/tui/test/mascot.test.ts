import { describe, expect, test } from "bun:test";
/**
 * Polpetto, the startup header's mascot (docs/feat/tui-mascot.md): the bitmap,
 * the nine palettes, the half-block projection and the whole show/hide
 * decision. Pure — no Ink, no React (AGENTS §7 "logic in pure modules").
 */
import { Chalk } from "chalk";
import { cellWidth } from "../src/cells.ts";
import {
  MASCOT_BITMAP,
  MASCOT_ENABLED,
  MASCOT_PALETTES,
  type MascotCell,
  PALETTE_NAMES,
  headerView,
  mascotCells,
  pickPalette,
} from "../src/mascot.ts";

const chars = (row: readonly MascotCell[]): string => row.map((c) => c.glyph).join("");

describe("MASCOT_BITMAP", () => {
  test("is the owner's 10 rows, verbatim", () => {
    expect([...MASCOT_BITMAP]).toEqual([
      "..KKKKK..",
      ".KSFFFSK.",
      "KSFFFFFSK",
      "KFEFFFEFK",
      "KFEFFFEFK",
      "KBBFSFBBK",
      ".KFFFFFK.",
      "KSSKSKSSK",
      ".KK.K.KK.",
      ".........",
    ]);
  });
});

describe("MASCOT_PALETTES", () => {
  // Verbatim from the task doc's table: a typo in a hex is the likeliest bug.
  const TABLE: Readonly<Record<string, readonly [string, string, string, string, string]>> = {
    soft: ["#7B3FC0", "#3E1A5E", "#B387EA", "#A274DE", "#DDBFF8"],
    logo: ["#6E36AE", "#3E1A5E", "#A267DB", "#9258CF", "#CFA8F3"],
    glow: ["#C9A6F2", "#3E1A5E", "#8E4BC4", "#8143B8", "#B583E0"],
    cyan: ["#0E8AA8", "#083A47", "#5FE0F2", "#3FCFE6", "#B7F3FB"],
    teal: ["#14857A", "#0A3B36", "#5CD6C4", "#40C2AF", "#B5EEE4"],
    coral: ["#C2475A", "#5A1622", "#F58C93", "#EC7480", "#FFC6C2"],
    mint: ["#3C9A5C", "#163D24", "#8FE0A6", "#73D28E", "#CFF5D9"],
    amber: ["#B7791F", "#4A2E07", "#F7C35C", "#EEB043", "#FFE3A8"],
    sky: ["#3A6FD0", "#13285A", "#8DB4F7", "#73A0F0", "#CFE0FF"],
  };

  test("nine names, in table order", () => {
    expect([...PALETTE_NAMES]).toEqual([
      "soft",
      "logo",
      "glow",
      "cyan",
      "teal",
      "coral",
      "mint",
      "amber",
      "sky",
    ]);
  });

  test("every palette is the table's five hexes", () => {
    for (const name of PALETTE_NAMES) {
      const [K, E, F, S, B] = TABLE[name] ?? [];
      expect(`${name}:${MASCOT_PALETTES[name].K}`).toBe(`${name}:${K}`);
      expect(`${name}:${MASCOT_PALETTES[name].E}`).toBe(`${name}:${E}`);
      expect(`${name}:${MASCOT_PALETTES[name].F}`).toBe(`${name}:${F}`);
      expect(`${name}:${MASCOT_PALETTES[name].S}`).toBe(`${name}:${S}`);
      expect(`${name}:${MASCOT_PALETTES[name].B}`).toBe(`${name}:${B}`);
    }
  });
});

describe("pickPalette", () => {
  test("maps rand() into the table, clamped at the last", () => {
    expect(pickPalette(() => 0)).toBe("soft");
    expect(pickPalette(() => 0.999)).toBe("sky");
    expect(pickPalette(() => 1)).toBe("sky");
    expect(pickPalette(() => 3 / 9)).toBe("cyan");
    expect(pickPalette(() => 4 / 9)).toBe("teal");
  });
});

describe("mascotCells", () => {
  const soft = MASCOT_PALETTES.soft;

  // `at` reads a cell by coordinate: `rows` is `MascotCell[][]`, and a missing
  // one must FAIL loudly rather than be read as undefined (no `!`, AGENTS §9).
  const at = (rows: readonly MascotCell[][], y: number, x: number): MascotCell => {
    const cell = rows[y]?.[x];
    if (cell === undefined) {
      throw new Error(`no cell at ${y},${x}`);
    }
    return cell;
  };

  test("the five pixel-pair cases", () => {
    // `..` -> space; `K.` -> ▀ fg K (no bg); `.K` -> ▄ fg K; `KK` -> █ fg K;
    // `KF` -> ▀ fg K bg F — read off the real sprite's pixel-row pairs.
    const rows = mascotCells(soft);
    // row 4 = pixel rows 8 and 9: `..KK.K.KK.` above `.........`
    expect(at(rows, 4, 0)).toEqual({ glyph: " " });
    expect(at(rows, 4, 1)).toEqual({ glyph: "▀", fg: soft.K });
    // row 0 = pixel rows 0 and 1: `..KKKKK..` above `.KSFFFSK.`
    expect(at(rows, 0, 1)).toEqual({ glyph: "▄", fg: soft.K });
    expect(at(rows, 0, 2)).toEqual({ glyph: "▀", fg: soft.K, bg: soft.S });
    // row 2 = pixel rows 4 and 5: `KFEFFFEFK` above `KBBFSFBBK` — col 0 is K
    // over K (the solid case), col 1 F over B (both, different).
    expect(at(rows, 2, 0)).toEqual({ glyph: "█", fg: soft.K });
    expect(at(rows, 2, 1)).toEqual({ glyph: "▀", fg: soft.F, bg: soft.B });
  });

  test("the feet row: ▀ fg K exactly at columns 1,2,4,6,7, space elsewhere", () => {
    // row 4 = pixel rows 8/9: `.KK.K.KK.` above the empty `.........` (by hand).
    const rows = mascotCells(soft);
    for (let x = 0; x < 9; x += 1) {
      const expected: MascotCell = [1, 2, 4, 6, 7].includes(x)
        ? { glyph: "▀", fg: soft.K }
        : { glyph: " " };
      expect(at(rows, 4, x)).toEqual(expected);
    }
  });

  test("an equal pair is a solid block (█) with no background", () => {
    const rows = mascotCells(soft);
    // row 2, col 0: K over K — fg only, so chalk never emits a redundant bg.
    expect(at(rows, 2, 0)).toEqual({ glyph: "█", fg: soft.K });
  });

  test("the eye row: F over E is a half block carrying both colours", () => {
    // row 1 = pixel rows 2 and 3: `KSFFFFFSK` above `KFEFFFEFK` -> col 2 is F/E.
    const rows = mascotCells(soft);
    expect(at(rows, 1, 2)).toEqual({ glyph: "▀", fg: soft.F, bg: soft.E });
  });

  test("five rows, nine cells wide, for every palette", () => {
    for (const name of PALETTE_NAMES) {
      const rows = mascotCells(MASCOT_PALETTES[name]);
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.length).toBe(9);
        expect(cellWidth(chars(row))).toBe(9);
      }
    }
  });
});

describe("headerView", () => {
  const base = {
    version: "0.7.1",
    model: "deepseek-v4",
    cwd: "/home/me/tentacle",
    home: "/home/me",
    width: 80,
    palette: "soft" as const,
  };

  test("colour off (level 0): mascot hidden, three text lines", () => {
    const view = headerView({ ...base, colorLevel: 0 });
    expect(view.mascot).toBeNull();
    expect(view.lines.length).toBe(3);
    expect(view.lines[0]).toEqual({ strong: "tentacle", text: " 0.7.1" });
    expect(view.lines[1]?.text).toBe("deepseek-v4 · ~/tentacle");
    expect(view.lines[2]?.text).toBe("/help for commands");
  });

  test("16 colours (level 1): hidden too (the five tones collapse)", () => {
    expect(headerView({ ...base, colorLevel: 1 }).mascot).toBeNull();
  });

  test("256 colours (level 2) and truecolor (level 3): shown with the opt-in", () => {
    expect(headerView({ ...base, colorLevel: 2, mascot: true }).mascot?.length).toBe(5);
    expect(headerView({ ...base, colorLevel: 3, mascot: true }).mascot?.length).toBe(5);
  });

  test("no version: line 1 is `tentacle` alone", () => {
    const view = headerView({ ...base, version: undefined, colorLevel: 0 });
    expect(view.lines[0]).toEqual({ strong: "tentacle", text: "" });
  });

  test("text lines are the same whether the mascot shows or not", () => {
    const hidden = headerView({ ...base, colorLevel: 0 });
    const shown = headerView({ ...base, colorLevel: 3, mascot: true });
    expect(shown.lines).toEqual(hidden.lines);
  });

  test("the shipped default hides the sprite: no room or colour makes it show", () => {
    // fix/tui-mascot-hidden: the switch is off until the owner decides how the
    // sprite should render (half blocks are drawn offset in Terminal.app).
    expect(MASCOT_ENABLED).toBe(false);
    for (const colorLevel of [2, 3]) {
      const view = headerView({ ...base, colorLevel, width: 200 });
      expect(view.mascot).toBeNull();
      // …and it is exactly the text-only header: no gutter, same three lines.
      expect(view.lines).toEqual(headerView({ ...base, colorLevel: 0, width: 200 }).lines);
    }
    // An explicit `false` is the same answer as no override at all.
    expect(headerView({ ...base, colorLevel: 3, mascot: false }).mascot).toBeNull();
  });

  test("the width boundary: threshold shows, one cell less hides", () => {
    const model = base.model;
    // GUTTER = 9 + 2; MIN_PATH = 12; the widest fixed line is model + " · " + MIN_PATH.
    const threshold =
      11 +
      Math.max(
        cellWidth("tentacle 0.7.1"),
        cellWidth("/help for commands"),
        cellWidth(model) + 3 + 12,
      );
    expect(
      headerView({ ...base, width: threshold, colorLevel: 3, mascot: true }).mascot,
    ).not.toBeNull();
    expect(
      headerView({ ...base, width: threshold - 1, colorLevel: 3, mascot: true }).mascot,
    ).toBeNull();
  });

  test("a long cwd is shortened with an ellipsis, inside the budget", () => {
    const view = headerView({
      ...base,
      cwd: "/home/me/a/very/long/path/that/keeps/going/and/going/for/ever/project",
      colorLevel: 3,
      mascot: true,
    });
    const line = view.lines[1]?.text ?? "";
    expect(line.startsWith("deepseek-v4 · ")).toBe(true);
    expect(line).toContain("…");
    expect(line).toContain("project");
    expect(cellWidth(line) + 11).toBeLessThanOrEqual(base.width);
  });

  test("narrow window: text kept, mascot yields", () => {
    const view = headerView({ ...base, width: 30, colorLevel: 3 });
    expect(view.mascot).toBeNull();
    expect(view.lines[1]?.text.startsWith("deepseek-v4 · ")).toBe(true);
  });
});

describe("256-colour survival (D6)", () => {
  test("K, E and F stay distinct after chalk's ansi256 downgrade, every palette", () => {
    const chalk256 = new Chalk({ level: 2 });
    for (const name of PALETTE_NAMES) {
      const p = MASCOT_PALETTES[name];
      // The full SGR sequence, read the way theme-contrast.test.ts does.
      const codes = [p.K, p.E, p.F].map((hex) => chalk256.hex(hex)("X"));
      expect(`${name}:${new Set(codes).size}`).toBe(`${name}:3`);
    }
  });
});

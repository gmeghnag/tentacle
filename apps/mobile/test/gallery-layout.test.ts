/**
 * `gallery-layout.ts` (docs/feat/mobile-gallery-polish.md): the gallery's list ↔
 * grid decisions, the grid's cells, the tile sizes and each kind's symbol.
 */
import { describe, expect, test } from "bun:test";
import { ARTIFACT_KINDS } from "@tentacle/protocol";
import {
  DEFAULT_GALLERY_LAYOUT,
  GRID_COLUMNS,
  GRID_GAP,
  LIST_ROW_PADDING,
  LIST_TILE,
  gridCell,
  gridRows,
  kindSymbol,
  kindSymbolSize,
  layoutToggle,
  otherLayout,
} from "../src/gallery-layout.ts";

describe("the look and its toggle", () => {
  test("the list is the default (mockup 7 A, the owner's pick)", () => {
    expect(DEFAULT_GALLERY_LAYOUT).toBe("list");
  });

  test("the toggle switches between the two looks, and back", () => {
    expect(otherLayout("list")).toBe("grid");
    expect(otherLayout("grid")).toBe("list");
    expect(otherLayout(otherLayout("list"))).toBe("list");
  });

  test("the toggle shows (and names) the look a tap switches TO", () => {
    expect(layoutToggle("list")).toEqual({ icon: "square.grid.2x2", label: "Show as grid" });
    expect(layoutToggle("grid")).toEqual({ icon: "list.bullet", label: "Show as list" });
  });
});

describe("sizes", () => {
  test("the list tile is 52 pt and the row holds it with its padding", () => {
    expect(LIST_TILE).toBe(52);
    expect(LIST_TILE + 2 * LIST_ROW_PADDING).toBe(68);
  });

  test("three square cells and two gaps fill the width, in whole points", () => {
    for (const width of [375, 393, 402, 430, 440]) {
      const cell = gridCell(width);
      expect(Number.isInteger(cell)).toBe(true);
      const used = GRID_COLUMNS * cell + (GRID_COLUMNS - 1) * GRID_GAP;
      expect(used).toBeLessThanOrEqual(width);
      expect(width - used).toBeLessThan(GRID_COLUMNS);
    }
    expect(gridCell(402)).toBe(132);
  });

  test("an unmeasured width (0, NaN) gives no cell", () => {
    expect(gridCell(0)).toBe(0);
    expect(gridCell(Number.NaN)).toBe(0);
  });

  test("rows of three; the last may be short; none for no items", () => {
    expect(gridRows([1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(gridRows([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(gridRows([])).toEqual([]);
  });
});

describe("kind symbols (a tile with no drawn thumbnail)", () => {
  test("every wire kind has a symbol, and no two kinds share one (never by hue alone)", () => {
    const symbols = ARTIFACT_KINDS.map((k) => kindSymbol(k));
    expect(symbols.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    expect(new Set(symbols).size).toBe(ARTIFACT_KINDS.length);
  });

  test("a chart that cannot be drawn shows the chart symbol", () => {
    expect(kindSymbol("chart")).toBe("chart.bar.xaxis");
  });

  test("the symbol is about half its tile, bounded", () => {
    expect(kindSymbolSize(LIST_TILE)).toBe(22);
    expect(kindSymbolSize(132)).toBe(32);
    expect(kindSymbolSize(10)).toBe(18);
  });
});

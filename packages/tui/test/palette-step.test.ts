/**
 * `paletteStep` (docs/feat/app-decomposition.md S12): the palette highlight's
 * wrap, moved out of `App.tsx`'s key port. The inline arithmetic gave `NaN` for
 * an empty list (`% 0`); a layer guarded it, nothing in the function did.
 */
import { describe, expect, test } from "bun:test";
import { paletteStep } from "../src/commands.ts";

describe("paletteStep", () => {
  test("an empty list never yields NaN: the index is 0", () => {
    expect(paletteStep(0, 0, 1)).toBe(0);
    expect(paletteStep(3, 0, -1)).toBe(0);
  });

  test("moves by one inside the list", () => {
    expect(paletteStep(0, 3, 1)).toBe(1);
    expect(paletteStep(2, 3, -1)).toBe(1);
  });

  test("wraps at both ends", () => {
    expect(paletteStep(2, 3, 1)).toBe(0);
    expect(paletteStep(0, 3, -1)).toBe(2);
  });

  test("an index past a list that shrank is clamped first, then moved", () => {
    // The highlight sat on row 7 of a longer list; the list is now 3 rows.
    expect(paletteStep(7, 3, 1)).toBe(0);
    expect(paletteStep(7, 3, -1)).toBe(1);
  });

  test("a one-row list stays on its row", () => {
    expect(paletteStep(0, 1, 1)).toBe(0);
    expect(paletteStep(0, 1, -1)).toBe(0);
  });
});

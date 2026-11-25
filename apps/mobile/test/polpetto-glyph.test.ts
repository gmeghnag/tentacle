/**
 * Polpetto's silhouette mask (docs/fix/mobile-ask-surfaces.md D3, S4).
 */
import { describe, expect, test } from "bun:test";
import { MASCOT_BITMAP } from "../src/mascot-scenes.ts";
import { polpettoMask } from "../src/polpetto-glyph.ts";

describe("polpettoMask", () => {
  test("9x9, parity with MASCOT_BITMAP: filled except `.` and the eyes", () => {
    const mask = polpettoMask();
    expect(mask).toHaveLength(9);
    for (const [y, row] of mask.entries()) {
      expect(row).toHaveLength(9);
      for (const [x, cell] of row.entries()) {
        const ch = MASCOT_BITMAP[y]?.[x];
        expect(cell).toBe(ch !== "." && ch !== "E");
      }
    }
  });

  test("the eyes are holes inside a filled face", () => {
    const mask = polpettoMask();
    expect(mask[3]?.[2]).toBe(false);
    expect(mask[4]?.[6]).toBe(false);
    expect(mask[3]?.[1]).toBe(true);
    expect(mask[0]?.[0]).toBe(false);
  });
});

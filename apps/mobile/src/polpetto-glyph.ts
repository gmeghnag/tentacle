/**
 * The main agent's origin icon (docs/fix/mobile-ask-surfaces.md D3): Polpetto's
 * 9x9 silhouette as a boolean mask, drawn in one ink (a template, like an SF
 * Symbol). Filled = every cell but `.` and `E`: the eyes are holes. The bitmap's
 * empty 10th row is dropped. Pure; `PolpettoGlyph.tsx` only draws the cells.
 */
import { MASCOT_BITMAP } from "./mascot-scenes.ts";

export function polpettoMask(): readonly (readonly boolean[])[] {
  return MASCOT_BITMAP.slice(0, 9).map((row) =>
    Array.from(row.slice(0, 9), (ch) => ch !== "." && ch !== "E"),
  );
}

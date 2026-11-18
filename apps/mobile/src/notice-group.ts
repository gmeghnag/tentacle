/**
 * Harness lines on the phone: ONE quiet voice, grouped
 * (docs/feat/mobile-harness-notices.md S1) — the TUI's rule
 * (`packages/tui/src/harness-group.ts`), line for line, over the mobile `Row`.
 *
 * A "harness line" is anything the machine says about the session itself — a
 * reply cut at the output limit, a repair, an empty turn, "Can't compact…" — as
 * opposed to the model's own text. Consecutive ones are ONE block: a glyph opens
 * it (`◇` info, `▲` warn) and the rest hang under it, no blank row between; the
 * glyph re-appears only where the LEVEL changes, so `◇ ◇ ▲ ◇` shows two `◇` and
 * a warning stands out by SHAPE (the owner is colour-blind).
 *
 * The DECISIONS are here, pure and React-free (AGENTS §7): `TranscriptRow` only
 * maps a look to a glyph and some padding. The TUI's module is the source of the
 * rule and `test/transcript-parity.test.ts` pins the two by running the SAME
 * fixtures through both.
 *
 * One difference from the TUI, deliberate and the owner's choice (Q5): the phone
 * folds reasoning into step cells, and a cell the layout HIDES draws nothing at
 * all — so it is transparent here too. The block is computed over what the eye
 * sees, not over the raw array.
 */
import type { Row } from "./transcript-rows.ts";

/** The glyphs both frontends use (the TUI's `HARNESS_GLYPHS`). */
export const NOTICE_GLYPHS = { info: "◇", warn: "▲" } as const;

/** One harness line's drawn shape: its glyph (or none, hanging under one) and whether it joins the row above. */
export interface NoticeLook {
  /** `null`: a continuation — its glyph column stays EMPTY so the text hangs aligned. */
  readonly glyph: (typeof NOTICE_GLYPHS)[keyof typeof NOTICE_GLYPHS] | null;
  /** No blank row above: this line continues the block the one above opened. */
  readonly joined: boolean;
}

/** Whether `row` is a harness line: a notice that is not a full-width separator rule. */
export function isHarness(row: Row | undefined): row is Extract<Row, { kind: "notice" }> & {
  readonly separator?: undefined;
} {
  return row !== undefined && row.kind === "notice" && row.separator !== true;
}

/** One harness line's level, `info` unless a warning. */
export function harnessLevel(row: Row | undefined): "info" | "warn" {
  return isHarness(row) && row.level === "warn" ? "warn" : "info";
}

/** Whether these two rows are drawn as ONE block (no blank row between them). */
export function joinsPrevious(prev: Row | undefined, row: Row): boolean {
  return isHarness(prev) && isHarness(row);
}

/** Whether `row` opens with its glyph, or hangs under the one above (a level change re-opens it). */
export function showsGlyph(prev: Row | undefined, row: Row): boolean {
  if (!isHarness(row)) {
    return false;
  }
  return !joinsPrevious(prev, row) || harnessLevel(prev) !== harnessLevel(row);
}

/**
 * How each harness row draws, by row key (only harness rows are present: any
 * other row has no look at all and draws as it does today).
 *
 * `cells` is `stepLayout`'s map (`tool-steps.ts`): a row it HIDES — reasoning
 * folded into a step or into the live Thinking footer — is transparent, both as
 * a result (it draws nothing) and as a predecessor (it must not break a block
 * the person cannot see breaking).
 */
export function noticeLooks(
  rows: readonly Row[],
  cells?: ReadonlyMap<string, { readonly kind: string }>,
): ReadonlyMap<string, NoticeLook> {
  const looks = new Map<string, NoticeLook>();
  let prev: Row | undefined;
  for (const row of rows) {
    if (cells?.get(row.key)?.kind === "hidden") {
      continue;
    }
    if (isHarness(row)) {
      const glyph = showsGlyph(prev, row);
      looks.set(row.key, {
        glyph: glyph ? NOTICE_GLYPHS[harnessLevel(row)] : null,
        joined: joinsPrevious(prev, row),
      });
    }
    prev = row;
  }
  return looks;
}

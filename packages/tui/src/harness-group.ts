/**
 * Harness lines: ONE quiet voice, grouped (docs/feat/harness-notices.md S2).
 *
 * A "harness line" is anything the machine says about the session itself — a
 * reply cut at the output limit, a job exiting, a repair, "Can't compact…" —
 * as opposed to the model's own text or a command's multi-line reply. They used
 * to be drawn by two unrelated paths in two colours, each as its own item with a
 * blank row between and a `●` the assistant and the tools also use.
 *
 * Now: consecutive harness lines are ONE block. A glyph opens it (`◇` info,
 * `▲` warn) and the rest hang under it (two spaces), with no blank row between
 * them; a glyph re-appears only where the level changes, so a run of info lines
 * reads as a list and a warning stands out by SHAPE (the owner is colour-blind).
 *
 * The DECISIONS are here, pure and React-free (AGENTS §7), because two callers
 * must agree on them or the transcript is wrong: `transcriptLines` makes the
 * logical rows, `layoutTranscript` the wrapped ones the scroll/selection maths
 * reads. A disagreement is an off-by-N-row bug — the class §6 warns about — so a
 * parity test pins them and neither is allowed its own rule.
 */
import type { DisplayItem } from "./state.ts";

/**
 * Whether `item` is a harness line: a notice that is not a full-width separator
 * rule. A separator is a different thing (a rule across the transcript), and an
 * `AssistantItem{notice:true}` is a COMMAND's reply, which keeps the model's
 * styling (Q5).
 */
export function isHarness(
  item: DisplayItem | undefined,
): item is Extract<DisplayItem, { kind: "notice" }> & { separator?: undefined } {
  return item !== undefined && item.kind === "notice" && item.separator !== true;
}

/** One harness line's level, `info` unless a warning. */
export function harnessLevel(item: DisplayItem | undefined): "info" | "warn" {
  return isHarness(item) && item.level === "warn" ? "warn" : "info";
}

/**
 * Whether these two items are drawn as ONE block: two harness lines running
 * together get no blank row between them.
 */
export function joinsPrevious(prev: DisplayItem | undefined, item: DisplayItem): boolean {
  return isHarness(prev) && isHarness(item);
}

/**
 * Whether `item` opens with its glyph, or hangs under the one above: the glyph
 * drops for a harness line whose predecessor is a harness line of the SAME
 * level. (Comparing with the immediate predecessor, not the block's first level,
 * is what makes `◇ ◇ ▲ ◇` show two `◇`: each level change re-opens the glyph.)
 */
export function showsGlyph(prev: DisplayItem | undefined, item: DisplayItem): boolean {
  if (!isHarness(item)) {
    return false;
  }
  return !joinsPrevious(prev, item) || harnessLevel(prev) !== harnessLevel(item);
}

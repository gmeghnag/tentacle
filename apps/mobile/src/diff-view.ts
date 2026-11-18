/**
 * A unified diff as rows (12b): hunks of `add | del | ctx` lines with their old
 * and new line numbers, bounded so one huge patch cannot build a million rows.
 *
 * The counts it reports MUST agree with `packages/client/src/mapping.ts`'s
 * `countDiff` — that is what the `+n −m` a tool row shows is built from, and a
 * disagreement would show two different numbers for one patch. The rule is the
 * same one, line by line: a line starting `+++`/`---` is a file header, never an
 * addition/removal (`diff-count.test.ts` pins both on one patch).
 */
import type { ToolDiffDetail } from "@tentacle/core";

/** A line's kind: an addition, a removal, or context (including hunk headers). */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The old file's line number, or null (an addition has none). */
  readonly oldNo: number | null;
  /** The new file's line number, or null (a removal has none). */
  readonly newNo: number | null;
  readonly text: string;
}

export interface DiffHunk {
  /** The `@@ … @@` heading, as the patch wrote it (`@@ -1,3 +1,4 @@`, trailing context). */
  readonly heading: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffView {
  readonly path: string;
  /** The `+n −m` counts the row shows (the same `countDiff` rule). */
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  /** Lines held back by the bound (`0` when the whole patch is shown). */
  readonly hidden: number;
}

/** Lines one patch renders (plan F21: bounded, with a truncation marker). */
export const DIFF_MAX_LINES = 400;

/** Characters of patch text this module parses (beyond it, none of it is). */
export const DIFF_MAX_CHARS = 200_000;

/** The `+added/−removed` counts of a unified patch — `countDiff`, rule for rule. */
export function countDiff(patch: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

/** `@@ -a,b +c,d @@` → the two starting numbers (a missing count means 1). */
function hunkStart(line: string): { readonly oldNo: number; readonly newNo: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (match === null) {
    return null;
  }
  return { oldNo: Number(match[1]), newNo: Number(match[2]) };
}

/**
 * Parse `patch` into hunks. A patch over `DIFF_MAX_CHARS` is not parsed at all
 * (the row shows its counts and the truncation marker); over
 * `DIFF_MAX_LINES` the hunks stop at the bound and `hidden` says how many
 * lines were held back.
 */
export function diffView(detail: ToolDiffDetail): DiffView {
  const { added, removed } = countDiff(detail.patch);
  const base = { path: detail.path, added, removed };
  if (detail.patch.length > DIFF_MAX_CHARS) {
    return { ...base, hunks: [], hidden: detail.patch.split("\n").length };
  }
  const lines = detail.patch.split("\n");
  const hunks: DiffHunk[] = [];
  let current: { heading: string; lines: DiffLine[] } | null = null;
  // File headers (`--- a/x`, `+++ b/x`, `diff --git`, `index …`) are not body lines.
  let inBody = false;
  let oldNo = 0;
  let newNo = 0;
  let rendered = 0;
  let cut = false;
  for (const line of lines) {
    const start = hunkStart(line);
    if (start !== null) {
      if (cut) {
        break;
      }
      current = { heading: line, lines: [] };
      hunks.push(current);
      oldNo = start.oldNo;
      newNo = start.newNo;
      inBody = true;
      continue;
    }
    if (!inBody || current === null) {
      continue; // the patch's header block
    }
    if (rendered >= DIFF_MAX_LINES) {
      cut = true;
      break;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo += 1;
    } else if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file": no line of its own
    } else {
      /**
       * Context, INCLUDING an empty line: a unified diff writes context as ` `
       * plus the line, but this repo's patches keep a bare empty line for an
       * empty context line (`split("\n")` also yields a trailing `""`). Both
       * count as context so the numbering stays right.
       */
      current.lines.push({
        kind: "ctx",
        oldNo,
        newNo,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
      oldNo += 1;
      newNo += 1;
    }
    rendered += 1;
  }
  const hidden = cut ? Math.max(0, lines.length - rendered - hunks.length) : 0;
  return { ...base, hunks, hidden };
}

/**
 * The ask card's command box (docs/fix/mobile-ask-surfaces.md D3): a few visual
 * rows collapsed, a capped list expanded. Pure. A monospace advance is fixed,
 * so the caller derives `cols` from the width (no `onTextLayout`), and the
 * wrap is deterministic. The text is pod-supplied: ANSI and control characters
 * are stripped, and the work done is bounded by `cap` rows, never by the
 * input's size (a 5000-line command builds 400 rows, not 5000).
 */
import { stripAnsi } from "./ansi.ts";

export interface CommandPreview {
  /** The first `rows` visual rows (collapsed form). */
  readonly shown: readonly string[];
  /** Visual rows hidden by the collapsed form (0: nothing to expand). */
  readonly more: number;
  /** At most `cap` visual rows (expanded form). */
  readonly expandedRows: readonly string[];
  /** Rows the expanded form still drops (`… N more lines not shown`). */
  readonly expandedCut: number;
}

export interface CommandPreviewOptions {
  readonly cols: number;
  readonly rows?: number;
  readonly cap?: number;
}

export const PREVIEW_ROWS = 4;
export const PREVIEW_CAP = 400;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function commandPreview(text: string, opts: CommandPreviewOptions): CommandPreview {
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = opts.rows ?? PREVIEW_ROWS;
  const cap = opts.cap ?? PREVIEW_CAP;
  const clean = stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL, "")
    .replace(/\s+$/, "");
  const lines = clean.split("\n");
  // Count rows arithmetically; materialise only the first `cap`.
  let total = 0;
  const out: string[] = [];
  for (const line of lines) {
    const n = Math.max(1, Math.ceil(line.length / cols));
    for (let i = 0; i < n && out.length < cap; i++) {
      out.push(line.slice(i * cols, (i + 1) * cols));
    }
    total += n;
  }
  return {
    shown: out.slice(0, rows),
    more: Math.max(0, total - rows),
    expandedRows: out,
    expandedCut: Math.max(0, total - cap),
  };
}

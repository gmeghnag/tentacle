/**
 * Result pipeline — the harness's "value-add" layer over raw tool output.
 *
 * Every tool result passes through a sequence of transforms before it enters
 * the conversation, so the harness can enforce good behaviour *deterministically*
 * instead of hoping the model complies. The flagship transform is
 * `spillLargeOutput`: a result bigger than a threshold is written out of band
 * (to a file the model can read selectively) and replaced in-context with a short
 * preview + a pointer — keeping a huge fetch/shell/read from flooding the window.
 *
 * Transforms are pure except for the injected `writeSpill`, so they test without
 * a real filesystem.
 */
import type { ToolResult } from "@tentacle/core";

export interface ResultTransformContext {
  readonly toolName: string;
  readonly toolCallId: string;
  /** The turn's abort signal, for transforms that do async work (e.g. summarise). */
  readonly signal?: AbortSignal;
  /**
   * Persist full output out of band and return a path the model can read, or
   * null if it could not be written (the transform then falls back to a plain
   * truncation so the context is still protected).
   */
  writeSpill(contents: string): Promise<string | null>;
}

export type ResultTransform = (
  result: ToolResult,
  ctx: ResultTransformContext,
) => ToolResult | Promise<ToolResult>;

/**
 * Skip `transform` for the named tools: their result passes through unchanged.
 * For a tool whose result is curated context the model asked for (a `skill`
 * body), where spilling, summarising or deduplicating would silently drop
 * the instructions — the tool bounds its own output instead. Safety layers
 * (secret redaction) are deliberately NOT wrapped.
 */
export function exemptTools(names: readonly string[], transform: ResultTransform): ResultTransform {
  return (result, ctx) => (names.includes(ctx.toolName) ? result : transform(result, ctx));
}

/** Run `result` through every transform in order. */
export async function applyResultTransforms(
  result: ToolResult,
  transforms: readonly ResultTransform[],
  ctx: ResultTransformContext,
): Promise<ToolResult> {
  let current = result;
  for (const transform of transforms) {
    current = await transform(current, ctx);
  }
  return current;
}

export interface SpillOptions {
  /** Max characters kept inline; a longer result is spilled. 0 disables spilling. */
  readonly maxInlineChars: number;
  /** Characters of head+tail preview kept inline (default 1200). */
  readonly previewChars?: number;
}

/**
 * Spill a too-large result to a file, replacing it in-context with a banner +
 * head/tail preview that tells the model where the full output lives and to read
 * it selectively. If the spill write fails, the result is truncated instead.
 */
export function spillLargeOutput(options: SpillOptions): ResultTransform {
  const max = options.maxInlineChars;
  const previewChars = options.previewChars ?? 1200;
  return async (result, ctx) => {
    const content = result.content;
    if (max <= 0 || content.length <= max) {
      return result;
    }
    const headLen = Math.ceil(previewChars / 2);
    const tailLen = Math.floor(previewChars / 2);
    const head = content.slice(0, headLen);
    const tail = content.slice(content.length - tailLen);
    const omitted = content.length - head.length - tail.length;
    const preview = omitted > 0 ? `${head}\n…[${omitted} characters omitted]…\n${tail}` : content;

    const path = await ctx.writeSpill(content);
    const pointer = path
      ? `full output (${content.length} chars) saved to ${path} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole`
      : `output truncated to ${previewChars} chars (could not be saved to a file)`;
    const banner = `[large ${ctx.toolName} output: ${pointer}]`;
    return { ...result, content: `${banner}\n${preview}` };
  };
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** A record whose values are all primitive (a tabulatable row). */
function isFlatRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPrimitive)
  );
}

function cell(value: unknown, maxWidth: number): string {
  const text = value === null || value === undefined ? "" : String(value);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > maxWidth ? `${oneLine.slice(0, maxWidth - 1)}…` : oneLine;
}

export interface TabulateOptions {
  /** Max rows rendered before the rest are elided (default 50). */
  readonly maxRows?: number;
  /** Max characters per cell (default 40). */
  readonly maxCellWidth?: number;
}

/**
 * Render a tool result that is a JSON array of flat objects as a compact text
 * table (more readable and token-lean than pretty-printed JSON). Conservative:
 * only fires for an array of ≥2 objects whose values are all primitive; anything
 * else is left untouched.
 */
export function tabulateJson(options: TabulateOptions = {}): ResultTransform {
  const maxRows = options.maxRows ?? 50;
  const maxCellWidth = options.maxCellWidth ?? 40;
  return (result) => {
    const text = result.content.trim();
    if (!text.startsWith("[")) {
      return result;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return result;
    }
    if (!Array.isArray(data) || data.length < 2 || !data.every(isFlatRecord)) {
      return result;
    }
    const rows = data as Record<string, unknown>[];
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    if (columns.length === 0) {
      return result;
    }
    const shown = rows.slice(0, maxRows);
    const lines = [
      columns.join(" | "),
      columns.map(() => "---").join(" | "),
      ...shown.map((row) => columns.map((c) => cell(row[c], maxCellWidth)).join(" | ")),
    ];
    const more = rows.length > maxRows ? `\n… ${rows.length - maxRows} more rows` : "";
    return {
      ...result,
      content: `[${rows.length} rows rendered as a table]\n${lines.join("\n")}${more}`,
    };
  };
}

export interface DedupOptions {
  /** Minimum run of identical consecutive lines to collapse (default 3). */
  readonly minRun?: number;
}

/**
 * Collapse runs of identical consecutive lines (e.g. repeated log spam) into the
 * line once plus a `repeated N more times` marker — a cheap, safe way to shrink
 * noisy output before it reaches the context.
 */
export function collapseRepeatedLines(options: DedupOptions = {}): ResultTransform {
  const minRun = options.minRun ?? 3;
  return (result) => {
    const lines = result.content.split("\n");
    const out: string[] = [];
    let collapsed = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "") === line) {
        j++;
      }
      const run = j - i;
      out.push(line);
      if (run >= minRun) {
        out.push(`… [previous line repeated ${run - 1} more times]`);
        collapsed = true;
      } else {
        for (let k = i + 1; k < j; k++) {
          out.push(lines[k] ?? "");
        }
      }
      i = j;
    }
    return collapsed ? { ...result, content: out.join("\n") } : result;
  };
}

export interface SummarizeOptions {
  /** Max characters kept inline; a longer result is summarised. 0 disables it. */
  readonly maxInlineChars: number;
  /** Produce a condensed summary of the given text (injected; uses the model). */
  readonly summarize: (text: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * Replace a too-large result with an LLM summary, spilling the full output to a
 * file for details. Falls back to a plain pointer if summarisation fails. More
 * expensive than `spillLargeOutput` (a model call per large result), so it is
 * opt-in.
 */
export function summarizeLargeOutput(options: SummarizeOptions): ResultTransform {
  const max = options.maxInlineChars;
  return async (result, ctx) => {
    const content = result.content;
    if (max <= 0 || content.length <= max) {
      return result;
    }
    const path = await ctx.writeSpill(content);
    const where = path
      ? `full output (${content.length} chars) saved to ${path} — fs_read it for details`
      : "full output could not be saved";
    try {
      const summary = await options.summarize(content, ctx.signal);
      return { ...result, content: `[summarised ${ctx.toolName} output — ${where}]\n${summary}` };
    } catch {
      return { ...result, content: `[large ${ctx.toolName} output — ${where}; summary failed]` };
    }
  };
}

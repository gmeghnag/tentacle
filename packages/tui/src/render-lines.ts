/**
 * Render the transcript into ANSI text lines for the virtualized scroll buffer.
 *
 * The TUI owns layout line-by-line (rather than delegating to Ink's flexbox) so
 * it can window, scroll, and collapse at the granularity of individual rows.
 * Each display item becomes an array of "logical" lines (pre-wrap); `wrapLines`
 * then folds them to the terminal width so row math stays exact.
 *
 * Pure and framework-free: no React, no Ink — just strings in, strings out.
 */
import type { ToolResultDetail } from "@agent-harness/core";
import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "./markdown.ts";
import type { DisplayItem, ToolItem } from "./state.ts";
import { dashedRule, theme } from "./theme.ts";
import { type WordOp, changeRatio, diffWords } from "./word-diff.ts";

export interface RenderOptions {
  /** When true, tool bodies are shown in full (Ctrl+O). */
  readonly expandAll: boolean;
  /** Display width in columns, used to size full-width diff bars. */
  readonly width?: number;
  /** Collapse a tool body longer than this many lines (default 8). */
  readonly collapseThreshold?: number;
  /** Lines shown in a collapsed preview (default 6). */
  readonly previewLines?: number;
}

const DEFAULT_THRESHOLD = 8;
const DEFAULT_PREVIEW = 6;
const DEFAULT_WIDTH = 80;
// Two-column prefixes under an item: a plain indent, or the corner connector
// that marks a tool's output block (Claude-Code style). Both are 2 columns so
// bodies stay aligned whichever is used.
const INDENT = "  ";
const CONNECTOR = `${theme.subtle("⎿")} `;
// Below this fraction of changed characters, a removed/added line pair is shown
// with word-level highlighting; above it, the whole line is tinted instead.
const WORD_DIFF_MAX_RATIO = 0.4;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI SGR codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI SGR colour codes, leaving the plain display text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function userLines(text: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [chalk.cyan.bold("› ") + first, ...rest.map((l) => `  ${l}`)];
}

function assistantLines(text: string): string[] {
  if (text.trim() === "") {
    return [];
  }
  const rendered = renderMarkdown(text).replace(/\n+$/, "");
  const [first = "", ...rest] = rendered.split("\n");
  // A claude-orange bullet marks the reply; continuation lines hang under it.
  return [`${theme.claude("⏺")} ${first}`, ...rest.map((l) => `${INDENT}${l}`)];
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("Index:") ||
    line.startsWith("===")
  );
}

interface DiffRow {
  kind: "add" | "del" | "context";
  /** Line text, without the leading +/-/space marker. */
  text: string;
  /** New-file line number (null for a removed line). */
  no: number | null;
  /** When set, the paired word-level diff for this add/del line. */
  words?: readonly WordOp[];
}

/** Split a unified-diff patch into hunks of typed rows with new-line numbers. */
function parseHunks(patch: string): DiffRow[][] {
  const hunks: DiffRow[][] = [];
  let cur: DiffRow[] | null = null;
  let n = 0;
  for (const raw of patch.split("\n")) {
    const h = HUNK_RE.exec(raw);
    if (h) {
      cur = [];
      hunks.push(cur);
      n = Number(h[1]);
      continue;
    }
    if (isDiffMeta(raw) || raw.startsWith("\\") || raw === "") {
      continue;
    }
    if (cur === null) {
      cur = [];
      hunks.push(cur);
    }
    if (raw.startsWith("+")) {
      cur.push({ kind: "add", text: raw.slice(1), no: n });
      n += 1;
    } else if (raw.startsWith("-")) {
      cur.push({ kind: "del", text: raw.slice(1), no: null });
    } else {
      cur.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, no: n });
      n += 1;
    }
  }
  return hunks;
}

/** Pair adjacent del→add runs and attach a word diff when the change is small. */
function pairWordDiffs(hunk: DiffRow[]): void {
  let i = 0;
  while (i < hunk.length) {
    if (hunk[i]?.kind !== "del") {
      i += 1;
      continue;
    }
    let j = i;
    const dels: DiffRow[] = [];
    while (j < hunk.length && hunk[j]?.kind === "del") {
      dels.push(hunk[j] as DiffRow);
      j += 1;
    }
    const adds: DiffRow[] = [];
    while (j < hunk.length && hunk[j]?.kind === "add") {
      adds.push(hunk[j] as DiffRow);
      j += 1;
    }
    if (dels.length > 0 && adds.length > 0) {
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const del = dels[k];
        const add = adds[k];
        if (!del || !add) {
          continue;
        }
        const ops = diffWords(del.text, add.text);
        if (changeRatio(ops) <= WORD_DIFF_MAX_RATIO) {
          del.words = ops;
          add.words = ops;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
}

/** Render one add/del row as a full-width background bar with a line gutter. */
function renderBar(row: DiffRow, gutterW: number, width: number): string {
  const isAdd = row.kind === "add";
  const bg = isAdd ? theme.diff.addBg : theme.diff.delBg;
  const fg = isAdd ? theme.diff.addFg : theme.diff.delFg;
  const gutterFg = isAdd ? theme.diff.addGutter : theme.diff.delGutter;
  const word = isAdd ? theme.diff.addWord : theme.diff.delWord;

  const numStr = (row.no !== null ? String(row.no) : "").padStart(gutterW);
  const marker = isAdd ? "+" : "-";
  const gutter = `${numStr} ${marker} `; // gutterW + space + marker + space

  let content: string;
  let plainLen: number;
  if (row.words) {
    const side: WordOp["kind"] = isAdd ? "add" : "remove";
    const shown = row.words.filter((op) => op.kind === "same" || op.kind === side);
    content = shown.map((op) => (op.kind === "same" ? fg(op.value) : word(op.value))).join("");
    plainLen = shown.reduce((sum, op) => sum + op.value.length, 0);
  } else {
    content = fg(row.text);
    plainLen = row.text.length;
  }
  const used = gutterW + 3 + plainLen;
  const pad = Math.max(0, width - used);
  return bg(gutterFg(gutter) + content + " ".repeat(pad));
}

function renderContext(row: DiffRow, gutterW: number): string {
  const numStr = (row.no !== null ? String(row.no) : "").padStart(gutterW);
  return theme.subtle(`${numStr}   ${row.text}`);
}

/**
 * Render a unified-diff patch Claude-Code style: a dashed frame, full-width
 * green/red background bars with a line-number gutter, word-level highlighting
 * of small changes, dim context, and a `⋯` between hunks. The noisy unified
 * headers (`Index:`, `---`, `+++`, `@@`) are dropped.
 */
function diffBody(detail: Extract<ToolResultDetail, { kind: "diff" }>, width: number): string[] {
  const summary = `${theme.success(`+${detail.added}`)} ${theme.error(`-${detail.removed}`)}`;
  const hunks = parseHunks(detail.patch);

  let maxNo = 0;
  for (const hunk of hunks) {
    pairWordDiffs(hunk);
    for (const row of hunk) {
      if (row.no !== null) {
        maxNo = Math.max(maxNo, row.no);
      }
    }
  }
  const gutterW = Math.max(2, String(maxNo).length);

  const out: string[] = [summary, dashedRule(width)];
  hunks.forEach((hunk, hi) => {
    if (hi > 0) {
      out.push(theme.subtle(`${"⋯".padStart(gutterW)}`));
    }
    for (const row of hunk) {
      out.push(
        row.kind === "context" ? renderContext(row, gutterW) : renderBar(row, gutterW, width),
      );
    }
  });
  out.push(dashedRule(width));
  return out;
}

/** The nested progress tree for a sub-agent (`task`) call. */
function subAgentLines(tool: ToolItem): string[] {
  const sub = tool.sub;
  if (!sub) {
    return [];
  }
  const uses = `${sub.toolUses} tool ${sub.toolUses === 1 ? "use" : "uses"}`;
  const head = theme.subtle(`${theme.accent("◆")} ${sub.agentType} · ${uses}`);
  const rows = sub.activities.map((label, i) => {
    const last = i === sub.activities.length - 1 && sub.done;
    return theme.subtle(`${last ? "└─" : "├─"} ${label}`);
  });
  if (!sub.done) {
    rows.push(theme.subtle("└─ …"));
  }
  return [head, ...rows];
}

function toolBody(tool: ToolItem, width: number): string[] {
  if (tool.detail?.kind === "diff") {
    return diffBody(tool.detail, width);
  }
  // Sub-agent (`task`): show the nested activity tree, then its report (when done).
  if (tool.sub) {
    const tree = subAgentLines(tool);
    if (tool.status === "running") {
      return tree;
    }
    const report =
      tool.resultText && tool.resultText.length > 0
        ? [
            "",
            ...tool.resultText
              .replace(/\n+$/, "")
              .split("\n")
              .map((l) => theme.subtle(l)),
          ]
        : [];
    return [...tree, ...report];
  }
  if (tool.status === "running") {
    return [theme.subtle("running…")];
  }
  if (tool.resultText && tool.resultText.length > 0) {
    const color = tool.status === "error" ? theme.error : theme.subtle;
    return tool.resultText
      .replace(/\n+$/, "")
      .split("\n")
      .map((line) => color(line));
  }
  return [];
}

/** A status-coloured bullet that opens a tool call. */
function bullet(tool: ToolItem): string {
  if (tool.status === "running") {
    return theme.accent("⏺");
  }
  return tool.status === "ok" ? theme.success("⏺") : theme.error("⏺");
}

/** A friendly action label + primary target for a tool call. */
export function toolTitle(tool: ToolItem): { label: string; subtitle: string } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(tool.args);
    if (parsed && typeof parsed === "object") {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON args fall through to the raw string below.
  }
  const str = (key: string): string | undefined =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;

  switch (tool.name) {
    case "fs_read":
      return { label: "Read", subtitle: str("path") ?? "" };
    case "fs_write":
      return { label: "Write", subtitle: str("path") ?? "" };
    case "fs_edit":
      return { label: "Edit", subtitle: str("path") ?? "" };
    case "shell":
      return { label: "Bash", subtitle: str("command") ?? "" };
    case "task":
      return { label: "Task", subtitle: str("description") ?? str("subagent_type") ?? "" };
    default:
      return { label: tool.name, subtitle: tool.args };
  }
}

function toolLines(tool: ToolItem, opts: RenderOptions): string[] {
  const width = Math.max(20, (opts.width ?? DEFAULT_WIDTH) - INDENT.length - 1);
  const elapsed =
    tool.endedAt !== undefined ? ` ${((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s` : "";
  const { label, subtitle } = toolTitle(tool);
  const sub = subtitle ? ` ${theme.subtle(truncate(subtitle, 72))}` : "";
  const header = `${bullet(tool)} ${chalk.bold(label)}${sub}${theme.subtle(elapsed)}`;

  const body = toolBody(tool, width);
  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;

  let shown = body;
  if (!opts.expandAll && body.length > threshold) {
    const hidden = body.length - preview;
    shown = [...body.slice(0, preview), theme.subtle(`… +${hidden} more lines · ctrl+o to expand`)];
  }
  // The first body line carries the corner connector; the rest align under it.
  return [header, ...shown.map((l, i) => (i === 0 ? CONNECTOR : INDENT) + l)];
}

function noticeLines(text: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [
    `${theme.subtle("⏺")} ${theme.subtle(first)}`,
    ...rest.map((l) => `  ${theme.subtle(l)}`),
  ];
}

/** Logical (pre-wrap) lines for a single display item. */
export function itemLines(item: DisplayItem, opts: RenderOptions): string[] {
  switch (item.kind) {
    case "user":
      return userLines(item.text);
    case "assistant":
      return assistantLines(item.text);
    case "tool":
      return toolLines(item, opts);
    case "notice":
      return noticeLines(item.text);
  }
}

/** Logical lines for the whole transcript, with a blank line between items. */
export function transcriptLines(items: readonly DisplayItem[], opts: RenderOptions): string[] {
  const out: string[] = [];
  for (const item of items) {
    const lines = itemLines(item, opts);
    if (lines.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push("");
    }
    out.push(...lines);
  }
  return out;
}

/** Fold logical lines to the given display width (ANSI-aware). */
export function wrapLines(lines: readonly string[], width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    const wrapped = wrapAnsi(line, w, { hard: true, trim: false, wordWrap: true });
    for (const piece of wrapped.split("\n")) {
      out.push(piece);
    }
  }
  return out;
}

// --- per-item layout cache -------------------------------------------------
// Laying out the whole transcript every frame (markdown parse + word-diff +
// ANSI wrap over every item) made per-frame cost grow with conversation
// length, so once a turn's render cost crossed the frame budget the single JS
// thread saturated — input (scroll, Ctrl+O), the spinner timer and the
// permission-dialog teardown all starved behind it.
//
// The fix keys a layout on the item's object identity. `state.ts` rebuilds the
// one changing item as a fresh object on each event (a text delta replaces the
// tail assistant item; a tool update replaces that tool) while every finished
// item keeps its identity. So a WeakMap gives a hit for every settled item and
// recomputes only the streaming tail — O(1) per frame instead of O(transcript).
// Width / expand / collapse options are part of the key: a resize or Ctrl+O
// legitimately re-lays-out everything (once), which is unavoidable.
interface RowCacheEntry {
  readonly width: number;
  readonly expand: boolean;
  readonly threshold: number;
  readonly preview: number;
  readonly rows: readonly string[];
}
const rowCache = new WeakMap<DisplayItem, RowCacheEntry>();

/** This item's final wrapped rows, memoised on its identity + layout options. */
function itemRows(item: DisplayItem, opts: RenderOptions): readonly string[] {
  const width = Math.max(1, Math.floor(opts.width ?? DEFAULT_WIDTH));
  const expand = opts.expandAll;
  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;
  const hit = rowCache.get(item);
  if (
    hit &&
    hit.width === width &&
    hit.expand === expand &&
    hit.threshold === threshold &&
    hit.preview === preview
  ) {
    return hit.rows;
  }
  const rows = wrapLines(itemLines(item, opts), width);
  rowCache.set(item, { width, expand, threshold, preview, rows });
  return rows;
}

/**
 * The whole transcript as final, width-wrapped rows — the layout the viewport
 * windows and the selection reads. Equivalent to
 * `wrapLines(transcriptLines(items, opts), opts.width)` but memoised per item,
 * so a running turn re-lays-out only the one item that changed.
 */
export function transcriptRows(items: readonly DisplayItem[], opts: RenderOptions): string[] {
  const out: string[] = [];
  for (const item of items) {
    const rows = itemRows(item, opts);
    if (rows.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push(""); // blank separator between items (matches transcriptLines)
    }
    out.push(...rows);
  }
  return out;
}

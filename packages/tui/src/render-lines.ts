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
import { type ToolResultDetail, type ToolResultSpill, toolLabel } from "@tentacle/core";
import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { formatDurationMs } from "./format.ts";
import { expandTabs } from "./input-view.ts";
import { renderMarkdown } from "./markdown.ts";
import { messageRows } from "./message-row.ts";
import { cleanReadText, highlightRead, pathOfArgs } from "./read-highlight.ts";
import { type SpillView, spillView } from "./spill-view.ts";
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
  /**
   * The daemon runs in a pod (`run`/`attach`): a spilled result's file is
   * "saved in the pod to" its path. Constant for an App's lifetime (the
   * runtime the laptop started), so it is not part of the row-cache key.
   */
  readonly spillInPod?: boolean;
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

// Already wrapped to the width and padded, so `wrapLines` leaves the rows alone.
function userLines(text: string, width: number): string[] {
  return messageRows(expandTabs(text), width);
}

function assistantLines(text: string): string[] {
  if (text.trim() === "") {
    return [];
  }
  const rendered = renderMarkdown(text).replace(/\n+$/, "");
  const [first = "", ...rest] = rendered.split("\n");
  // A brand-accent bullet marks the reply; continuation lines hang under it.
  return [`${theme.accent("⏺")} ${first}`, ...rest.map((l) => `${INDENT}${l}`)];
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
    // Tabs are expanded here, once, so the word diff and the bar padding both
    // see the text exactly as it is shown.
    if (raw.startsWith("+")) {
      cur.push({ kind: "add", text: expandTabs(raw.slice(1)), no: n });
      n += 1;
    } else if (raw.startsWith("-")) {
      cur.push({ kind: "del", text: expandTabs(raw.slice(1)), no: null });
    } else {
      cur.push({
        kind: "context",
        text: expandTabs(raw.startsWith(" ") ? raw.slice(1) : raw),
        no: n,
      });
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
    plainLen = shown.reduce((sum, op) => sum + stringWidth(op.value), 0);
  } else {
    content = fg(row.text);
    plainLen = stringWidth(row.text);
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

/** The nested progress tree for a sub-agent (`agent_task`) call. */
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

/**
 * The hook annotation under a tool call (H1), as plain text: `name` and the
 * rest of the `hook <name> blocked <Tool>` line, the reason lines (blocked
 * only), and whether it replaces the body (a block: the model-facing
 * "Blocked by a hook…" text would repeat the line). Null without a hook.
 */
export function hookLines(
  tool: ToolItem,
): { name: string; rest: string; reason: string[]; replacesBody: boolean } | null {
  const hook = tool.hook;
  if (!hook) {
    return null;
  }
  const label = toolLabel(tool.name);
  if (hook.action === "modified") {
    return { name: hook.name, rest: ` modified ${label} input`, reason: [], replacesBody: false };
  }
  const reason = hook.reason ? hook.reason.replace(/\n+$/, "").split("\n") : [];
  return { name: hook.name, rest: ` blocked ${label}`, reason, replacesBody: true };
}

function toolBody(tool: ToolItem, width: number, inPod: boolean, headLimit?: number): string[] {
  const hook = hookLines(tool);
  if (!hook) {
    return plainToolBody(tool, width, inPod, headLimit);
  }
  const line = theme.subtle("hook ") + theme.accent(hook.name) + theme.subtle(hook.rest);
  const reason = hook.reason.map((l) => theme.subtle(l));
  return [
    line,
    ...reason,
    ...(hook.replacesBody ? [] : plainToolBody(tool, width, inPod, headLimit)),
  ];
}

// A spilled result's head and tail lines, memoised on the item like
// `readHlCache` (a Ctrl+O / resize reuses them). Small (the preview), so one
// slot: both views show the same parts.
const spillPartsCache = new WeakMap<ToolItem, readonly [readonly string[], readonly string[]]>();

function spillParts(
  tool: ToolItem,
  view: SpillView,
): readonly [readonly string[], readonly string[]] {
  const hit = spillPartsCache.get(tool);
  if (hit) {
    return hit;
  }
  const color = tool.status === "error" ? theme.error : theme.subtle;
  const path =
    tool.name === "fs_read" && tool.status !== "error" ? pathOfArgs(tool.args) : undefined;
  // Discontiguous parts: each is highlighted on its own; plain when it can't be.
  const part = (text: string): readonly string[] =>
    text === ""
      ? []
      : ((path !== undefined ? highlightRead(text, path) : undefined) ??
        text.split("\n").map((l) => color(l)));
  const parts = [part(view.head), part(view.tail)] as const;
  spillPartsCache.set(tool, parts);
  return parts;
}

/** The note, the path (expanded only), the head, the omitted line, the tail. */
function spillBody(
  tool: ToolItem,
  spill: ToolResultSpill,
  expanded: boolean,
  inPod: boolean,
): string[] {
  const view = spillView(spill, { expanded, inPod });
  const [head, tail] = spillParts(tool, view);
  return [
    theme.subtle(view.note),
    ...(view.where !== undefined ? [theme.subtle(view.where)] : []),
    ...head,
    ...(view.omitted !== undefined ? [theme.subtle(view.omitted)] : []),
    ...tail,
  ];
}

// A file read's syntax-coloured lines, memoised on the tool item's identity
// (like `rowCache`): a Ctrl+O / resize re-lay-out reuses them instead of
// re-highlighting. `limit` (undefined = all) is the key: a collapsed preview
// highlights only its head, the expanded view the whole file.
// One slot per limit (preview head, full), so toggling Ctrl+O highlights each
// view at most once; a cached `undefined` (plain) is remembered too.
const readHlCache = new WeakMap<ToolItem, Map<number | undefined, readonly string[] | undefined>>();

function readLines(tool: ToolItem, limit: number | undefined): readonly string[] | undefined {
  let slots = readHlCache.get(tool);
  if (!slots) {
    slots = new Map();
    readHlCache.set(tool, slots);
  }
  if (slots.has(limit)) {
    return slots.get(limit);
  }
  const path = pathOfArgs(tool.args);
  const lines =
    path === undefined || tool.resultText === undefined
      ? undefined
      : highlightRead(cleanReadText(tool.resultText), path, "dark", limit);
  slots.set(limit, lines);
  return lines;
}

function plainToolBody(
  tool: ToolItem,
  width: number,
  inPod: boolean,
  headLimit?: number,
): string[] {
  if (tool.detail?.kind === "diff") {
    return diffBody(tool.detail, width);
  }
  // `headLimit` is undefined exactly when expanded (Ctrl+O): `toolLines`.
  const expanded = headLimit === undefined;
  // Sub-agent (`agent_task`): show the nested activity tree, then its report (when done).
  if (tool.sub) {
    const tree = subAgentLines(tool);
    if (tool.status === "running") {
      return tree;
    }
    const report = tool.spill
      ? ["", ...spillBody(tool, tool.spill, expanded, inPod)]
      : tool.resultText && tool.resultText.length > 0
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
  // Spilled: the structured fact, never the model's banner (docs/feat/tui-spill-note.md).
  if (tool.spill) {
    return spillBody(tool, tool.spill, expanded, inPod);
  }
  if (tool.resultText && tool.resultText.length > 0) {
    if (tool.name === "fs_read" && tool.status !== "error") {
      const coloured = readLines(tool, headLimit);
      if (coloured) {
        return [...coloured];
      }
    }
    const color = tool.status === "error" ? theme.error : theme.subtle;
    const text = tool.name === "fs_read" ? cleanReadText(tool.resultText) : tool.resultText;
    return text
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

  return { label: toolLabel(tool.name), subtitle: toolSubtitle(tool, args, str) };
}

/** The primary target shown after a tool's label. */
function toolSubtitle(
  tool: ToolItem,
  args: Record<string, unknown>,
  str: (key: string) => string | undefined,
): string {
  switch (tool.name) {
    case "fs_read":
    case "fs_write":
    case "fs_edit":
      return str("path") ?? "";
    case "fs_multi_edit": {
      const path = str("path") ?? "";
      if (!Array.isArray(args.edits)) {
        return path;
      }
      const n = args.edits.length;
      return `${path} · ${n} ${n === 1 ? "edit" : "edits"}`;
    }
    case "shell":
      return str("command") ?? "";
    case "shell_output":
    case "shell_kill":
      return str("job_id") ?? "";
    case "agent_task":
      return str("description") ?? str("subagent_type") ?? "";
    case "skill":
      return str("name") ?? "";
    default:
      return tool.args;
  }
}

function toolLines(tool: ToolItem, opts: RenderOptions): string[] {
  const width = Math.max(20, (opts.width ?? DEFAULT_WIDTH) - INDENT.length - 1);
  const elapsed =
    tool.endedAt !== undefined ? ` ${formatDurationMs(tool.endedAt - tool.startedAt)}` : "";
  const { label, subtitle } = toolTitle(tool);
  const sub = subtitle ? ` ${theme.subtle(truncate(subtitle, 72))}` : "";
  const header = `${bullet(tool)} ${chalk.bold(label)}${sub}${theme.subtle(elapsed)}`;

  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;
  const body = toolBody(
    tool,
    width,
    opts.spillInPod === true,
    opts.expandAll ? undefined : Math.max(threshold, preview),
  );

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
      return userLines(item.text, Math.floor(opts.width ?? DEFAULT_WIDTH));
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

/**
 * Fold logical lines to the given display width (ANSI-aware). Every transcript
 * row passes here, so it is also where a TAB byte is kept from reaching the
 * terminal (which would expand it to an 8-column stop and overflow the row).
 */
export function wrapLines(lines: readonly string[], width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    const text = expandTabs(line);
    if (fitsUnchanged(text, w)) {
      // wrapAnsi would return `text` as is (see `fitsUnchanged`); skip its
      // per-escape regex scan, the bulk of an expanded transcript's layout cost.
      out.push(...carryColor([text]));
      continue;
    }
    const wrapped = wrapAnsi(text, w, { hard: true, trim: false, wordWrap: true });
    out.push(...carryColor(wrapped.split("\n")));
  }
  return out;
}

/**
 * True when `wrapAnsi(text, w, { hard, trim: false, wordWrap })` provably
 * returns `text` unchanged: one line (no `\n` to split, no `\r\n` to rewrite),
 * already NFC-normalised (wrap-ansi normalises first), and no wider than `w`
 * (so no break is inserted, and with no break it appends no SGR close/reopen).
 */
function fitsUnchanged(text: string, w: number): boolean {
  return !/[\r\n]/.test(text) && stringWidth(text) <= w && text.normalize() === text;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR_CODE = /\x1b\[([0-9;]*)m/g;

/**
 * Make each row of one wrapped line self-contained for truecolour foregrounds.
 * wrap-ansi tracks only single-number SGR codes, so a `38;2;r;g;b` colour that
 * spans a wrap point stays open at the end of its row and is missing on the
 * next. Done on the finished rows, it changes no text and no wrap point: the
 * open colour is re-emitted at the start of each following row and closed
 * (`39`) at the end of each row. Rows without such a colour pass through as is.
 */
export function carryColor(rows: readonly string[]): string[] {
  let open: string | null = null;
  return rows.map((row) => {
    const lead = open ?? "";
    for (const m of row.matchAll(SGR_CODE)) {
      const p = m[1] ?? "";
      if (p.startsWith("38;2;")) {
        open = m[0];
      } else if (p === "39" || p === "0" || p === "") {
        open = null;
      }
    }
    return lead === "" && open === null ? row : `${lead}${row}${open === null ? "" : "\x1b[39m"}`;
  });
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
//
// Two slots per item, collapsed and expanded, so a Ctrl+O flip in either
// direction finds the other view already laid out. A width / threshold /
// preview change invalidates both (a fresh entry holds only the view just built).
interface RowCacheEntry {
  readonly width: number;
  readonly threshold: number;
  readonly preview: number;
  collapsed?: readonly string[];
  expanded?: readonly string[];
}
const rowCache = new WeakMap<DisplayItem, RowCacheEntry>();

/** This item's final wrapped rows, memoised on its identity + layout options. */
function itemRows(item: DisplayItem, opts: RenderOptions): readonly string[] {
  const width = Math.max(1, Math.floor(opts.width ?? DEFAULT_WIDTH));
  const expand = opts.expandAll;
  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;
  // Only `tool` items collapse, so only their layout depends on
  // expand/threshold/preview; every other kind is a function of width alone
  // (always the `collapsed` slot). Keying those options for non-tool items too
  // made a Ctrl+O (expandAll) flip needlessly invalidate the whole transcript.
  const expandMatters = item.kind === "tool";
  const slot = expandMatters && expand ? "expanded" : "collapsed";
  let entry = rowCache.get(item);
  if (
    entry &&
    entry.width === width &&
    (!expandMatters || (entry.threshold === threshold && entry.preview === preview))
  ) {
    const hit = entry[slot];
    if (hit) {
      return hit;
    }
  } else {
    entry = { width, threshold, preview };
    rowCache.set(item, entry);
  }
  const rows = wrapLines(itemLines(item, opts), width);
  entry[slot] = rows;
  return rows;
}

/** One laid-out item: its final wrapped rows and the global index of its first row. */
export interface LaidItem {
  readonly rows: readonly string[];
  readonly start: number;
}

/**
 * A positional index of the whole transcript: each non-empty item's cached rows
 * plus its global start offset (with one blank separator row between items), and
 * the grand `total` row count.
 *
 * This is the cheap half of the layout: it walks every item but only does O(1)
 * cache lookups (`itemRows`) and offset arithmetic — it never materialises the
 * full row array. Callers take `total` for scroll maths and `sliceLaid` only the
 * visible window, so per-frame cost is O(items + viewport), not O(transcript).
 * The whole array is built (via `transcriptRows`) only when something genuinely
 * needs it — e.g. extracting a text selection on mouse-release.
 */
export interface TranscriptLayout {
  readonly laid: readonly LaidItem[];
  readonly total: number;
}

export function layoutTranscript(
  items: readonly DisplayItem[],
  opts: RenderOptions,
): TranscriptLayout {
  const laid: LaidItem[] = [];
  let cursor = 0;
  for (const item of items) {
    const rows = itemRows(item, opts);
    if (rows.length === 0) {
      continue;
    }
    if (laid.length > 0) {
      cursor += 1; // blank separator row between items (matches transcriptLines)
    }
    laid.push({ rows, start: cursor });
    cursor += rows.length;
  }
  return { laid, total: cursor };
}

/**
 * Materialise rows `[start, end)` of a laid-out transcript, in global order and
 * including the blank separator rows. Equivalent to
 * `transcriptRows(items, opts).slice(start, end)` but it copies only the rows
 * the window actually covers.
 */
export function sliceLaid(laid: readonly LaidItem[], start: number, end: number): string[] {
  const out: string[] = [];
  let i = 0;
  for (const { rows, start: s } of laid) {
    if (i > 0) {
      const sep = s - 1; // the separator row sits just before this item
      if (sep >= start && sep < end) {
        out.push("");
      }
    }
    const from = Math.max(start, s);
    const to = Math.min(end, s + rows.length);
    for (let r = from; r < to; r++) {
      const row = rows[r - s];
      if (row !== undefined) {
        out.push(row);
      }
    }
    i += 1;
  }
  return out;
}

/**
 * Warm the per-item row cache for items `[from, …)` at `opts`, processing at
 * least one item and then stopping once ~`budgetMs` has elapsed. Returns the
 * index to resume from (`=== items.length` when the whole transcript is warm).
 *
 * Pure apart from the module cache it populates. The resize path drives this off
 * the render thread (time-budgeted chunks) so the width change's O(transcript)
 * re-wrap never blocks a frame; once warm, the committing render is all hits.
 */
export function warmRowsChunk(
  items: readonly DisplayItem[],
  opts: RenderOptions,
  from: number,
  budgetMs: number,
): number {
  const start = performance.now();
  let i = Math.max(0, from);
  while (i < items.length) {
    const item = items[i];
    if (item !== undefined) {
      itemRows(item, opts);
    }
    i += 1;
    if (performance.now() - start >= budgetMs) {
      break;
    }
  }
  return i;
}

/**
 * The whole transcript as final, width-wrapped rows — the layout the selection
 * reads on mouse-release. Equivalent to
 * `wrapLines(transcriptLines(items, opts), opts.width)` but memoised per item,
 * so a running turn re-lays-out only the one item that changed. The hot render
 * path uses `layoutTranscript` + `sliceLaid` instead of building this in full.
 */
export function transcriptRows(items: readonly DisplayItem[], opts: RenderOptions): string[] {
  const { laid, total } = layoutTranscript(items, opts);
  return sliceLaid(laid, 0, total);
}

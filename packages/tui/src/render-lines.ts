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
import { BULLET, blinkOn, hiddenBullet } from "./blink.ts";
import { truncateCells } from "./cells.ts";
import { formatDurationMs } from "./format.ts";
import { expandTabs } from "./input-view.ts";
import { renderMarkdown } from "./markdown.ts";
import { messageRows } from "./message-row.ts";
import { DENIED_LABEL, denialReplyLines } from "./permission-reply.ts";
import { cleanReadText, highlightRead, pathOfArgs } from "./read-highlight.ts";
import { type SpillView, spillView } from "./spill-view.ts";
import type { DisplayItem, ToolItem } from "./state.ts";
import {
  subAgentEarlierRow,
  subAgentHeadRow,
  subAgentOutcomeNote,
  subAgentReport,
  subAgentRow,
  subAgentView,
} from "./subagent-view.ts";
import { dashedRule, theme, themeMode } from "./theme.ts";
import { EXPAND_HINT, fitSubtitle, isExpanded } from "./tool-expand.ts";
import { queuedRow } from "./tool-phase-view.ts";
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
   * The shared blink phase (ms) of running tool calls: `blink.ts` decides the
   * glyph from it. One value for the whole transcript, so every running call
   * blinks in sync (docs/feat/tui-tool-blink.md). 0 renders the ON phase.
   */
  readonly blinkPhase?: number;
  /**
   * The daemon runs in a pod (`run`/`attach`): a spilled result's file is
   * "saved in the pod to" its path. Constant for an App's lifetime (the
   * runtime the laptop started), so it is not part of the row-cache key.
   */
  readonly spillInPod?: boolean;
  /**
   * The tool calls whose full command is shown wrapped under the header (a
   * left click on one call; docs/feat/tui-tool-expand.md). Keyed by the call's
   * stable id, sorted, so per-item cache keys stay cheap. Ctrl+O (`expandAll`)
   * shows every call's command, which subsumes this set.
   */
  readonly expandedIds?: readonly string[];
}

const DEFAULT_THRESHOLD = 8;
const DEFAULT_PREVIEW = 6;
const DEFAULT_WIDTH = 80;
// Two-column prefixes under an item: a plain indent, or the corner connector
// that marks a tool's output block (Claude-Code style). Both are 2 columns so
// bodies stay aligned whichever is used.
const INDENT = "  ";
/** Read at CALL time: a module-load capture would freeze the palette (and the mode). */
const connector = (): string => `${theme.subtle("⎿")} `;
// An expanded call's command, on the rows under its header (owner mockup):
// 4 display columns, so the command never wraps under the bullet.
const COMMAND_PREFIX = "  │ ";
// Below this fraction of changed characters, a removed/added line pair is shown
// with word-level highlighting; above it, the whole line is tinted instead.
const WORD_DIFF_MAX_RATIO = 0.4;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI SGR codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI SGR colour codes, leaving the plain display text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
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

/**
 * The nested progress block for a sub-agent (`agent_task`) call: the head, how
 * many earlier steps are not shown, then a ROLLING TAIL of its latest steps
 * (docs/feat/subagent-tail-view.md — eval A5, the owner's 2026-11-07 decision,
 * Opus mockup 1). `width` is the body's, so a long label is cut by CELLS here
 * rather than wrapped into an extra row. Ctrl+O (`expanded`) keeps the whole
 * kept trail.
 */
function subAgentLines(tool: ToolItem, width: number, expanded: boolean): string[] {
  const sub = tool.sub;
  if (!sub) {
    return [];
  }
  // Ctrl+O keeps the whole kept trail (the escape hatch, as before).
  const view = subAgentView(sub, expanded ? { maxRows: Number.POSITIVE_INFINITY } : {});
  const out = [theme.subtle(`${theme.accent("◆")} ${subAgentHeadRow(view.head, width)}`)];
  const earlier = subAgentEarlierRow(view.hidden, expanded);
  if (earlier !== null) {
    // The existing ellipsis grammar, pointed at the past instead of the future.
    out.push(theme.subtle(truncateCells(earlier, width)));
  }
  const closing = view.done?.closing;
  view.rows.forEach((label, i) => {
    // The last row closes the block on a CLEAN end; a non-clean one closes on
    // its own row below (review M3 / Q2).
    const last = i === view.rows.length - 1 && view.done !== null && closing === undefined;
    const prefix = `${last ? "└─" : "├─"} `;
    // A `├─ `/`└─ ` row is padded and pre-wrapped to the body's width: the
    // transcript's `wrapLines` then leaves it alone, so a wrapped label's
    // continuation stays under its own row instead of restarting at column 0
    // with a mid-word break (review N2). Same seam as `commandRows`.
    out.push(...subAgentStepRow(prefix, label, width, expanded));
  });
  if (closing !== undefined) {
    out.push(`${theme.subtle("└─")} ${theme.error(closing)}`);
  } else if (view.done === null) {
    out.push(theme.subtle("└─ …"));
  }
  return out;
}

/**
 * One step row of a sub-agent's tree. Collapsed, `subAgentRow` cuts the label by
 * CELLS on a single row (the tail is a summary, not a flood). Expanded, the label
 * is whole, so it is wrapped HERE to `width - prefix` and every continuation row
 * is indented to the LABEL's column: each row already fits the width, so the
 * transcript's `wrapLines` leaves it alone instead of re-breaking the joined row
 * at column 0 (review N2). Same seam as `commandRows`.
 */
function subAgentStepRow(
  prefix: string,
  label: string,
  width: number,
  expanded: boolean,
): readonly string[] {
  // The cut-vs-whole decision is the view-model's (`subAgentRow`); this only
  // wraps and indents it.
  const text = subAgentRow(label, width, expanded);
  if (!expanded) {
    return [theme.subtle(`${prefix}${text}`)];
  }
  const indent = " ".repeat(stringWidth(prefix));
  const room = Math.max(1, width - stringWidth(prefix));
  return wrapLines([expandTabs(text)], room).map((row, i) =>
    theme.subtle(`${i === 0 ? prefix : indent}${row}`),
  );
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

function toolBody(tool: ToolItem, width: number, inPod: boolean, fit: BodyFit): string[] {
  const hook = hookLines(tool);
  if (!hook) {
    return plainToolBody(tool, width, inPod, fit);
  }
  const line = theme.subtle("hook ") + theme.accent(hook.name) + theme.subtle(hook.rest);
  const reason = hook.reason.map((l) => theme.subtle(l));
  return [line, ...reason, ...(hook.replacesBody ? [] : plainToolBody(tool, width, inPod, fit))];
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

/**
 * The note, the path (expanded only), the head, the omitted line, the tail.
 * `dropNote` removes one trailing already-coloured line: a sub-agent's spilled
 * report carries `agent_task`'s `_(sub-agent …)_` note at its end, and the
 * block's closing row already says it (review N3).
 */
function spillBody(
  tool: ToolItem,
  spill: ToolResultSpill,
  expanded: boolean,
  inPod: boolean,
  dropNote?: string,
): string[] {
  const view = spillView(spill, { expanded, inPod });
  const [head, tail] = spillParts(tool, view);
  const plain = (l: string): string => stripAnsi(l).trim();
  const rest =
    dropNote !== undefined && tail.length > 0 && plain(tail[tail.length - 1] ?? "") === dropNote
      ? tail.slice(0, -1)
      : tail;
  return [
    theme.subtle(view.note),
    ...(view.where !== undefined ? [theme.subtle(view.where)] : []),
    ...head,
    ...(view.omitted !== undefined ? [theme.subtle(view.omitted)] : []),
    ...rest,
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
      : highlightRead(cleanReadText(tool.resultText), path, themeMode(), limit);
  slots.set(limit, lines);
  return lines;
}

function plainToolBody(tool: ToolItem, width: number, inPod: boolean, fit: BodyFit): string[] {
  if (tool.detail?.kind === "diff") {
    return diffBody(tool.detail, width);
  }
  const expanded = fit.expanded;
  // Sub-agent (`agent_task`): the rolling tail, then its report (when done).
  // The TREE is exempt from the generic top-collapse (`toolLines`, review H1):
  // it is what the block exists to show, and a finished child's report used to
  // push its newest step, its closing row AND the report itself out of view,
  // leaving two different cut markers stacked in one block. Only the report
  // collapses, with the transcript's own marker.
  if (tool.sub) {
    const tree = subAgentLines(tool, width, expanded);
    if (tool.status === "running") {
      return tree;
    }
    const report = tool.spill
      ? spillBody(tool, tool.spill, expanded, inPod, subAgentOutcomeNote(tool.sub.stopReason))
      : tool.resultText && tool.resultText.length > 0
        ? subAgentReport(tool.resultText, tool.sub.stopReason)
            .split("\n")
            .map((l) => theme.subtle(l))
        : [];
    // Folded to the body's width FIRST, then cut (review N1): the cut counts ROWS
    // the terminal draws, not logical lines. A prose report is paragraphs on
    // single long lines, so counting lines let 8 of them through uncut and the
    // block rendered 49/65/81 rows at 80/60/46 columns — the newest steps
    // scrolled off the top, exactly what this block exists to prevent.
    const folded = report.flatMap((l) => wrapLines([l], width));
    return [...tree, ...(folded.length > 0 ? ["", ...collapsedBody(folded, fit)] : [])];
  }
  if (tool.status === "running") {
    return [theme.subtle("running…")];
  }
  if (tool.status === "queued") {
    return [];
  }
  // Spilled: the structured fact, never the model's banner (docs/feat/tui-spill-note.md).
  if (tool.spill) {
    return spillBody(tool, tool.spill, expanded, inPod);
  }
  // Refused with a reply: the same, `✗ Denied · <text>` (docs/feat/permission-reply.md).
  if (tool.denialReply !== undefined) {
    return denialReplyLines(tool.denialReply).map((line, i) =>
      i === 0
        ? `${theme.error(DENIED_LABEL)}${theme.subtle(line.slice(DENIED_LABEL.length))}`
        : theme.subtle(line),
    );
  }
  if (tool.resultText && tool.resultText.length > 0) {
    if (tool.name === "fs_read" && tool.status !== "error") {
      const coloured = readLines(tool, fit.limit);
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
    return theme.accent(BULLET);
  }
  if (tool.status === "queued") {
    return theme.subtle(BULLET); // unreachable: a queued row has its own header (`toolLines`)
  }
  return tool.status === "ok" ? theme.success(BULLET) : theme.error(BULLET);
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

/**
 * The full command of an expanded call, wrapped to the terminal width and
 * prefixed `  │ ` on every row (owner mockup, docs/feat/tui-tool-expand.md).
 * Each command LINE is kept (a multi-line command stays multi-line); only its
 * wrapping is width-derived. Rows are folded here, not by the transcript's
 * `wrapLines`, because the prefix must repeat on each of them.
 */
function commandRows(subtitle: string, cols: number): string[] {
  const room = Math.max(1, cols - stringWidth(COMMAND_PREFIX));
  const rows: string[] = [];
  for (const line of expandTabs(subtitle).split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, "");
    const wrapped = trimmed === "" ? [""] : wrapLines([trimmed], room);
    for (const row of wrapped) {
      rows.push(theme.subtle(COMMAND_PREFIX) + row);
    }
  }
  return rows;
}

/**
 * The one place a long BODY is cut, shared by the generic tool body and a
 * sub-agent's report (a sub-agent's STEP TREE is exempt: review H1). Collapsed,
 * everything over `threshold` rows becomes the first `preview` plus
 * `… +N more lines · ctrl+o to expand`; expanded, the whole body.
 */
function collapsedBody(body: string[], fit: CollapseFit): string[] {
  if (fit.expanded || body.length <= fit.threshold) {
    return body;
  }
  const hidden = body.length - fit.preview;
  return [...body.slice(0, fit.preview), theme.subtle(`… +${hidden} more lines · ${EXPAND_HINT}`)];
}

/** How a body collapses: Ctrl+O shows it whole; else `threshold`/`preview` rows. */
interface CollapseFit {
  readonly expanded: boolean;
  readonly threshold: number;
  readonly preview: number;
}

/**
 * How a tool BODY is fitted: the collapse rules plus `readLines`' preview limit
 * (undefined = highlight the whole file). One value threaded down to
 * `plainToolBody`, which needs both.
 */
interface BodyFit extends CollapseFit {
  /** `readLines`' preview limit (undefined = highlight the whole file). */
  readonly limit: number | undefined;
}

function toolLines(tool: ToolItem, opts: RenderOptions): string[] {
  const cols = Math.max(1, Math.floor(opts.width ?? DEFAULT_WIDTH));
  if (tool.status === "queued") {
    // Approved, not started: one dim row, no body, no spinner.
    const row = queuedRow(toolTitle(tool));
    const head = `${row.glyph} ${row.label}`;
    const budget = cols - stringWidth(head) - stringWidth(row.suffix) - 2;
    const fitted = row.subtitle === "" ? "" : fitSubtitle(row.subtitle, budget);
    return [theme.subtle(`${head}${fitted === "" ? "" : ` ${fitted}`} ${row.suffix}`)];
  }
  const width = Math.max(20, cols - INDENT.length - 1);
  const elapsed = tool.durationMs !== undefined ? ` ${formatDurationMs(tool.durationMs)}` : "";
  const { label, subtitle } = toolTitle(tool);
  // Collapsed: the subtitle is cut to whatever the header has ROOM for on one
  // row at this terminal width (bullet + label + elapsed accounted for), not to
  // a fixed 72. Expanded (this call clicked, or Ctrl+O): the header drops the
  // subtitle and the whole command follows on `  │ ` rows under it.
  const head = `${bullet(tool)} ${chalk.bold(label)}`;
  const expanded = opts.expandAll === true || isExpanded(opts.expandedIds ?? [], tool.id);
  const budget = cols - (stringWidth(BULLET) + 1 + stringWidth(label)) - stringWidth(elapsed) - 1;
  const fitted = expanded || subtitle === "" ? "" : fitSubtitle(subtitle, budget);
  const header = `${head}${fitted === "" ? "" : ` ${theme.subtle(fitted)}`}${theme.subtle(elapsed)}`;
  const command = expanded && subtitle !== "" ? commandRows(subtitle, cols) : [];

  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;
  const body = toolBody(tool, width, opts.spillInPod === true, {
    expanded: opts.expandAll === true,
    limit: opts.expandAll ? undefined : Math.max(threshold, preview),
    threshold,
    preview,
  });

  // The generic cut. A sub-agent body never reaches here uncut: its tree is
  // exempt and its report is already folded by `collapsedBody` inside
  // `plainToolBody` (review H1).
  const shown = tool.sub
    ? body
    : collapsedBody(body, { expanded: opts.expandAll === true, threshold, preview });
  // The first body line carries the corner connector; the rest align under it.
  return [header, ...command, ...shown.map((l, i) => (i === 0 ? connector() : INDENT) + l)];
}

/** A full-width grey rule with `text` in it: `── text ─────…`. */
function separatorLines(text: string, width: number): string[] {
  const head = `── ${text} `;
  const rest = Math.max(2, width - stringWidth(head));
  return [theme.subtle(`${head}${"─".repeat(rest)}`)];
}

function noticeLines(text: string, expanded: boolean, hint?: string, body?: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  const lines = [
    `${theme.notice("⏺")} ${theme.notice(first)}`,
    ...rest.map((l) => `  ${theme.notice(l)}`),
  ];
  if (hint) {
    // The hint ends the last line, grey: a separate field, never cut out of the text.
    lines[lines.length - 1] += ` ${theme.subtle(hint)}`;
  }
  if (body) {
    // A note's body (a finished sub-agent's report): shown when expanded (Ctrl+O),
    // else only hinted at, so a resume stays compact.
    if (expanded) {
      lines.push(...body.split("\n").map((l) => `  ${theme.notice(l)}`));
    } else {
      lines[lines.length - 1] += ` ${theme.subtle(EXPAND_HINT)}`;
    }
  }
  return lines;
}

/** Logical (pre-wrap) lines for a single display item. */
export function itemLines(item: DisplayItem, opts: RenderOptions): string[] {
  switch (item.kind) {
    case "user": {
      const rows = userLines(item.text, Math.floor(opts.width ?? DEFAULT_WIDTH));
      return item.restart ? [theme.subtle("restart prompt"), ...rows] : rows;
    }
    case "assistant":
      return assistantLines(item.text);
    case "tool":
      return toolLines(item, opts);
    case "notice":
      return item.separator
        ? separatorLines(item.text, Math.floor(opts.width ?? DEFAULT_WIDTH))
        : noticeLines(item.text, opts.expandAll === true, item.hint, item.body);
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
// Two slots per item — collapsed and expanded — plus a third for a call whose
// command alone is expanded (a left click, docs/feat/tui-tool-expand.md): that
// view differs from BOTH (the command block is there, the body is still the
// collapsed preview). Ctrl+O (`expandAll`) wins over the per-call set and uses
// the `expanded` slot, so a call clicked before Ctrl+O comes straight back from
// `command` when Ctrl+O is turned off again. A width / threshold / preview
// change invalidates all three (a fresh entry holds only the view just built).
//
// The blink glyph is NOT part of the cache: a row is always wrapped with the ON
// glyph `⏺` and the OFF phase swaps in the SAME character under the SGR conceal
// attribute (`fix/tui-blink-off-width`), so a phase tick changes one equal-width
// glyph in row 0 of an already-cached layout and re-wraps nothing at all
// (docs/feat/tui-tool-blink.md, finding 1). Swapping before/inside the wrap was
// the round-1 bug: the OFF glyph was 1 column, so the row wrapped differently
// and the transcript jumped a row at 1 Hz. Counting spaces is wrong wherever a
// terminal draws `⏺` narrower than `string-width` says — the same character is
// width-identical by construction, so the row cannot move in ANY terminal.
// The same property is what lets a CLICKED call keep blinking
// (docs/feat/tui-tool-expand.md point 7): the command block is below row 0, so
// it is untouched by the swap.
interface RowCacheEntry {
  readonly width: number;
  readonly threshold: number;
  readonly preview: number;
  collapsed?: readonly string[];
  expanded?: readonly string[];
  command?: readonly string[];
}
const rowCache = new WeakMap<DisplayItem, RowCacheEntry>();
/**
 * The OFF-phase variant of an already-wrapped row array, memoised on that array
 * (which is itself cached per item + width + slot). A tick therefore allocates
 * nothing after its first visit and the ON layout is never thrown away.
 */
const offPhaseCache = new WeakMap<readonly string[], readonly string[]>();

/** The same rows with the leading bullet concealed for the OFF phase. */
function offPhaseRows(rows: readonly string[]): readonly string[] {
  const hit = offPhaseCache.get(rows);
  if (hit) {
    return hit;
  }
  const [first = "", ...rest] = rows;
  // The FIRST `⏺` of row 0 is the bullet: `toolLines` opens the header with it.
  // Replacing only that one keeps the SGR codes around it and the rest of the
  // row (label, subtitle, duration) byte-identical — the conceal closes at
  // `ESC[28m` immediately after the glyph, so nothing else on the row is hidden.
  const swapped = [first.replace(BULLET, hiddenBullet()), ...rest];
  offPhaseCache.set(rows, swapped);
  return swapped;
}

/** This item's final wrapped rows, memoised on its identity + layout options. */
function itemRows(item: DisplayItem, opts: RenderOptions): readonly string[] {
  const width = Math.max(1, Math.floor(opts.width ?? DEFAULT_WIDTH));
  const expand = opts.expandAll;
  const threshold = opts.collapseThreshold ?? DEFAULT_THRESHOLD;
  const preview = opts.previewLines ?? DEFAULT_PREVIEW;
  // Only `tool` items collapse, so only their layout depends on
  // expand/threshold/preview/expandedIds; every other kind is a function of
  // width alone (always the `collapsed` slot) — except a notice with a BODY
  // (a sub-agent's report), whose body shows only when expanded.
  // (docs/feat/subagent-ledger-log.md)
  const expandMatters = item.kind === "tool" || (item.kind === "notice" && item.body !== undefined);
  const slot: "collapsed" | "expanded" | "command" = !expandMatters
    ? "collapsed"
    : expand
      ? "expanded"
      : item.kind === "tool" && isExpanded(opts.expandedIds ?? [], item.id)
        ? "command"
        : "collapsed";
  let entry = rowCache.get(item);
  if (
    entry &&
    entry.width === width &&
    (!expandMatters || (entry.threshold === threshold && entry.preview === preview))
  ) {
    const hit = entry[slot];
    if (hit) {
      return withPhase(item, hit, opts);
    }
  } else {
    entry = { width, threshold, preview };
    rowCache.set(item, entry);
  }
  const rows = wrapLines(itemLines(item, opts), width);
  entry[slot] = rows;
  return withPhase(item, rows, opts);
}

/**
 * The cached ON layout, or its concealed OFF twin while a running call is in
 * the OFF half of the shared cycle. Only a RUNNING tool is ever affected: a
 * settled call's `toolBullet` is `⏺` at every phase, so its rows are returned
 * as the very same array (the cache-hit identity the tests pin).
 */
function withPhase(
  item: DisplayItem,
  rows: readonly string[],
  opts: RenderOptions,
): readonly string[] {
  if (item.kind !== "tool" || item.status !== "running") {
    return rows;
  }
  return blinkOn(opts.blinkPhase ?? 0) ? rows : offPhaseRows(rows);
}

/** One laid-out item: its final wrapped rows and the global index of its first row. */
export interface LaidItem {
  readonly rows: readonly string[];
  readonly start: number;
  /**
   * The `DisplayItem.id` this item was laid out for (`""` for the kinds that
   * have none). It carries the tool-call id into the hit-test, so "which call is
   * under this row" needs no second index that a cache hit could leave stale
   * (`tool-hit.ts: toolCallAt`).
   */
  readonly id: string;
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
    laid.push({ rows, start: cursor, id: item.kind === "tool" ? item.id : "" });
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

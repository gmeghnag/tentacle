/**
 * How transcript rows become a thread of steps (docs/feat/mobile-tool-rows.md,
 * Design 2, mockup C). Pure and React-free (AGENTS §7): the screen memoises
 * `stepLayout(rows, running)` and each cell only draws what it is told.
 *
 * The contract is ONE list cell per row: the FlatList keeps `rows` as its data
 * (keys, "Show in chat" indices and open-at-end's follow are unchanged), and the
 * layout only says how a row draws — a reasoning row folded into a step draws
 * nothing (`hidden`); the live "Thinking…" node is the list's footer (`tail`).
 */
import { shellExitCode, shellRowParts } from "@tentacle/core";
import { chartRowSpec } from "./chart-row.ts";
import { type FileBodyView, fileBodyView } from "./file-body.ts";
import {
  type ToolNameParts,
  type ToolTone,
  bodyCommand,
  liveElapsed,
  outputView,
  rowSubtitle,
  spokenDuration,
  toolMeta,
  toolName,
} from "./tool-summary.ts";
import type { ContextRow, ReasoningRow, Row, ToolRow, ToolStatus } from "./transcript-rows.ts";

/** Draw the thread segment above / below a node. */
export interface ThreadPos {
  readonly up: boolean;
  readonly down: boolean;
}

export type StepCell =
  /** A reasoning row folded into a step, or into the live tail. */
  | { readonly kind: "hidden" }
  /**
   * A tool row; `thought` = the reasoning text folded into it, if any (live
   * only); `thoughtFirst` = a thought preceded it, text or stored placeholder
   * (docs/fix/thought-placeholder.md — "thought first" in its label).
   */
  | {
      readonly kind: "step";
      readonly thought: string | null;
      readonly thoughtFirst: boolean;
      readonly thread: ThreadPos;
    }
  /**
   * An orphan thought: reasoning with no tool to fold into (Owner Q1), drawn
   * `Thought · 12 s`, collapsed and not expandable (owner decision 2,
   * docs/fix/thought-placeholder.md). `ms` absent = not measured (no clock).
   */
  | { readonly kind: "thought"; readonly ms: number | undefined; readonly thread: ThreadPos }
  /**
   * A context reset or a compaction as a node of the rail
   * (docs/feat/mobile-reset-in-timeline.md 1A): the row's own body is drawn by
   * `contextRowView`, this only places it on the thread.
   */
  | { readonly kind: "context"; readonly thread: ThreadPos };

export interface StepLayout {
  /** By row key. A row absent from the map (user, text, notice) draws as today. */
  readonly cells: ReadonlyMap<string, StepCell>;
  /**
   * The live "Thinking…" footer node (Owner Q2), or null. `thought` is the live
   * reasoning ("" before any); `up` = it continues the thread of the node above.
   */
  readonly tail: { readonly thought: string; readonly up: boolean } | null;
}

const FINISHED: ReadonlySet<ToolStatus> = new Set(["ok", "error", "denied"]);

const HIDDEN: StepCell = { kind: "hidden" };

/** Reasoning texts joined by a blank line; null when they say nothing. */
function joined(rows: readonly ReasoningRow[]): string | null {
  const texts = rows.map((r) => r.text.trim()).filter((t) => t !== "");
  return texts.length === 0 ? null : texts.join("\n\n");
}

/** A stored placeholder (a reload's reasoning row: no text, a duration). */
function placeheld(rows: readonly ReasoningRow[]): boolean {
  return rows.some((r) => r.ms !== undefined);
}

/** The runs' total duration, or undefined when none was measured. */
function totalMs(rows: readonly ReasoningRow[]): number | undefined {
  const measured = rows.flatMap((r) => (r.ms === undefined ? [] : [r.ms]));
  return measured.length === 0 ? undefined : measured.reduce((a, b) => a + b, 0);
}

/**
 * While `running`, the turn is "thinking" when the last row is reasoning, a
 * finished tool (and no tool of its trailing batch still runs or waits), the
 * user's own prompt, or a context step (a reset / compaction starts a new round,
 * so the model is about to answer). Streaming text or a running tool is its own
 * signal.
 */
function isThinking(rows: readonly Row[], running: boolean): boolean {
  const last = rows.at(-1);
  if (!running || last === undefined) {
    return false;
  }
  if (last.kind === "reasoning" || last.kind === "user" || last.kind === "context") {
    return true;
  }
  if (last.kind !== "tool") {
    return false;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind !== "tool") {
      break;
    }
    if (!FINISHED.has(row.status)) {
      return false;
    }
  }
  return true;
}

type Node = { key: string } & (
  | { kind: "step"; thought: string | null; thoughtFirst: boolean }
  | { kind: "thought"; ms: number | undefined }
  | { kind: "context" }
);

/** The tool that renews the model's context (its call is one fact with the reset step). */
const CONTEXT_RESET_TOOL = "context_reset";

/**
 * The first row after `from` that says a FACT (a step, a text, a context step…),
 * skipping reasoning: thinking is not a node boundary for the Q3-A merge — a
 * thought between a `context_reset` call and the reset it caused belongs to the
 * round before, and is flushed as an orphan Thought either way.
 */
function nextFactRow(rows: readonly Row[], from: number): Row | undefined {
  for (let i = from + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined && row.kind !== "reasoning") {
      return row;
    }
  }
  return undefined;
}

/**
 * The keys of the `context_reset` calls that draw NOTHING (owner Q3-A): a
 * successful call immediately followed by the reset step it produced is the same
 * fact, so live shows one node — exactly what a reopen shows (the call is
 * discarded with the old history). A running, failed or denied call stays an
 * ordinary step: no reset happened.
 */
function mergedResetCalls(rows: readonly Row[]): ReadonlySet<string> {
  const merged = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (row.kind !== "tool" || row.name !== CONTEXT_RESET_TOOL || row.status !== "ok") {
      continue;
    }
    const next = nextFactRow(rows, i);
    if (next?.kind === "context" && next.event === "reset") {
      merged.add(row.key);
    }
  }
  return merged;
}

/**
 * `isBlock`: a tool row that draws as a block instead of a step (a chart, an
 * artifact card). It is not a node: like assistant text, it ends the run and is
 * absent from `cells`, and no thought folds into it.
 */
export function stepLayout(
  rows: readonly Row[],
  running: boolean,
  isBlock: (row: ToolRow) => boolean = () => false,
): StepLayout {
  const thinking = isThinking(rows, running);
  const merged = mergedResetCalls(rows);
  const cells = new Map<string, StepCell>();
  // Nodes per run, in order; a run ends at any row that is not a step/thought/
  // context step (hidden cells are transparent).
  const runs: Node[][] = [[]];
  let pending: ReasoningRow[] = [];

  const node = (n: Node): void => {
    runs[runs.length - 1]?.push(n);
  };
  const endRun = (): void => {
    if ((runs.at(-1)?.length ?? 0) > 0) {
      runs.push([]);
    }
  };
  /** Reasoning with no tool to fold into: one Thought node (or nothing, if empty). */
  const flushOrphan = (): void => {
    const first = pending[0];
    if (first !== undefined) {
      for (const r of pending) {
        cells.set(r.key, HIDDEN);
      }
      if (joined(pending) !== null || placeheld(pending)) {
        node({ key: first.key, kind: "thought", ms: totalMs(pending) });
      }
    }
    pending = [];
  };

  let batchOpen = false; // the previous non-hidden row was a tool (a parallel batch)
  for (const row of rows) {
    if (row.kind === "reasoning") {
      pending.push(row);
      batchOpen = false;
      continue;
    }
    if (row.kind === "context") {
      // A step of the rail like a tool's: the reasoning written before it belongs
      // to the round it ENDED, so it flushes as an orphan Thought (never folds
      // into the new round), then the context step joins the thread.
      flushOrphan();
      node({ key: row.key, kind: "context" });
      batchOpen = false;
      continue;
    }
    if (row.kind === "tool" && !isBlock(row)) {
      if (merged.has(row.key)) {
        // The call that caused the reset step below it: one fact, one node (Q3-A).
        // Transparent like a folded reasoning row: it neither ends the run nor
        // opens a batch.
        cells.set(row.key, HIDDEN);
        continue;
      }
      let thought: string | null = null;
      let thoughtFirst = false;
      if (pending.length > 0) {
        for (const r of pending) {
          cells.set(r.key, HIDDEN);
        }
        thought = joined(pending);
        thoughtFirst = thought !== null || placeheld(pending);
        pending = [];
      }
      node({
        key: row.key,
        kind: "step",
        thought: batchOpen ? null : thought,
        thoughtFirst: !batchOpen && thoughtFirst,
      });
      batchOpen = true;
      continue;
    }
    flushOrphan();
    endRun();
    batchOpen = false;
  }

  // Trailing reasoning: the live tail shows it, else it is an orphan.
  let tailThought = "";
  if (thinking && pending.length > 0) {
    for (const r of pending) {
      cells.set(r.key, HIDDEN);
    }
    tailThought = joined(pending) ?? "";
    pending = [];
  } else {
    flushOrphan();
  }

  // The tail continues the thread only if the last non-hidden row is a node.
  const last = runs.at(-1) ?? [];
  const tailJoins = thinking && last.length > 0;

  for (const run of runs) {
    run.forEach((n, i) => {
      const thread: ThreadPos = {
        up: i > 0,
        down: i < run.length - 1 || (tailJoins && run === last),
      };
      cells.set(
        n.key,
        n.kind === "step"
          ? { kind: "step", thought: n.thought, thoughtFirst: n.thoughtFirst, thread }
          : n.kind === "context"
            ? { kind: "context", thread }
            : { kind: "thought", ms: n.ms, thread },
      );
    });
  }

  return { cells, tail: thinking ? { thought: tailThought, up: tailJoins } : null };
}

const STATUS_WORD: Readonly<Record<ToolStatus, string>> = {
  ok: "succeeded",
  error: "failed",
  denied: "denied",
  running: "running",
  queued: "queued",
};

/**
 * One VoiceOver label per step: `Bash, ls -la x, succeeded, 14 milliseconds,
 * thought first`. Parts the row does not know are left out, never invented.
 */
export function stepA11yLabel(
  row: Pick<ToolRow, "name" | "label" | "args" | "status" | "durationMs" | "diff">,
  thought: boolean,
): string {
  const name = toolName(row.name, row.label);
  const parts = [name.server === undefined ? name.tool : `${name.server} ${name.tool}`];
  const subtitle = rowSubtitle(row.name, row.args);
  if (subtitle !== "") {
    parts.push(subtitle);
  }
  parts.push(STATUS_WORD[row.status]);
  if (row.diff !== undefined) {
    parts.push(`${row.diff.added} added, ${row.diff.removed} removed`);
  } else if (row.durationMs !== undefined) {
    parts.push(spokenDuration(row.durationMs));
  }
  if (thought) {
    parts.push("thought first");
  }
  return parts.join(", ");
}

/**
 * The open-step set with `key` toggled: a sorted array, never mutated (the
 * TUI's `toggleExpanded` shape, `packages/tui/src/tool-expand.ts`). It lives in
 * the SCREEN, so a virtualised cell that unmounts does not lose it.
 */
export function toggleOpen(ids: readonly string[], key: string): readonly string[] {
  return ids.includes(key)
    ? ids.filter((i) => i !== key)
    : [...ids, key].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function isOpen(ids: readonly string[], key: string): boolean {
  return ids.includes(key);
}

// ── What one node is told to draw (S2: `ui/StepNode.tsx` only maps these) ──

/** The node on the thread: a green/red dot, a spinner, a hollow ring. */
export type StepDot = "ok" | "error" | "running" | "queued";

const DOT: Readonly<Record<ToolTone, StepDot>> = {
  ok: "ok",
  error: "error",
  running: "running",
  pending: "queued",
};

export interface StepRowView {
  readonly name: ToolNameParts;
  /** The one mono line after the name. */
  readonly subtitle: string;
  /**
   * A described `shell` call's `$ <first command line>`, drawn as a second
   * line UNDER the name (docs/feat/shell-intent-line.md §6); null: none (no
   * sentence, or the beta hides it).
   */
  readonly subline: string | null;
  /** The name shimmers (`ThinkingWord`): a described `shell` call while it runs. */
  readonly shimmer: boolean;
  readonly dot: StepDot;
  /**
   * `toolMeta`'s right-hand text: `+n −m`, `denied` or the duration — and NEVER
   * an outcome glyph: a done step's trailing is the duration alone, for a
   * success and a failure alike (owner 22/11, decision 1). A failure is told in
   * TEXT at the end of the `$` line (`exitSuffix`).
   */
  readonly trailing: string;
  readonly trailingRed: boolean;
  /**
   * The failure, written at the END of the `$ command` line: `exit 125` (owner
   * 22/11, decision 2 — the owner is colour-blind, so a red title is not enough).
   * `null`: nothing to write there — the trailing keeps today's red instead.
   */
  readonly exitSuffix: string | null;
  /** A running step with a known start and no trailing yet: the node ticks its own clock. */
  readonly live: boolean;
  /**
   * The body, in order: the command, the result. NEVER the reasoning folded
   * into the step (owner 21/11, docs/fix/mobile-running-row.md). A described
   * `shell` step whose `$` line is drawn leaves the command OUT (owner 22/11,
   * decision 5): it is already on that line, once.
   */
  readonly command: readonly string[];
  /**
   * The result, one line per row, at the text column (no `⎿`, no indent —
   * decision 5). The TAIL of a long log: `hidden` EARLIER lines wait for "show
   * all". Drawn neutral (the failure is `exitSuffix`). Null: no result.
   */
  readonly output: {
    readonly text: string;
    readonly hidden: number;
  } | null;
  /**
   * A FILE tool's coloured content (docs/feat/mobile-file-view.md part 1), or
   * undefined for every other tool. When present it IS the body: `command` and
   * `output` are empty (the step line and this header already said the path and
   * the counts), and `ui/FileBody.tsx` draws it.
   */
  readonly file?: FileBodyView;
  /** False when the body would be empty (no command, result, diff or reply). */
  readonly tappable: boolean;
  readonly a11yLabel: string;
}

/**
 * A tool row as its step node draws it; `full` = every output line (the screen's
 * show-all set). `thought` (the reasoning folded into it) only sets the default of
 * `thoughtFirst` — VoiceOver's "thought first" — and is never drawn in the body.
 */
export function stepRowView(
  row: ToolRow,
  thought: string | null,
  full: boolean,
  thoughtFirst: boolean = thought !== null,
  compact = false,
): StepRowView {
  const meta = toolMeta(row);
  const dot = DOT[meta.tone];
  // A `shell` call the model described: the sentence is the name, the command
  // a `$` line under it, the failure WRITTEN at that line's end. No sentence
  // ⇒ `null` ⇒ the view below, unchanged.
  const shell = row.name === "shell" ? shellRowParts(row.args, row.status, compact) : null;
  const sublineShown = shell?.commandRow === true;
  // The exit code lives on the `$` line (decision 2): only when that line is
  // drawn, and only when the result states a code (never invented).
  const exitSuffix = sublineShown ? shellExitSuffix(row) : null;
  // The command appears ONCE (decision 5): the body drops it exactly when the
  // step's own line already shows that same text — the `$` sub-line of a
  // described shell call, or a plain row whose subtitle IS its one command. A
  // multi-line command (only its first line fits the line) is never dropped: the
  // body is then the only place it reads in full.
  const command = bodyCommand(row.name, row.args);
  const subtitle = shell === null ? rowSubtitle(row.name, row.args) : "";
  const lineShows = shell !== null && sublineShown ? firstLine(shell.command) : subtitle;
  const oneLine = command.length === 1 ? command[0] : null;
  const bodyCommandLines = oneLine !== null && oneLine === lineShows ? [] : command;
  // Decision 5 applies to an ok step too, and to the beta's compact path: a
  // described shell call's body never opens with `exit=N`. A failure's code is
  // on the `$` line (always drawn for an error or a denial), and a success's
  // `exit=0` is no information — even when the line itself is hidden.
  const cut = outputView(shell === null ? (row.output ?? "") : withoutExitLine(row.output), {
    full,
    error: row.status === "error",
  });
  const output =
    cut.lines.length === 0
      ? null
      : {
          text: cut.lines.join("\n"),
          hidden: cut.hidden,
        };
  // A file tool's content REPLACES the plain body (docs/feat/mobile-file-view.md):
  // the tool's own result line (`edited … with 2 edits (+78 -30)`, the raw
  // `[path lines 1-12 of 521]` header) is never drawn, and neither is the
  // command line — the step's own line already names the path.
  const file = fileBodyView(row, full) ?? undefined;
  return {
    name: shell === null ? toolName(row.name, row.label) : { tool: shell.sentence },
    subtitle,
    subline: sublineShown ? `$ ${firstLine(shell.command)}` : null,
    shimmer: shell !== null && dot === "running",
    dot,
    trailing: meta.trailing,
    trailingRed: exitSuffix === null && (row.status === "error" || row.status === "denied"),
    exitSuffix,
    live: dot === "running" && row.at !== undefined && meta.trailing === "",
    ...(file === undefined ? {} : { file }),
    command: file === undefined ? bodyCommandLines : [],
    output: file === undefined ? output : null,
    tappable:
      file !== undefined ||
      bodyCommandLines.length > 0 ||
      output !== null ||
      row.diff !== undefined ||
      row.denialReply !== undefined,
    a11yLabel:
      shell === null
        ? stepA11yLabel(row, thoughtFirst)
        : shellA11yLabel(row, shell.sentence, thoughtFirst),
  };
}

/** A command's first line, `…` when it has more. */
function firstLine(command: string): string {
  const lines = command.split(/\r?\n/);
  return `${lines[0] ?? ""}${lines.length > 1 ? "…" : ""}`;
}

/**
 * A failed `shell` row's `exit N`, read from its own result (the spill head
 * first), or `null` when the result states no code — never invented, and never
 * for a denial or a tool error that carries none.
 */
function shellExitSuffix(row: ToolRow): string | null {
  if (row.status !== "error") {
    return null;
  }
  const code = shellExitCode(row.spill?.head ?? row.output);
  return code === null ? null : `exit ${code}`;
}

/**
 * A described shell call's result without its leading `exit=N` line: that code
 * is on the `$` line now (drawn for a success too — decision 5 has no ok
 * exception, and it does not depend on that line being drawn: with the beta's
 * compactShell the line is hidden and `exit=0` still says nothing).
 */
function withoutExitLine(output: string | undefined): string {
  return (output ?? "").replace(/^exit=-?\d+(?:\r?\n|$)/, "");
}

/** VoiceOver for a described shell row: the sentence, then the outcome in words. */
function shellA11yLabel(row: ToolRow, sentence: string, thought: boolean): string {
  const parts = [sentence, STATUS_WORD[row.status]];
  if (row.status === "error") {
    const code = shellExitCode(row.spill?.head ?? row.output);
    if (code !== null) {
      parts.push(`exit code ${code}`);
    }
  }
  if (row.durationMs !== undefined) {
    parts.push(spokenDuration(row.durationMs));
  }
  if (thought) {
    parts.push("thought first");
  }
  return parts.join(", ");
}

/**
 * An orphan thought's line (docs/fix/thought-placeholder.md, owner decision 2):
 * `Thought · 12 s`, collapsed and NOT expandable, live and after a reload alike
 * — only the duration is ever stored, so live shows no more than a reload can.
 */
export function thoughtRowView(cell: { readonly ms: number | undefined }): {
  readonly subtitle: string;
  readonly expandable: false;
  readonly a11yLabel: string;
} {
  const ms = cell.ms;
  if (ms === undefined) {
    return { subtitle: "", expandable: false, a11yLabel: `Thought. ${NOT_KEPT}` };
  }
  const seconds = Math.floor(ms / 1000);
  return {
    subtitle: `· ${seconds < 1 ? "<1 s" : liveElapsed(ms)}`,
    expandable: false,
    a11yLabel: `Thought for ${
      seconds < 1
        ? "under a second"
        : seconds < 60
          ? `${seconds} ${seconds === 1 ? "second" : "seconds"}`
          : spokenDuration(seconds * 1000)
    }. ${NOT_KEPT}`,
  };
}

const NOT_KEPT = "The thinking itself is not kept.";

// ── A context reset / compaction step (docs/feat/mobile-reset-in-timeline.md) ──

/**
 * How many SOURCE lines of a reset prompt / compaction summary an open step
 * shows before "show all" (owner Q2-A): the tool output's own rule, in lines of
 * markdown rather than of a log, so the cut's fence rule below can hold.
 */
export const CONTEXT_BODY_LINES = 12;

export interface ContextRowView {
  /** The glyph's node: `↺` for a reset, `⤡` for a compaction. */
  readonly node: "reset" | "compact";
  readonly name: string;
  /** The reset prompt's first line (marks stripped) or the compaction's figures. */
  readonly subtitle: string;
  /** The subtitle is the prompt's own prose: drawn italic, like a thought's line. */
  readonly italic: boolean;
  /**
   * The open body: markdown source, its first `CONTEXT_BODY_LINES` lines unless
   * `full`; `hidden` = the source lines held back (0 when all are shown). Null
   * when the body says nothing: never an empty expansion
   * (`ui-empty-action-standard`).
   */
  readonly body: { readonly text: string; readonly hidden: number } | null;
  /** False when there is no body to open. */
  readonly tappable: boolean;
  readonly a11yLabel: string;
}

/**
 * A context reset or a compaction as its rail step (owner 1A/2A): ONE line —
 * the name, then the prompt's first line in italic or the figures in mono — and,
 * when opened, the body as markdown in secondary grey, capped at
 * `CONTEXT_BODY_LINES` source lines with "show all" (`full`) for the rest.
 *
 * Always ONE element, never cut inside a ``` fence: a cut that would fall in the
 * middle of a code block moves back to the fence's opening line, so an open step
 * never draws a code block with no close (or — if the fence opens on line 1 — it
 * runs on past its close instead, since there is no room to move back to).
 */
export function contextRowView(row: ContextRow, full: boolean): ContextRowView {
  const reset = row.event === "reset";
  const subtitle = reset ? firstSourceLine(row.body) : (row.figures ?? "");
  const cut = contextBody(row.body, full);
  return {
    node: reset ? "reset" : "compact",
    name: reset ? "Context reset" : "Compacted",
    subtitle,
    italic: reset && subtitle !== "",
    body: cut,
    tappable: cut !== null,
    a11yLabel: contextA11yLabel(reset, row, subtitle),
  };
}

/** The prompt's first line with its markdown marks stripped, or `""`. */
function firstSourceLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = stripMarks(line);
    if (text !== "") {
      return text;
    }
  }
  return "";
}

/**
 * The marks a prompt's opening line may carry, dropped so the step reads as
 * prose: an ATX heading's `#`s, a list's bullet, bold/italic/strike marks and
 * inline-code backticks. Only the LINE, never the body: the body is markdown and
 * is rendered as such.
 */
function stripMarks(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The body a step opens: its first `CONTEXT_BODY_LINES` source lines (never a
 * cut inside a fence), or all of it when `full`. Null for a blank body.
 */
function contextBody(
  body: string,
  full: boolean,
): { readonly text: string; readonly hidden: number } | null {
  const lines = body.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.every((line) => line.trim() === "")) {
    return null;
  }
  if (full || lines.length <= CONTEXT_BODY_LINES) {
    return { text: lines.join("\n"), hidden: 0 };
  }
  const cut = safeCut(lines);
  return { text: lines.slice(0, cut).join("\n"), hidden: lines.length - cut };
}

/**
 * Where an open step's body may be cut so that no ``` fence is left open: the
 * cap (`CONTEXT_BODY_LINES`), unless that lands inside a fence — then the fence's
 * opening line; and if that opening is line 1, the fence's own close instead
 * (moving back is impossible, so it runs on rather than break the block).
 */
function safeCut(lines: readonly string[]): number {
  const open = [...lines.slice(0, CONTEXT_BODY_LINES)].map(isFence);
  const fencesBefore = open.filter(Boolean).length;
  if (fencesBefore % 2 === 0) {
    return CONTEXT_BODY_LINES;
  }
  const opening = open.lastIndexOf(true);
  if (opening > 0) {
    return opening;
  }
  for (let i = CONTEXT_BODY_LINES; i < lines.length; i++) {
    if (isFence(lines[i] ?? "")) {
      return i + 1;
    }
  }
  return lines.length;
}

/** A ``` fence line (its info string may follow on the opening one). */
function isFence(line: string): boolean {
  return line.trim().startsWith("```");
}

/**
 * VoiceOver for a context step: the name, then what it holds — the prompt's
 * first line, or the figures spoken in words (the `→` arrow is not read
 * reliably, and an estimated figure says so).
 */
function contextA11yLabel(reset: boolean, row: ContextRow, subtitle: string): string {
  if (reset) {
    return subtitle === "" ? "Context reset" : `Context reset. Restart prompt: ${subtitle}`;
  }
  const figures = row.figures;
  if (figures === undefined || figures === "") {
    return "Compacted";
  }
  return `Compacted, ${spokenFigures(figures)}`;
}

/** `ctx 182k → ~9k` as VoiceOver reads it: `context 182k to about 9k`. */
function spokenFigures(figures: string): string {
  const match = /^ctx (\d+(?:\.\d+)?k) → (~?)(\d+(?:\.\d+)?k)$/.exec(figures);
  if (match === null) {
    return figures;
  }
  const [, from, approximate, to] = match;
  return `context ${from} to ${approximate === "~" ? "about " : ""}${to}`;
}

/** The footer's VoiceOver label: `Thinking`, then `Thinking, 12 seconds`. */
export function thinkingA11yLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) {
    return "Thinking";
  }
  return `Thinking, ${
    seconds < 60
      ? `${seconds} ${seconds === 1 ? "second" : "seconds"}`
      : spokenDuration(seconds * 1000)
  }`;
}

/**
 * The screen's `isBlock` for `stepLayout`: a tool row that `TranscriptRow` draws
 * as a block, not a step — a presented artifact (its card) or a chart call whose
 * spec re-validates (the chart takes the row's place, `chart-row.ts`). A forged
 * spec or a failed chart call keeps the generic row, so it stays a step.
 */
export function isBlockRow(row: ToolRow): boolean {
  return row.artifact !== undefined || chartRowSpec(row) !== null;
}

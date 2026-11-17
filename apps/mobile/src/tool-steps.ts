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
import { rowSubtitle, spokenDuration, toolName } from "./tool-summary.ts";
import type { ReasoningRow, Row, ToolRow, ToolStatus } from "./transcript-rows.ts";

/** Draw the thread segment above / below a node. */
export interface ThreadPos {
  readonly up: boolean;
  readonly down: boolean;
}

export type StepCell =
  /** A reasoning row folded into a step, or into the live tail. */
  | { readonly kind: "hidden" }
  /** A tool row; `thought` = the reasoning folded into it, if any. */
  | { readonly kind: "step"; readonly thought: string | null; readonly thread: ThreadPos }
  /** An orphan thought: reasoning with no tool to fold into (Owner Q1). */
  | { readonly kind: "thought"; readonly text: string; readonly thread: ThreadPos };

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

/**
 * While `running`, the turn is "thinking" when the last row is reasoning, a
 * finished tool (and no tool of its trailing batch still runs or waits), or the
 * user's own prompt. Streaming text or a running tool is its own signal.
 */
function isThinking(rows: readonly Row[], running: boolean): boolean {
  const last = rows.at(-1);
  if (!running || last === undefined) {
    return false;
  }
  if (last.kind === "reasoning" || last.kind === "user") {
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
  | { kind: "step"; thought: string | null }
  | { kind: "thought"; text: string }
);

export function stepLayout(rows: readonly Row[], running: boolean): StepLayout {
  const thinking = isThinking(rows, running);
  const cells = new Map<string, StepCell>();
  // Nodes per run, in order; a run ends at any row that is not a step/thought
  // (hidden cells are transparent).
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
      const text = joined(pending);
      if (text !== null) {
        node({ key: first.key, kind: "thought", text });
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
    if (row.kind === "tool") {
      let thought: string | null = null;
      if (pending.length > 0) {
        for (const r of pending) {
          cells.set(r.key, HIDDEN);
        }
        thought = joined(pending);
        pending = [];
      }
      node({ key: row.key, kind: "step", thought: batchOpen ? null : thought });
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
          ? { kind: "step", thought: n.thought, thread }
          : { kind: "thought", text: n.text, thread },
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

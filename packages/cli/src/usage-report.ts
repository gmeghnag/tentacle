/**
 * `tentacle logs --usage`'s deciding (docs/feat/token-usage-log.md): the
 * per-round `usage` entries of a session's log as rows and totals. Pure — no
 * I/O, no clock, no colour — so the arithmetic and the layout are understood
 * and tested here, not inside the command (`logs-cmd.ts` finds the file).
 *
 * An unmeasured value stays ABSENT: a row the provider reported no cache hit
 * for shows `—`, never `0` (a 0 would claim a full miss, a measurement nobody
 * made). Totals sum what exists and say so.
 */
import type { KnownLogEntry } from "@tentacle/protocol";
import { untrustedText } from "./untrusted-text.ts";

/** One model round's spend, as the session log recorded it. */
export interface UsageRow {
  /** 0-based round inside the turn; absent on the forced final report. */
  readonly round?: number;
  /** The no-tools report a spent step budget forces. */
  readonly final?: boolean;
  readonly turnId?: string;
  readonly model?: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Absent: the provider did not report the cache split. */
  readonly cachedPromptTokens?: number;
  /** How many messages the request carried (the context it sent). */
  readonly messages?: number;
  /** The entry's own timestamp (display only). */
  readonly ts: number;
}

export interface UsageTotals {
  readonly rounds: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Tokens of prompt served from cache, over the rows that reported it. */
  readonly cachedPromptTokens: number;
  /** How many rows reported a cache split (so a total of 0 is never read as "no hit"). */
  readonly cachedRows: number;
}

export interface UsageReport {
  readonly rows: readonly UsageRow[];
  readonly totals: UsageTotals;
}

/** The `usage` entries of a log, in log order, as rows (everything else is ignored). */
export function usageRows(entries: readonly KnownLogEntry[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const entry of entries) {
    if (entry.type !== "usage") {
      continue;
    }
    rows.push({
      ...(entry.round !== undefined ? { round: entry.round } : {}),
      ...(entry.final === true ? { final: true } : {}),
      ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      ...(entry.cachedPromptTokens !== undefined
        ? { cachedPromptTokens: entry.cachedPromptTokens }
        : {}),
      ...(entry.messages !== undefined ? { messages: entry.messages } : {}),
      ts: entry.ts,
    });
  }
  return rows;
}

/** The totals over `rows`: what exists is summed, what is absent is counted, never invented. */
export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let cachedRows = 0;
  for (const row of rows) {
    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    if (row.cachedPromptTokens !== undefined) {
      cachedPromptTokens += row.cachedPromptTokens;
      cachedRows += 1;
    }
  }
  return { rounds: rows.length, promptTokens, completionTokens, cachedPromptTokens, cachedRows };
}

/** The report of a log's entries. */
export function usageReport(entries: readonly KnownLogEntry[]): UsageReport {
  const rows = usageRows(entries);
  return { rows, totals: usageTotals(rows) };
}

/** A row's round label: `r0`, `r1`, … or `final` for the forced report. */
function roundLabel(row: UsageRow): string {
  if (row.final === true) {
    return "final";
  }
  return row.round === undefined ? "?" : `r${row.round}`;
}

/** Right-align `text` in `width` (the table's columns are numbers). */
function right(text: string, width: number): string {
  return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

/**
 * The plain-text table: one line per round (round, model, messages sent, the
 * three token counts) and a `total` line. No colour and no escapes, so it reads
 * the same piped (`| cat`) as on a terminal. An unmeasured cell is `—`.
 */
export function formatUsage(report: UsageReport): string {
  const { rows, totals } = report;
  if (rows.length === 0) {
    return "[usage] no token usage was recorded in this session's current segment\n";
  }
  const cells = rows.map((row) => ({
    round: roundLabel(row),
    model: row.model === undefined ? "—" : untrustedText(row.model),
    messages: row.messages === undefined ? "—" : String(row.messages),
    prompt: String(row.promptTokens),
    completion: String(row.completionTokens),
    cached: row.cachedPromptTokens === undefined ? "—" : String(row.cachedPromptTokens),
  }));
  const header = {
    round: "round",
    model: "model",
    messages: "msgs",
    prompt: "input",
    completion: "output",
    cached: "cached",
  };
  const widths = {
    round: Math.max(header.round.length, ...cells.map((c) => c.round.length)),
    model: Math.max(header.model.length, ...cells.map((c) => c.model.length)),
    messages: Math.max(header.messages.length, ...cells.map((c) => c.messages.length)),
    prompt: Math.max(header.prompt.length, ...cells.map((c) => c.prompt.length)),
    completion: Math.max(header.completion.length, ...cells.map((c) => c.completion.length)),
    cached: Math.max(header.cached.length, ...cells.map((c) => c.cached.length)),
  };
  const line = (c: typeof header): string =>
    [
      right(c.round, widths.round),
      right(c.model, widths.model),
      right(c.messages, widths.messages),
      right(c.prompt, widths.prompt),
      right(c.completion, widths.completion),
      right(c.cached, widths.cached),
    ].join("  ");
  const total = {
    round: "total",
    // `—` in every cell the total does not measure: an empty string would
    // collapse the column separators and misalign the row under them.
    model: "—",
    messages: "—",
    prompt: String(totals.promptTokens),
    completion: String(totals.completionTokens),
    cached: totals.cachedRows === 0 ? "—" : String(totals.cachedPromptTokens),
  };
  const out = [
    line(header),
    ...cells.map(line),
    line(total),
    totals.cachedRows === 0
      ? `[usage] ${totals.rounds} round(s), ${totals.promptTokens} in / ${totals.completionTokens} out (the provider reported no cache split)\n`
      : `[usage] ${totals.rounds} round(s), ${totals.promptTokens} in / ${totals.completionTokens} out, ${totals.cachedPromptTokens} of the input served from cache (over ${totals.cachedRows} round(s))\n`,
  ];
  return out.join("\n");
}

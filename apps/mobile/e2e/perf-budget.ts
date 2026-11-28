/**
 * The AI-free perf budget (docs/feat/mobile-ui-fluidity-s0.md): reads the app's
 * `ptrace` lines (`src/perf-trace.ts`, written to the app's log file) after flow
 * `90-perf-stream` and says whether the session screen stayed fluid. Pure — no
 * I/O: `run.ts` reads the files and writes the report.
 */
import { PANES, PTRACE } from "../src/perf-trace.ts";
import type { AttemptStatus } from "./gate.ts";

/** The flow the budget is checked after. */
export const PERF_FLOW = "90-perf-stream";

export const PERF_BUDGET = {
  /** No JS frame gap longer than this in any jank window. */
  maxGapMs: 250,
  /** Every hub fan open finishes within this (never finishing fails too). */
  maxSettleMs: 1500,
  /** Screen renders per second, aggregated over the streaming jank windows. */
  maxRendersPerSecond: 11,
  /** Fewer fan opens under a stream than this is no evidence at all. */
  minStreamingFans: 4,
} as const;

/** How many violating lines a report quotes (the totals are always complete). */
const REPORT_LINES = 10;

const RULES = ["gap", "settle", "rate", "coupling", "evidence"] as const;

export interface PerfViolation {
  readonly rule: (typeof RULES)[number];
  readonly detail: string;
  /** The `ptrace` line at fault; absent for a verdict over the whole log. */
  readonly line?: string;
}

export interface PerfReport {
  readonly ok: boolean;
  readonly violations: readonly PerfViolation[];
  readonly jankLines: number;
  readonly fanLines: number;
  readonly streamingFans: number;
  /** The worst gap any jank line reports, or null (no jank line). */
  readonly worstGapMs: number | null;
  /** Every fan line's `settle`, in log order. */
  readonly settles: readonly number[];
  /** Σ renders / Σ window over the streaming jank lines, or null (none). */
  readonly rendersPerSecond: number | null;
  /** Every complete `ev=panes` line's figures, in log order. */
  readonly panes: readonly string[];
}

/** A stream the shell rendered fewer times than this says nothing about coupling. */
const COUPLING_MIN_SHELL = 50;

/** The most a pane may render over a stream the shell rendered `shell` times. */
const paneRendersAllowed = (shell: number): number => Math.max(10, 0.1 * shell);

type Fields = ReadonlyMap<string, string>;

/** The `k=v` fields of a `<iso> <level> ptrace …` line, or null for any other line. */
function ptraceFields(line: string): Fields | null {
  const [, , kind, ...rest] = line.trim().split(" ");
  if (kind !== PTRACE) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const token of rest) {
    const at = token.indexOf("=");
    if (at > 0) {
      fields.set(token.slice(0, at), token.slice(at + 1));
    }
  }
  return fields;
}

const numberOf = (fields: Fields, key: string): number | null => {
  const text = fields.get(key);
  return text !== undefined && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
};

const flagOf = (fields: Fields, key: string): boolean | null => {
  const text = fields.get(key);
  return text === "true" ? true : text === "false" ? false : null;
};

export function checkPerf(logText: string): PerfReport {
  const violations: PerfViolation[] = [];
  const settles: number[] = [];
  let jankLines = 0;
  let fanLines = 0;
  let streamingFans = 0;
  let worstGapMs: number | null = null;
  let renders = 0;
  let windowMs = 0;
  const panes: string[] = [];
  let coupledEvidence = false;
  for (const line of logText.split("\n")) {
    const fields = ptraceFields(line);
    if (fields === null) {
      continue;
    }
    const broken = (detail: string): void => {
      violations.push({ rule: "evidence", detail, line });
    };
    const ev = fields.get("ev");
    if (ev === undefined) {
      broken("a ptrace line with no `ev`");
    } else if (ev === "jank") {
      jankLines += 1;
      const worst = numberOf(fields, "worst");
      const win = numberOf(fields, "win");
      const count = numberOf(fields, "renders");
      const stream = flagOf(fields, "stream");
      if (worst === null || win === null || win <= 0 || count === null || stream === null) {
        broken("a jank line missing `win`, `worst`, `renders` or `stream`");
      }
      if (worst !== null) {
        worstGapMs = Math.max(worstGapMs ?? 0, worst);
        if (worst > PERF_BUDGET.maxGapMs) {
          const detail = `worst=${worst} > ${PERF_BUDGET.maxGapMs} ms`;
          violations.push({ rule: "gap", detail, line });
        }
      }
      if (stream === true && win !== null && win > 0 && count !== null) {
        renders += count;
        windowMs += win;
      }
    } else if (ev === "fan") {
      fanLines += 1;
      const settle = numberOf(fields, "settle");
      const stream = flagOf(fields, "stream");
      if (settle === null || stream === null) {
        broken("a fan line missing `settle` or `stream`");
      }
      if (stream === true) {
        streamingFans += 1;
      }
      if (settle !== null) {
        settles.push(settle);
        if (settle < 0 || settle > PERF_BUDGET.maxSettleMs) {
          const detail =
            settle < 0 ? "never settled" : `settle=${settle} > ${PERF_BUDGET.maxSettleMs} ms`;
          violations.push({ rule: "settle", detail, line });
        }
      }
    } else if (ev === "panes") {
      const shell = numberOf(fields, "shell");
      const counts = PANES.map((pane) => [pane, numberOf(fields, pane)] as const);
      if (shell === null || counts.some(([, n]) => n === null)) {
        broken(`a panes line missing \`shell\`, \`${PANES.join("`, `")}\``);
        continue;
      }
      panes.push(`shell=${shell} ${counts.map(([pane, n]) => `${pane}=${n}`).join(" ")}`);
      if (shell < COUPLING_MIN_SHELL) {
        continue;
      }
      coupledEvidence = true;
      const allowed = paneRendersAllowed(shell);
      for (const [pane, n] of counts) {
        if (n !== null && n > allowed) {
          const detail = `${pane}=${n} > ${allowed} renders over ${shell} shell renders`;
          violations.push({ rule: "coupling", detail, line });
        }
      }
    }
  }
  const rendersPerSecond = windowMs === 0 ? null : (renders * 1000) / windowMs;
  if (rendersPerSecond !== null && rendersPerSecond > PERF_BUDGET.maxRendersPerSecond) {
    violations.push({
      rule: "rate",
      detail: `${rendersPerSecond.toFixed(1)} renders/s > ${PERF_BUDGET.maxRendersPerSecond}`,
    });
  }
  if (streamingFans < PERF_BUDGET.minStreamingFans) {
    violations.push({
      rule: "evidence",
      detail: `${streamingFans} streaming fan opens < ${PERF_BUDGET.minStreamingFans}`,
    });
  }
  if (!coupledEvidence) {
    violations.push({
      rule: "evidence",
      detail: `no \`panes\` line over a stream of ${COUPLING_MIN_SHELL}+ shell renders`,
    });
  }
  return {
    panes,
    ok: violations.length === 0,
    violations,
    jankLines,
    fanLines,
    streamingFans,
    worstGapMs,
    settles,
    rendersPerSecond,
  };
}

export function perfReportText(report: PerfReport): string {
  const out = [
    report.ok ? "PERF PASS" : "PERF FAIL",
    `jank lines: ${report.jankLines}, fan lines: ${report.fanLines} (${report.streamingFans} streaming)`,
    `worst gap: ${report.worstGapMs === null ? "n/a" : `${report.worstGapMs} ms`}`,
    `fan settle ms: ${report.settles.length === 0 ? "n/a" : report.settles.join(", ")}`,
    // The shell's renders only: a pane's own are in the `panes` figures.
    `renders/s (shell only): ${report.rendersPerSecond?.toFixed(1) ?? "n/a"}`,
    ...(report.panes.length === 0 ? ["panes: n/a"] : report.panes.map((p) => `panes: ${p}`)),
  ];
  if (report.ok) {
    return out.join("\n");
  }
  const totals = RULES.map((rule) => ({
    rule,
    n: report.violations.filter((v) => v.rule === rule).length,
  })).filter((t) => t.n > 0);
  out.push(`violations: ${totals.map((t) => `${t.rule} ${t.n}`).join(", ")}`);
  // The whole-log verdicts first: a pile of bad lines never cuts them off.
  for (const v of report.violations.filter((v) => v.line === undefined)) {
    out.push(`  ${v.rule}: ${v.detail}`);
  }
  const lines = report.violations.filter((v) => v.line !== undefined);
  for (const v of lines.slice(0, REPORT_LINES)) {
    out.push(`  ${v.rule}: ${v.detail} — ${v.line}`);
  }
  if (lines.length > REPORT_LINES) {
    out.push(`  … ${lines.length - REPORT_LINES} more violating lines (${lines.length} in all)`);
  }
  return out.join("\n");
}

/** The budget can only turn a `pass` into a `fail`. */
export function perfOutcome(outcome: AttemptStatus, report: PerfReport): AttemptStatus {
  return outcome === "pass" && !report.ok ? "fail" : outcome;
}

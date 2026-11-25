/**
 * The ONE vocabulary of a "unit of work with a state" (docs/feat/a2a.md,
 * Unification) — pure, React-free, IO-free, clock-free. A turn and a workflow
 * run keep their own native words and log entries; this module maps both to one
 * state set, so a reader (the A2A task projection) never learns a third.
 *
 * Inside a log segment the native entries (`turn_*`, `workflow_*`) are the
 * record of a unit; ACROSS segments a carried `unit_end` entry is. Both are read
 * by `unitsFromSegment`, and a unit's result is computed by ONE function
 * (`turnResult`), so a live end and a load derivation cannot give two records.
 *
 * Every native word is a free string: a newer build's word never breaks a
 * reader (unknown → `working` if not ended, else `failed`).
 */
import {
  type KnownLogEntry,
  type LogUnitEndEntry,
  LogUnitEndEntrySchema,
  UNIT_END_ID_MAX_CHARS,
  UNIT_END_REASON_MAX_CHARS,
  UNIT_END_RESULT_MAX_CHARS,
  UNIT_END_WORD_MAX_CHARS,
  projectEntry,
} from "@tentacle/protocol";
import { capSubagentText } from "./agent-job-ledger.ts";
import type { ChatMessage } from "./model.ts";
import { judged } from "./workflow-ledger.ts";

export type WorkUnitKind = "turn" | "workflow";
export type WorkUnitState = "working" | "waiting" | "completed" | "failed" | "canceled";

export interface WorkUnit {
  readonly kind: WorkUnitKind;
  /** A turn's `turnId`; a run's `wf-N`. */
  readonly id: string;
  /** The `turnId` that started it (`workflow_start.turnId`). */
  readonly origin?: string;
  readonly state: WorkUnitState;
  /** With `waiting`: a tool ask, or a workflow file's approval. */
  readonly waitingFor?: "permission" | "approval";
  /** The unit's own word (display/debug): a stop reason, a run state, `stopped:<why>`. */
  readonly native: string;
  /** One line. */
  readonly reason?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** A turn: the final round's text; a run: its end reason + last step report. */
  readonly result?: string;
  /** The unit had a result that no longer fits the retained budget. */
  readonly resultDropped?: true;
}

/** A session retains its newest this-many ended units. */
export const WORK_UNIT_MAX_ENDED = 256;
/** All retained results together (UTF-16 code units, like every cap here), newest first. */
export const WORK_UNIT_RESULTS_BUDGET_CHARS = 256 * 1024;
/** The entry's own bounds: protocol is the one truth (it cannot import core). */
export const WORK_UNIT_RESULT_MAX_CHARS = UNIT_END_RESULT_MAX_CHARS;
export const WORK_UNIT_REASON_MAX_CHARS = UNIT_END_REASON_MAX_CHARS;

/** A carried ended unit, as a segment holds it (the entry without its envelope). Every word is free. */
export type CarriedUnitEntry = Omit<LogUnitEndEntry, "seq" | "id" | "prev" | "ts" | "critical">;
/** What a `unit_end` entry carries (the payload, without its envelope). */
export type UnitEndBody = Omit<CarriedUnitEntry, "type">;

export interface SegmentUnits {
  /** In the order they ended, bounded (`boundEndedUnits`). */
  readonly ended: readonly WorkUnit[];
  /** Started and not ended, in start order. The caller closes or resumes them. */
  readonly open: readonly WorkUnit[];
}

export interface LiveTurn {
  readonly turnId: string;
  /** Present iff the turn ended. */
  readonly stopReason?: string;
  /** A permission ask of the turn is pending. */
  readonly asking?: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly result?: string;
}

/** A run as the driver's row shows it (`endedAt` present iff it ended). */
export interface LiveWorkflow {
  readonly runId: string;
  readonly origin?: string;
  readonly state: string;
  readonly stopReason?: string;
  readonly reason?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly result?: string;
}

interface Mapped {
  readonly state: WorkUnitState;
  readonly waitingFor?: "permission" | "approval";
  /** The reason a unit gets when its native record has none. */
  readonly reason?: string;
}

// Maps, not object literals: a word like `constructor` must read as unknown.
const TURN_STATES: ReadonlyMap<string, Mapped> = new Map<string, Mapped>([
  ["end_turn", { state: "completed" }],
  ["max_tokens", { state: "completed", reason: "stopped: max_tokens" }],
  ["max_iterations", { state: "completed", reason: "stopped: max_iterations" }],
  ["max_token_budget", { state: "completed", reason: "stopped: max_token_budget" }],
  ["cancelled", { state: "canceled" }],
  ["error", { state: "failed", reason: "the turn failed" }],
]);

const WORKFLOW_STATES: ReadonlyMap<string, Mapped> = new Map<string, Mapped>([
  ["needs-approval", { state: "waiting", waitingFor: "approval" }],
  ["waiting", { state: "waiting", waitingFor: "permission" }],
  ["running", { state: "working" }],
  ["ok", { state: "completed" }],
  ["error", { state: "failed" }],
  // Every stop but `cancelled` is a failure (`unifyWorkflow`).
  ["stopped", { state: "failed" }],
]);

const TERMINAL: ReadonlySet<string> = new Set<WorkUnitState>(["completed", "failed", "canceled"]);

function oneLine(text: string): string {
  return capSubagentText(text, WORK_UNIT_REASON_MAX_CHARS).replace(/\s+/g, " ").trim();
}

/** Drop the absent fields: a unit is compared and re-serialized, so no `undefined` keys. */
function unit(
  fields: Pick<WorkUnit, "kind" | "id" | "state" | "native"> & {
    readonly [K in
      | "origin"
      | "waitingFor"
      | "reason"
      | "startedAt"
      | "endedAt"
      | "result"
      | "resultDropped"]?: WorkUnit[K] | undefined;
  },
): WorkUnit {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== ""),
  ) as unknown as WorkUnit;
}

function cappedResult(text: string | undefined): string | undefined {
  return text === undefined || text === ""
    ? undefined
    : capSubagentText(text, WORK_UNIT_RESULT_MAX_CHARS);
}

/** A turn in the one vocabulary. Its reason comes from the stop reason ALONE: the log has no more. */
export function unifyTurn(turn: LiveTurn): WorkUnit {
  const { stopReason } = turn;
  const mapped: Mapped =
    stopReason === undefined
      ? turn.asking === true
        ? { state: "waiting", waitingFor: "permission" }
        : { state: "working" }
      : (TURN_STATES.get(stopReason) ?? { state: "failed", reason: `ended: ${stopReason}` });
  return unit({
    kind: "turn",
    id: turn.turnId,
    state: mapped.state,
    waitingFor: mapped.waitingFor,
    native: stopReason ?? "running",
    reason: mapped.reason,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    result: cappedResult(turn.result),
  });
}

export function unifyWorkflow(run: LiveWorkflow): WorkUnit {
  const ended = run.endedAt !== undefined;
  const native =
    run.state === "stopped" && run.stopReason !== undefined
      ? `stopped:${run.stopReason}`
      : run.state;
  let mapped: Mapped = WORKFLOW_STATES.get(run.state) ?? {
    state: ended ? "failed" : "working",
  };
  if (native === "stopped:cancelled") {
    mapped = { state: "canceled" };
  } else if (ended && !TERMINAL.has(mapped.state)) {
    mapped = { state: "failed" };
  }
  const reason = oneLine(run.reason ?? "");
  return unit({
    kind: "workflow",
    id: run.runId,
    origin: run.origin,
    state: mapped.state,
    waitingFor: mapped.waitingFor,
    native,
    reason: reason !== "" ? reason : mapped.state === "failed" ? `ended: ${native}` : undefined,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    result: cappedResult(run.result),
  });
}

/**
 * A turn's result: the text of its FINAL round, the last assistant message in
 * `messages[from, to)`. A final round without text has no result — an earlier
 * round's preamble is never passed off as the answer.
 */
export function turnResult(
  messages: readonly ChatMessage[],
  span: { readonly from: number; readonly to: number },
): string | undefined {
  const from = Math.max(0, span.from);
  for (let i = Math.min(messages.length, span.to) - 1; i >= from; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return cappedResult(message.content);
    }
  }
  return undefined;
}

/**
 * The retention bounds over ended units, OLDEST FIRST: the newest
 * `WORK_UNIT_MAX_ENDED` stay; their results share the budget, newest first, and
 * one that does not fit is dropped (state and reason stay). Idempotent.
 */
export function boundEndedUnits(units: readonly WorkUnit[]): WorkUnit[] {
  const kept = units.slice(-WORK_UNIT_MAX_ENDED);
  let room = WORK_UNIT_RESULTS_BUDGET_CHARS;
  for (let i = kept.length - 1; i >= 0; i--) {
    const current = kept[i];
    if (current?.result === undefined) continue;
    if (current.result.length <= room) {
      room -= current.result.length;
    } else {
      const { result: _dropped, ...rest } = current;
      kept[i] = { ...rest, resultDropped: true };
    }
  }
  return kept;
}

/** A short identifying word: cut, never a cut line (noise in a label). `""` → `"unknown"`. */
function word(text: string, max = UNIT_END_WORD_MAX_CHARS): string {
  return text === "" ? "unknown" : text.slice(0, max);
}

/**
 * The `unit_end` body that carries an ENDED unit into a new segment: every text
 * capped, then judged by the entry's schema (a malformed KNOWN entry makes a
 * reader refuse the whole log, so an invalid body throws here, never on disk).
 */
export function unitEndBody(ended: WorkUnit): UnitEndBody {
  if (!TERMINAL.has(ended.state) || ended.endedAt === undefined) {
    throw new Error(`unit_end: ${ended.kind} ${ended.id} is not ended`);
  }
  const result = cappedResult(ended.result);
  return judged(LogUnitEndEntrySchema, "unit_end", {
    kind: ended.kind,
    unitId: word(ended.id, UNIT_END_ID_MAX_CHARS),
    ...(ended.origin !== undefined ? { origin: ended.origin } : {}),
    state: ended.state,
    native: word(ended.native),
    ...(ended.reason !== undefined ? { reason: oneLine(ended.reason) } : {}),
    ...(ended.startedAt !== undefined ? { startedAt: ended.startedAt } : {}),
    endedAt: ended.endedAt,
    ...(result !== undefined ? { result } : {}),
    ...(ended.resultDropped === true ? { resultDropped: true as const } : {}),
  });
}

/** A carried entry back as a unit; `undefined` for a kind this build does not know. */
function carriedUnit(entry: CarriedUnitEntry): WorkUnit | undefined {
  if (entry.kind !== "turn" && entry.kind !== "workflow") {
    return undefined;
  }
  return unit({
    kind: entry.kind,
    id: entry.unitId,
    origin: entry.origin,
    // A carried unit is ended, whatever a newer build calls its state.
    state: TERMINAL.has(entry.state) ? (entry.state as WorkUnitState) : "failed",
    native: entry.native,
    reason: entry.reason,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    result: entry.result,
    resultDropped: entry.resultDropped,
  });
}

interface OpenTurn {
  readonly turnId: string;
  readonly startedAt?: number;
  /** The projection's length where the turn's messages begin. */
  readonly from: number;
}
interface OpenRun {
  readonly origin?: string;
  readonly startedAt: number;
  readonly report?: string;
}

/**
 * THE derivation: the units of ONE segment's entries, from its `base` (native
 * markers and carried `unit_end`s). A turn's result is read from the projection
 * AS IT IS WHERE THE TURN ENDS, folded here from the same entries. A segment cut
 * inside a turn has no `turn_start`: `base.turn` names it, and only what follows
 * the base's own messages is attributable to it. An `end` with neither gets a
 * unit without a result; a run's `step`/`end` without its `start` is ignored.
 *
 * A run's result holds the last step report of THIS segment: a step that ended
 * before a segment boundary is not carried while the run is live.
 */
export function unitsFromSegment(
  entries: readonly (KnownLogEntry | CarriedUnitEntry)[],
): SegmentUnits {
  const messages: ChatMessage[] = [];
  const ended = new Map<string, WorkUnit>();
  const turns = new Map<string, OpenTurn>();
  const runs = new Map<string, OpenRun>();
  const key = (kind: WorkUnitKind, id: string) => `${kind} ${id}`;
  // Delete first: the map's order is the end order.
  const end = (done: WorkUnit) => {
    ended.delete(key(done.kind, done.id));
    ended.set(key(done.kind, done.id), done);
  };
  for (const entry of entries) {
    if (entry.type === "unit_end") {
      const done = carriedUnit(entry);
      if (done !== undefined) end(done);
      continue;
    }
    // A bad replace/truncate cannot occur in a parsed log; it would only skew a result.
    projectEntry(messages, entry, (m) => m as ChatMessage);
    switch (entry.type) {
      case "base":
        if (entry.turn !== undefined) {
          turns.set(entry.turn, { turnId: entry.turn, from: entry.count });
        }
        break;
      case "turn_start":
        ended.delete(key("turn", entry.turnId));
        turns.set(entry.turnId, {
          turnId: entry.turnId,
          startedAt: entry.ts,
          from: messages.length,
        });
        break;
      case "turn_end": {
        const open = turns.get(entry.turnId);
        turns.delete(entry.turnId);
        const result =
          open === undefined
            ? undefined
            : turnResult(messages, { from: open.from, to: messages.length });
        end(
          unifyTurn({
            turnId: entry.turnId,
            stopReason: entry.stopReason,
            ...(open?.startedAt !== undefined ? { startedAt: open.startedAt } : {}),
            endedAt: entry.ts,
            ...(result !== undefined ? { result } : {}),
          }),
        );
        break;
      }
      case "workflow_start": {
        // A start of an ENDED run is a rerun (same id): open again, from scratch.
        // A start of an OPEN one is its re-log: what it already said stays.
        ended.delete(key("workflow", entry.runId));
        const before = runs.get(entry.runId);
        runs.set(entry.runId, {
          startedAt: entry.ts,
          ...before,
          ...(entry.turnId !== undefined ? { origin: entry.turnId } : {}),
        });
        break;
      }
      case "workflow_step": {
        const run = runs.get(entry.runId);
        if (run !== undefined) {
          runs.set(entry.runId, { ...run, report: entry.report ?? "" });
        }
        break;
      }
      case "workflow_end": {
        const run = runs.get(entry.runId);
        if (run === undefined) break;
        runs.delete(entry.runId);
        end(
          unifyWorkflow({
            runId: entry.runId,
            ...(run.origin !== undefined ? { origin: run.origin } : {}),
            state: entry.state,
            ...(entry.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
            reason: entry.reason,
            startedAt: run.startedAt,
            endedAt: entry.ts,
            result: [entry.reason, run.report ?? ""].filter((t) => t !== "").join("\n\n"),
          }),
        );
        break;
      }
      default:
        break;
    }
  }
  return {
    ended: boundEndedUnits([...ended.values()]),
    open: [
      ...[...turns.values()].map((t) =>
        unifyTurn({
          turnId: t.turnId,
          ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        }),
      ),
      ...[...runs].map(([runId, run]) =>
        unifyWorkflow({
          runId,
          ...(run.origin !== undefined ? { origin: run.origin } : {}),
          state: "running",
          startedAt: run.startedAt,
        }),
      ),
    ],
  };
}

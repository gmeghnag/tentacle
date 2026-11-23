/**
 * The persistence contract of a workflow run (docs/feat/agent-workflows.md D4)
 * — pure, React-free, IO-free, clock-free. The twin of `agent-job-ledger.ts`.
 *
 * Only TERMINAL facts are durable: a run started (`workflow_start`), one step
 * execution ended (`workflow_step`), the run ended (`workflow_end`). All three
 * are NON-critical log entries (owner Q1): they project nothing, so an older
 * build skips them and the conversation is intact. `running`/`waiting` live in
 * the driver's memory and on the wire only.
 *
 * Two jobs here, one rule each:
 * - The BODY builders are the ONE place an entry is built. A malformed KNOWN
 *   entry is fatal to every reader (it refuses the whole file), so every text
 *   is capped to the schema's bounds here, and the result is judged by the
 *   entry's own schema — a body that would still fail (a bad id or hash: a
 *   caller bug, nothing to cap) THROWS before it reaches the log.
 * - `workflowLoadNotes` is THE load derivation, used by both loads (the laptop
 *   store and the `serve` reload): a `start` without its `end` in the current
 *   segment is closed as `stopped: interrupted` by a NOTE carrying the run id.
 *   The load writes nothing; the note rides the next save, and a note already
 *   in the history closes its id, so the derivation is idempotent.
 *
 * Load-bearing (for the driver, Slice 4): like the sub-agent markers, these
 * entries never travel past a segment start, so a run still RUNNING when a
 * `base` is cut (a compaction, a `context_reset`) must have its
 * `workflow_start` re-logged after that base, or a crash later would leave it
 * un-noted. A run is never resumed by a load (owner Q4): only an explicit
 * `session/workflow{resume}` re-runs the cut step.
 */
import {
  type KnownLogEntry,
  type LogWorkflowEndEntry,
  LogWorkflowEndEntrySchema,
  type LogWorkflowStartEntry,
  LogWorkflowStartEntrySchema,
  type LogWorkflowStepEntry,
  LogWorkflowStepEntrySchema,
  SUBAGENT_REPORT_MAX_CHARS,
  WORKFLOW_INPUTS_MAX_CHARS,
  WORKFLOW_INPUT_NAME_MAX_CHARS,
  WORKFLOW_MODEL_MAX_CHARS,
  WORKFLOW_NAME_MAX_CHARS,
  WORKFLOW_PATH_MAX_CHARS,
  WORKFLOW_PROMPT_MAX_CHARS,
  WORKFLOW_REASON_MAX_CHARS,
  WORKFLOW_WHERE_MAX_CHARS,
  type WorkflowInputValue,
} from "@tentacle/protocol";
import type { z } from "zod";
import { capSubagentText } from "./agent-job-ledger.ts";
import type { ChatMessage } from "./model.ts";
import { NOTE_KIND } from "./model.ts";

type Envelope = "type" | "seq" | "id" | "prev" | "ts" | "critical";
/** What a `workflow_start` entry carries (the payload, without its envelope). */
export type WorkflowStartBody = Omit<LogWorkflowStartEntry, Envelope>;
/** What a `workflow_step` entry carries. */
export type WorkflowStepBody = Omit<LogWorkflowStepEntry, Envelope>;
/** What a `workflow_end` entry carries. */
export type WorkflowEndBody = Omit<LogWorkflowEndEntry, Envelope>;

/** The id prefix of a workflow run: `wf-1`, `wf-2`, … */
export const WORKFLOW_RUN_ID_PREFIX = "wf-";

const RUN_ID_IN_TEXT = /\bwf-(\d+)\b/g;

/**
 * The highest `N` of any `wf-N` a history already names — a note's `id` or a
 * message's text (an end note, an interrupted note, a tool result). A driver
 * seeded with it never mints an id this session's log or conversation has
 * seen, so `workflowLoadNotes` (which keys by run id) never lets an old run's
 * end note hide a new run's open start (review round 1 #1). 0 when none.
 */
export function workflowRunSeqFromHistory(messages: readonly ChatMessage[]): number {
  let highest = 0;
  const consider = (digits: string | undefined): void => {
    const n = digits !== undefined ? Number(digits) : 0;
    if (Number.isSafeInteger(n) && n > highest) {
      highest = n;
    }
  };
  for (const message of messages) {
    const id = message.note?.id;
    if (id !== undefined) {
      consider(/^wf-(\d+)$/.exec(id)?.[1]);
    }
    for (const match of message.content.matchAll(RUN_ID_IN_TEXT)) {
      consider(match[1]);
    }
  }
  return highest;
}

/** Throw unless `body` is a valid entry of `schema` (a dummy envelope stands in for the emitter's). */
function judged<T extends object>(schema: z.ZodTypeAny, type: string, body: T): T {
  const parsed = schema.safeParse({ ...body, type, seq: 1, id: "check/1", ts: 0 });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined ? issue.path.join(".") : "?";
    throw new Error(
      `${type}: refusing to log an invalid entry (${where}: ${issue?.message ?? "invalid"})`,
    );
  }
  return body;
}

/** A non-negative integer from a measured number (NaN / negative / fraction → a valid count). */
function count(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** A short identifying string: cut, never a cut line (noise in a label). `""` → `"unknown"`. */
function bounded(text: string, max: number): string {
  return text === "" ? "unknown" : text.slice(0, max);
}

/**
 * The inputs as the log keeps them: `{name, value}` in name order, each value
 * capped, and the whole list within `WORKFLOW_INPUTS_MAX_CHARS` of JSON (D4
 * "inputs ≤ 4 KiB"). An input that does not fit any more (or whose name is
 * out of bounds) is dropped whole and a last `…` row says how many — never a
 * silent loss.
 */
export function capWorkflowInputs(inputs: Readonly<Record<string, string>>): WorkflowInputValue[] {
  const out: WorkflowInputValue[] = [];
  let dropped = 0;
  for (const key of Object.keys(inputs).sort()) {
    if (key === "" || key.length > WORKFLOW_INPUT_NAME_MAX_CHARS) {
      dropped += 1;
      continue;
    }
    // 96 held back for the drop row below; 24 for this row's `{"name":,"value":}`.
    const room =
      WORKFLOW_INPUTS_MAX_CHARS - 96 - JSON.stringify(out).length - JSON.stringify(key).length - 24;
    if (room <= 16) {
      dropped += 1;
      continue;
    }
    const value = inputs[key] ?? "";
    // Measured ENCODED (JSON escaping grows a value); shrinks strictly, so it ends.
    const fits = (v: string) => JSON.stringify(v).length - 2 <= room;
    let kept = value;
    if (!fits(kept)) {
      let n = Math.min(value.length, room);
      while (n > 0 && !fits(`${value.slice(0, n)}…`)) {
        n = Math.floor(n * 0.9);
      }
      kept = `${value.slice(0, n)}…`;
    }
    out.push({ name: key, value: kept });
  }
  if (dropped > 0) {
    out.push({ name: "…", value: `${dropped} more input(s) not logged` });
  }
  return out;
}

export interface WorkflowStartInput {
  readonly runId: string;
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  readonly path: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly by: "user" | "model" | "schedule";
  readonly turnId?: string;
  /** The schedule that started it (`by: "schedule"`, slice 10). */
  readonly scheduleId?: string;
}

/** The `workflow_start` body: capped, and judged by its schema (throws on a bad id/hash). */
export function workflowStartBody(input: WorkflowStartInput): WorkflowStartBody {
  return judged(LogWorkflowStartEntrySchema, "workflow_start", {
    runId: input.runId,
    name: bounded(input.name, WORKFLOW_NAME_MAX_CHARS),
    version: count(input.version),
    hash: input.hash,
    path: bounded(input.path, WORKFLOW_PATH_MAX_CHARS),
    inputs: capWorkflowInputs(input.inputs),
    by: input.by,
    ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
    ...(input.scheduleId !== undefined && input.scheduleId !== ""
      ? { scheduleId: input.scheduleId }
      : {}),
  });
}

export interface WorkflowStepInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly round: number;
  readonly state: "ok" | "error" | "stopped";
  readonly verdict?: "pass" | "fail";
  readonly reason?: string;
  readonly model?: string;
  /** `local` | `docker:<name>[/<container>]`. */
  readonly where: string;
  readonly tokens?: number;
  readonly durationMs?: number;
  /** The resolved prompt (agent), command (run) or title (approve). */
  readonly prompt?: string;
  readonly report?: string;
}

/** The `workflow_step` body: every text capped (head + tail), judged by its schema. */
export function workflowStepBody(input: WorkflowStepInput): WorkflowStepBody {
  return judged(LogWorkflowStepEntrySchema, "workflow_step", {
    runId: input.runId,
    stepId: input.stepId,
    attempt: count(input.attempt),
    round: count(input.round),
    state: input.state,
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
    reason: capSubagentText(input.reason ?? "", WORKFLOW_REASON_MAX_CHARS),
    ...(input.model !== undefined && input.model !== ""
      ? { model: input.model.slice(0, WORKFLOW_MODEL_MAX_CHARS) }
      : {}),
    where: bounded(input.where, WORKFLOW_WHERE_MAX_CHARS),
    tokens: count(input.tokens),
    durationMs: count(input.durationMs),
    ...(input.prompt !== undefined
      ? { prompt: capSubagentText(input.prompt, WORKFLOW_PROMPT_MAX_CHARS) }
      : {}),
    ...(input.report !== undefined
      ? { report: capSubagentText(input.report, SUBAGENT_REPORT_MAX_CHARS) }
      : {}),
  });
}

export interface WorkflowEndInput {
  readonly runId: string;
  readonly state: "ok" | "error" | "stopped";
  readonly stopReason?: "budget" | "timeout" | "cancelled" | "interrupted" | "changed";
  readonly reason?: string;
}

/** The `workflow_end` body, judged by its schema. */
export function workflowEndBody(input: WorkflowEndInput): WorkflowEndBody {
  return judged(LogWorkflowEndEntrySchema, "workflow_end", {
    runId: input.runId,
    state: input.state,
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    reason: capSubagentText(input.reason ?? "", WORKFLOW_REASON_MAX_CHARS),
  });
}

/** An open run, as the load replay sees it. */
export interface OpenWorkflowRun {
  readonly runId: string;
  readonly name: string;
  readonly version: number;
  /** Step executions that ENDED (their entries), in order. */
  readonly ended: number;
  /** The last step that ended, if any. */
  readonly lastStep?: string;
}

/**
 * The note a run a restart cut leaves (user role, model-visible): it is closed
 * `stopped: interrupted`, never resumed by the load (owner Q4), and the step
 * that was running may have had side effects.
 */
export function workflowInterruptedNote(run: OpenWorkflowRun): ChatMessage {
  const after =
    run.lastStep !== undefined
      ? ` after ${run.ended} step run(s), the last one "${run.lastStep}"`
      : " before any step finished";
  return {
    role: "user",
    content: `[workflow ${run.runId} ${run.name} v${run.version}: stopped · interrupted] the session restarted${after}. The step that was running may have had side effects; check before redoing it. A run a restart cut is not resumed; start a new run if it is still wanted.`,
    note: { kind: NOTE_KIND.workflowInterrupted, id: run.runId },
  };
}

/**
 * THE load derivation (laptop load + `serve` reload, one rule): replay the
 * CURRENT segment's `workflow_*` entries, drop the runs that ended, drop the
 * ids a workflow note in `messages` already names, and return one
 * `stopped: interrupted` note per run still open, in start order.
 *
 * Idempotent: the notes carry `note.id`, so the next load (with them in
 * `messages`) returns `[]`. No entries → `[]`. A `workflow_step` / `end` whose
 * `start` is not in the segment is ignored (nothing to close).
 */
export function workflowLoadNotes(
  entries: readonly KnownLogEntry[],
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const open = new Map<string, OpenWorkflowRun>();
  for (const entry of entries) {
    if (entry.type === "workflow_start") {
      open.set(entry.runId, {
        runId: entry.runId,
        name: entry.name,
        version: entry.version,
        ended: 0,
      });
    } else if (entry.type === "workflow_step") {
      const run = open.get(entry.runId);
      if (run !== undefined) {
        open.set(entry.runId, { ...run, ended: run.ended + 1, lastStep: entry.stepId });
      }
    } else if (entry.type === "workflow_end") {
      open.delete(entry.runId);
    }
  }
  for (const message of messages) {
    const note = message.note;
    if (
      note?.id !== undefined &&
      (note.kind === NOTE_KIND.workflowEnd || note.kind === NOTE_KIND.workflowInterrupted)
    ) {
      open.delete(note.id);
    }
  }
  return [...open.values()].map(workflowInterruptedNote);
}

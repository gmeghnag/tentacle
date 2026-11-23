/**
 * The laptop's view of a session's workflow runs (docs/feat/workflows-ui.md
 * D2): bounded and sanitized HERE, never in a component — a pod's daemon is not
 * trusted (AGENTS §7), so the row count and every free-text label (`reason`,
 * `live`, `model`, `where`) are cut before anything paints them.
 *
 * A `workflows` update is FULL STATE (`updates.ts:486`): the current run plus
 * the last few ended ones, replacing any earlier list, never a delta — so a
 * client converges from any loss and this module never merges.
 *
 * Pure: no React, no I/O.
 */
import type { WorkflowInputValue, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { progressText } from "./mapping.ts";

/**
 * What the USER asks of a run (`session/workflow`, docs/feat/agent-workflows.md
 * D3): the wire params minus everything the client owns — the `sessionId` its
 * session knows, and the `turnId` it MINTS, so a caller can never forget one
 * (a start whose asks nothing owns would silently stall auto-accept).
 */
export type WorkflowAction =
  | {
      readonly action: "start";
      readonly name: string;
      /** The file's `inputs`, already validated against it daemon-side. */
      readonly inputs?: WorkflowInputValue[];
    }
  | { readonly action: "stop"; readonly runId: string }
  | { readonly action: "resume"; readonly runId: string }
  | { readonly action: "rerun_step"; readonly runId: string; readonly stepId: string };

/**
 * How many runs a client keeps. The daemon already sends the live run + 5 ended
 * ones (`WORKFLOW_RECENT_RUNS`), so this is the client's own hard ceiling on a
 * hostile or newer one: a rail, a panel and a phone list paint at most these.
 */
export const MAX_WORKFLOW_RUNS = 8;

/** How long one line of a failed `run` step's reason may be on screen (the wire's own 2 KiB). */
export const WORKFLOW_REASON_CLIENT_MAX = 2_000;
/** How long a step's live action line may be (`WorkflowStepRow.live`'s wire bound). */
export const WORKFLOW_LIVE_CLIENT_MAX = 200;
/** How long a step's `models` NAME label may be (it is a label, never an id or URL). */
export const WORKFLOW_MODEL_CLIENT_MAX = 128;
/** How long a step's `where` (`local`, `docker:<name>[/<container>]`) may be. */
export const WORKFLOW_WHERE_CLIENT_MAX = 256;

/** Shown when the daemon cannot answer: it predates the method. */
export const WORKFLOW_OLD_DAEMON = "this daemon cannot show workflow steps (older version)";
/**
 * A client that must not act on a run at all (a pod's daemon, `run`/`attach`):
 * its daemon is not trusted (AGENTS §7). A run's asks — a hash approval, an
 * `approve` step — would otherwise be a pod-originated prompt on the laptop.
 */
export const WORKFLOW_UNTRUSTED_DAEMON = "this client does not trust its daemon to run workflows";

/**
 * Every character a terminal must never receive, mapped to ONE space: C0 (so
 * `ESC`'s `\u001b[2J` prints as text), DEL and the C1 range (so `\u009b31m`
 * cannot become a CSI). One space, not nothing, so a tab keeps its column count.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** The invisible reordering/zero-width classes: STRIPPED (a space would lie about the width). */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One free-text field, safe to paint: one line, escapes gone, bounded with an
 * ellipsis (never a silent cut). A `run` step's failure reason is prose — its
 * newlines become spaces, because a row is one line and the panel shows the
 * same value as lines after the component splits it.
 */
export function sanitizeWorkflowText(value: string, cap: number): string {
  const clean = value.replace(CONTROL, " ").replace(INVISIBLE, "").trim();
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** One step row, safe to render: every string a bounded label, the numbers as sent. */
function boundStep(step: WorkflowStepRow): WorkflowStepRow {
  return {
    id: progressText(step.id).trim(),
    kind: progressText(step.kind).trim(),
    ...(step.model === undefined
      ? {}
      : { model: sanitizeWorkflowText(step.model, WORKFLOW_MODEL_CLIENT_MAX) }),
    where: sanitizeWorkflowText(step.where, WORKFLOW_WHERE_CLIENT_MAX),
    // The STATE is a free word (`session.ts:813`): a newer daemon's is kept as
    // sent, never coerced into one this build knows — a UI paints an unknown
    // state as its own word with a neutral glyph.
    state: progressText(step.state).trim(),
    attempt: step.attempt,
    round: step.round,
    ...(step.maxRound === undefined ? {} : { maxRound: step.maxRound }),
    ...(step.reason === undefined
      ? {}
      : { reason: sanitizeWorkflowText(step.reason, WORKFLOW_REASON_CLIENT_MAX) }),
    ...(step.live === undefined
      ? {}
      : { live: sanitizeWorkflowText(step.live, WORKFLOW_LIVE_CLIENT_MAX) }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
  };
}

/** One run, safe to render: the labels bounded, the step list mapped, the numbers as sent. */
function boundRun(run: WorkflowRow): WorkflowRow {
  return {
    runId: progressText(run.runId).trim(),
    name: progressText(run.name).trim(),
    version: run.version,
    // The hash is what an approval cites; the schema pins 64 hex chars, so a
    // value that reached here is already safe to show verbatim.
    hash: run.hash,
    state: progressText(run.state).trim(),
    ...(run.stopReason === undefined ? {} : { stopReason: progressText(run.stopReason).trim() }),
    ...(run.reason === undefined
      ? {}
      : { reason: sanitizeWorkflowText(run.reason, WORKFLOW_REASON_CLIENT_MAX) }),
    tokens: run.tokens,
    ...(run.budget === undefined ? {} : { budget: run.budget }),
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    // Already ≤ 64 by schema (`WorkflowRowSchema`): the cap is a slice, not a map
    // of a hostile 10 000, and it keeps the FIRST steps — the run's order.
    steps: run.steps.slice(0, 64).map(boundStep),
  };
}

/**
 * The list as this client keeps it: at most `MAX_WORKFLOW_RUNS`, the daemon's
 * order preserved. The daemon appends the live run (`workflow-driver.ts:326`),
 * so what is cut is the OLDEST end — never the run being watched.
 */
export function boundWorkflows(rows: readonly WorkflowRow[]): WorkflowRow[] {
  const kept = rows.length > MAX_WORKFLOW_RUNS ? rows.slice(-MAX_WORKFLOW_RUNS) : rows;
  return kept.map(boundRun);
}

/** A snapshot's list, bounded the same way. Absent (an older daemon) stays absent. */
export function workflowsFromSnapshot(
  rows: readonly WorkflowRow[] | undefined,
): WorkflowRow[] | undefined {
  return rows === undefined ? undefined : boundWorkflows(rows);
}

/** The one thing this module needs of a pending ask: its id and the `agent.id` it was raised under. */
export interface PendingWorkflowAsk {
  readonly requestId: string;
  readonly agent?: { readonly id?: string } | undefined;
}

/**
 * The pending ask of ONE workflow step, or `undefined` — the ONE pairing of a
 * row with the prompt that must answer it (a phone's approve card, the panel's
 * "answer in the prompt" note).
 *
 * The driver tags every step's ask with `agent.id = "<runId>.<stepId>"`, and the
 * run's own hash approval with `"<runId>"` (`workflow-driver.ts:964`), so the
 * match is EXACT: a prefix test would pair `wf-1` with `wf-11`'s ask — the wrong
 * run, and the wrong approval answered. An ask with no `agent.id` is a
 * main-agent call, never a run's.
 */
export function askForStep<T extends PendingWorkflowAsk>(
  pending: readonly T[],
  runId: string,
  stepId: string | null,
): T | undefined {
  const wanted = stepId === null ? runId : `${runId}.${stepId}`;
  return pending.find((ask) => ask.agent?.id === wanted);
}

/**
 * The one short line the model reads about a live workflow run
 * (docs/feat/workflow-run-awareness.md, Design (a)). A pure projection of the
 * rows the clients are shown. Only `runId`, `name`, a step's id, states and
 * numbers get in: never a `reason`, a `live` text, an ask's title or a command,
 * which carry workflow-file or sub-agent text.
 */
import { type DaemonWakeState, daemonWakeGate, formatTokens } from "@tentacle/core";
import type { WorkflowRow, WorkflowStepRow } from "./workflow-driver.ts";

const LIVE_RUN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "needs-approval",
]);
const LIVE_STEP_STATES: ReadonlySet<string> = new Set(["running", "waiting", "needs-approval"]);

const MAX_LINES = 2;
const MAX_LINE_CHARS = 200;
/** What a name and a step id are cut to when the whole line would not fit. */
const CLIPPED_LABEL_CHARS = 32;

const whole = (label: string): string => label;
const clipped = (label: string): string =>
  label.length > CLIPPED_LABEL_CHARS ? `${label.slice(0, CLIPPED_LABEL_CHARS - 1)}…` : label;

/** `live` is only compared with the driver's `slot` marker, never shown. */
const waitsForSlot = (step: WorkflowStepRow): boolean =>
  step.state === "waiting" && step.live === "slot";

/** Where the step a run is on sits in its rows; -1 between two steps. */
const liveStepIndex = (row: WorkflowRow): number =>
  row.steps.findIndex((s) => LIVE_STEP_STATES.has(s.state));

function stepPhrase(step: WorkflowStepRow): string {
  if (step.state === "running") {
    const retry = step.attempt > 0 ? ` (retry ${step.attempt})` : "";
    const max = step.maxRound !== undefined ? `/${step.maxRound}` : "";
    const round = step.round > 0 ? ` (round ${step.round}${max})` : "";
    return `running${retry}${round}`;
  }
  return waitsForSlot(step) ? "waits for a sub-agent slot" : "waits for the user";
}

function runLine(row: WorkflowRow, label: (text: string) => string): string {
  const head = `[workflow ${row.runId} ${label(row.name)}: `;
  const index = liveStepIndex(row);
  const step = row.steps[index];
  if (step === undefined && row.state === "needs-approval") {
    return `${head}waits for the user to approve the run]`;
  }
  // No step is live between two steps: the run's progress is all there is to say.
  const now =
    step === undefined
      ? "running"
      : `step ${index + 1}/${row.steps.length} ${label(step.id)} ${stepPhrase(step)}`;
  const ok = row.steps.filter((s) => s.state === "ok").length;
  return `${head}${now} · ${ok}/${row.steps.length} ok · ${formatTokens(row.tokens)} tok]`;
}

function fittedLine(row: WorkflowRow): string {
  const line = runLine(row, whole);
  return line.length <= MAX_LINE_CHARS ? line : runLine(row, clipped);
}

const liveRuns = (rows: readonly WorkflowRow[]): WorkflowRow[] =>
  rows.filter((r) => LIVE_RUN_STATES.has(r.state));

/** One line per live run (two at most, then a count); `undefined` with none. */
export function workflowStatusLine(rows: readonly WorkflowRow[]): string | undefined {
  const live = liveRuns(rows);
  if (live.length === 0) {
    return undefined;
  }
  const lines = live.slice(0, MAX_LINES).map(fittedLine);
  if (live.length > MAX_LINES) {
    lines.push(`+${live.length - MAX_LINES} more`);
  }
  return lines.join("\n");
}

/** The ask of a live run that only a person can answer. */
export interface WorkflowUserWait {
  readonly runId: string;
  /** One per ask: `wf-3/approval`, or `wf-3/<step>/<attempt>/<round>`. */
  readonly key: string;
  /** The run's status line. */
  readonly line: string;
}

/** The key of the ask `row` waits on, if any: its live step's, or the run's approval. */
function userWaitKey(row: WorkflowRow): string | undefined {
  const step = row.steps[liveStepIndex(row)];
  if (step === undefined) {
    return row.state === "needs-approval" ? `${row.runId}/approval` : undefined;
  }
  // A slot wait is not the user's: it ends by itself.
  if (step.state === "running" || waitsForSlot(step)) {
    return undefined;
  }
  return `${row.runId}/${step.id}/${step.attempt}/${step.round}`;
}

/** The first live run that waits for the user; the same rows the line reads. */
export function workflowUserWait(rows: readonly WorkflowRow[]): WorkflowUserWait | undefined {
  for (const row of liveRuns(rows)) {
    const key = userWaitKey(row);
    if (key !== undefined) {
      return { runId: row.runId, key, line: fittedLine(row) };
    }
  }
  return undefined;
}

/** What the daemon knows when a wait's timer fires. */
export interface WorkflowWaitWakeState extends DaemonWakeState {
  /** The key the timer was armed for. */
  readonly armedKey: string;
  /** The key derived from the rows at fire time, never the armed copy. */
  readonly currentKey: string | undefined;
  readonly attachedCount: number;
  /** This key already woke the agent. */
  readonly woke: boolean;
  /** When this RUN last woke the agent for a wait. */
  readonly lastWakeAt: number | undefined;
  readonly now: number;
  readonly minGapMs: number;
}

export type WorkflowWaitWake =
  | { readonly kind: "wake" }
  /** Drop the timer; the key stays un-woken. */
  | { readonly kind: "disarm" }
  /** A turn runs: look again after another grace. */
  | { readonly kind: "rearm" }
  /** The run woke too recently: look again at `at`. */
  | { readonly kind: "rearm_at"; readonly at: number };

/**
 * Whether a wait whose timer just fired wakes the agent. The order matters: a
 * running turn comes before `lastEndBad`, which still describes the turn before
 * it, and both before the gap.
 */
export function workflowWaitWakeDue(s: WorkflowWaitWakeState): WorkflowWaitWake {
  const gate = daemonWakeGate(s);
  if (s.currentKey !== s.armedKey || s.woke || s.attachedCount > 0 || !gate.enabled || s.closed) {
    return { kind: "disarm" };
  }
  if (!gate.idle) {
    return { kind: "rearm" };
  }
  if (gate.blocked) {
    return { kind: "disarm" };
  }
  if (s.lastWakeAt !== undefined && s.now - s.lastWakeAt < s.minGapMs) {
    return { kind: "rearm_at", at: s.lastWakeAt + s.minGapMs };
  }
  return { kind: "wake" };
}

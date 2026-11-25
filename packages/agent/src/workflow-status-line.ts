/**
 * The one short line the model reads about a live workflow run
 * (docs/feat/workflow-run-awareness.md, Design (a)). A pure projection of the
 * rows the clients are shown. Only `runId`, `name`, a step's id, states and
 * numbers get in: never a `reason`, a `live` text, an ask's title or a command,
 * which carry workflow-file or sub-agent text.
 */
import { formatTokens } from "@tentacle/core";
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

function stepPhrase(step: WorkflowStepRow): string {
  if (step.state === "running") {
    const retry = step.attempt > 0 ? ` (retry ${step.attempt})` : "";
    const max = step.maxRound !== undefined ? `/${step.maxRound}` : "";
    const round = step.round > 0 ? ` (round ${step.round}${max})` : "";
    return `running${retry}${round}`;
  }
  // `live` is only compared with the driver's `slot` marker, never shown.
  return step.state === "waiting" && step.live === "slot"
    ? "waits for a sub-agent slot"
    : "waits for the user";
}

function runLine(row: WorkflowRow, label: (text: string) => string): string {
  const head = `[workflow ${row.runId} ${label(row.name)}: `;
  const index = row.steps.findIndex((s) => LIVE_STEP_STATES.has(s.state));
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

/** One line per live run (two at most, then a count); `undefined` with none. */
export function workflowStatusLine(rows: readonly WorkflowRow[]): string | undefined {
  const live = rows.filter((r) => LIVE_RUN_STATES.has(r.state));
  if (live.length === 0) {
    return undefined;
  }
  const lines = live.slice(0, MAX_LINES).map((row) => {
    const line = runLine(row, whole);
    return line.length <= MAX_LINE_CHARS ? line : runLine(row, clipped);
  });
  if (live.length > MAX_LINES) {
    lines.push(`+${live.length - MAX_LINES} more`);
  }
  return lines.join("\n");
}

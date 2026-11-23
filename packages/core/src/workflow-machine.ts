/**
 * The workflow executor's brain: a pure state machine that owns ORDER, retry,
 * `on_fail` goto counters, `max_step_runs` and the run's token sum
 * (docs/feat/agent-workflows.md D3, owner decision 2).
 *
 * Why it is a module and not code inside the driver: this is the whole promise
 * of the feature — "the CODE executes the sequence, the model does the work
 * INSIDE a step". So the sequence lives in one React-free, I/O-free, clock-free
 * place that a test drives with a scripted event list, and the daemon-side
 * driver only does the I/O (`workflow-driver.ts`).
 *
 * Nothing here decides a VERDICT: `step_result` carries it, typed by the step's
 * own protocol (a child's `step_verdict` call, a command's exit code, a human's
 * answer). Nothing here waits either — `waiting` and `needs-approval` are the
 * driver's memory and the wire's, never a durable fact (D4).
 *
 * Every end is FINAL: once `status` is not `running`, `next` returns the same
 * `end` action and changes nothing, so a late event (a child that exits after a
 * timeout) can never resurrect a run.
 */
import {
  WORKFLOW_MAX_REASON,
  type WorkflowSpec,
  type WorkflowStep,
  capWorkflowText,
  renderTemplate,
} from "./workflow-spec.ts";

/** How one step ended, as the machine and the log record it. */
export type StepVerdict = "pass" | "fail";

/** Why a run stopped without finishing (D3's `stopped{…}`). */
export type WorkflowStopReason =
  /** The token sum or `max_step_runs` ran out — the belt behind the counters. */
  | "budget"
  | "timeout"
  | "cancelled"
  | "interrupted"
  /** The file changed under a `resume`/`rerun_step`. */
  | "changed";

/** The run's state. Only `running` continues; the rest are terminal. */
export type WorkflowRunStatus = "running" | "ok" | "error" | "stopped";

/** What the driver reports back about the step it ran. */
export type WorkflowEvent =
  | {
      readonly kind: "step_result";
      readonly verdict: StepVerdict;
      /** Why, in the step's own words (`exit 2`, `no verdict`, …). Never empty on `fail`. */
      readonly reason?: string;
      /** Tokens this attempt spent (added to the run's sum). */
      readonly tokens?: number;
      /** The step's full output, for `{{steps.<id>.report}}` and the detail view. */
      readonly report?: string;
    }
  /** The token budget is spent — stop even if the step that noticed it passed. */
  | { readonly kind: "budget_hit"; readonly reason?: string }
  /** A step's ask went unanswered past `budget.wait` (decision 3). */
  | { readonly kind: "timeout" }
  | { readonly kind: "cancel" }
  /** A crash/quit: the run is closed honestly when it is loaded or torn down. */
  | { readonly kind: "interrupted" }
  /** A `resume`/`rerun_step` against an edited file. */
  | { readonly kind: "changed" };

/** What the driver must do next. */
export type WorkflowAction =
  | {
      readonly kind: "run_step";
      readonly id: string;
      /** 0 for the first attempt, 1..`retry` after a retry. */
      readonly attempt: number;
      /** The `on_fail.goto` counter this step was entered on (0 = not a goto). */
      readonly round: number;
      /** The goto edge's `max`, when `round` is a goto round. */
      readonly maxRound?: number;
      /** The prompt/command/title, templated with the run's inputs and outcomes. */
      readonly text: string;
    }
  | {
      readonly kind: "end";
      readonly status: Exclude<WorkflowRunStatus, "running">;
      readonly reason?: string;
    };

/** One step's LATEST outcome — what `{{steps.<id>.…}}` renders and the log records. */
export interface WorkflowStepOutcome {
  readonly verdict: StepVerdict;
  readonly reason?: string;
  readonly report?: string;
  readonly tokens: number;
  /** 1-based execution number of that step (a retry or a goto round re-runs it). */
  readonly run: number;
  /** The goto round it ended in (0 when entered by fall-through or `next`). */
  readonly round: number;
  readonly attempt: number;
}

/** The run's whole live state — plain data, serialisable in principle. */
export interface WorkflowRunState {
  readonly spec: WorkflowSpec;
  /** Every declared input, defaults applied (strings only in v1). */
  readonly inputs: Readonly<Record<string, string>>;
  readonly status: WorkflowRunStatus;
  /** The step to run (or the one that just ended). */
  readonly current: string;
  /** Attempts of `current` so far; 0 while its first attempt runs. */
  readonly attempt: number;
  /** The goto round `current` was entered on (0 = fall-through/`next`). */
  readonly round: number;
  /** `from->to` → times that goto edge was taken (its `max` is the limit). */
  readonly counters: Readonly<Record<string, number>>;
  /** Step id → executions so far (capped by `budget.maxStepRuns` in total). */
  readonly runs: Readonly<Record<string, number>>;
  /** Total executions across every step — the `maxStepRuns` belt. */
  readonly executions: number;
  /** The run's token sum so far. */
  readonly tokens: number;
  /** Step id → its latest outcome. */
  readonly outcomes: Readonly<Record<string, WorkflowStepOutcome>>;
  /** Set once `status` is terminal. */
  readonly stopReason?: WorkflowStopReason;
  /**
   * The end's ONE sentence — set with `status`, so the action and `endReason`
   * can never disagree (a derived sentence silently lost the goto detail).
   */
  readonly detail?: string;
}

/** The goto edge's key: a counter is per EDGE, so two loops don't share one. */
export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** The step a `pass` falls through to: `next`, else the next one in the file. */
function passTarget(spec: WorkflowSpec, step: WorkflowStep): string | undefined {
  if (step.next !== undefined) {
    return step.next;
  }
  const i = spec.steps.findIndex((s) => s.id === step.id);
  return i === -1 ? undefined : spec.steps[i + 1]?.id;
}

/** A declared input's value: what was given, else the default ("" when absent). */
export function resolveInputs(
  spec: WorkflowSpec,
  given: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, input] of Object.entries(spec.inputs)) {
    out[key] = given[key] ?? input.default ?? "";
  }
  return out;
}

/** The required inputs that were not given — the driver refuses the start on these. */
export function missingInputs(
  spec: WorkflowSpec,
  given: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(spec.inputs)
    .filter(([key, input]) => input.required && (given[key] ?? "") === "")
    .map(([key]) => key);
}

/** The templating context of a state: its inputs and every outcome so far. */
function renderContext(state: WorkflowRunState): {
  inputs: Record<string, string>;
  steps: Record<string, { reason?: string; report?: string }>;
} {
  const steps: Record<string, { reason?: string; report?: string }> = {};
  for (const [id, outcome] of Object.entries(state.outcomes)) {
    steps[id] = {
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.report === undefined ? {} : { report: outcome.report }),
    };
  }
  return { inputs: { ...state.inputs }, steps };
}

/** The step's own text, templated: its prompt, its command, or its ask title. */
function stepText(state: WorkflowRunState, step: WorkflowStep): string {
  const raw =
    step.kind === "agent"
      ? (step.promptText ?? "")
      : step.kind === "run"
        ? step.command
        : step.title;
  return renderTemplate(raw, renderContext(state));
}

/** A `stopped` state carrying its reason; the sentence is stored with it. */
function stopped(
  state: WorkflowRunState,
  reason: WorkflowStopReason,
): { state: WorkflowRunState; action: WorkflowAction } {
  const next: WorkflowRunState = { ...state, status: "stopped", stopReason: reason };
  const detail = stopDetail(next);
  const stated: WorkflowRunState = { ...next, detail };
  return { state: stated, action: { kind: "end", status: "stopped", reason: detail } };
}

/** An `error` state: the sequence cannot continue honestly. */
function failed(
  state: WorkflowRunState,
  detail: string,
): { state: WorkflowRunState; action: WorkflowAction } {
  const next: WorkflowRunState = { ...state, status: "error", detail };
  return { state: next, action: { kind: "end", status: "error", reason: detail } };
}

/** The `end` action a terminal state keeps returning — idempotent, always the same. */
function endOf(state: WorkflowRunState): WorkflowAction {
  const status = state.status === "running" ? "error" : state.status;
  return { kind: "end", status, reason: state.detail ?? stopDetail(state) };
}

/**
 * The sentence a terminal state reports. Derived (not stored) so a state is
 * plain data: `error` names the step that failed, `stopped` names the reason.
 */
function stopDetail(state: WorkflowRunState): string {
  if (state.status === "ok") {
    return `done · ${state.executions} step${state.executions === 1 ? "" : "s"} · ${state.tokens} tok`;
  }
  const last = state.outcomes[state.current];
  const why = last?.reason === undefined ? "" : ` — ${last.reason}`;
  switch (state.stopReason) {
    case "budget":
      return `budget spent (${state.tokens} tok, ${state.executions} steps)`;
    case "timeout":
      return `a permission went unanswered — stopped at ${state.current}${why}`;
    case "cancelled":
      return `cancelled at ${state.current}${why}`;
    case "interrupted":
      return `interrupted at ${state.current}${why}`;
    case "changed":
      return "the workflow file changed — start a new run";
    default:
      return `${state.current} failed${why}`;
  }
}

/** The action that runs `step`: the run's guard rails first, then the verdict. */
function runStep(
  state: WorkflowRunState,
  step: WorkflowStep,
  attempt: number,
  round: number,
  maxRound: number | undefined,
): { state: WorkflowRunState; action: WorkflowAction } {
  // The two belts, checked BEFORE another step starts — a run never enters a
  // step it cannot pay for or is not allowed to run (D1's termination rule).
  if (state.executions >= state.spec.budget.maxStepRuns) {
    return stopped(state, "budget");
  }
  const budget = state.spec.budget.tokens;
  if (budget !== undefined && state.tokens >= budget) {
    return stopped(state, "budget");
  }
  const next: WorkflowRunState = {
    ...state,
    current: step.id,
    attempt,
    round,
    executions: state.executions + 1,
    runs: { ...state.runs, [step.id]: (state.runs[step.id] ?? 0) + 1 },
  };
  return {
    state: next,
    action: {
      kind: "run_step",
      id: step.id,
      attempt,
      round,
      ...(maxRound === undefined ? {} : { maxRound }),
      text: stepText(next, step),
    },
  };
}

/**
 * Begin a run: the first step's `run_step`, or `error` when the file has none
 * (validation refuses that, so this is the belt).
 */
export function start(
  spec: WorkflowSpec,
  given: Readonly<Record<string, string>> = {},
): { state: WorkflowRunState; action: WorkflowAction } {
  const inputs = resolveInputs(spec, given);
  const first = spec.steps[0];
  const empty: WorkflowRunState = {
    spec,
    inputs,
    status: "running",
    current: first?.id ?? "",
    attempt: 0,
    round: 0,
    counters: {},
    runs: {},
    executions: 0,
    tokens: 0,
    outcomes: {},
  };
  if (first === undefined) {
    return failed(empty, "the workflow has no steps");
  }
  return runStep(empty, first, 0, 0, undefined);
}

/**
 * Advance one step. `state` carries the spec, so this is total: a terminal state
 * returns the same `end`, unknown ids fall back to a clean refusal.
 */
export function next(
  state: WorkflowRunState,
  event: WorkflowEvent,
): { state: WorkflowRunState; action: WorkflowAction } {
  if (state.status !== "running") {
    return { state, action: endOf(state) };
  }
  if (event.kind !== "step_result") {
    const stopReason: WorkflowStopReason =
      event.kind === "budget_hit" ? "budget" : event.kind === "cancel" ? "cancelled" : event.kind;
    // The driver's own sentence (a `budget_hit` may quote its numbers); the
    // derived one otherwise, so the two can never disagree.
    const supplied = event.kind === "budget_hit" ? event.reason : undefined;
    const ended = stopped(state, stopReason);
    return supplied === undefined
      ? ended
      : { state: ended.state, action: { kind: "end", status: "stopped", reason: supplied } };
  }

  const step = state.spec.steps.find((s) => s.id === state.current);
  if (step === undefined) {
    return failed(state, `${state.current} is not a step of ${state.spec.name}`);
  }
  const spent = event.tokens ?? 0;
  const withSpend: WorkflowRunState = { ...state, tokens: state.tokens + spent };
  const reason =
    event.reason === undefined ? undefined : capWorkflowText(event.reason, WORKFLOW_MAX_REASON);
  const outcome: WorkflowStepOutcome = {
    verdict: event.verdict,
    ...(reason === undefined ? {} : { reason }),
    ...(event.report === undefined ? {} : { report: event.report }),
    tokens: spent,
    run: state.runs[step.id] ?? 1,
    round: state.round,
    attempt: state.attempt,
  };
  const recorded: WorkflowRunState = {
    ...withSpend,
    outcomes: { ...withSpend.outcomes, [step.id]: outcome },
  };

  if (event.verdict === "pass") {
    const target = passTarget(state.spec, step);
    if (target === undefined) {
      const done: WorkflowRunState = {
        ...recorded,
        status: "ok",
        detail: `done · ${recorded.executions} step${recorded.executions === 1 ? "" : "s"} · ${recorded.tokens} tok`,
      };
      return { state: done, action: endOf(done) };
    }
    const nextStep = state.spec.steps.find((s) => s.id === target);
    if (nextStep === undefined) {
      return failed(recorded, `next: no step "${target}"`);
    }
    return runStep(recorded, nextStep, 0, 0, undefined);
  }

  // `fail`: retry first, then `on_fail`.
  if (state.attempt < step.retry) {
    return runStep(recorded, step, state.attempt + 1, state.round, undefined);
  }
  const onFail = step.onFail;
  if (onFail.kind === "stop") {
    return failed(recorded, `${step.id} failed${reason === undefined ? "" : ` — ${reason}`}`);
  }
  const key = edgeKey(step.id, onFail.id);
  const taken = state.counters[key] ?? 0;
  if (taken >= onFail.max) {
    return failed(
      recorded,
      `${step.id} failed${reason === undefined ? "" : ` — ${reason}`}; on_fail.goto ${onFail.id} already ran ${taken}/${onFail.max} times`,
    );
  }
  const gotoStep = state.spec.steps.find((s) => s.id === onFail.id);
  if (gotoStep === undefined) {
    return failed(recorded, `on_fail.goto: no step "${onFail.id}"`);
  }
  const round = taken + 1;
  const withCounter: WorkflowRunState = {
    ...recorded,
    counters: { ...recorded.counters, [key]: round },
  };
  return runStep(withCounter, gotoStep, 0, round, onFail.max);
}

/**
 * `rerun_step` after a crash (owner Q4): the same run, re-entered at `id` from
 * scratch — attempt +1, the execution counters kept, so a resume cannot loop
 * forever around the cap.
 */
export function rerunAt(
  state: WorkflowRunState,
  id: string,
  round = state.round,
): { state: WorkflowRunState; action: WorkflowAction } {
  const step = state.spec.steps.find((s) => s.id === id);
  if (step === undefined) {
    return failed(state, `${id} is not a step of ${state.spec.name}`);
  }
  const resumed: WorkflowRunState = { ...state, status: "running", stopReason: undefined };
  return runStep(
    resumed,
    step,
    (state.runs[id] ?? 0) > 0 ? state.attempt + 1 : 0,
    round,
    undefined,
  );
}

/**
 * The run's `budget.wait` (decision 3): the driver arms it around every ask, and
 * a state whose wait expired ends `stopped: timeout` — never a silent retry.
 */
export function waitExpired(state: WorkflowRunState): {
  state: WorkflowRunState;
  action: WorkflowAction;
} {
  return next(state, { kind: "timeout" });
}

/** A state's terminal sentence, for the note the driver leaves in the conversation. */
export function endReason(state: WorkflowRunState): string {
  return state.detail ?? stopDetail(state);
}

/** `true` once no further step can run. */
export function isTerminal(state: WorkflowRunState): boolean {
  return state.status !== "running";
}

/**
 * ONE projection of a workflow run, shared by the phone and the TUI
 * (docs/fix/workflows-ux.md D2, slice S5): each step's PHASE, each edge's TRACE,
 * the "not run" sentence, the B timeline and the run's summary strip. Pure and
 * React-free (AGENTS §7), so every branch is tested without a simulator or a
 * terminal, and the two ends cannot disagree about "not yet" vs "not run".
 *
 * Why a phase is not the wire's state: the wire says `pending` for BOTH "has not
 * run yet, and will" and "never ran, and never will" — which is how `fix` came
 * out as `○ fix · waiting` inside the chain of a FINISHED run (d1b5faaa). The
 * difference is not in one row, it is in the run: on a live run a reachable step
 * is "not yet", everything else is "not run". That calculation lives here once.
 *
 * Input is a row the client already bounded (`boundWorkflows`), so nothing here
 * sanitizes: every id is a label, every state a free word that may be one this
 * build does not know (kept and printed verbatim, never coerced).
 */
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";

/**
 * What a step IS, for a reader — the mockups' seven looks (`final-v3`): `later`
 * = not yet (it will run), `skipped` = not run (it will not), `ask` = it needs
 * the person. `unknown` is a wire word this build does not know, kept as its own
 * phase so a newer daemon is never mislabelled.
 */
export type WorkflowPhase =
  | "ok"
  | "error"
  | "running"
  | "ask"
  | "later"
  | "skipped"
  | "stopped"
  | "unknown";

/**
 * How an edge is drawn. `taken` = it happened; `go` = it is happening (the run
 * is moving along it right now); `later` = it may still happen; `never` = it
 * cannot (the run ended, the counter is spent, or the source already passed).
 */
export type WorkflowTrace = "taken" | "go" | "later" | "never";

/** An edge of the run's OWN definition snapshot (`next`, `on_fail`, `retry`). */
export interface WorkflowEdgeView {
  readonly kind: "next" | "fail" | "retry";
  readonly from: string;
  readonly to: string;
  readonly trace: WorkflowTrace;
  /** The counter, on the edges that have one: `✗ 1/2` (goto), `↻ 0/1` (retry). */
  readonly chip?: string;
}

/** One step, projected. */
export interface WorkflowStepView {
  readonly id: string;
  readonly kind: string;
  /** The wire's own word, as sent. */
  readonly state: string;
  readonly phase: WorkflowPhase;
  /** The word a reader is given: `done`, `not run`, `needs approval`, the unknown word… */
  readonly word: string;
  /** `word` plus what the mockups print beside it (`done · 0.4s`, a live action line). */
  readonly meta: string;
  readonly attempt: number;
  readonly round: number;
  readonly durationMs?: number;
  /** The run's frozen definition edges, for a panel that lists them (D7). */
  readonly next: string | null;
  readonly onFail: { readonly goto: string; readonly max: number; readonly taken: number } | null;
  readonly retry: number;
}

/** Why a step is "not run", in the owner's words, with the smaller second line. */
export interface WorkflowWhy {
  readonly text: string;
  readonly small?: string;
}

/** One row of the B timeline: a visit, or a step that has not been visited. */
export interface WorkflowTimelineRow {
  readonly step: string;
  readonly phase: WorkflowPhase;
  readonly meta: string;
  readonly durationMs?: number;
  readonly round?: number;
  readonly attempt?: number;
  /** Only on a "not run" row. */
  readonly why?: WorkflowWhy;
}

/** The B timeline: the visits in order, then what is next, then what never runs. */
export interface WorkflowTimeline {
  readonly rows: readonly WorkflowTimelineRow[];
  readonly next: readonly WorkflowTimelineRow[];
  readonly notRun: readonly WorkflowTimelineRow[];
  /** `3 earlier steps not shown`, when the row's `history` was capped. */
  readonly droppedNote?: string;
}

/** The graph's facts: phases, traces, and which step the run is on. */
export interface WorkflowProjection {
  readonly live: boolean;
  /** `steps[0]` is the file's first step, always. */
  readonly steps: readonly WorkflowStepView[];
  readonly edges: readonly WorkflowEdgeView[];
  /** The step the run is ON (running, or waiting on the person), when there is one. */
  readonly current?: string;
  /** Steps that will still run (reachable while the run is live), in file order. */
  readonly next: readonly string[];
  /** Steps that will not run, in file order. */
  readonly notRun: readonly string[];
  /** The run itself, as the strip and the timeline read it. */
  readonly run: {
    readonly runId: string;
    readonly name: string;
    readonly state: string;
    readonly stopReason?: string;
    readonly tokens: number;
    readonly budget?: number;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly history: WorkflowRow["history"];
    readonly historyDropped: number;
  };
}

/** The top strip of the run screen. */
export interface WorkflowSummary {
  readonly phase: WorkflowPhase;
  readonly word: string;
  readonly time: string;
  readonly line2: string;
}

/** The wire's known states, as phases. `pending` is deliberately NOT here (it needs the run). */
const PHASE_OF_STATE: Readonly<Record<string, WorkflowPhase>> = {
  ok: "ok",
  error: "error",
  running: "running",
  stopped: "stopped",
  waiting: "ask",
  "needs-approval": "ask",
};

/** A duration as the mockups print it: `36s`, `1m 12s`, `1h 02m`. Never negative (clock skew). */
function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A token count as the strip prints it: `940`, `21.4k`, `40k`. */
function compactTokens(n: number): string {
  if (n < 1_000) {
    return String(n);
  }
  return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The word a step of this phase is said with. `unknown` keeps the wire's own word. */
function wordOf(phase: WorkflowPhase, step: WorkflowStepRow, state: string): string {
  switch (phase) {
    case "ok":
      return step.kind === "approve" ? "approved" : "done";
    case "error":
      return "failed";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "ask":
      return state === "waiting" ? "waiting on you" : "needs approval";
    case "later":
      return "not yet";
    case "skipped":
      return "not run";
    default:
      return state;
  }
}

/** `done · 0.4s`, `running · edit notes/demo-note.md` — the mockups' second line. */
function metaOf(phase: WorkflowPhase, word: string, step: WorkflowStepRow): string {
  if (phase === "running" && step.live !== undefined && step.live !== "") {
    return `${word} · ${step.live}`;
  }
  return step.durationMs === undefined ? word : `${word} · ${elapsedLabel(step.durationMs)}`;
}

/**
 * Every step reachable from `root` along the run's OWN edges: `next`, and an
 * `on_fail` goto while its counter has room. The retry self-loop adds no step,
 * so it is not walked. Cycle-guarded (a `next` cycle with a counter is legal).
 */
function reachableFrom(steps: readonly WorkflowStepRow[], root: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const reached = new Set<string>();
  const queue: WorkflowStepRow[] = [];
  const first = byId.get(root);
  if (first !== undefined) {
    queue.push(first);
  }
  while (queue.length > 0) {
    const step = queue.shift();
    if (step === undefined) {
      continue;
    }
    const out: string[] = [];
    if (step.next !== null) {
      out.push(step.next);
    }
    if (step.onFail !== null && step.onFail.taken < step.onFail.max) {
      out.push(step.onFail.goto);
    }
    for (const id of out) {
      const target = byId.get(id);
      if (target === undefined || id === step.id || reached.has(id)) {
        continue;
      }
      reached.add(id);
      queue.push(target);
    }
  }
  return reached;
}

/** The step the run is ON: a running one, else the one waiting on the person. */
function currentOf(steps: readonly WorkflowStepRow[]): string | undefined {
  return (
    steps.find((s) => s.state === "running")?.id ??
    steps.find((s) => s.state === "needs-approval" || s.state === "waiting")?.id
  );
}

/**
 * The run, projected (docs/fix/workflows-ux.md D2). Called on every `workflows`
 * update, so it stays O(steps + edges).
 */
export function runProjection(row: WorkflowRow): WorkflowProjection {
  const live = row.endedAt === undefined;
  const current = currentOf(row.steps);
  // Reachability only matters while the run can still move: an ended run's every
  // `pending` step is "not run" by definition — there is nothing left to come.
  const root = current ?? row.history.at(-1)?.step ?? row.steps[0]?.id;
  const reached = live && root !== undefined ? reachableFrom(row.steps, root) : new Set<string>();
  if (live && root !== undefined) {
    // A run that has not moved yet: its first step is "not yet", not "not run".
    reached.add(root);
  }
  if (current !== undefined) {
    // The step it is ON is worded by its own wire state, never as pending.
    reached.delete(current);
  }

  const steps = row.steps.map((step): WorkflowStepView => {
    const phase: WorkflowPhase =
      step.state === "pending"
        ? reached.has(step.id)
          ? "later"
          : "skipped"
        : (PHASE_OF_STATE[step.state] ?? "unknown");
    const word = wordOf(phase, step, step.state);
    return {
      id: step.id,
      kind: step.kind,
      state: step.state,
      phase,
      word,
      meta: metaOf(phase, word, step),
      attempt: step.attempt,
      round: step.round,
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      next: step.next,
      onFail: step.onFail,
      retry: step.retry,
    };
  });
  const viewOf = new Map(steps.map((s) => [s.id, s]));

  // The transitions the run's history PROVES: two consecutive visits, and — while
  // it is live — the leg into the step it is on now.
  const transitions = new Set<string>();
  const key = (from: string, to: string): string => `${from}\u0000${to}`;
  for (let i = 1; i < row.history.length; i += 1) {
    const prev = row.history[i - 1];
    const here = row.history[i];
    if (prev !== undefined && here !== undefined) {
      transitions.add(key(prev.step, here.step));
    }
  }
  const lastVisited = row.history.at(-1)?.step;
  if (live && current !== undefined && lastVisited !== undefined) {
    transitions.add(key(lastVisited, current));
  }

  const traceOf = (from: string, to: string, kind: WorkflowEdgeView["kind"]): WorkflowTrace => {
    const source = viewOf.get(from);
    if (live && to === current && from === lastVisited) {
      // The leg the run is walking right now, or the one into the step it waits on:
      // ONLY the one out of its last visit. Any other edge into `current` (the loop
      // back from a step that never ran, a retry that did not happen) falls through.
      return viewOf.get(to)?.phase === "running" ? "go" : "taken";
    }
    if (transitions.has(key(from, to))) {
      return "taken";
    }
    // A spent counter or a raised attempt is proof of its own, even on an ended run.
    const proved =
      kind === "fail"
        ? (source?.onFail?.taken ?? 0) > 0
        : kind === "retry"
          ? (source?.attempt ?? 0) > 0
          : false;
    if (proved) {
      return "taken";
    }
    if (!live || source === undefined) {
      return "never";
    }
    const phase = source.phase;
    const couldMove = phase === "error" || phase === "running" || phase === "later";
    if (kind === "next") {
      // A pass edge waits on a source that ran or still has to: the loop back into
      // `review` is possible while `fix` runs (mockup ④).
      return phase === "later" ||
        phase === "running" ||
        phase === "ask" ||
        phase === "ok" ||
        phase === "error"
        ? "later"
        : "never";
    }
    if (kind === "fail") {
      // A goto fires off a step that failed or has still to run; a step that
      // already PASSED never jumps, which is why mockup ③ draws it "never".
      const spent = (source.onFail?.taken ?? 0) >= (source.onFail?.max ?? 0);
      return !spent && couldMove ? "later" : "never";
    }
    return source.attempt < source.retry && couldMove ? "later" : "never";
  };

  const edges: WorkflowEdgeView[] = [];
  for (const step of row.steps) {
    if (step.next !== null) {
      edges.push({
        kind: "next",
        from: step.id,
        to: step.next,
        trace: traceOf(step.id, step.next, "next"),
      });
    }
    if (step.onFail !== null) {
      edges.push({
        kind: "fail",
        from: step.id,
        to: step.onFail.goto,
        trace: traceOf(step.id, step.onFail.goto, "fail"),
        chip: `✗ ${step.onFail.taken}/${step.onFail.max}`,
      });
    }
    if (step.retry > 0) {
      edges.push({
        kind: "retry",
        from: step.id,
        to: step.id,
        trace: traceOf(step.id, step.id, "retry"),
        chip: `↻ ${step.attempt}/${step.retry}`,
      });
    }
  }

  return {
    live,
    steps,
    edges,
    ...(current === undefined ? {} : { current }),
    next: row.steps.filter((s) => reached.has(s.id)).map((s) => s.id),
    notRun: steps.filter((s) => s.phase === "skipped").map((s) => s.id),
    run: {
      runId: row.runId,
      name: row.name,
      state: row.state,
      ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
      tokens: row.tokens,
      ...(row.budget === undefined ? {} : { budget: row.budget }),
      startedAt: row.startedAt,
      ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
      history: row.history,
      historyDropped: row.historyDropped,
    },
  };
}

/**
 * Why a step did not run, in the owner's words (docs/fix/workflows-ux.md D2):
 * `null` when the step DID run. Cases in order — the specific reason first, the
 * generic one last, so a step whose only route is an unused `on_fail` says why
 * instead of "the run went another way".
 */
export function notRunWhy(projection: WorkflowProjection, stepId: string): WorkflowWhy | null {
  const step = projection.steps.find((s) => s.id === stepId);
  if (step === undefined || step.phase !== "skipped") {
    return null;
  }
  // Its ONLY way in is a goto, from a step that PASSED: its on-fail route never fired.
  const sources = projection.edges
    .filter((e) => e.kind === "fail" && e.to === stepId)
    .map((e) => projection.steps.find((s) => s.id === e.from))
    .filter((s): s is WorkflowStepView => s !== undefined);
  const first = sources[0];
  if (first !== undefined && sources.every((s) => s.phase === "ok")) {
    const when = first.round > 1 ? `on round ${first.round}` : "on its first try";
    const max = first.onFail?.max ?? 0;
    return {
      text: `Not run — ${first.id} passed ${when}.`,
      small: `${stepId} runs only when ${first.id} fails, up to ${max} ${plural(max, "time", "times")}.`,
    };
  }
  // The step the run ENDED at: the last one that failed or was cut, so a run
  // that recovered once and then failed names the step it actually died on.
  const cut = projection.steps.filter((s) => s.phase === "stopped" || s.phase === "error").at(-1);
  if (cut !== undefined && !projection.live) {
    return { text: `Not run — the run ended at ${cut.id}.` };
  }
  return { text: "Not run — the run went another way." };
}

/** How the B timeline words a step the run is on. */
function currentMeta(view: WorkflowStepView): string {
  if (view.phase === "ask") {
    return "needs you";
  }
  if (view.phase === "running" && view.meta !== view.word) {
    return view.meta.slice(view.word.length + 3);
  }
  return view.word;
}

/** How the B timeline words one visit: `done · try 2`, `failed · round 1 → fix`. */
function visitMeta(
  entry: WorkflowRow["history"][number],
  step: WorkflowStepView | undefined,
): string {
  const word =
    entry.state === "ok"
      ? step?.kind === "approve"
        ? "approved"
        : "done"
      : entry.state === "error"
        ? "failed"
        : entry.state;
  const parts = [word];
  // A step that CAN be retried says which try each visit was, the first one too
  // (mockup ②: `failed · try 1`, then `done · try 2`).
  if ((step?.retry ?? 0) > 0) {
    parts.push(`try ${entry.attempt + 1}`);
  }
  if (entry.round > 0) {
    parts.push(
      entry.state === "error" && step?.onFail
        ? `round ${entry.round} → ${step.onFail.goto}`
        : `round ${entry.round}`,
    );
  }
  return parts.join(" · ");
}

/** The B timeline (D2/D5): the visits, then Next (live only), then Not run. */
export function timeline(projection: WorkflowProjection): WorkflowTimeline {
  const rows: WorkflowTimelineRow[] = projection.run.history.map((entry) => {
    const step = projection.steps.find((s) => s.id === entry.step);
    const phase: WorkflowPhase =
      entry.state === "ok" || entry.state === "error" || entry.state === "stopped"
        ? entry.state
        : (PHASE_OF_STATE[entry.state] ?? "unknown");
    return {
      step: entry.step,
      phase,
      meta: visitMeta(entry, step),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      round: entry.round,
      attempt: entry.attempt,
    };
  });

  const currentView = projection.steps.find((s) => s.id === projection.current);
  if (currentView !== undefined) {
    rows.push({
      step: currentView.id,
      phase: currentView.phase,
      meta: currentMeta(currentView),
      ...(currentView.durationMs === undefined ? {} : { durationMs: currentView.durationMs }),
      round: currentView.round,
      attempt: currentView.attempt,
    });
  }

  const next: WorkflowTimelineRow[] = projection.live
    ? projection.next.map((id) => {
        const view = projection.steps.find((s) => s.id === id);
        const parent = projection.edges.find((e) => e.to === id && e.trace === "later");
        const after = `after ${parent?.from ?? "the run"}`;
        return {
          step: id,
          phase: view?.phase ?? "later",
          meta: view !== undefined && view.round > 0 ? `${after} · round ${view.round}` : after,
        };
      })
    : [];

  const notRun: WorkflowTimelineRow[] = projection.notRun.map((id) => {
    const why = notRunWhy(projection, id);
    return {
      step: id,
      phase: "skipped",
      meta: "not run",
      ...(why === null ? {} : { why }),
    };
  });

  const dropped = projection.run.historyDropped;
  return {
    rows,
    next,
    notRun,
    ...(dropped > 0
      ? { droppedNote: `${dropped} earlier ${plural(dropped, "step", "steps")} not shown` }
      : {}),
  };
}

/** The outcome word of the strip. */
function outcomeWord(projection: WorkflowProjection): string {
  const state = projection.run.state;
  const currentView = projection.steps.find((s) => s.id === projection.current);
  switch (currentView?.phase) {
    case "running":
      return "Running";
    case "ask":
      return currentView.state === "waiting" ? "Waiting on you" : "Needs approval";
    case "error":
      return "Failed";
    case "stopped":
      return `Stopped${projection.run.stopReason === undefined ? "" : ` · ${projection.run.stopReason}`}`;
    case "ok":
      return projection.live ? "Running" : "Done";
    default:
      break;
  }
  const phase = PHASE_OF_STATE[state];
  if (phase === "stopped") {
    return `Stopped${projection.run.stopReason === undefined ? "" : ` · ${projection.run.stopReason}`}`;
  }
  if (phase === "error") {
    return "Failed";
  }
  if (phase === "ok") {
    return "Done";
  }
  if (phase === "running") {
    return "Running";
  }
  if (phase === "ask") {
    return "Needs approval";
  }
  // An unknown run state is said as the daemon sent it, never relabelled.
  return state;
}

/**
 * The top strip (D2): the outcome and its phase, the total time, and what the run
 * spent and did. `now` is passed in so the strip's time is testable and never
 * read from a clock inside a pure module.
 */
export function summary(projection: WorkflowProjection, now: number): WorkflowSummary {
  const currentView = projection.steps.find((s) => s.id === projection.current);
  const phase: WorkflowPhase =
    projection.live && currentView !== undefined
      ? currentView.phase
      : (PHASE_OF_STATE[projection.run.state] ?? "unknown");

  const time = elapsedLabel((projection.run.endedAt ?? now) - projection.run.startedAt);
  const tokens = compactTokens(projection.run.tokens);
  const money =
    projection.run.budget === undefined
      ? `${tokens} tokens${projection.live ? " so far" : ""}`
      : `${tokens} of ${compactTokens(projection.run.budget)} tokens`;

  const loops = projection.steps.reduce((n, s) => n + (s.onFail?.taken ?? 0), 0);
  const loopNote = loops > 0 ? ` · ${loops} ${plural(loops, "loop", "loops")}` : "";
  const total = projection.steps.length;
  const index = projection.steps.findIndex((s) => s.id === projection.current) + 1;

  let line2: string;
  if (projection.live) {
    const on =
      currentView?.phase === "running"
        ? `${currentView.id}${currentView.round > 0 ? `, round ${currentView.round}` : ""} · step ${index} of ${total}`
        : `step ${index} of ${total}`;
    line2 = `${money} · ${on}${loopNote}`;
  } else {
    // A step that ran is one the daemon no longer calls `pending`; the history is
    // capped, so counting it would undercount a long run.
    const ran = projection.steps.filter((s) => s.state !== "pending").length;
    line2 = `${money} · ${ran} of ${total} steps ran${loopNote}`;
  }

  return { phase, word: outcomeWord(projection), time, line2 };
}

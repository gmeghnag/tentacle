/**
 * One workflow run on the phone, graph 2C ⇄ cards 2A (docs/feat/workflows-ui.md
 * D4, slice 3). Pure and injected (AGENTS §7): the screen draws `state()` and
 * forwards taps.
 *
 * - **The attach** goes through the SAME session runtime as the Session screen
 *   (`session-runtimes.ts`): `open(sessionId)`, never with `reopen` — an archived
 *   session is only revived by its explicit Reopen (§7). A session that ended
 *   between the list and the tap says "This session has ended". A session another
 *   screen already follows is BORROWED: leaving never detaches it from under that
 *   screen (`createSessionController` keeps one handle per id, no refcount).
 * - **The run** is the session's own `workflows` feed, picked by `runId`.
 * - **Approve** pairs the ONE ask on the phone's permission sheet with its step
 *   (`askForStep`: exact `<runId>.<stepId>`, the run's hash approval `<runId>`) and
 *   answers it through the sheet's own path (`answerFor`, keyed on that ask's
 *   `requestId`) — never a second resolve path. With no sheet for this session
 *   (its screen is not up) there are no buttons.
 * - **Stop / resume / rerun** are the session's `workflow(...)`; a refusal is a
 *   notice with the daemon's reason.
 */
import { type WorkflowAction, askForStep } from "@tentacle/client";
import type {
  WorkflowResult,
  WorkflowRow,
  WorkflowStepDetail,
  WorkflowStepResult,
  WorkflowStepRow,
} from "@tentacle/protocol";
import type { SheetState } from "./permission-sheet.ts";
import type { SessionOpenFailure } from "./session-controller.ts";
import { type StateLook, stateLook } from "./workflow-list.ts";

/** Shown (with a way back) when the session ended between the list and the tap. */
export const SESSION_ENDED = "This session has ended";
/** A tap on an ask that was settled meanwhile (answered elsewhere, withdrawn). */
export const RUN_ASK_GONE = "That request is no longer waiting";

export type RunMode = "graph" | "cards";

/**
 * A step's DETAIL, as this screen holds it (docs/feat/workflows-ui.md D5): absent
 * = never asked. The four answers a read can give are kept apart on purpose —
 * `missing` (never ran, or its entry left the retained log) is not the same thing
 * as `unsupported` (an older daemon: "update tentacle"), and a failed read is its
 * own state with the reason, never a skeleton left shimmering forever.
 */
export type StepDetail =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: WorkflowStepDetail }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string };

/** The ask a card shows: its id, the asker's id (the pairing), and the text VERBATIM. */
export interface CardAsk {
  readonly requestId: string;
  readonly agent?: { readonly id?: string };
  readonly title: string;
  /** Never truncated: a `run` command is shown as it will run (§7). */
  readonly detail: string;
}

/** The phone's permission sheet for THIS session, narrowed to what a card needs. */
export interface AskSource {
  current(): CardAsk | null;
  answerFor(requestId: string, optionId: "allow_once" | "reject_once"): "sent" | "ignored";
  subscribe(listener: () => void): () => void;
}

/**
 * The session's permission sheet as a card's ask source: the ask on screen when
 * it has the daemon's id (a local ask has none and cannot be keyed), its title and
 * detail VERBATIM, and its asker id for the pairing. Everything else (idle, a
 * returned reply) is no ask. Answers go to the sheet's own `answerFor`.
 */
export function askSourceFromSheet(sheet: {
  view(): SheetState;
  answerFor(requestId: string, optionId: "allow_once" | "reject_once"): "sent" | "ignored";
  subscribe(listener: () => void): () => void;
}): AskSource {
  return {
    current() {
      const view = sheet.view();
      if (view.kind !== "asking" || view.requestId === null) {
        return null;
      }
      return {
        requestId: view.requestId,
        ...(view.agentId === null ? {} : { agent: { id: view.agentId } }),
        title: view.request.title,
        detail: view.request.detail ?? "",
      };
    },
    answerFor: (requestId, optionId) => sheet.answerFor(requestId, optionId),
    subscribe: (listener) => sheet.subscribe(listener),
  };
}

export interface RunSessionHandle {
  onWorkflows(listener: (rows: readonly WorkflowRow[]) => void): () => void;
  workflow(action: WorkflowAction): Promise<WorkflowResult | { ok: false; reason: string }>;
  /**
   * One step execution's `prompt`/`report` (`session/workflow_step`, slice 1a).
   * Optional because a handle is the Session screen's own subset too; absent =
   * this build has no way to read a detail, and the card says so.
   */
  workflowStep?(
    runId: string,
    stepId: string,
    attempt?: number,
  ): Promise<WorkflowStepResult | { unsupported: true }>;
}

export interface WorkflowRunDeps {
  readonly runId: string;
  readonly sessionId: string;
  /** Another screen already follows this session: never `leave` it. */
  readonly borrowed: boolean;
  readonly open: (
    sessionId: string,
  ) => Promise<
    | { readonly ok: true; readonly session: RunSessionHandle }
    | { readonly ok: false; readonly reason: SessionOpenFailure }
  >;
  readonly leave: () => void;
  readonly asks: AskSource | null;
  /** The per-app view-mode memory. */
  readonly mode: { get(): RunMode; set(mode: RunMode): void };
  readonly onChange?: () => void;
}

export interface StepCard {
  readonly step: WorkflowStepRow;
  readonly look: StateLook;
  /** The pending ask of this step, or null (none, settled, or no sheet here). */
  readonly ask: CardAsk | null;
  /** This step's prompt/report, once asked for; absent = never asked. */
  readonly detail?: StepDetail;
}

export interface RunState {
  readonly phase: "opening" | "ready" | "ended" | "failed";
  /** The run, or null until the session's feed carries it. */
  readonly run: WorkflowRow | null;
  readonly steps: readonly StepCard[];
  /** The run's own hash approval, when it is the ask on the sheet. */
  readonly runAsk: CardAsk | null;
  readonly mode: RunMode;
  /** A refusal, an ended session, a stale tap. */
  readonly notice: string | null;
  /** Whether this screen can answer asks at all (a sheet exists for the session). */
  readonly canAnswer: boolean;
  /** The step whose detail is open (the morph layer), or null. */
  readonly openStepId: string | null;
}

const ENDED: readonly SessionOpenFailure[] = ["archived", "deleted", "gone"];

export interface WorkflowRunController {
  state(): RunState;
  start(): void;
  dispose(): void;
  setMode(mode: RunMode): void;
  /** Answer the ask of `stepId` (null: the run's own approval). */
  answer(stepId: string | null, optionId: "allow_once" | "reject_once"): void;
  stop(): Promise<void>;
  resume(): Promise<void>;
  rerun(stepId: string): Promise<void>;
  /** Open a step's detail, reading its prompt/report once (D5). */
  openStep(stepId: string, attempt?: number): void;
  /** Close the detail layer (its record stays, so a reopen paints at once). */
  closeStep(): void;
}

export function createWorkflowRunController(deps: WorkflowRunDeps): WorkflowRunController {
  let phase: RunState["phase"] = "opening";
  let rows: readonly WorkflowRow[] = [];
  let notice: string | null = null;
  let session: RunSessionHandle | null = null;
  let opened = false;
  let disposed = false;
  let unfeed: (() => void) | null = null;
  let unasks: (() => void) | null = null;
  let openStepId: string | null = null;
  /** One record per step, kept across close/reopen (the read is not repeated). */
  const details = new Map<string, StepDetail>();
  /** The steps whose read is in flight: one request per step, never a storm. */
  const inflight = new Set<string>();

  const changed = () => deps.onChange?.();

  function pending(): CardAsk[] {
    const ask = deps.asks?.current() ?? null;
    return ask === null ? [] : [ask];
  }

  function state(): RunState {
    const run = rows.find((r) => r.runId === deps.runId) ?? null;
    const asks = pending();
    return {
      phase,
      run,
      steps: (run?.steps ?? []).map((step) => ({
        step,
        look: stateLook(step.state),
        ask: askForStep(asks, deps.runId, step.id) ?? null,
        ...(details.has(step.id) ? { detail: details.get(step.id) } : {}),
      })),
      runAsk: askForStep(asks, deps.runId, null) ?? null,
      mode: deps.mode.get(),
      notice,
      canAnswer: deps.asks !== null,
      openStepId,
    };
  }

  async function act(action: WorkflowAction): Promise<void> {
    if (session === null) {
      return;
    }
    const result = await session.workflow(action);
    if (disposed) {
      return;
    }
    notice = result.ok ? null : (result.reason ?? "refused");
    changed();
  }

  /** One step's `prompt`/`report`: at most ONE read in flight, and never repeated once held. */
  function readStep(stepId: string, attempt?: number): void {
    const handle = session;
    // Only a step of the run THIS screen follows: never a request for an id that
    // is not on the feed (a stale tap, or another run's step).
    const onRun = rows.find((r) => r.runId === deps.runId)?.steps.some((s) => s.id === stepId);
    if (onRun !== true) {
      return;
    }
    if (handle === null || handle.workflowStep === undefined) {
      details.set(stepId, { kind: "unsupported" });
      changed();
      return;
    }
    if (inflight.has(stepId) || details.get(stepId)?.kind === "loaded") {
      return;
    }
    inflight.add(stepId);
    details.set(stepId, { kind: "loading" });
    changed();
    const finish = (next: StepDetail): void => {
      inflight.delete(stepId);
      if (disposed) {
        return;
      }
      // The record lands on ITS step, whatever is open NOW: a late read for a step
      // the person has since left must never paint under the open one.
      details.set(stepId, next);
      changed();
    };
    void handle
      .workflowStep(deps.runId, stepId, attempt)
      .then((result) => {
        if ("unsupported" in result) {
          finish({ kind: "unsupported" });
          return;
        }
        finish(
          result.detail === undefined
            ? { kind: "missing" }
            : { kind: "loaded", detail: result.detail },
        );
      })
      .catch((err: unknown) => {
        finish({ kind: "failed", reason: err instanceof Error ? err.message : "read failed" });
      });
  }

  return {
    state,
    openStep(stepId, attempt) {
      openStepId = stepId;
      readStep(stepId, attempt);
    },
    closeStep() {
      openStepId = null;
      changed();
    },
    start() {
      unasks = deps.asks?.subscribe(changed) ?? null;
      void deps.open(deps.sessionId).then((result) => {
        if (disposed) {
          if (result.ok && !deps.borrowed) {
            deps.leave();
          }
          return;
        }
        if (!result.ok) {
          phase = ENDED.includes(result.reason) ? "ended" : "failed";
          notice =
            phase === "ended" ? SESSION_ENDED : `Could not open the session (${result.reason})`;
          changed();
          return;
        }
        opened = true;
        session = result.session;
        phase = "ready";
        unfeed = result.session.onWorkflows((next) => {
          rows = next;
          changed();
        });
        changed();
      });
    },
    dispose() {
      disposed = true;
      unfeed?.();
      unasks?.();
      unfeed = null;
      unasks = null;
      if (opened && !deps.borrowed) {
        deps.leave();
      }
      session = null;
    },
    setMode(mode) {
      deps.mode.set(mode);
      changed();
    },
    answer(stepId, optionId) {
      const ask = askForStep(pending(), deps.runId, stepId);
      const sent =
        ask !== undefined && deps.asks !== null
          ? deps.asks.answerFor(ask.requestId, optionId)
          : "ignored";
      notice = sent === "sent" ? null : RUN_ASK_GONE;
      changed();
    },
    stop: () => act({ action: "stop", runId: deps.runId }),
    resume: () => act({ action: "resume", runId: deps.runId }),
    rerun: (stepId) => {
      // The old attempt's prompt is not the new one's: drop it, so the next open
      // reads afresh instead of painting a stale detail under a re-run step.
      details.delete(stepId);
      return act({ action: "rerun_step", runId: deps.runId, stepId });
    },
  };
}

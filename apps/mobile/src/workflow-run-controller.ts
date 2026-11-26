/**
 * One workflow run on the phone, graph A ⇄ list B (docs/fix/workflows-ux.md D3/D5;
 * was `docs/feat/workflows-ui.md` D4, slice 3). Pure and injected (AGENTS §7): the
 * screen draws `state()` and forwards taps.
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
import {
  type WorkflowAction,
  type WorkflowProjection,
  askForStep,
  runProjection,
} from "@tentacle/client";
import type { AskOrigin } from "@tentacle/client";
import type {
  WorkflowResult,
  WorkflowRow,
  WorkflowStepDetail,
  WorkflowStepResult,
  WorkflowStepRow,
} from "@tentacle/protocol";
import { type AskBannerView, landingAskBanner } from "./ask-park.ts";
import type { SheetState } from "./permission-sheet.ts";
import type { SessionOpenFailure } from "./session-controller.ts";
import { type StateLook, stateLook } from "./workflow-list.ts";

/** Shown (with a way back) when the session ended between the list and the tap. */
export const SESSION_ENDED = "This session has ended";
/** A tap on an ask that was settled meanwhile (answered elsewhere, withdrawn). */
export const RUN_ASK_GONE = "That request is no longer waiting";

export type RunMode = "graph" | "list";

/**
 * WHICH visit of a step a tap named (a list row, a prev/next arrow): `round`
 * tells two runs of one goto apart, `attempt` two tries of one retried step.
 * Absent = the step's latest execution.
 */
export interface StepVisit {
  readonly attempt?: number;
  readonly round?: number;
}

/**
 * A step's DETAIL, as this screen holds it (docs/feat/workflows-ui.md D5): absent
 * = never asked. The four answers a read can give are kept apart on purpose —
 * `missing` (its entry left the retained log) is not the same thing as
 * `unsupported` (an older daemon: "update tentacle"), and a failed read is its
 * own state with the reason, never a skeleton left shimmering forever.
 *
 * `notRun` is the fifth (docs/fix/workflows-ux.md S7, D5) and the only one that
 * is decided WITHOUT a read: the shared projection says the step never ran, so
 * there is no execution to ask about — and asking anyway got `{}` back, which
 * this screen drew as "no longer available", a false story about a step that
 * simply was not reached.
 */
export type StepDetail =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: WorkflowStepDetail }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "notRun" };

/** The ask a card shows: its id, the asker's id (the pairing), and the text VERBATIM. */
export interface CardAsk {
  readonly requestId: string;
  readonly agent?: { readonly id?: string };
  /** Who asked, from the structured fields (`askOrigin`): the pairing's first key. */
  readonly origin?: AskOrigin;
  readonly title: string;
  /** Never truncated: a `run` command is shown as it will run (§7). */
  readonly detail: string;
  /**
   * A remote agent's QUESTION rather than an approval. It takes no grant: the
   * answer is text, so the bar says «Answer» and its tap opens the field
   * (docs/fix/a2a-question-workflow-label.md D4).
   */
  readonly question?: boolean;
}

/** The phone's permission sheet for THIS session, narrowed to what a card needs. */
export interface AskSource {
  current(): CardAsk | null;
  /**
   * `"reply"` opens the ask's text field (it settles nothing); the settle
   * options are the sheet's own. Only ever the ask on screen: keyed on its id.
   */
  answerFor(
    requestId: string,
    optionId: "allow_once" | "reject_once" | "reply",
  ): "sent" | "typing" | "ignored";
  subscribe(listener: () => void): () => void;
  /** Bring the parked ask's sheet back (the slim row's tap). Absent: nothing to bring. */
  unpark?(): void;
  /**
   * The banner of an ask that is not up here (`landingAskBanner`): the Workflows
   * landing's, any ask, with or without the daemon's id. Absent: a source built
   * without `queued` (the run screen draws its own bar).
   */
  banner?(): AskBannerView | null;
}

/**
 * The ask of one step (`stepId`) or of the run itself (`null`), paired by the
 * STRUCTURED origin first (docs/fix/mobile-ask-surfaces.md D6): `origin.runId` is
 * the run and `origin.stepId` the step (absent: the run's own approval). An ask
 * whose origin names a run is decided by that alone — another run's origin never
 * pairs, whatever its agent id says. Only an ask WITHOUT a run id in its origin
 * (an older daemon) falls back to `askForStep`'s `<runId>.<stepId>` id split.
 */
export function askForRunStep(
  asks: readonly CardAsk[],
  runId: string,
  stepId: string | null,
): CardAsk | undefined {
  const structured = asks.find(
    (ask) =>
      ask.origin?.kind === "workflow" && ask.origin.runId === runId && ask.origin.stepId === stepId,
  );
  if (structured !== undefined) {
    return structured;
  }
  return askForStep(
    asks.filter((ask) => !(ask.origin?.kind === "workflow" && ask.origin.runId !== null)),
    runId,
    stepId,
  );
}

/**
 * The session's permission sheet as a card's ask source: the ask on screen when
 * it has the daemon's id (a local ask has none and cannot be keyed), its title and
 * detail VERBATIM, and its asker id for the pairing. Everything else (idle, a
 * returned reply) is no ask. Answers go to the sheet's own `answerFor`.
 */
export function askSourceFromSheet(sheet: {
  view(): SheetState;
  answerFor(
    requestId: string,
    optionId: "allow_once" | "reject_once" | "reply",
  ): "sent" | "typing" | "ignored";
  subscribe(listener: () => void): () => void;
  unpark?(): void;
  /** Asks waiting behind the one on screen; given → the source offers `banner()`. */
  queued?: () => number;
}): AskSource {
  const queued = sheet.queued;
  return {
    current() {
      const view = sheet.view();
      if (view.kind !== "asking" || view.requestId === null) {
        return null;
      }
      return {
        requestId: view.requestId,
        ...(view.agentId === null ? {} : { agent: { id: view.agentId } }),
        origin: view.origin,
        title: view.request.title,
        detail: view.request.detail ?? "",
        ...(view.request.kind === "question" ? { question: true } : {}),
      };
    },
    answerFor: (requestId, optionId) => sheet.answerFor(requestId, optionId),
    subscribe: (listener) => sheet.subscribe(listener),
    ...(sheet.unpark === undefined ? {} : { unpark: () => sheet.unpark?.() }),
    ...(queued === undefined
      ? {}
      : {
          banner: () => {
            const view = sheet.view();
            const origin = view.kind === "asking" ? view.origin : undefined;
            return landingAskBanner(view, queued(), origin ?? { kind: "main" });
          },
        }),
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
  /**
   * The run as the SHARED projection reads it (`@tentacle/client`, D2, slice S6b):
   * phases, traces, chips and the words, so this screen and the TUI cannot
   * disagree about what an edge is. Null until the feed carries the run.
   */
  readonly projection: WorkflowProjection | null;
  readonly steps: readonly StepCard[];
  /** The run's own hash approval, when it is the ask on the sheet. */
  readonly runAsk: CardAsk | null;
  /**
   * The ONE bar the run screen shows (D3): the ask it can answer, the sentence that
   * sends the person to the session, or null. Decided by `askBarFor`, never here.
   */
  readonly askBar: AskBar | null;
  readonly mode: RunMode;
  /** A refusal, an ended session, a stale tap. */
  readonly notice: string | null;
  /** Whether this screen can answer asks at all (a sheet exists for the session). */
  readonly canAnswer: boolean;
  /** The step whose detail is open (the morph layer), or null. */
  readonly openStepId: string | null;
  /**
   * The visit the open step was opened FOR, when a list row or an arrow named one
   * (a step that ran twice): the nav bar's position and its neighbours are per
   * VISIT, so the screen must know which visit it is looking at.
   */
  readonly openVisit?: StepVisit;
}

const ENDED: readonly SessionOpenFailure[] = ["archived", "deleted", "gone"];

/**
 * The ask the run screen shows in its ONE bar (D3, slice S6b): the run's own
 * approval first (answering it is what lets the run go on), then a step's. This
 * is a pure selector rather than a component's `if`, so the precedence is pinned
 * by a test; `stepId: null` means the run itself.
 */
export function pendingAsk(
  state: Pick<RunState, "runAsk" | "steps">,
): { readonly stepId: string | null; readonly ask: CardAsk } | null {
  if (state.runAsk !== null) {
    return { stepId: null, ask: state.runAsk };
  }
  const step = state.steps.find((card) => card.ask !== null);
  return step?.ask === null || step === undefined ? null : { stepId: step.step.id, ask: step.ask };
}

/**
 * What the bottom bar holds on this screen (D3). An ask it can answer is the ask
 * itself; a step the run says waits on the person while no sheet is here (`phase`
 * `ask`, and `canAnswer` false) is the sentence that sends the person to the
 * session — never a button that cannot work. Null = nothing waits, so no bar.
 */
export type AskBar =
  | {
      readonly kind: "ask";
      readonly stepId: string | null;
      readonly ask: CardAsk;
      /** What its button says: a grant decision «Review», a question «Answer». */
      readonly action: "review" | "answer";
    }
  /** An ask that is NOT this run's (Q1): a slim row; its tap opens the session. */
  | { readonly kind: "foreign"; readonly ask: CardAsk }
  | { readonly kind: "open-session"; readonly stepId: string };

export function askBarFor(
  state: Pick<RunState, "runAsk" | "steps" | "projection" | "canAnswer"> & {
    readonly foreign?: CardAsk | null;
  },
): AskBar | null {
  const pending = pendingAsk(state);
  if (pending !== null) {
    return {
      kind: "ask",
      stepId: pending.stepId,
      ask: pending.ask,
      action: pending.ask.question === true ? "answer" : "review",
    };
  }
  if (state.foreign !== undefined && state.foreign !== null) {
    return { kind: "foreign", ask: state.foreign };
  }
  if (state.canAnswer || state.projection === null) {
    return null;
  }
  const waiting = state.projection.steps.find((step) => step.phase === "ask");
  return waiting === undefined ? null : { kind: "open-session", stepId: waiting.id };
}

/**
 * Whether a held detail still answers an open of `row` (asked for `attempt`, or the
 * row's current one): `final` = an ENDED read of that very execution (never re-read);
 * `live` = that execution, but read while it ran (its text is a snapshot: re-read);
 * `no` = another attempt or goto round (a rerun started anywhere: re-read).
 */
function heldFits(
  held: WorkflowStepDetail,
  row: WorkflowStepRow,
  attempt: number | undefined,
): "final" | "live" | "no" {
  const same =
    attempt === undefined
      ? held.attempt === row.attempt && held.round === row.round
      : held.attempt === attempt;
  if (!same) {
    return "no";
  }
  return held.live ? "live" : "final";
}

export interface WorkflowRunController {
  state(): RunState;
  start(): void;
  dispose(): void;
  setMode(mode: RunMode): void;
  /** Answer the ask of `stepId` (null: the run's own approval). */
  answer(stepId: string | null, optionId: "allow_once" | "reject_once"): void;
  /** Bring the parked ask's sheet back over this run (the slim row's tap). */
  reviewAsk(): void;
  /**
   * Open the text field of the run's own QUESTION ask (the bar's «Answer»): the
   * answer is typed and sent by the sheet, never by a second resolve path.
   */
  openAnswer(): void;
  stop(): Promise<void>;
  resume(): Promise<void>;
  rerun(stepId: string): Promise<void>;
  /**
   * Open a step's detail, reading its prompt/report once (D5). `visit` names the
   * row tapped; its `attempt` is read only when it is of the step's CURRENT round
   * (the read selects by attempt alone — an earlier round reads the latest).
   */
  openStep(stepId: string, visit?: StepVisit): void;
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
  let openVisit: StepVisit | undefined;
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
    const projection = run === null ? null : runProjection(run);
    const cards: StepCard[] = (run?.steps ?? []).map((step) => ({
      step,
      look: stateLook(step.state),
      ask: askForRunStep(asks, deps.runId, step.id) ?? null,
      ...(details.has(step.id) ? { detail: details.get(step.id) } : {}),
    }));
    const runAsk = askForRunStep(asks, deps.runId, null) ?? null;
    const foreign =
      asks.find((ask) => ask !== runAsk && !cards.some((card) => card.ask === ask)) ?? null;
    return {
      phase,
      run,
      projection,
      steps: cards,
      runAsk,
      askBar: askBarFor({
        runAsk,
        steps: cards,
        projection,
        canAnswer: deps.asks !== null,
        foreign,
      }),
      mode: deps.mode.get(),
      notice,
      canAnswer: deps.asks !== null,
      openStepId,
      ...(openVisit === undefined ? {} : { openVisit }),
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

  /**
   * Whether the run's OWN projection says this step never ran (S7): the one fact
   * that makes a read wrong rather than merely redundant — there is no execution
   * to ask about, and a `workflowStep` for one answered `{}`, painted as "no longer
   * available". `skipped` is D2's phase for exactly that (a live run's `pending`
   * step is `later`, which a read may legitimately answer).
   */
  function neverRan(stepId: string): boolean {
    const run = rows.find((r) => r.runId === deps.runId);
    if (run === null || run === undefined) {
      return false;
    }
    return runProjection(run).steps.some((s) => s.id === stepId && s.phase === "skipped");
  }

  /**
   * The attempt a visit's read may name: only one of the step's CURRENT round —
   * the read selects by attempt alone, so an attempt of an earlier goto round
   * would match the wrong execution. Anything else reads the latest.
   */
  function attemptOf(stepId: string, visit: StepVisit | undefined): number | undefined {
    if (visit?.attempt === undefined) {
      return undefined;
    }
    const row = rows.find((r) => r.runId === deps.runId)?.steps.find((s) => s.id === stepId);
    return row !== undefined && (visit.round === undefined || visit.round === row.round)
      ? visit.attempt
      : undefined;
  }

  /**
   * One step's `prompt`/`report`: at most ONE read in flight, and never repeated once
   * an ended read of the same attempt/round is held (`heldFits`).
   */
  function readStep(stepId: string, attempt?: number): void {
    const handle = session;
    // Only a step of the run THIS screen follows: never a request for an id that
    // is not on the feed (a stale tap, or another run's step).
    const row = rows.find((r) => r.runId === deps.runId)?.steps.find((s) => s.id === stepId);
    if (row === undefined) {
      return;
    }
    // A step that never ran has no detail to read: the record is `notRun` and no
    // request is sent (S7). Decided by the projection, never by the state word.
    if (neverRan(stepId)) {
      details.set(stepId, { kind: "notRun" });
      changed();
      return;
    }
    if (handle === null || handle.workflowStep === undefined) {
      details.set(stepId, { kind: "unsupported" });
      changed();
      return;
    }
    if (inflight.has(stepId)) {
      return;
    }
    const held = details.get(stepId);
    const fit = held?.kind === "loaded" ? heldFits(held.detail, row, attempt) : "no";
    if (fit === "final") {
      return;
    }
    inflight.add(stepId);
    // A live record of the SAME execution stays painted while the fresh read flies;
    // anything else (never read, another attempt/round) shows the skeleton.
    if (fit !== "live") {
      details.set(stepId, { kind: "loading" });
    }
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
    openStep(stepId, visit) {
      openStepId = stepId;
      openVisit = visit;
      readStep(stepId, attemptOf(stepId, visit));
    },
    closeStep() {
      openStepId = null;
      openVisit = undefined;
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
          // A `notRun` record is a fact about the RUN, not about an execution: when
          // the run moves that step (a resume, a re-run), it is stale — dropped, so
          // the next open decides again from the projection.
          for (const [id, held] of details) {
            if (held.kind === "notRun" && !neverRan(id)) {
              details.delete(id);
            }
          }
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
      const ask = askForRunStep(pending(), deps.runId, stepId);
      const sent =
        ask !== undefined && deps.asks !== null
          ? deps.asks.answerFor(ask.requestId, optionId)
          : "ignored";
      notice = sent === "sent" ? null : RUN_ASK_GONE;
      changed();
    },
    reviewAsk() {
      deps.asks?.unpark?.();
    },
    openAnswer() {
      const bar = state().askBar;
      const ask = bar !== null && bar.kind === "ask" ? bar.ask : undefined;
      const opened =
        ask !== undefined && deps.asks !== null
          ? deps.asks.answerFor(ask.requestId, "reply")
          : "ignored";
      notice = opened === "ignored" ? RUN_ASK_GONE : null;
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

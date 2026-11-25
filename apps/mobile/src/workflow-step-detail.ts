/**
 * The step DETAIL's view-model (docs/feat/workflows-ui.md D5, slice 4): what the
 * morph layer and its skeleton draw, as numbers and words. Pure and React-free
 * (AGENTS §7) — `screens/WorkflowStep.tsx` is the dumb renderer that feeds these
 * to `Animated`, and every property below is asserted without a simulator.
 *
 * Three things live here, all of them the kind of decision that must not sit in a
 * component:
 * - **the flight's box.** A graph node is drawn inside the run graph's own logical
 *   space (402 pt wide, `workflow-run-layout.ts`), while the detail lives in screen
 *   points. The morph needs ONE space, so `nodeBoxOnScreen` maps the node's box
 *   through the canvas's scale/offset — the pill starts exactly where it was
 *   tapped, whatever the screen width.
 * - **the hero's metrics.** The detail's header is where the pill LANDS.
 * - **the body.** The kv rows and the log block come from `detailBlocks` (the ONE
 *   place they are decided), so the skeleton and the loaded view cannot list
 *   different rows; this module only says what each state READS.
 */
import type { WorkflowPhase, WorkflowProjection, WorkflowWhy } from "@tentacle/client";
import { notRunWhy, timeline } from "@tentacle/client";
import type { WorkflowStepDetail, WorkflowStepRow } from "@tentacle/protocol";
import { oneLine } from "./activity.ts";
import { size } from "./theme.ts";
import { type Box, HERO_METRICS, NODE_METRICS } from "./workflow-morph.ts";
import type { StepDetail, StepVisit } from "./workflow-run-controller.ts";
import type { RunGeometry } from "./workflow-run-layout.ts";
import { RUN_WIDTH, runLayout } from "./workflow-run-layout.ts";
import { DETAIL, type DetailBlocks, detailBlocks, logLines } from "./workflow-skeleton.ts";

/** What the body says for each state of the read (the plan's four answers, plus loading). */
export const DETAIL_TEXT = {
  loading: "Reading this step…",
  missing: "This step's detail is no longer available",
  unsupported: "Update tentacle on this computer to read a step",
  /** Not an answer to a read: nothing was asked, because nothing ran (S7). */
  notRun: "Not run — the run went another way.",
} as const;

/**
 * The run graph's canvas as the screen draws it: the logical 402 pt width scaled
 * to whatever the phone gives, with the canvas's own left inset. `runLayout` works
 * in the logical space, so one scale maps a node's pill onto the screen.
 */
export interface CanvasMap {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** The canvas for a drawn graph: centred if the phone is wider than the run's own 402 pt, never upscaled past 1. */
export function canvasMap(screenWidth: number, graphWidth: number = RUN_WIDTH): CanvasMap {
  const usable = Math.max(0, screenWidth);
  // The graph is never magnified (a narrower phone's pill text would blur); a phone
  // narrower than the drawing scales it down so every node stays reachable.
  const scale = graphWidth <= 0 ? 1 : Math.min(1, usable / graphWidth);
  return { scale, offsetX: Math.max(0, (usable - graphWidth * scale) / 2), offsetY: 0 };
}

/**
 * A node's pill, in SCREEN points: the morph's start. It returns null for an id
 * the run's own layout does not hold (a stale tap, a run that changed under it)
 * rather than a made-up box that would fly in from nowhere.
 */
export function nodeBoxOnScreen(
  projection: WorkflowProjection,
  stepId: string,
  canvas: CanvasMap,
  geometry: RunGeometry = runLayout(projection),
): Box | null {
  const node = geometry.nodes.find((n) => n.id === stepId);
  if (node === undefined) {
    return null;
  }
  return {
    x: canvas.offsetX + node.x * canvas.scale,
    y: canvas.offsetY + node.y * canvas.scale,
    width: node.width * canvas.scale,
    height: node.height * canvas.scale,
  };
}

/**
 * The detail's NAV BAR (docs/fix/workflows-ux.md S3, defect 3): `‹ <run name>` on
 * the left, `step N of M` on the right, UNDER the safe-area top. It exists because
 * the hero used to start at the sheet's own 16 pt inset — above the clock, beside
 * the back chevron (screenshots 162fac2b / d1b5faaa). The bar claims the status
 * bar's height first, so nothing else in this layer can draw there.
 */
export const STEP_NAV = {
  /** The bar's height UNDER the safe-area top (the chat header's own 50 pt). */
  height: size.headerChat,
  /** Between the bar and the hero: the sheet's side inset, so the pill never touches it. */
  gap: DETAIL.inset,
} as const;

/** A safe-area inset that cannot be drawn with (a NaN from a rotating iPad) is 0, never NaN. */
function safeInset(insetTop: number): number {
  return Number.isFinite(insetTop) ? Math.max(0, insetTop) : 0;
}

/** The nav bar's box, in screen points: pinned to the layer's top, tall enough to clear the status bar. */
export function navBox(insetTop: number, width: number): Box {
  return { x: 0, y: 0, width: Math.max(0, width), height: safeInset(insetTop) + STEP_NAV.height };
}

/** The hero's TOP: always below the status bar AND below the nav bar (the bug's own property). */
export function heroTop(insetTop: number): number {
  return safeInset(insetTop) + STEP_NAV.height + STEP_NAV.gap;
}

/** The hero: where the pill lands — the detail's own header box, in screen points. */
export function heroBox(top: number, inset: number, width: number): Box {
  return {
    x: inset,
    y: top,
    width: Math.max(0, width - inset * 2),
    height: HERO_METRICS.height,
  };
}

/**
 * What the nav bar SAYS: the run's name on the back button, and where this step
 * sits in B's VISIT order (docs/fix/workflows-ux.md S7, owner 6b): the timeline's
 * visits as they happened (a step that ran twice appears twice), then the `Next`
 * ones, then the `Not run` ones. File order was the old rule (`step 4 of 6`) and
 * it lies about a run with a goto: it jumps review → fix and cannot say WHICH
 * review, so the position and the neighbours both come from the timeline now.
 * A step the run does not hold (a stale tap) gets no position rather than a
 * made-up one.
 */
export interface NavStep {
  readonly step: string;
  readonly phase: WorkflowPhase;
  /** The word the marker is drawn with (D2's, so the bar and the rail agree). */
  readonly word: string;
  readonly meta: string;
  /** Which visit of the step this is, on a visit row (a step that ran twice). */
  readonly attempt?: number;
  /** The goto round, when that is what tells two visits of the same step apart. */
  readonly round?: number;
}

/**
 * Which VISIT of a step this is: `round` tells two reviews of one goto apart, and
 * `attempt` two tries of one retried step. Both are absent on a row that never
 * ran — there is only ever one of those. The controller's own type (one shape).
 */
export type NavVisit = StepVisit;

/** One side of the prev/next bar: a neighbour, or the honest end of the run. */
export type NavSide =
  | {
      readonly kind: "step";
      readonly step: string;
      readonly phase: WorkflowPhase;
      readonly word: string;
      readonly meta: string;
      /** So the bar can open the NEIGHBOUR's own visit, not just its step. */
      readonly visit: NavVisit;
    }
  /** `Start of run` / `End of run`: said, never an empty tap target. */
  | { readonly kind: "end"; readonly label: string };

export interface StepNav {
  /** The back button's label: the run's own name, flattened. */
  readonly back: string;
  /** `4 of 8` in B's order, or null for a step this run does not hold. */
  readonly position: string | null;
  readonly prev: NavSide;
  readonly next: NavSide;
}

/**
 * B's visit order as one flat list: the visits, then `Next`, then `Not run` —
 * exactly the order the list view draws, so the detail's position and its arrows
 * can never disagree with the rows they came from.
 */
export function visitOrder(projection: WorkflowProjection): readonly NavStep[] {
  const line = timeline(projection);
  return [...line.rows, ...line.next, ...line.notRun].map((row) => {
    return {
      step: row.step,
      phase: row.phase,
      word: visitWord(projection, row),
      meta: row.meta,
      ...(row.attempt === undefined ? {} : { attempt: row.attempt }),
      ...(row.round === undefined ? {} : { round: row.round }),
    };
  });
}

/**
 * The word a B row is SAID with: the step's own D2 word (`approved`, `passed`, an
 * unknown wire word) only when this visit is in the step's current phase; an
 * earlier visit (a review that failed before it passed) gets `""`, which
 * `markerFor` fills with its own phase's word — never the latest visit's word
 * on an older one.
 */
export function visitWord(
  projection: WorkflowProjection,
  row: { readonly step: string; readonly phase: WorkflowPhase },
): string {
  const view = projection.steps.find((s) => s.id === row.step);
  return view !== undefined && view.phase === row.phase ? view.word : "";
}

/**
 * The step detail's nav: where this visit sits in B's order, and its two
 * neighbours (the mockup's «Passo precedente / successivo», owner 6b option c).
 * `visit` picks WHICH visit of a step that ran twice; absent, the LAST one — the
 * row a person just tapped in a list whose earlier visits are above it.
 */
export function stepNav(
  projection: WorkflowProjection,
  stepId: string,
  runName: string,
  visit?: NavVisit,
): StepNav {
  const order = visitOrder(projection);
  const back = oneLine(runName) || "Run";
  const candidates = order.flatMap((row, index) => (row.step === stepId ? [{ row, index }] : []));
  // A named visit matches on EVERY fact it names: `round` alone separates two
  // reviews of one goto, `attempt` alone two tries of one retried step.
  const named = (row: NavStep): boolean =>
    visit !== undefined &&
    (visit.round === undefined || row.round === visit.round) &&
    (visit.attempt === undefined || row.attempt === visit.attempt);
  const here =
    visit === undefined
      ? candidates.at(-1)
      : (candidates.findLast((c) => named(c.row)) ?? candidates.at(-1));
  if (here === undefined) {
    return { back, position: null, prev: endSide("prev"), next: endSide("next") };
  }
  const side = (index: number, which: "prev" | "next"): NavSide => {
    const row = order[index];
    if (row === undefined) {
      return endSide(which);
    }
    return {
      kind: "step",
      step: row.step,
      phase: row.phase,
      word: row.word,
      meta: row.meta,
      visit: {
        ...(row.attempt === undefined ? {} : { attempt: row.attempt }),
        ...(row.round === undefined ? {} : { round: row.round }),
      },
    };
  };
  return {
    back,
    position: `${here.index + 1} of ${order.length}`,
    prev: side(here.index - 1, "prev"),
    next: side(here.index + 1, "next"),
  };
}

/** The two ends' own words, so the bar never shows an empty side. */
function endSide(which: "prev" | "next"): NavSide {
  return { kind: "end", label: which === "prev" ? "Start of run" : "End of run" };
}

/**
 * The body's blocks for ONE step (docs/fix/workflows-ux.md S7, D5): the shared
 * `detailBlocks` list, plus the two pieces only this screen has — the `say` block
 * that explains a step which never ran, and an approve step's question and answer.
 *
 * Why an approve step is different (owner, D5): its `prompt` IS the question the
 * person was asked, so the drawn body is «Asked» + «Answer» — Outcome
 * Allowed/Denied from the step's state (with the daemon's reason when denied) and
 * Waited from `durationMs`. No who, no when: neither is in the wire, and neither
 * is required.
 */
export interface StepBody extends DetailBlocks {
  /** `Not run — …` in the owner's words, on a step the run never reached. */
  readonly say: WorkflowWhy | null;
  /** The question an approve step asked, VERBATIM (`prompt`), else null. */
  readonly asked: string | null;
  /** The answer's own rows: Outcome, then the reason when denied, then Waited. */
  readonly answer: readonly (readonly [string, string])[];
}

/**
 * Everything a step's detail body draws, decided in ONE pure place. `detail` is
 * the read as this screen holds it: `notRun` is a state of knowledge, not an
 * answer, so it carries the projection's own sentence instead of a log block.
 */
export function stepBody(
  projection: WorkflowProjection,
  step: WorkflowStepRow,
  detail: StepDetail | undefined,
  kindWord: (kind: string) => string,
  stateWord: (state: string) => string,
  actionCount: number,
): StepBody {
  const base = stepBlocks(step, detail, kindWord, stateWord, actionCount);
  const notRun = detail !== undefined && detail.kind === "notRun";
  const loaded = detail !== undefined && detail.kind === "loaded" ? detail.detail : undefined;
  return {
    kv: base.kv,
    log: base.log,
    actions: base.actions,
    // The projection's own sentence; its plain fallback if it has none (never a
    // blank body on a step the person was told did not run).
    say: notRun ? (notRunWhy(projection, step.id) ?? { text: DETAIL_TEXT.notRun }) : null,
    asked: step.kind === "approve" ? approveQuestion(loaded) : null,
    answer: step.kind === "approve" ? approveAnswer(step, loaded) : [],
  };
}

/**
 * The question an approve step put to the person: the read's `prompt`, VERBATIM
 * (the daemon stores the ask's title there). While the read is in flight there is
 * no question yet — the body says it is reading, rather than inventing one.
 */
function approveQuestion(detail: WorkflowStepDetail | undefined): string | null {
  const prompt = detail?.prompt ?? "";
  return prompt === "" ? null : prompt;
}

/**
 * What the person answered. `ok` = allowed, `error` = denied — the driver's own
 * two outcomes (`approveStep`: `pass`/`approved`, `fail`/`denied: …`), never a
 * third reading of the state word. `Waited` is `durationMs`, the time the run sat
 * on the ask; while the ask is still open there is no answer and no wait yet.
 */
function approveAnswer(
  step: WorkflowStepRow,
  detail: WorkflowStepDetail | undefined,
): readonly (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [];
  if (step.state === "ok") {
    rows.push(["Outcome", "Allowed"]);
  } else if (step.state === "error") {
    rows.push(["Outcome", "Denied"]);
    const why = oneLine(step.reason ?? detail?.reason ?? "");
    if (why !== "") {
      rows.push(["Reason", why]);
    }
  }
  const ms = step.durationMs ?? detail?.durationMs;
  if (ms !== undefined) {
    rows.push(["Waited", `${Math.round(ms / 100) / 10}s`]);
  }
  return rows;
}

/** A step's own header text: its glyph + hand, exactly as the graph's pill draws it. */ export interface HeroText {
  readonly id: string;
  readonly subtitle: string;
}

/** `id` + `state word · where`: the pill's two lines, never a wire token alone. */
export function heroText(step: WorkflowStepRow, stateWord: string): HeroText {
  const subtitle = [stateWord, oneLine(step.where === "" ? "local" : step.where)]
    .filter((p) => p !== "")
    .join(" · ");
  return { id: oneLine(step.id), subtitle };
}

/**
 * The body's blocks, from the step row + the read's state. The KV LIST ALWAYS
 * COMES FROM THE ROW — so it is final before the read lands, and no box above the
 * log block can move when it does (the property the plan pins). The log block is
 * the detail's `prompt` then its `report` (the mockup's rows: the prompt is what
 * the step was ASKED, the report is what it answered).
 */
export function stepBlocks(
  step: WorkflowStepRow,
  detail: StepDetail | undefined,
  kindWord: (kind: string) => string,
  stateWord: (state: string) => string,
  actionCount: number,
): DetailBlocks {
  const base = detailBlocks(
    {
      id: step.id,
      kind: step.kind,
      state: step.state,
      where: step.where,
      attempt: step.attempt,
      round: step.round,
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.maxRound === undefined ? {} : { maxRound: step.maxRound }),
      ...(step.reason === undefined ? {} : { reason: step.reason }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    },
    kindWord,
    stateWord,
    actionCount,
  );
  return { ...base, log: detailLog(detail) };
}

/**
 * The log block's lines for a read's state: the prompt, then the report (or the
 * live text while it runs), each flattened for a row but kept as lines in the
 * block. A read that gave nothing says SO in words — one line in the same box —
 * so the block never silently collapses and the layout still holds.
 */
export function detailLog(detail: StepDetail | undefined): readonly string[] {
  if (detail === undefined) {
    return [];
  }
  if (detail.kind === "notRun") {
    // Nothing was asked of the daemon, so there is no log: the `say` block carries
    // the reason, and a second copy here would be the same sentence twice.
    return [];
  }
  if (detail.kind === "loading") {
    return logLines(DETAIL_TEXT.loading);
  }
  if (detail.kind === "missing") {
    return logLines(DETAIL_TEXT.missing);
  }
  if (detail.kind === "unsupported") {
    return logLines(DETAIL_TEXT.unsupported);
  }
  if (detail.kind === "failed") {
    return logLines(oneLine(detail.reason) || "The detail could not be read");
  }
  return loadedLog(detail.detail);
}

/** A loaded detail's block: `prompt:` (what it was asked), then the report (what it said). */
function loadedLog(detail: WorkflowStepDetail): readonly string[] {
  const lines: string[] = [];
  if (detail.prompt !== undefined && detail.prompt !== "") {
    lines.push("prompt:", ...logLines(detail.prompt));
  }
  if (detail.report !== undefined && detail.report !== "") {
    lines.push(detail.live ? "running now:" : "report:", ...logLines(detail.report));
  }
  return lines.length === 0 ? logLines(DETAIL_TEXT.missing) : lines;
}

/**
 * Whether the body is still waiting on data: the skeleton shows in the log block
 * only (the kv rows are already final), and never after a failed/empty answer.
 */
export function bodyPending(detail: StepDetail | undefined): boolean {
  return detail === undefined || detail.kind === "loading";
}
/** The pill's start/end for the flight, or null when the node is not on this run's graph. */
export function flight(
  projection: WorkflowProjection,
  stepId: string,
  canvas: CanvasMap,
  top: number,
  inset: number,
  width: number,
  geometry: RunGeometry = runLayout(projection),
): { readonly from: Box; readonly to: Box } | null {
  const from = nodeBoxOnScreen(projection, stepId, canvas, geometry);
  return from === null ? null : { from, to: heroBox(top, inset, width) };
}

export { NODE_METRICS, HERO_METRICS };

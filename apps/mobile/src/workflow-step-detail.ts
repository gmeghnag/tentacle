/**
 * The step DETAIL's view-model (docs/feat/workflows-ui.md D5, slice 4): what the
 * morph layer and its skeleton draw, as numbers and words. Pure and React-free
 * (AGENTS §7) — `screens/WorkflowStep.tsx` is the dumb renderer that feeds these
 * to `Animated`, and every property below is asserted without a simulator.
 *
 * Three things live here, all of them the kind of decision that must not sit in a
 * component:
 * - **the flight's box.** A graph node is drawn inside the graph's own logical
 *   space (318 pt wide, `workflow-graph.ts`), while the detail lives in screen
 *   points. The morph needs ONE space, so `nodeBoxOnScreen` maps the node's box
 *   through the canvas's scale/offset — the pill starts exactly where it was
 *   tapped, whatever the screen width.
 * - **the hero's metrics.** The detail's header is where the pill LANDS.
 * - **the body.** The kv rows and the log block come from `detailBlocks` (the ONE
 *   place they are decided), so the skeleton and the loaded view cannot list
 *   different rows; this module only says what each state READS.
 */
import type { WorkflowStepDetail, WorkflowStepRow } from "@tentacle/protocol";
import { oneLine } from "./activity.ts";
import { GRAPH_WIDTH, graphGeometry } from "./workflow-graph.ts";
import { type Box, HERO_METRICS, NODE_METRICS } from "./workflow-morph.ts";
import type { StepDetail } from "./workflow-run-controller.ts";
import { type DetailBlocks, detailBlocks, logLines } from "./workflow-skeleton.ts";

/** What the body says for each state of the read (the plan's four answers, plus loading). */
export const DETAIL_TEXT = {
  loading: "Reading this step…",
  missing: "This step's detail is no longer available",
  unsupported: "Update tentacle on this computer to read a step",
} as const;

/**
 * The graph's canvas as the screen draws it: the logical 318 pt width scaled to
 * whatever the phone gives, with the canvas's own left inset. `graphGeometry`
 * works in the logical space, so one scale maps a node's pill onto the screen.
 */
export interface CanvasMap {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** The canvas for a drawn graph: centred if the phone is wider than 318 pt, never upscaled past 1. */
export function canvasMap(screenWidth: number, graphWidth: number = GRAPH_WIDTH): CanvasMap {
  const usable = Math.max(0, screenWidth);
  // The graph is never magnified (a 390 pt phone would blur the pills' text); a
  // narrower phone scales it down so every node stays reachable.
  const scale = graphWidth <= 0 ? 1 : Math.min(1, usable / graphWidth);
  return { scale, offsetX: Math.max(0, (usable - graphWidth * scale) / 2), offsetY: 0 };
}

/**
 * A node's pill, in SCREEN points: the morph's start. It returns null for an id
 * the geometry does not hold (a stale tap, a run that changed under it) rather
 * than a made-up box that would fly in from nowhere.
 */
export function nodeBoxOnScreen(
  steps: readonly WorkflowStepRow[],
  stepId: string,
  canvas: CanvasMap,
): Box | null {
  const node = graphGeometry(steps).nodes.find((n) => n.id === stepId);
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

/** The hero: where the pill lands — the detail's own header box, in screen points. */
export function heroBox(inset: number, width: number): Box {
  return {
    x: inset,
    y: inset,
    width: Math.max(0, width - inset * 2),
    height: HERO_METRICS.height,
  };
}

/** A step's own header text: its glyph + hand, exactly as the graph's pill draws it. */
export interface HeroText {
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

/** The pill's start/end for the flight, or null when the node is not on this graph. */
export function flight(
  steps: readonly WorkflowStepRow[],
  stepId: string,
  canvas: CanvasMap,
  inset: number,
  width: number,
): { readonly from: Box; readonly to: Box } | null {
  const from = nodeBoxOnScreen(steps, stepId, canvas);
  return from === null ? null : { from, to: heroBox(inset, width) };
}

export { NODE_METRICS, HERO_METRICS };

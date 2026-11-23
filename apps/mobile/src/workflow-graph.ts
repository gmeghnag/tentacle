/**
 * The run's **2C vertical graph** as GEOMETRY (docs/feat/agent-workflows.md slice
 * 7; spec `docs/feat/agent-workflows/diagram.html` section "2C · Grafo moderno,
 * verticale"). Pure and React-free (AGENTS §7): `screens/WorkflowRun.tsx` maps it
 * onto `react-native-svg` (the pill bodies are absolutely positioned Views over
 * the path layer, exactly as the mockup does), so the shape is testable with no
 * renderer and no simulator.
 *
 * Two rules earn their keep here:
 * - **the loop is read, never guessed from ids.** A goto edge's round reaches the
 *   phone on the wire (`WorkflowStepRow.round`/`maxRound`, set by the driver when
 *   a step was entered through `on_fail`), so the `review ⇄ fix` pair is placed
 *   from DATA. The mockup hard-codes the ids `review`/`fix`; a real workflow may
 *   name them anything, so id-matching would draw the loop in the wrong place on
 *   the first workflow that is not the mockup's.
 * - **every node owns one row.** The mockup compresses a loop pair into 1.5 rows;
 *   rows here are a uniform pitch, so `y` is strictly increasing by construction —
 *   two pills can never overlap, whatever names, widths or counts arrive. The
 *   loop still READS as a loop: its two nodes are narrower and pushed to opposite
 *   sides, and the back edge is drawn dashed with its `↻ n/max` label.
 *
 * The logical space is the mockup's own (`GRAPH_WIDTH` = 318, the phone's content
 * width there): the renderer scales the `viewBox`, so a small or large phone gets
 * the same drawing, not a different one.
 */
import type { WorkflowStepRow } from "@tentacle/protocol";
import { oneLine } from "./activity.ts";
import { BRANCH_TURN } from "./step-rail.ts";
import { size } from "./theme.ts";
import { type WorkflowTone, stateLook } from "./workflow-list.ts";

/** The mockup's logical width: the drawing is authored once here and scaled by the renderer. */
export const GRAPH_WIDTH = 318;

/** A pill is one touch target tall and fully rounded — the mockup's 44 px / 22 px radius. */
export const PILL_H = size.touch;
export const PILL_RADIUS = PILL_H / 2;

/** The state badge inside a pill: 26 pt, centred on the pill's own middle. */
export const BADGE = 26;
export const BADGE_INSET = (PILL_H - BADGE) / 2;

/** Vertical pitch: the pill plus `NODE_GAP`, the mockup's 70 px. */
export const NODE_GAP = 26;
export const PITCH = PILL_H + NODE_GAP;

/** Top inset of the first pill, so its halo has room above it. */
export const TOP_PAD = 14;

/** Bottom room: the last pill's drop shadow and the loop's label. */
export const BOTTOM_PAD = 34;

/**
 * The three column shapes. A step in the straight flow is the wide main pill; a
 * loop's SOURCE is the narrow left one and its TARGET the narrow right one, so the
 * dashed back edge has somewhere to go (the mockup's x 64/6/172, w 190/150/140).
 */
export const MAIN = { x: 64, w: 190 } as const;
export const LOOP_SOURCE = { x: 6, w: 150 } as const;
export const LOOP_TARGET = { x: 172, w: 140 } as const;

/** How far a loop's back edge bows out sideways, past the pills' own centres. */
export const LOOP_BOW = 26;

export interface GraphNode {
  readonly id: string;
  readonly index: number;
  /** The pill's top-left box in the logical space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly state: string;
  readonly tone: WorkflowTone | null;
  /** Whether this node is a goto TARGET (its state came through `on_fail`). */
  readonly loopTarget: boolean;
  /** Whether this node is the SOURCE of a goto (the next node loops back from it). */
  readonly loopSource: boolean;
  /** `↻ 1 of 3`, on the target only; absent otherwise. */
  readonly loopLabel?: string;
}

/**
 * One drawn edge. `d` is an SVG path in the logical space, ready for a `<Path>`;
 * `kind` picks the stroke (a future edge is dashed, a live one is accented).
 */
export interface GraphEdge {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly d: string;
  readonly kind: "flow" | "future" | "back";
}

export interface GraphGeometry {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** The mockup's smooth vertical connector: down out of `(x1,y1)` and into `(x2,y2)`. */
export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** The dashed way back up: out of the target's left, around and into the source's bottom. */
function backCurve(target: GraphNode, source: GraphNode): string {
  const fromX = target.x + LOOP_BOW;
  const fromY = target.y + PILL_RADIUS;
  const toX = source.x + source.width - LOOP_BOW;
  const toY = source.y + PILL_H;
  const mid = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX - LOOP_BOW * 2} ${mid}, ${toX + LOOP_BOW * 2} ${mid}, ${toX} ${toY}`;
}

/**
 * Where a step sits on the wire: a goto target carries `maxRound` (the edge's
 * `max`), which is the only reliable "this state came from an `on_fail`" fact.
 * Exported because the cards view (2A) draws the same pair.
 */
export function isLoopTarget(step: WorkflowStepRow): boolean {
  return step.maxRound !== undefined;
}

/**
 * The whole drawing for a run's steps. `steps` order is the file's order, which is
 * also the graph's order (a goto does not reorder the file — it re-visits a step).
 */
export function graphGeometry(steps: readonly WorkflowStepRow[]): GraphGeometry {
  // Which indices are goto targets, and which are their sources. A target's source
  // is the step before it in the file (that is the edge the goto leaves from).
  const targets = new Set<number>();
  steps.forEach((step, i) => {
    if (isLoopTarget(step) && i > 0) {
      targets.add(i);
    }
  });
  const sources = new Set<number>();
  for (const t of targets) {
    sources.add(t - 1);
  }

  const nodes: GraphNode[] = steps.map((step, i) => {
    const target = targets.has(i);
    const source = sources.has(i) && !target;
    const column = target ? LOOP_TARGET : source ? LOOP_SOURCE : MAIN;
    return {
      id: step.id,
      index: i,
      x: column.x,
      // One row per node, uniformly: strictly increasing, so nothing overlaps.
      y: TOP_PAD + i * PITCH,
      width: column.w,
      height: PILL_H,
      radius: PILL_RADIUS,
      state: step.state,
      tone: stateLook(step.state).tone,
      loopTarget: target,
      loopSource: source,
      ...(target && step.maxRound !== undefined
        ? { loopLabel: `↻ ${Math.max(1, step.round)} of ${step.maxRound}` }
        : {}),
    };
  });

  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const from = nodes[i - 1];
    const to = nodes[i];
    if (from === undefined || to === undefined) {
      continue;
    }
    const look = stateLook(to.state);
    // A step that has not started yet (or was skipped) is a FUTURE edge: dashed and
    // dimmed, as the mockup draws it. `pending` is the wire's own word for it.
    const future = to.state === "pending" || to.state === "waiting" || to.state === "stopped";
    edges.push({
      key: `e-${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      d: curve(from.x + from.width / 2, from.y + PILL_H, to.x + to.width / 2, to.y),
      kind: look.tone === "running" ? "flow" : future ? "future" : "flow",
    });
    // The goto's way back: from the target up into the step it came from.
    if (to.loopTarget) {
      edges.push({
        key: `loop-${from.id}-${to.id}`,
        from: to.id,
        to: from.id,
        d: backCurve(to, from),
        kind: "back",
      });
    }
  }

  const last = nodes[nodes.length - 1];
  return {
    width: GRAPH_WIDTH,
    // A corner radius, never the pill's own: the branch's turn is what the curated
    // type sizes guarantee room for (`step-rail.ts`), so the loop reuses it.
    height:
      last === undefined
        ? TOP_PAD + BOTTOM_PAD
        : last.y + PILL_H + BOTTOM_PAD + (last.loopTarget ? BRANCH_TURN : 0),
    nodes,
    edges,
  };
}

/** The node a tap landed on, or null: the graph's OWN hit test (a pill's box). */
export function nodeAt(graph: GraphGeometry, x: number, y: number): GraphNode | null {
  for (const node of graph.nodes) {
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
      return node;
    }
  }
  return null;
}

/** A node's one-line subtitle, the mockup's `ok · ds · local`. */
export function nodeSubtitle(step: WorkflowStepRow): string {
  const look = stateLook(step.state);
  return [
    look.word,
    ...(step.model === undefined ? [] : [oneLine(step.model)]),
    oneLine(step.where),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export interface GraphHeader {
  readonly title: string;
  readonly subtitle: string;
}

/** The graph's title block: the run's name over `name vN · hash · 4 of 7`. */
export function graphHeader(
  run: {
    readonly name: string;
    readonly version?: number;
    readonly hash?: string;
    readonly state: string;
  },
  position: string,
): GraphHeader {
  const version =
    run.version === undefined ? oneLine(run.name) : `${oneLine(run.name)} v${run.version}`;
  return {
    title: oneLine(run.name),
    subtitle: [version, ...(run.hash === undefined ? [] : [run.hash.slice(0, 7)]), position].join(
      " · ",
    ),
  };
}

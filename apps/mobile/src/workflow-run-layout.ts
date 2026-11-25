/**
 * The RUN's graph as GEOMETRY (docs/fix/workflows-ux.md D3, slice S6a): where each
 * pill of a run sits and how each of the run's OWN edges is drawn. Pure and
 * React-free (AGENTS §7), so the phone draws what a test proved and S6b's
 * `WorkflowRun.tsx` only maps this onto `react-native-svg` and Views.
 *
 * It replaces the guess in `workflow-graph.ts` (defect 1, d1b5faaa) — that one
 * placed the pills in FILE order and read the loop off `maxRound`, so `fix` (never
 * entered: review passed first try) sat IN the chain between `review` and
 * `confirm`, and there was no back edge at all. Here placement comes from the
 * run's frozen definition snapshot (the wire's `next`/`onFail`/`retry`, D1/P2):
 *
 * - **the spine is the `next` walk from the first step**, cycle-guarded. A step
 *   the pass path does not reach is OFF the spine and goes in the side column, so
 *   a goto's target draws beside its source, never in the linear chain.
 * - **a side pill's row is ≥ its first entering source's row + 1**, and rows
 *   strictly increase within each column in file order. Together with two
 *   x-DISJOINT columns (16…216 and 244…386) that is what makes overlap impossible
 *   by construction, for any 64-step file — not a coincidence of the mockup's six
 *   ids (pinned by a randomised and a 64-step test).
 * - **an edge is a curve between two boxes, never a line through the middle**: a
 *   spine `next` runs straight down the spine's own centre; a goto leaves its
 *   source's right edge and enters the side pill's top; a side `next` curves back
 *   up into its target's right edge; an arc back up the spine gets its own LANE,
 *   bowing in the 28 pt gap between the columns so two arcs never coincide and no
 *   arc ever crosses the side column.
 *
 * The logical space is the mockup's own (`final-v3.html`: spine x16 w200, side
 * x244 w142, pitch 72, pill 44, in a 402 pt-wide phone), so the renderer scales
 * ONE drawing to every phone with the existing `canvasMap`
 * (`workflow-step-detail.ts`), which never magnifies it.
 */
import type { WorkflowPhase, WorkflowProjection, WorkflowTrace } from "@tentacle/client";
import { size } from "./theme.ts";

/** The mockup's logical width: the drawing is authored in a 402 pt phone and scaled. */
export const RUN_WIDTH = 402;

/** The spine: the pass path's column, on the left (mockup `SP`). */
export const RUN_SPINE = { x: 16, w: 200 } as const;
/** The side column: a goto's target, and anything the pass path does not reach (`BR`). */
export const RUN_SIDE = { x: 244, w: 142 } as const;

/** The pill: one touch target tall, fully rounded (the mockup's 44 / 22). */
export const RUN_PILL_H = size.touch;
export const RUN_PILL_RADIUS = RUN_PILL_H / 2;

/** Row pitch: the pill plus the mockup's 28 pt gap. */
export const RUN_PITCH = 72;
/** Above the first pill (the mockup's `TOP`: room for its halo). */
export const RUN_TOP = 18;
/** Below the last pill (the mockup's own `+ 22`). */
export const RUN_BOTTOM = 22;

/**
 * A back arc's bow, per lane, measured from the spine's right edge. The 28 pt gap
 * between the columns (216 → 244) holds five lanes: 6, 11, 16, 21, 26, and a
 * cubic stays inside its control points' hull, so no lane can reach a side pill.
 * Past five arcs the lanes reuse their bows — distinct enough for the sixth arc to
 * read as its own, and the drawing still cannot leave the gap.
 */
const LANE_BOWS = [6, 11, 16, 21, 26] as const;
function laneBow(lane: number): number {
  const at = (Math.max(1, lane) - 1) % LANE_BOWS.length;
  return LANE_BOWS[at] ?? LANE_BOWS[0];
}
/** How far a retry's self-arc bows out of its pill's right edge (the mockup's 26). */
const RETRY_BOW = 26;
/** A goto leaves its source this far below its top, and enters the side pill at 66 % of its width. */
const FAIL_OUT_Y = 14;
const FAIL_IN_X = 0.66;
/** A side `next` leaves the pill this far in from its left edge (the mockup's 22). */
const SIDE_BACK_X = 22;

/** A chip's box, for the "outside the pills" rule: the mockup's caption mono + its padding. */
const CHIP_H = 18;
const CHIP_CHAR = 7;
const CHIP_PAD = 12;
/** How far the search for a free chip spot moves per try, and how many tries. */
const CHIP_STEP = 12;
const CHIP_TRIES = 10;

/** Which column a pill is in. */
export type RunColumn = "spine" | "side";

/** One pill, in the logical space. */
export interface RunNode {
  readonly id: string;
  readonly column: RunColumn;
  /** The row it sits on: strictly increasing within its column, in file order. */
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  /** The wire's own word, and the phase the shared projection gave it (D2). */
  readonly state: string;
  readonly phase: WorkflowPhase;
}

/** One drawn edge: `d` is an SVG path in the logical space, `trace` picks the stroke (D4). */
export interface RunEdge {
  readonly key: string;
  readonly kind: "next" | "fail" | "retry";
  readonly from: string;
  readonly to: string;
  readonly trace: WorkflowTrace;
  readonly d: string;
}

/** A counter chip (`✗ 1/2`, `↻ 0/1`), centred on its arc's midpoint and clear of every pill. */
export interface RunChip {
  readonly key: string;
  readonly kind: "fail" | "retry";
  readonly text: string;
  readonly trace: WorkflowTrace;
  /** The box's centre — the mockup centres the chip with `translate(-50%, -50%)`. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RunGeometry {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly RunNode[];
  readonly edges: readonly RunEdge[];
  readonly chips: readonly RunChip[];
}

/** Straight down the spine's centre: the pass path's own vertical connector. */
function vertical(x: number, y1: number, y2: number): string {
  return `M ${x} ${y1} L ${x} ${y2}`;
}

/**
 * A back arc, out of the source's right edge and into the target's right edge,
 * bowing right by `bow`. Its control points are the only points it can reach
 * (a cubic stays in their hull), which is what keeps a lane out of the side
 * column; `bow` is therefore clamped to the canvas.
 */
function backArc(from: RunNode, to: RunNode, bow: number): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x + to.width;
  const y2 = to.y + to.height / 2;
  const c = Math.min(Math.max(x1, x2) + Math.max(4, bow), RUN_WIDTH - 2);
  return `M ${x1} ${y1} C ${c} ${y1}, ${c} ${y2}, ${x2} ${y2}`;
}

/** A goto: out of the source's right edge, down and into its target's top (the mockup's curve). */
function gotoCurve(from: RunNode, to: RunNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + FAIL_OUT_Y;
  const x2 = to.x + to.width * FAIL_IN_X;
  const y2 = to.y;
  return `M ${x1} ${y1} C ${x2} ${y1}, ${x2} ${y1 + (y2 - y1) / 2}, ${x2} ${y2}`;
}

/** A retry: a self-arc on the pill's right edge, bowing out by as much as the canvas allows. */
function retryArc(node: RunNode): string {
  const x = node.x + node.width;
  const bow = Math.max(6, Math.min(RETRY_BOW, RUN_WIDTH - 2 - x));
  return `M ${x} ${node.y + 12} C ${x + bow} ${node.y + 8}, ${x + bow} ${node.y + 36}, ${x} ${node.y + 32}`;
}

/**
 * A side `next` closing the loop: out of the side pill's top, curving up into its
 * target's right edge (the mockup's `bx` curve) — the way back is drawn from the
 * pill that closes the loop, never from the spine's chain.
 */
function sideBackCurve(from: RunNode, to: RunNode): string {
  const x1 = from.x + SIDE_BACK_X;
  const y1 = from.y;
  const x2 = to.x + to.width;
  const y2 = to.y + to.height * 0.75;
  return `M ${x1} ${y1} C ${x1} ${y2 - 8}, ${x2 + 10} ${y2}, ${x2} ${y2}`;
}

/**
 * The spine: the `next` walk from the run's first step, cycle-guarded (a `next`
 * cycle is legal — the revisit is drawn as an arc, never as a second pill).
 */
export function spineOf(
  ids: readonly string[],
  next: ReadonlyMap<string, string | null>,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  let at: string | null = ids[0] ?? null;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    order.push(at);
    at = next.get(at) ?? null;
  }
  return order;
}

/**
 * Where every pill sits: its row, and which column. The spine is the `next` walk
 * (each step of it owns the next row: 0, 1, 2 …), and every step the walk does
 * not reach is off it and belongs to the side column, whose rows are computed
 * from the steps that ENTER it.
 */
function placement(projection: WorkflowProjection): {
  readonly rows: ReadonlyMap<string, number>;
  readonly spine: ReadonlySet<string>;
} {
  const ids = projection.steps.map((step) => step.id);
  const next = new Map<string, string | null>(projection.steps.map((s) => [s.id, s.next]));
  const walk = spineOf(ids, next);
  const spine = new Set(walk);
  const rows = new Map<string, number>(walk.map((id, row) => [id, row]));

  const off = ids.filter((id) => !spine.has(id));
  if (off.length === 0) {
    return { rows, spine };
  }
  const sourcesOf = new Map<string, string[]>(
    off.map((id) => [
      id,
      projection.steps.filter((s) => s.next === id || s.onFail?.goto === id).map((s) => s.id),
    ]),
  );
  const wanted = (id: string): number | undefined => {
    const sources = (sourcesOf.get(id) ?? [])
      .map((source) => rows.get(source))
      .filter((row): row is number => row !== undefined);
    return sources.length === 0 ? undefined : Math.max(...sources) + 1;
  };
  // Relax, then re-establish strict increase in file order, until nothing moves:
  // rows only ever grow, and both rules are what overlap-freedom rests on.
  for (let pass = 0; pass < off.length + 1; pass += 1) {
    let moved = false;
    for (const id of off) {
      const want = wanted(id);
      const have = rows.get(id);
      if (want !== undefined && (have === undefined || want > have)) {
        rows.set(id, want);
        moved = true;
      }
    }
    let prev: number | undefined;
    for (const id of off) {
      const have = rows.get(id);
      const floor = prev === undefined ? 0 : prev + 1;
      const row = Math.max(have ?? floor, floor);
      if (row !== have) {
        rows.set(id, row);
        moved = true;
      }
      prev = row;
    }
    if (!moved) {
      break;
    }
  }
  return { rows, spine };
}

/** Whether a box contains a point (a chip's push-out uses the block, `nodeAt` the pill). */
function boxHolds(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return (
    !(x + w / 2 <= box.x || x - w / 2 >= box.x + box.width) &&
    !(y + h / 2 <= box.y || y - h / 2 >= box.y + box.height)
  );
}

/**
 * Nudge a chip out of every pill it lands on: right along the arc first (that is
 * where the room is), then down, then the two mixed. Deterministic, so a test can
 * pin the spot; bounded, so a huge run still draws.
 */
function freeSpot(
  base: { readonly x: number; readonly y: number },
  w: number,
  nodes: readonly RunNode[],
): { readonly x: number; readonly y: number } {
  const offsets: (readonly [number, number])[] = [[0, 0]];
  for (let k = 1; k <= CHIP_TRIES; k += 1) {
    offsets.push([CHIP_STEP * k, 0], [0, CHIP_STEP * k], [CHIP_STEP * k, CHIP_STEP * k]);
    offsets.push([CHIP_STEP * k, -CHIP_STEP * k]);
  }
  for (const [dx, dy] of offsets) {
    const x = Math.min(Math.max(base.x + dx, w / 2 + 2), RUN_WIDTH - w / 2 - 2);
    const y = base.y + dy;
    if (!nodes.some((node) => boxHolds(node, x, y, w, CHIP_H))) {
      return { x, y };
    }
  }
  return { x: base.x, y: base.y };
}

/**
 * The whole drawing for a run: the pills, their edges and the counter chips. The
 * phases and traces come from the SHARED projection (D2) — this module owns
 * geometry only, so the two ends cannot disagree about what an edge is.
 */
export function runLayout(projection: WorkflowProjection): RunGeometry {
  const { rows, spine } = placement(projection);
  const nodes: RunNode[] = projection.steps.map((step) => {
    const row = rows.get(step.id) ?? 0;
    const column: RunColumn = spine.has(step.id) ? "spine" : "side";
    const pin = column === "spine" ? RUN_SPINE : RUN_SIDE;
    return {
      id: step.id,
      column,
      row,
      x: pin.x,
      y: RUN_TOP + row * RUN_PITCH,
      width: pin.w,
      height: RUN_PILL_H,
      radius: RUN_PILL_RADIUS,
      state: step.state,
      phase: step.phase,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spineCenter = RUN_SPINE.x + RUN_SPINE.w / 2;

  const edges: RunEdge[] = [];
  const chips: RunChip[] = [];
  /** Back arcs already drawn on the spine, in drawing order: each gets the next lane. */
  let lane = 0;

  for (const edge of projection.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) {
      // A dangling target (a step deleted between the run and its row): no edge, and
      // no made-up box to draw it to. The projection already words it "not run".
      continue;
    }
    const key = `${edge.kind}-${edge.from}-${edge.to}`;
    if (edge.kind === "retry") {
      const node = from;
      edges.push({
        key,
        kind: "retry",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: retryArc(node),
      });
      if (edge.chip !== undefined) {
        const w = edge.chip.length * CHIP_CHAR + CHIP_PAD;
        const spot = freeSpot(
          {
            x: Math.min(node.x + node.width + RETRY_BOW + w / 2 + 4, RUN_WIDTH - w / 2 - 2),
            y: node.y + 22,
          },
          w,
          nodes,
        );
        chips.push({
          key,
          kind: "retry",
          text: edge.chip,
          trace: edge.trace,
          ...spot,
          width: w,
          height: CHIP_H,
        });
      }
      continue;
    }
    if (edge.kind === "fail" && to.row > from.row) {
      // A goto that fires FORWARD: down from its source's right edge into the target.
      edges.push({
        key,
        kind: "fail",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: gotoCurve(from, to),
      });
    } else if (edge.kind === "fail") {
      // A goto that jumps BACK UP (the loop's own way round): its own lane.
      lane += 1;
      edges.push({
        key,
        kind: "fail",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: backArc(from, to, laneBow(lane)),
      });
    }
    if (edge.kind === "fail") {
      if (edge.chip !== undefined) {
        const w = edge.chip.length * CHIP_CHAR + CHIP_PAD;
        const gx = to.x + to.width * FAIL_IN_X;
        const spot = freeSpot(
          {
            x: Math.min(gx + w / 2 + 12, RUN_WIDTH - w / 2 - 2),
            y: Math.min(from.y + 18, to.y - CHIP_H),
          },
          w,
          nodes,
        );
        chips.push({
          key,
          kind: "fail",
          text: edge.chip,
          trace: edge.trace,
          ...spot,
          width: w,
          height: CHIP_H,
        });
      }
      continue;
    }

    // A pass edge. Down the spine is the vertical; anything that closes back UP is an
    // arc on its own lane; a `next` into the side column is drawn like a goto.
    const forward = to.row > from.row;
    if (from.column === "spine" && to.column === "spine" && forward && to.row === from.row + 1) {
      edges.push({
        key,
        kind: "next",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: vertical(spineCenter, from.y + from.height, to.y),
      });
      continue;
    }
    if (from.column === "side" && to.column === "spine" && !forward) {
      edges.push({
        key,
        kind: "next",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: sideBackCurve(from, to),
      });
      continue;
    }
    if (to.column === "side" && from.column === "spine") {
      edges.push({
        key,
        kind: "next",
        from: from.id,
        to: to.id,
        trace: edge.trace,
        d: gotoCurve(from, to),
      });
      continue;
    }
    // Back up the spine: its own lane in the gap between the columns.
    lane += 1;
    edges.push({
      key,
      kind: "next",
      from: from.id,
      to: to.id,
      trace: edge.trace,
      d: backArc(from, to, laneBow(lane)),
    });
  }

  const lastY = nodes.reduce((max, node) => Math.max(max, node.y + node.height), RUN_TOP);
  return {
    width: RUN_WIDTH,
    height: lastY + RUN_BOTTOM,
    nodes,
    edges,
    chips,
  };
}

/** The node a tap landed on, or null: this layout's OWN hit test (a pill's box). */
export function nodeAt(geometry: RunGeometry, x: number, y: number): RunNode | null {
  for (const node of geometry.nodes) {
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
      return node;
    }
  }
  return null;
}

/**
 * A flowchart as an ASCII drawing (docs/feat/model-diagrams.md D8, mockup 5A).
 *
 * Layered layout, in four steps on an ABSTRACT grid — `main` runs along the
 * flow (rows for TD/BT, columns for LR/RL), `cross` across it — mapped to the
 * screen only when drawn, so one router serves the four directions:
 * 1. ranks: longest path from the sources; a cycle's back edge is laid out
 *    reversed and drawn with its arrowhead at the start;
 * 2. order: an edge spanning ranks becomes a chain through dummy slots, then
 *    barycentre sweeps reduce crossings;
 * 3. cross positions: each rank pulled towards its neighbours' centres
 *    (the average of a left- and a right-packed placement, both valid);
 * 4. routing: each edge leaves its box through its own port (`┬`), turns in a
 *    channel row of the gap if it must move across, and lands on `▼`.
 *
 * It never guesses: a graph it cannot draw faithfully (a self-loop, two edges
 * forced through one column, a label with no room, nested or overlapping
 * subgraphs, wider than the terminal) returns `undefined` and the caller shows
 * the source instead.
 *
 * Pure: no I/O, no React, no colour (cells carry style names).
 */
import type { DiagramEdge, DiagramNode, FlowModel } from "@tentacle/core";
import { cellWidth } from "./cells.ts";
import {
  Canvas,
  DOWN,
  type DiagramRow,
  LEFT,
  type LineWeight,
  RIGHT,
  UP,
} from "./diagram-canvas.ts";

/** A box as drawn: its id and screen rectangle (what the tests check overlaps on). */
export interface FlowBox {
  readonly id: string;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
}

export interface FlowDrawing {
  readonly rows: DiagramRow[];
  readonly width: number;
  readonly boxes: readonly FlowBox[];
}

/** Beyond this many nodes a terminal drawing is not readable: the source is. */
export const FLOW_MAX_NODES = 60;
/** Barycentre sweeps (down + up each). */
const SWEEPS = 2;
/** Cross-position relaxation passes (down + up each). */
const RELAX = 4;
/** How far a subgraph's title may slide right to clear an edge crossing its border. */
const FRAME_TITLE_SLIDE = 12;

interface Vertex {
  readonly key: string;
  readonly node: DiagramNode | undefined;
  readonly rank: number;
  /** Size across the flow (box width for TD, height for LR); 1 for a dummy. */
  crossSize: number;
  /** Size along the flow (box height for TD, width for LR); 0 for a dummy. */
  mainSize: number;
  pos: number;
  order: number;
  readonly outs: Segment[];
  readonly ins: Segment[];
}

interface Segment {
  readonly from: Vertex;
  readonly to: Vertex;
  readonly chain: Chain;
  c1: number;
  c2: number;
  channel: number;
}

interface Chain {
  readonly edge: DiagramEdge;
  readonly reversed: boolean;
  readonly segs: Segment[];
}

type Dir = "TD" | "BT" | "LR" | "RL";

/** The drawing, or `undefined` when it cannot be drawn faithfully in `maxWidth`. */
export function drawFlow(model: FlowModel, maxWidth: number): FlowDrawing | undefined {
  if (model.nodes.length === 0 || model.nodes.length > FLOW_MAX_NODES) return undefined;
  const byId = new Map(model.nodes.map((n) => [n.id, n] as const));
  for (const e of model.edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) return undefined;
  }
  const dir: Dir = model.direction;
  const sideways = dir === "LR" || dir === "RL";

  // 1. ranks — DFS back edges reversed, then longest path.
  const reversed = backEdges(model);
  const dag = model.edges.map((e, i) =>
    reversed.has(i) ? { a: e.to, b: e.from } : { a: e.from, b: e.to },
  );
  const rank = longestPath(model, dag);
  if (rank === undefined) return undefined;

  // 2. vertices + chains through dummies.
  const verts = new Map<string, Vertex>();
  const vertex = (key: string, node: DiagramNode | undefined, r: number): Vertex => {
    const v: Vertex = {
      key,
      node,
      rank: r,
      crossSize: 1,
      mainSize: 0,
      pos: 0,
      order: 0,
      outs: [],
      ins: [],
    };
    verts.set(key, v);
    return v;
  };
  for (const n of model.nodes) vertex(n.id, n, rank.get(n.id) ?? 0);
  const chains: Chain[] = model.edges.map((edge, i) => {
    const { a, b } = dag[i] as { a: string; b: string };
    const path: Vertex[] = [verts.get(a) as Vertex];
    const ra = rank.get(a) ?? 0;
    const rb = rank.get(b) ?? 0;
    for (let r = ra + 1; r < rb; r++) path.push(vertex(`\u0000${i}.${r}`, undefined, r));
    path.push(verts.get(b) as Vertex);
    const chain: Chain = { edge, reversed: reversed.has(i), segs: [] };
    for (let k = 0; k + 1 < path.length; k++) {
      const seg: Segment = {
        from: path[k] as Vertex,
        to: path[k + 1] as Vertex,
        chain,
        c1: 0,
        c2: 0,
        channel: 0,
      };
      chain.segs.push(seg);
      seg.from.outs.push(seg);
      seg.to.ins.push(seg);
    }
    return chain;
  });

  const ranks = Math.max(...[...verts.values()].map((v) => v.rank)) + 1;
  const layers: Vertex[][] = Array.from({ length: ranks }, () => []);
  for (const v of verts.values()) (layers[v.rank] as Vertex[]).push(v);
  orderLayers(layers);

  // sizes
  for (const v of verts.values()) sizeVertex(v, sideways);
  const framed = model.subgraphs.length > 0;
  const gaps = layers.map((layer) => layer.map((v) => crossGap(v, sideways, framed)));

  // 3. cross positions
  placeCross(layers, gaps);

  // ports
  for (const v of verts.values()) assignPorts(v, sideways);

  // 4. main positions, gaps, channels, labels
  const crossOffset = framed ? 2 : 0;
  if (crossOffset > 0) for (const v of verts.values()) v.pos += crossOffset;
  if (crossOffset > 0)
    for (const s of chains.flatMap((c) => c.segs))
      [s.c1, s.c2] = [s.c1 + crossOffset, s.c2 + crossOffset];

  const rankStart: number[] = [];
  const rankThick: number[] = layers.map((layer) => Math.max(0, ...layer.map((v) => v.mainSize)));
  const gapPlan: GapPlan[] = [];
  let m = framed ? 2 : 0;
  for (let r = 0; r < ranks; r++) {
    rankStart[r] = m;
    m += rankThick[r] as number;
    if (r === ranks - 1) break;
    const plan = planGap(layers[r] as Vertex[], m, sideways, framed);
    if (plan === undefined) return undefined;
    gapPlan.push(plan);
    m += plan.thickness;
  }
  const mainExtent = m + (framed ? 1 : 0);

  // drawing
  const map = (mm: number, cc: number): [number, number] => {
    switch (dir) {
      case "TD":
        return [mm, cc];
      case "BT":
        return [mainExtent - 1 - mm, cc];
      case "LR":
        return [cc, mm];
      default:
        return [cc, mainExtent - 1 - mm];
    }
  };
  const forward = { TD: "▼", BT: "▲", LR: "►", RL: "◄" }[dir];
  const backward = { TD: "▲", BT: "▼", LR: "◄", RL: "►" }[dir];

  const canvas = new Canvas();
  const boxes: FlowBox[] = [];
  for (const v of verts.values()) {
    if (v.node === undefined) continue;
    const ms = rankStart[v.rank] as number;
    const [ra, ca] = map(ms, v.pos);
    const [rb, cb] = map(ms + v.mainSize - 1, v.pos + v.crossSize - 1);
    const box: FlowBox = {
      id: v.node.id,
      row: Math.min(ra, rb),
      col: Math.min(ca, cb),
      width: Math.abs(cb - ca) + 1,
      height: Math.abs(rb - ra) + 1,
    };
    boxes.push(box);
    drawBox(canvas, box, v.node);
  }

  for (const chain of chains) {
    const first = chain.segs[0] as Segment;
    const last = chain.segs[chain.segs.length - 1] as Segment;
    const weight: LineWeight = chain.edge.style;
    const startM = (rankStart[first.from.rank] as number) + first.from.mainSize - 1;
    const pts: [number, number][] = [[startM, first.c1]];
    for (const seg of chain.segs) {
      if (seg.c1 === seg.c2) continue;
      const plan = gapPlan[seg.from.rank] as GapPlan;
      const ch = plan.channelStart + seg.channel;
      pts.push([ch, seg.c1], [ch, seg.c2]);
    }
    const plan = gapPlan[last.from.rank] as GapPlan;
    const headForward = chain.edge.arrow && !chain.reversed;
    const endM = headForward ? plan.arrowRow : (rankStart[last.to.rank] as number);
    pts.push([endM, last.c2]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [m0, c0] = pts[i] as [number, number];
      const [m1, c1] = pts[i + 1] as [number, number];
      const [r0, k0] = map(m0, c0);
      const [r1, k1] = map(m1, c1);
      canvas.line(r0, k0, r1, k1, "border", weight);
    }
    if (headForward) {
      const [r, c] = map(plan.arrowRow, last.c2);
      canvas.put(r, c, forward, "border");
    }
    if (chain.edge.arrow && chain.reversed) {
      const [r, c] = map(startM + 1, first.c1);
      canvas.put(r, c, backward, "border");
    }
  }

  // labels
  for (const chain of chains) {
    const label = chain.edge.label;
    if (label === undefined || label === "") continue;
    const seg = chain.segs[0] as Segment;
    const plan = gapPlan[seg.from.rank] as GapPlan;
    const spot = plan.labels.get(seg);
    if (spot === undefined) return undefined;
    if (sideways) {
      const w = cellWidth(label) + 2;
      const [r, c0] = map(spot.main, seg.c1);
      const [, c1] = map(spot.main + w - 1, seg.c1);
      canvas.text(r, Math.min(c0, c1), ` ${label} `, "label");
    } else {
      const [r] = map(spot.main, spot.cross);
      canvas.text(r, spot.cross, label, "label");
    }
  }

  if (framed) {
    // A frame spans its members' ranks (their arrow row inside, the row before
    // it free) and one cell around their cross range: abstract grid, mapped.
    const rects: FrameRect[] = [];
    for (const sg of model.subgraphs) {
      const members = sg.nodes
        .map((id) => verts.get(id))
        .filter((v): v is Vertex => v !== undefined);
      if (members.length === 0) return undefined;
      const m0 = Math.min(...members.map((v) => rankStart[v.rank] as number)) - 2;
      const m1 = Math.max(
        ...members.map((v) => (rankStart[v.rank] as number) + (rankThick[v.rank] as number)),
      );
      const margin = sideways ? 1 : 2;
      const k0 = Math.min(...members.map((v) => v.pos)) - margin;
      const k1 = Math.max(...members.map((v) => v.pos + v.crossSize)) + margin - 1;
      const [ra, ca] = map(m0, k0);
      const [rb, cb] = map(m1, k1);
      rects.push({
        r0: Math.min(ra, rb),
        c0: Math.min(ca, cb),
        r1: Math.max(ra, rb),
        c1: Math.max(ca, cb),
        title: sg.title,
        nodes: sg.nodes,
      });
    }
    if (!drawFrames(canvas, rects, boxes)) return undefined;
  }

  const width = canvas.width;
  if (width > maxWidth) return undefined;
  // a frame's margin can leave blank rows at the top/bottom: trimmed (boxes shift with them)
  const rows = canvas.rows();
  let top = 0;
  while (top < rows.length && (rows[top] as DiagramRow).length === 0) top++;
  let end = rows.length;
  while (end > top && (rows[end - 1] as DiagramRow).length === 0) end--;
  return {
    rows: rows.slice(top, end),
    width,
    boxes: boxes.map((b) => ({ ...b, row: b.row - top })),
  };
}

// ── ranks ────────────────────────────────────────────────────────────────────

/** Indices of the edges a DFS (in source order) finds closing a cycle. */
function backEdges(model: FlowModel): Set<number> {
  const out = new Map<string, number[]>();
  model.edges.forEach((e, i) => {
    const list = out.get(e.from) ?? [];
    list.push(i);
    out.set(e.from, list);
  });
  const state = new Map<string, 1 | 2>();
  const back = new Set<number>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const i of out.get(id) ?? []) {
      const to = (model.edges[i] as DiagramEdge).to;
      const s = state.get(to);
      if (s === 1) back.add(i);
      else if (s === undefined) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of model.nodes) if (!state.has(n.id)) visit(n.id);
  return back;
}

function longestPath(
  model: FlowModel,
  dag: readonly { readonly a: string; readonly b: string }[],
): Map<string, number> | undefined {
  const indeg = new Map<string, number>(model.nodes.map((n) => [n.id, 0]));
  for (const { b } of dag) indeg.set(b, (indeg.get(b) ?? 0) + 1);
  const rank = new Map<string, number>(model.nodes.map((n) => [n.id, 0]));
  const queue = model.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    seen++;
    for (const { a, b } of dag) {
      if (a !== id) continue;
      rank.set(b, Math.max(rank.get(b) ?? 0, (rank.get(a) ?? 0) + 1));
      const d = (indeg.get(b) ?? 0) - 1;
      indeg.set(b, d);
      if (d === 0) queue.push(b);
    }
  }
  return seen === model.nodes.length ? rank : undefined;
}

// ── order ────────────────────────────────────────────────────────────────────

function orderLayers(layers: Vertex[][]): void {
  const renumber = (layer: Vertex[]): void => {
    layer.forEach((v, i) => {
      v.order = i;
    });
  };
  for (const layer of layers) renumber(layer);
  const sweep = (layer: Vertex[], nbrs: (v: Vertex) => Vertex[]): void => {
    const key = new Map<Vertex, number>();
    for (const v of layer) {
      const n = nbrs(v);
      key.set(v, n.length === 0 ? v.order : n.reduce((s, u) => s + u.order, 0) / n.length);
    }
    layer.sort((a, b) => (key.get(a) as number) - (key.get(b) as number) || a.order - b.order);
    renumber(layer);
  };
  for (let s = 0; s < SWEEPS; s++) {
    for (let r = 1; r < layers.length; r++)
      sweep(layers[r] as Vertex[], (v) => v.ins.map((g) => g.from));
    for (let r = layers.length - 2; r >= 0; r--)
      sweep(layers[r] as Vertex[], (v) => v.outs.map((g) => g.to));
  }
}

// ── sizes and cross positions ───────────────────────────────────────────────

function sizeVertex(v: Vertex, sideways: boolean): void {
  if (v.node === undefined) return;
  const k = Math.max(v.outs.length, v.ins.length);
  const labelW = cellWidth(v.node.label);
  const width = labelW + (v.node.shape === "decision" ? 6 : 4);
  const cylinder = v.node.shape === "cylinder";
  const base = cylinder ? 4 : 3;
  if (sideways) {
    v.mainSize = width;
    v.crossSize = Math.max(base, k + 2 + (cylinder ? 1 : 0));
  } else {
    v.mainSize = base;
    v.crossSize = Math.max(width, 2 * k + 3);
  }
}

/** Cells left free after a vertex in its rank (TD: room for its rightmost label). */
function crossGap(v: Vertex, sideways: boolean, framed: boolean): number {
  // framed: a frame's margin on both sides of the gap, and a blank between frames
  if (sideways) return framed ? 3 : 1;
  const base = framed ? 5 : 3;
  const right = [...v.outs].sort((a, b) => a.to.order - b.to.order).at(-1);
  const label =
    right !== undefined && right.chain.segs[0] === right ? right.chain.edge.label : undefined;
  if (label === undefined || label === "") return base;
  const portOffset = v.outs.length <= 1 ? Math.floor((v.crossSize - 1) / 2) : v.crossSize - 3;
  const overflow = portOffset + 2 + cellWidth(label) - v.crossSize;
  return base + Math.max(0, overflow);
}

const center = (v: Vertex): number => v.pos + Math.floor((v.crossSize - 1) / 2);

function placeCross(layers: Vertex[][], gaps: number[][]): void {
  layers.forEach((layer, r) => {
    let at = 0;
    layer.forEach((v, i) => {
      v.pos = at;
      at += v.crossSize + ((gaps[r] as number[])[i] as number);
    });
  });
  const place = (r: number, nbrs: (v: Vertex) => Vertex[]): void => {
    const layer = layers[r] as Vertex[];
    const gap = gaps[r] as number[];
    const desired = layer.map((v) => {
      const n = nbrs(v);
      if (n.length === 0) return v.pos;
      const c = n.reduce((s, u) => s + center(u), 0) / n.length;
      return Math.round(c) - Math.floor((v.crossSize - 1) / 2);
    });
    const left: number[] = [];
    layer.forEach((v, i) => {
      const prev = layer[i - 1];
      const min =
        prev === undefined
          ? Number.NEGATIVE_INFINITY
          : (left[i - 1] as number) + prev.crossSize + (gap[i - 1] as number);
      left[i] = Math.max(desired[i] as number, min);
    });
    const right: number[] = [];
    for (let i = layer.length - 1; i >= 0; i--) {
      const v = layer[i] as Vertex;
      const next = layer[i + 1];
      const max =
        next === undefined
          ? Number.POSITIVE_INFINITY
          : (right[i + 1] as number) - v.crossSize - (gap[i] as number);
      right[i] = Math.min(desired[i] as number, max);
    }
    layer.forEach((v, i) => {
      v.pos = Math.floor(((left[i] as number) + (right[i] as number)) / 2);
    });
  };
  for (let s = 0; s < RELAX; s++) {
    for (let r = 1; r < layers.length; r++) place(r, (v) => v.ins.map((g) => g.from));
    for (let r = layers.length - 2; r >= 0; r--) place(r, (v) => v.outs.map((g) => g.to));
  }
  const min = Math.min(...layers.flat().map((v) => v.pos));
  for (const v of layers.flat()) v.pos -= min;
}

function assignPorts(v: Vertex, sideways: boolean): void {
  const spread = (
    segs: Segment[],
    other: (s: Segment) => Vertex,
    set: (s: Segment, c: number) => void,
  ): void => {
    const sorted = [...segs].sort(
      (a, b) => center(other(a)) - center(other(b)) || other(a).order - other(b).order,
    );
    const k = sorted.length;
    if (v.node === undefined) {
      for (const s of sorted) set(s, v.pos);
      return;
    }
    if (k === 1) {
      set(sorted[0] as Segment, center(v));
      return;
    }
    let lo = v.pos + 1 + (sideways && v.node.shape === "cylinder" ? 1 : 0);
    let hi = v.pos + v.crossSize - 2;
    if (!sideways && hi - lo >= k + 1) {
      lo++;
      hi--;
    }
    sorted.forEach((s, i) => set(s, lo + Math.round((i * (hi - lo)) / (k - 1))));
  };
  spread(
    v.outs,
    (s) => s.to,
    (s, c) => {
      s.c1 = c;
    },
  );
  spread(
    v.ins,
    (s) => s.from,
    (s, c) => {
      s.c2 = c;
    },
  );
}

// ── gaps ─────────────────────────────────────────────────────────────────────

interface GapPlan {
  readonly thickness: number;
  readonly channelStart: number;
  readonly arrowRow: number;
  /** Where each labelled first segment's label goes (abstract main + cross start). */
  readonly labels: Map<Segment, { main: number; cross: number }>;
}

/**
 * Plan the gap after one rank, from its first free main cell `g0`: stub rows
 * (labels), channel rows (one per overlapping horizontal run, ordered so no two
 * vertical runs share a column), and the arrow row.
 */
function planGap(
  layer: Vertex[],
  g0: number,
  sideways: boolean,
  framed: boolean,
): GapPlan | undefined {
  const segs = layer.flatMap((v) => v.outs);
  const bent = segs.filter((s) => s.c1 !== s.c2);
  const straight = new Set(segs.filter((s) => s.c1 === s.c2).map((s) => s.c1));
  for (const b of bent) if (straight.has(b.c1) || straight.has(b.c2)) return undefined;

  // channel order: a run ending in column x must arrive after the run leaving x turned away
  const before = new Map<Segment, Segment[]>(bent.map((s) => [s, []]));
  for (const a of bent)
    for (const b of bent) if (a !== b && a.c2 === b.c1) (before.get(a) as Segment[]).push(b);
  const done = new Set<Segment>();
  const lanes: Segment[][] = [];
  const pending = [...bent].sort((a, b) => Math.abs(a.c1 - a.c2) - Math.abs(b.c1 - b.c2));
  while (pending.length > 0) {
    const i = pending.findIndex((s) => (before.get(s) as Segment[]).every((p) => done.has(p)));
    if (i < 0) return undefined;
    const s = pending.splice(i, 1)[0] as Segment;
    const floor = Math.max(-1, ...(before.get(s) as Segment[]).map((p) => p.channel)) + 1;
    const lo = Math.min(s.c1, s.c2);
    const hi = Math.max(s.c1, s.c2);
    let ch = floor;
    while ((lanes[ch] ?? []).some((o) => Math.min(o.c1, o.c2) <= hi && lo <= Math.max(o.c1, o.c2)))
      ch++;
    s.channel = ch;
    const lane = lanes[ch] ?? [];
    lane.push(s);
    lanes[ch] = lane;
    done.add(s);
  }
  const channels = lanes.length;

  // labels
  const labelled = segs.filter((s) => s.chain.segs[0] === s && (s.chain.edge.label ?? "") !== "");
  const labels = new Map<Segment, { main: number; cross: number }>();
  let stub = 0;
  const top = g0 + (framed ? 1 : 0);
  if (sideways) {
    const widest = Math.max(0, ...labelled.map((s) => cellWidth(s.chain.edge.label ?? "") + 2));
    stub = widest > 0 ? widest + 2 : channels > 0 ? 1 : 0;
    for (const s of labelled) labels.set(s, { main: top + 1, cross: s.c1 });
  } else {
    const stubs = segs.map((s) => s.c1);
    const rows: [number, number][][] = [];
    for (const s of [...labelled].sort((a, b) => a.c1 - b.c1)) {
      const w = cellWidth(s.chain.edge.label ?? "");
      const spans: [number, number][] = [
        [s.c1 + 2, s.c1 + 1 + w],
        [s.c1 - 1 - w, s.c1 - 2],
      ];
      const ok = spans.filter(
        ([a, b]) => a >= 0 && !stubs.some((c) => c !== s.c1 && c >= a - 1 && c <= b + 1),
      );
      const span = ok[0];
      if (span === undefined) return undefined;
      let row = 0;
      while ((rows[row] ?? []).some(([a, b]) => a <= span[1] + 1 && span[0] <= b + 1)) row++;
      const taken = rows[row] ?? [];
      taken.push(span);
      rows[row] = taken;
      labels.set(s, { main: top + row, cross: span[0] });
    }
    stub = rows.length > 0 ? rows.length : channels > 0 ? 1 : 0;
  }
  const channelStart = top + stub;
  const frameTop = framed ? 1 : 0;
  const arrowRow = channelStart + channels + frameTop;
  return { thickness: arrowRow + 1 - g0, channelStart, arrowRow, labels };
}

// ── boxes and frames ────────────────────────────────────────────────────────

function drawBox(canvas: Canvas, box: FlowBox, node: DiagramNode): void {
  const style = node.shape === "decision" ? "decision" : "border";
  const r1 = box.row + box.height - 1;
  const c1 = box.col + box.width - 1;
  canvas.line(box.row, box.col, box.row, c1, style);
  canvas.line(r1, box.col, r1, c1, style);
  canvas.line(box.row, box.col, r1, box.col, style);
  canvas.line(box.row, c1, r1, c1, style);
  let first = box.row + 1;
  if (node.shape === "cylinder") {
    canvas.line(box.row + 1, box.col, box.row + 1, c1, style);
    first++;
  }
  const textRow = first + Math.floor((r1 - 1 - first) / 2);
  const w = cellWidth(node.label);
  canvas.text(textRow, box.col + Math.floor((box.width - w) / 2), node.label, "text");
  if (node.shape === "decision") {
    canvas.put(textRow, box.col, "◇", "decision");
    canvas.put(textRow, c1, "◇", "decision");
  }
}

/**
 * A dim titled frame around each subgraph's boxes. `false` when one cannot be
 * drawn honestly (a non-member box inside it, two frames meeting, no room for
 * its title): the caller then shows the source.
 */
interface FrameRect {
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
  readonly title: string;
  readonly nodes: readonly string[];
}

function drawFrames(
  canvas: Canvas,
  given: readonly FrameRect[],
  boxes: readonly FlowBox[],
): boolean {
  // 1. the title: the first stretch of the top border (else the bottom) that no
  //    edge crosses; the frame grows rightwards to hold it.
  const rects: (FrameRect & { titleRow: number; titleCol: number })[] = [];
  for (const f of given) {
    const title = f.title === "" ? "" : ` ${f.title} `;
    const tw = cellWidth(title);
    const clear = (row: number, from: number): boolean => {
      for (let c = from - 1; c <= from + tw; c++) if (!canvas.isBlank(row, c)) return false;
      return true;
    };
    const limit = f.c0 + 2 + FRAME_TITLE_SLIDE;
    let placed: { titleRow: number; titleCol: number } | undefined;
    for (const row of [f.r0, f.r1]) {
      for (let at = f.c0 + 2; placed === undefined && at <= limit; at++) {
        if (tw === 0 || clear(row, at)) placed = { titleRow: row, titleCol: at };
      }
      if (placed !== undefined) break;
    }
    if (placed === undefined) return false;
    rects.push({ ...f, c1: Math.max(f.c1, placed.titleCol + tw + 1), ...placed });
  }
  // 2. honesty: no stranger inside a frame, no two frames touching.
  for (const f of rects) {
    const inside = (b: FlowBox): boolean =>
      b.row <= f.r1 && b.row + b.height - 1 >= f.r0 && b.col <= f.c1 && b.col + b.width - 1 >= f.c0;
    if (boxes.some((b) => !f.nodes.includes(b.id) && inside(b))) return false;
  }
  for (const a of rects) {
    for (const b of rects) {
      if (a !== b && a.r0 <= b.r1 + 1 && b.r0 <= a.r1 + 1 && a.c0 <= b.c1 + 1 && b.c0 <= a.c1 + 1)
        return false;
    }
  }
  // 3. draw on blank cells only: an edge crossing the frame keeps its glyph.
  for (const f of rects) {
    const edge = (r: number, c: number, dirs: number): void => {
      if (canvas.isBlank(r, c)) canvas.link(r, c, dirs, "frame");
    };
    for (let c = f.c0; c <= f.c1; c++) {
      const ends = c === f.c0 || c === f.c1;
      edge(f.r0, c, (c > f.c0 ? LEFT : 0) | (c < f.c1 ? RIGHT : 0) | (ends ? DOWN : 0));
      edge(f.r1, c, (c > f.c0 ? LEFT : 0) | (c < f.c1 ? RIGHT : 0) | (ends ? UP : 0));
    }
    for (let r = f.r0 + 1; r < f.r1; r++) {
      edge(r, f.c0, UP | DOWN);
      edge(r, f.c1, UP | DOWN);
    }
    if (f.title !== "") canvas.text(f.titleRow, f.titleCol, ` ${f.title} `, "frame");
  }
  return true;
}

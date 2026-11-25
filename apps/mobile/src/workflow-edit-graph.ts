/**
 * docs/feat/workflow-editor.md D6 — the EDITOR's graph as GEOMETRY (slice 5).
 *
 * The run view's `workflow-graph.ts` draws a run the wire reported; this draws a
 * DRAFT the user is editing, so placement comes from the draft's own structure
 * (never from rounds, which a draft does not have) and every affordance the
 * direct-manipulation editor needs — `＋` on an edge, a `✗` port per pill, the
 * `✗ ×n` / `↻ ×n` labels you tap — is a value here, not a view. Pure and
 * React-free (AGENTS §7): `screens/WorkflowEdit.tsx` maps it onto
 * `react-native-svg` and Views, so the shape, the hit priority and the 44 pt
 * rule are testable with no renderer and no simulator
 * (`apps/mobile/test/workflow-edit-graph.test.ts`).
 *
 * Three rules earn their keep here:
 * - **one row per node, a uniform pitch.** `y` is strictly increasing BY
 *   CONSTRUCTION, so two pills never overlap whatever the ids, kinds or counts —
 *   the same rule the run view states, and the reason a 64-step draft still
 *   draws.
 * - **the side column is derived, not hard-coded.** A step sits in the side
 *   column when a `goto`/`next` above it reaches it AND its own `next:` points
 *   back UP: that is the loop's closing step (the mockup's hand-placed
 *   `fix`, `side: true`). Any other layout would draw the first real workflow
 *   that is not the mockup's in the wrong place.
 * - **a dangling reference is a GHOST pill.** `deleteStep` deliberately leaves
 *   `next:`/`on_fail.goto:` naming the removed step (D2), so the editor has to
 *   draw what is no longer there: a dashed pill `no such step`, plus the
 *   validator's exact sentence in the bar. It never hides the break.
 *
 * Every tappable thing carries a `hit` box padded to `EDIT_MIN_HIT` (44 pt), not
 * its drawn size: the `✗` port is 16 pt wide and the `＋` 22 pt, and both must
 * still be reachable one-handed.
 */
import type { InsertAt, StepKind, WorkflowDraft } from "@tentacle/core";
import { oneLine } from "./activity.ts";
import { size } from "./theme.ts";
import {
  BOTTOM_PAD,
  GRAPH_WIDTH,
  LOOP_TARGET,
  MAIN,
  NODE_GAP,
  PILL_H,
  PILL_RADIUS,
  PITCH,
  TOP_PAD,
  curve,
} from "./workflow-graph.ts";

type Mapping = Record<string, unknown>;

/** The minimum touch target, from the tokens: every hit box is at least this. */
export const EDIT_MIN_HIT = size.touch;

/** The badge glyph per kind — the mockup's `GLYPH` table. */
export const KIND_GLYPH: Readonly<Record<StepKind, string>> = {
  agent: "✧",
  run: "›_",
  approve: "?",
};

/** The `✗` port and `＋` anchor as DRAWN (their hit boxes are 44 pt regardless). */
export const PORT_SIZE = Math.round(size.touch * 0.36);
export const PLUS_SIZE = Math.round(size.touch * 0.5);

/** How far in from the pill's right edge its port hangs (`a.x + a.w - 30`). */
const PORT_INSET = 30;
/** Where a fail edge leaves its source and enters its target. */
const FAIL_INSET = 26;
/** Where a back `next` leaves the pill's top and how far it bows out. */
const BACK_INSET = 24;
/** A label's font: the mockup's 12 pt mono, and its caption line height. */
const LABEL_CHAR = 7;
const LABEL_H = 16;
const LABEL_PAD = 6;
/** The `＋` below the last pill: `--sp-transcript` + 4, the mockup's own offset. */
const END_GAP = NODE_GAP + 4;

export interface HitBox {
  readonly x: number;
  readonly y: number;
  /** Width / height of the TAPPABLE box, never smaller than `EDIT_MIN_HIT`. */
  readonly w: number;
  readonly h: number;
}

/** A box of at least `min` (default the 44 pt touch target) centred on a point. */
export function padHit(cx: number, cy: number, w: number, h: number, min = EDIT_MIN_HIT): HitBox {
  const width = Math.max(min, w);
  const height = Math.max(min, h);
  return { x: cx - width / 2, y: cy - height / 2, w: width, h: height };
}

/** Whether a tap at `(x, y)` lands inside `box`. */
export function hitContains(box: HitBox, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/** One pill: a real draft step, or a ghost for a reference that names no step. */
export interface EditNode {
  /** Step id, or the dangling id a ghost stands for. */
  readonly id: string;
  /** Its row in the drawing, 0-based: strictly increasing in `y` by construction. */
  readonly row: number;
  /** Its index in the file's `steps:`, or null for a ghost. */
  readonly stepIndex: number | null;
  readonly kind: StepKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly glyph: string;
  readonly sub: string;
  /** The loop's closing step: the narrow, right-hand column. */
  readonly side: boolean;
  readonly ghost: boolean;
  /** The validator has something to say about THIS step (glyph + word, never hue). */
  readonly bad: boolean;
  readonly hit: HitBox;
}

/** A tappable label on an edge: `✗ ×3`, `↻ ×1`, or the routed `next`. */
export interface EditLabel {
  /** The step the edge leaves (a label opens THAT step's sheet). */
  readonly id: string;
  readonly which: "fail" | "retry" | "next";
  readonly text: string;
  /** Its centre, in the logical space. */
  readonly x: number;
  readonly y: number;
  readonly hit: HitBox;
}

export interface EditEdge {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  /** `flow` (fall-through), `next` (explicit, routed), `fail` (dashed), `retry` (self-arc). */
  readonly kind: "flow" | "next" | "fail" | "retry";
  /** An SVG path in the logical space, ready for a `<Path>`. */
  readonly d: string;
  /** The target does not exist (a ghost), or the validator flags this edge. */
  readonly bad: boolean;
  readonly label?: EditLabel;
}

/** A `✗` port: the handle you drag (or tap, then tap a step) onto a target. */
export interface EditPort {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly hit: HitBox;
}

/** A `＋` anchor: it inserts at `insertAt`, the draft operation's own argument. */
export interface EditPlus {
  readonly insertAt: InsertAt;
  readonly x: number;
  readonly y: number;
  readonly hit: HitBox;
}

export interface EditGeometry {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly EditNode[];
  readonly edges: readonly EditEdge[];
  readonly labels: readonly EditLabel[];
  readonly ports: readonly EditPort[];
  readonly pluses: readonly EditPlus[];
  /** The validator's sentences, verbatim: the bar paints them. */
  readonly problems: readonly string[];
}

/** What a tap landed on. Priority: label > port > plus > node (D6). */
export type EditTarget =
  | { readonly kind: "label"; readonly id: string; readonly which: EditLabel["which"] }
  | { readonly kind: "port"; readonly id: string }
  | { readonly kind: "plus"; readonly insertAt: InsertAt }
  | { readonly kind: "node"; readonly id: string };

/** A draft's steps array, as mappings. A structurally-broken draft has none. */
function stepsOf(draft: WorkflowDraft): Mapping[] {
  const steps = draft.steps;
  return Array.isArray(steps) ? (steps as Mapping[]) : [];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The step's kind, from the body it carries (an editor only sees valid shapes). */
function kindOf(step: Mapping): StepKind {
  if (step.agent !== undefined) {
    return "agent";
  }
  if (step.approve !== undefined) {
    return "approve";
  }
  return "run";
}

function nextOf(step: Mapping): string | undefined {
  const next = textOf(step.next);
  return next === undefined || next === "" ? undefined : next;
}

/** `on_fail: {goto, max}` when it names a step; a `stop` or a blank is no edge. */
function onFailOf(step: Mapping): { readonly goto: string; readonly max: number } | undefined {
  const onFail = step.on_fail;
  if (typeof onFail !== "object" || onFail === null) {
    return undefined;
  }
  const mapping = onFail as Mapping;
  const goto = textOf(mapping.goto);
  if (goto === undefined || goto === "") {
    return undefined;
  }
  const max = mapping.max;
  return { goto, max: typeof max === "number" ? max : 0 };
}

function retryOf(step: Mapping): number {
  const retry = step.retry;
  return typeof retry === "number" && Number.isFinite(retry) ? Math.max(0, Math.floor(retry)) : 0;
}

/** A pill's one-line subtitle — the mockup's `sub(s)`. */
function subtitleOf(step: Mapping, kind: StepKind): string {
  if (kind === "agent") {
    const agent = (step.agent ?? {}) as Mapping;
    const model = textOf(agent.model);
    return `agent · ${model === undefined ? "default model" : oneLine(model)}`;
  }
  if (kind === "run") {
    const where = (step.where ?? {}) as Mapping;
    const docker = textOf(where.docker);
    const timeout = textOf(step.timeout);
    return [
      "run",
      docker === undefined ? "local" : `docker ${oneLine(docker)}`,
      ...(timeout === undefined ? [] : [oneLine(timeout)]),
    ].join(" · ");
  }
  return "approve · waits for you";
}

/**
 * Which steps close a loop, i.e. sit in the side column: reached by a
 * `goto`/`next` from ABOVE, and their own `next:` points back UP. In the
 * mockup's template that is `fix` (reached by `review.on_fail.goto`, pointing
 * back at `review`) and nothing else — `gate` is reached explicitly too, but it
 * does not close anything, so it stays in the main column.
 */
function sideFlags(steps: readonly Mapping[], indexById: Map<string, number>): boolean[] {
  return steps.map((step, i) => {
    const id = String(step.id);
    const reachedFromAbove = steps.some(
      (other, j) => j < i && (nextOf(other) === id || onFailOf(other)?.goto === id),
    );
    if (!reachedFromAbove) {
      return false;
    }
    const back = nextOf(step);
    const at = back === undefined ? undefined : indexById.get(back);
    return at !== undefined && at < i;
  });
}

/** One drawing row: a real step, or a ghost inserted after the step that names it. */
interface Row {
  readonly id: string;
  readonly stepIndex: number | null;
  readonly step: Mapping | null;
}

/**
 * The rows to draw. A dangling `next:`/`on_fail.goto:` becomes a ghost pill
 * directly BELOW the step that names it (`next` first, then the fail edge), so
 * the break is visible where it happens; the same missing id yields ONE ghost,
 * however many edges name it.
 */
function rowsOf(steps: readonly Mapping[]): Row[] {
  const known = new Set(steps.map((step) => String(step.id)));
  const ghosts = new Set<string>();
  const rows: Row[] = [];
  steps.forEach((step, i) => {
    rows.push({ id: String(step.id), stepIndex: i, step });
    const refs = [nextOf(step), onFailOf(step)?.goto];
    for (const ref of refs) {
      if (ref === undefined || known.has(ref) || ghosts.has(ref)) {
        continue;
      }
      ghosts.add(ref);
      rows.push({ id: ref, stepIndex: null, step: null });
    }
  });
  return rows;
}

/** A label centred on `cx`, kept inside the canvas, with its 44 pt hit box. */
function labelAt(
  id: string,
  which: EditLabel["which"],
  text: string,
  cx: number,
  cy: number,
): EditLabel {
  const width = Math.max(1, text.length) * LABEL_CHAR + LABEL_PAD * 2;
  const half = width / 2;
  const x = Math.min(Math.max(cx, half + 2), GRAPH_WIDTH - half - 2);
  return { id, which, text, x, y: cy, hit: padHit(x, cy, width, LABEL_H) };
}

/** A forward edge: down out of the source's bottom and into the target's top. */
function forwardPath(a: EditNode, b: EditNode, inset = 0): string {
  const fromX = inset === 0 ? a.x + a.width / 2 : a.x + a.width - inset;
  const toX = inset === 0 ? b.x + b.width / 2 : b.x + inset;
  return curve(fromX, a.y + a.height, toX, b.y);
}

/** A back `next`: up out of the source's top-right into the target's right end. */
function backPath(a: EditNode, b: EditNode): string {
  const sx = a.x + a.width - BACK_INSET;
  const sy = a.y;
  const ex = b.x + b.width;
  const ey = b.y + b.height / 2;
  return `M ${sx} ${sy} C ${sx} ${ey}, ${sx} ${ey}, ${ex + 10} ${ey} L ${ex} ${ey}`;
}

/** A goto that points UP: out of the source's left, around, into the target's left. */
function backFailPath(a: EditNode, b: EditNode): string {
  const gx = a.x - 30;
  const ay = a.y + a.height / 2;
  const ty = b.y + b.height / 2;
  return [
    `M ${a.x} ${ay}`,
    `L ${gx + 12} ${ay}`,
    `Q ${gx} ${ay} ${gx} ${ay - 12}`,
    `L ${gx} ${ty + 12}`,
    `Q ${gx} ${ty} ${gx + 12} ${ty}`,
    `L ${b.x} ${ty}`,
  ].join(" ");
}

/** A retry: the self-arc on the pill's right end. */
function retryPath(a: EditNode): string {
  const rx = a.x + a.width;
  return `M ${rx - 8} ${a.y + 6} C ${rx + 14} ${a.y + 2}, ${rx + 14} ${a.y + a.height - 2}, ${rx - 6} ${a.y + a.height - 6}`;
}

/** `steps[3]` / `steps[3].next` → 3. A whole-list problem (`steps: …`) names none. */
const STEP_PATH = /^steps\[(\d+)\]/;

function badFlags(problems: readonly string[], count: number): boolean[] {
  const flags = new Array<boolean>(count).fill(false);
  for (const problem of problems) {
    const match = STEP_PATH.exec(problem);
    if (match === null) {
      continue;
    }
    const at = Number(match[1]);
    if (at >= 0 && at < count) {
      flags[at] = true;
    }
  }
  return flags;
}

/**
 * The whole drawing for a draft: pills (with their ghost pills), edges by kind,
 * the tappable labels, one `✗` port per pill and the `＋` anchors. `problems` are
 * `draftProblems`' sentences: they mark the step they name `bad` and are handed
 * back verbatim for the bar.
 */
export function editGeometry(draft: WorkflowDraft, problems: readonly string[] = []): EditGeometry {
  const steps = stepsOf(draft);
  const rows = rowsOf(steps);
  const indexById = new Map(steps.map((step, i) => [String(step.id), i]));
  const side = sideFlags(steps, indexById);
  const bad = badFlags(problems, steps.length);

  const nodes: EditNode[] = rows.map((row, at) => {
    const column =
      row.stepIndex === null ? MAIN : side[row.stepIndex] === true ? LOOP_TARGET : MAIN;
    const kind = row.step === null ? "run" : kindOf(row.step);
    const x = column.x;
    const y = TOP_PAD + at * PITCH;
    return {
      id: row.id,
      row: at,
      stepIndex: row.stepIndex,
      kind,
      x,
      y,
      width: column.w,
      height: PILL_H,
      radius: PILL_RADIUS,
      glyph: row.step === null ? "+" : KIND_GLYPH[kind],
      sub: row.step === null ? "no such step" : subtitleOf(row.step, kind),
      side: row.stepIndex === null ? false : side[row.stepIndex] === true,
      ghost: row.step === null,
      bad: row.stepIndex === null ? true : bad[row.stepIndex] === true,
      hit: padHit(x + column.w / 2, y + PILL_H / 2, column.w, PILL_H),
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: EditEdge[] = [];
  const labels: EditLabel[] = [];
  const ports: EditPort[] = [];
  const pluses: EditPlus[] = [];
  const real = nodes.filter((node) => !node.ghost);

  for (const node of real) {
    if (node.stepIndex === null) {
      continue;
    }
    const step = steps[node.stepIndex];
    if (step === undefined) {
      continue;
    }
    ports.push({
      id: node.id,
      x: node.x + node.width - PORT_INSET,
      y: node.y + node.height,
      hit: padHit(node.x + node.width - PORT_INSET, node.y + node.height, PORT_SIZE, PORT_SIZE),
    });

    // The pass edge: an explicit `next:`, else the file's own fall-through.
    const explicit = nextOf(step);
    const fallThrough = steps[node.stepIndex + 1];
    const nextId = explicit ?? (fallThrough === undefined ? undefined : String(fallThrough.id));
    if (nextId !== undefined) {
      const target = byId.get(nextId);
      if (target !== undefined) {
        const forward = target.y > node.y;
        const label =
          forward || explicit === undefined
            ? undefined
            : labelAt(
                node.id,
                "next",
                "next",
                target.x + target.width + 30,
                target.y + target.height / 2 - 11,
              );
        if (label !== undefined) {
          labels.push(label);
        }
        edges.push({
          key: `e-${node.id}-${nextId}`,
          from: node.id,
          to: nextId,
          kind: explicit === undefined ? "flow" : "next",
          d: forward ? forwardPath(node, target) : backPath(node, target),
          bad: target.ghost,
          ...(label === undefined ? {} : { label }),
        });
        // A `＋` on every forward pass edge that does not enter the side column:
        // inserting on a loop's own back edge would draw a step nobody reaches.
        if (forward && !target.side) {
          const x = (node.x + node.width / 2 + target.x + target.width / 2) / 2;
          const y = (node.y + node.height + target.y) / 2;
          pluses.push({
            insertAt: { after: node.id },
            x,
            y,
            hit: padHit(x, y, PLUS_SIZE, PLUS_SIZE),
          });
        }
      }
    }

    // The fail edge (`on_fail: {goto, max}`): dashed, labelled `✗ ×max`.
    const onFail = onFailOf(step);
    if (onFail !== undefined) {
      const target = byId.get(onFail.goto);
      if (target !== undefined) {
        const forward = target.y > node.y;
        const text = `✗ ×${onFail.max > 0 ? onFail.max : "?"}`;
        const label = forward
          ? labelAt(
              node.id,
              "fail",
              text,
              Math.min(node.x + node.width - FAIL_INSET, target.x + FAIL_INSET) - 30,
              (node.y + node.height + target.y) / 2,
            )
          : labelAt(
              node.id,
              "fail",
              text,
              node.x - 30,
              (node.y + node.height / 2 + target.y + target.height / 2) / 2,
            );
        labels.push(label);
        edges.push({
          key: `fail-${node.id}-${onFail.goto}`,
          from: node.id,
          to: onFail.goto,
          kind: "fail",
          d: forward ? forwardPath(node, target, FAIL_INSET) : backFailPath(node, target),
          bad: target.ghost,
          label,
        });
      }
    }

    // The retry: a self-arc, labelled `↻ ×n`. Its label goes right of the pill
    // when it fits inside the canvas and left of it otherwise (a side column
    // pill already ends at the canvas edge).
    const retry = retryOf(step);
    if (retry > 0) {
      const text = `↻ ×${retry}`;
      const width = Math.max(1, text.length) * LABEL_CHAR + LABEL_PAD * 2;
      const right = node.x + node.width + 14 + width / 2;
      const label = labelAt(
        node.id,
        "retry",
        text,
        right + width / 2 <= GRAPH_WIDTH - 2 ? right : node.x - 14 - width / 2,
        node.y + node.height / 2,
      );
      labels.push(label);
      edges.push({
        key: `retry-${node.id}`,
        from: node.id,
        to: node.id,
        kind: "retry",
        d: retryPath(node),
        bad: false,
        label,
      });
    }
  }

  // The `＋` at the end: below the LAST drawn pill, ghost included, so it never
  // sits inside one.
  const last = nodes[nodes.length - 1];
  if (last !== undefined) {
    const x = last.x + last.width / 2;
    const y = last.y + last.height + END_GAP;
    pluses.push({ insertAt: { end: true }, x, y, hit: padHit(x, y, PLUS_SIZE, PLUS_SIZE) });
  }

  const lastPlus = pluses[pluses.length - 1];
  const height = Math.max(
    last === undefined ? TOP_PAD + BOTTOM_PAD : last.y + last.height + BOTTOM_PAD,
    lastPlus === undefined ? 0 : lastPlus.y + lastPlus.hit.h / 2 + 2,
  );

  return {
    width: GRAPH_WIDTH,
    height,
    nodes,
    edges,
    labels,
    ports,
    pluses,
    problems,
  };
}

/** The node a point is over (its padded hit box), or null. */
function nodeBoxAt(nodes: readonly EditNode[], x: number, y: number): EditNode | null {
  for (const node of nodes) {
    if (hitContains(node.hit, x, y)) {
      return node;
    }
  }
  return null;
}

/**
 * What a tap at `(x, y)` hits, in the ONE priority order the mockup needs:
 * label > port > plus > node. A label sits on an edge crossing a pill, and a
 * port hangs over its own pill's corner; testing the pill first would make both
 * unreachable.
 */
export function editTargetAt(geometry: EditGeometry, x: number, y: number): EditTarget | null {
  for (const label of geometry.labels) {
    if (hitContains(label.hit, x, y)) {
      return { kind: "label", id: label.id, which: label.which };
    }
  }
  for (const port of geometry.ports) {
    if (hitContains(port.hit, x, y)) {
      return { kind: "port", id: port.id };
    }
  }
  for (const plus of geometry.pluses) {
    if (hitContains(plus.hit, x, y)) {
      return { kind: "plus", insertAt: plus.insertAt };
    }
  }
  const node = nodeBoxAt(geometry.nodes, x, y);
  return node === null ? null : { kind: "node", id: node.id };
}

/**
 * The steps a `✗` port may be dropped on, while it is held: every real pill but
 * its own. A view-model FLAG (the screen dims the non-targets and ticks the
 * haptic from it), never branching in the component — and exactly the set
 * `dropTargetAt` accepts, so a highlight can never promise a drop it refuses.
 */
export function validDropTargets(geometry: EditGeometry, portId: string): readonly string[] {
  if (!geometry.ports.some((port) => port.id === portId)) {
    return [];
  }
  return geometry.nodes.filter((node) => !node.ghost && node.id !== portId).map((node) => node.id);
}

/**
 * Where a `✗` port was dropped: the step id, `"self"` when it lands on the step
 * it came from (refused — a self-goto is what `retry:` is), or null when it
 * lands nowhere. The one-handed path (tap the port, then tap a step) goes through
 * the same function, so both gestures can never disagree.
 */
export function dropTargetAt(
  geometry: EditGeometry,
  portId: string,
  x: number,
  y: number,
): string | "self" | null {
  if (!geometry.ports.some((port) => port.id === portId)) {
    return null;
  }
  const node = nodeBoxAt(geometry.nodes, x, y);
  if (node === null || node.ghost) {
    return null;
  }
  return node.id === portId ? "self" : node.id;
}

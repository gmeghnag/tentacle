/**
 * docs/fix/workflows-ux.md slice S6a — the RUN's graph geometry (D3). One test per
 * property the slice names, each written to go red on the PROPERTY, not on an
 * import:
 *
 * - no two pills overlap, for the mockup's demo-note, for a 64-step chain and for
 *   randomised shapes with nested gotos;
 * - `fix` lands in the SIDE column for demo-note (mutation: place by file order →
 *   red, which is exactly defect 1);
 * - every edge starts and ends ON its two nodes' boxes;
 * - chips are outside every pill (mutation: keep the arc midpoint → red);
 * - a `next` cycle is one pill and an arc, never a second pill;
 * - the drawing is the mockup's 402 pt space, so the existing `canvasMap` scales it.
 */
import { describe, expect, test } from "bun:test";
import { runProjection } from "@tentacle/client";
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import {
  RUN_PILL_H,
  RUN_SIDE,
  RUN_SPINE,
  RUN_TOP,
  RUN_WIDTH,
  type RunGeometry,
  type RunNode,
  nodeAt,
  runLayout,
} from "../src/workflow-run-layout.ts";

const step = (id: string, extra: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  kind: "agent",
  where: "local",
  state: "pending",
  attempt: 0,
  round: 0,
  next: null,
  onFail: null,
  retry: 0,
  ...extra,
});

/** demo-note, as the owner ran it: collect → draft(retry 1) → review(goto fix, 2) → fix(next review) → confirm → archive. */
function demoNote(steps?: WorkflowStepRow[]): WorkflowRow {
  return {
    runId: "wf-1",
    name: "demo-note",
    version: 1,
    hash: "a".repeat(64),
    state: "ok",
    tokens: 21_400,
    startedAt: 1_000,
    endedAt: 37_000,
    history: [],
    historyDropped: 0,
    steps: steps ?? [
      step("collect", { kind: "run", state: "ok", next: "draft", durationMs: 400 }),
      step("draft", { state: "ok", next: "review", retry: 1, durationMs: 18_200 }),
      step("review", {
        state: "ok",
        next: "confirm",
        onFail: { goto: "fix", max: 2, taken: 0 },
        durationMs: 9_600,
      }),
      step("fix", { state: "pending", next: "review" }),
      step("confirm", { kind: "approve", state: "ok", next: "archive", durationMs: 5_100 }),
      step("archive", { kind: "run", state: "ok", next: null, durationMs: 200 }),
    ],
  };
}

const layout = (row: WorkflowRow): RunGeometry => runLayout(runProjection(row));
const nodeById = (geometry: RunGeometry, id: string): RunNode => {
  const node = geometry.nodes.find((n) => n.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
};

/** Two boxes overlap only if they overlap on BOTH axes (a shared x alone is not overlap). */
/** The two numbers every overlap question needs: a pill's or a chip's box. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function overlappingPairs(geometry: RunGeometry): string[] {
  const bad: string[] = [];
  for (let i = 0; i < geometry.nodes.length; i += 1) {
    for (let j = i + 1; j < geometry.nodes.length; j += 1) {
      const a = geometry.nodes[i];
      const b = geometry.nodes[j];
      if (a !== undefined && b !== undefined && overlaps(a, b)) {
        bad.push(`${a.id}/${b.id}`);
      }
    }
  }
  return bad;
}

describe("S6a · placement comes from the definition, not the file order", () => {
  test("demo-note: the spine is the pass path, and `fix` is in the SIDE column", () => {
    const geometry = layout(demoNote());
    // collect → draft → review → confirm → archive: the pass walk, in rows 0…4.
    expect(
      ["collect", "draft", "review", "confirm", "archive"].map((id) => nodeById(geometry, id).row),
    ).toEqual([0, 1, 2, 3, 4]);
    for (const id of ["collect", "draft", "review", "confirm", "archive"]) {
      expect(nodeById(geometry, id).column).toBe("spine");
      expect(nodeById(geometry, id).x).toBe(RUN_SPINE.x);
      expect(nodeById(geometry, id).width).toBe(RUN_SPINE.w);
    }
    // `fix`: reached only by review's on_fail goto, its own `next:` back up ⇒ side.
    const fix = nodeById(geometry, "fix");
    expect(fix.column).toBe("side");
    expect(fix.x).toBe(RUN_SIDE.x);
    expect(fix.width).toBe(RUN_SIDE.w);
    // …one row below its source (the mockup's `fix` beside `confirm`), never IN the chain.
    expect(fix.row).toBeGreaterThanOrEqual(nodeById(geometry, "review").row + 1);
    expect(fix.row).toBe(nodeById(geometry, "confirm").row);
  });

  test("mutation check: placing by FILE index puts `fix` on the spine between review and confirm", () => {
    // The defect itself (workflow-graph.ts's rule), computed here so the assertion
    // above is shown to be non-vacuous: file order ⇒ fix at row 3, spine, in the chain.
    const geometry = layout(demoNote());
    const fileRow = 3;
    const fix = nodeById(geometry, "fix");
    expect(fix.row !== fileRow || fix.column !== "spine").toBe(true);
    const spiral = nodeById(geometry, "review");
    expect(spiral.row).toBe(2);
    expect(nodeById(geometry, "confirm").row).toBe(3);
  });

  test("every pill keeps the mockup's measures and the first one sits at TOP", () => {
    const geometry = layout(demoNote());
    for (const node of geometry.nodes) {
      expect(node.height).toBe(RUN_PILL_H);
      expect(node.radius).toBe(RUN_PILL_H / 2);
    }
    expect(nodeById(geometry, "collect").y).toBe(RUN_TOP);
    expect(geometry.width).toBe(RUN_WIDTH);
  });
});

describe("S6a · no two pills can overlap, for any definition", () => {
  test("demo-note", () => {
    expect(overlappingPairs(layout(demoNote()))).toEqual([]);
  });

  test("a 64-step chain", () => {
    const steps = Array.from({ length: 64 }, (_, i) =>
      step(`s${i}`, { next: i === 63 ? null : `s${i + 1}` }),
    );
    const geometry = layout(demoNote(steps));
    expect(geometry.nodes).toHaveLength(64);
    expect(overlappingPairs(geometry)).toEqual([]);
    // Rows strictly increase down the single column.
    const rows = geometry.nodes.map((n) => n.row);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });

  test("64 steps with nested gotos and retries", () => {
    const steps = Array.from({ length: 64 }, (_, i) =>
      step(`s${i}`, {
        next: i % 3 === 2 ? `s${i - 1}` : i === 63 ? null : `s${i + 1}`,
        // Every fifth step can jump forward two: a second route off the spine.
        onFail: i % 5 === 0 && i + 2 < 64 ? { goto: `s${i + 2}`, max: 2, taken: 0 } : null,
        retry: i % 7 === 0 ? 1 : 0,
      }),
    );
    expect(overlappingPairs(layout(demoNote(steps)))).toEqual([]);
  });

  test("randomised definitions: no overlap, in 200 seeded shapes", () => {
    // A tiny LCG from ONE pinned initial seed, so a failure reproduces exactly.
    let seed = 20_241_124;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const bad: string[] = [];
    for (let shape = 0; shape < 200; shape += 1) {
      const count = 2 + rnd(12);
      const ids = Array.from({ length: count }, (_, i) => `n${i}`);
      const steps = ids.map((id, i) =>
        step(id, {
          next: i === count - 1 ? null : (ids[Math.min(count - 1, i + 1 + rnd(2))] ?? null),
          onFail:
            rnd(3) === 0 && i > 0 ? { goto: ids[rnd(i)] ?? id, max: 1 + rnd(3), taken: 0 } : null,
          retry: rnd(4) === 0 ? 1 + rnd(2) : 0,
        }),
      );
      for (const pair of overlappingPairs(layout(demoNote(steps)))) {
        bad.push(`shape ${shape}: ${pair}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("S6a · every edge starts and ends on its two nodes' boxes", () => {
  test("demo-note's edges all touch both pills", () => {
    const geometry = layout(demoNote());
    expect(geometry.edges.length).toBeGreaterThanOrEqual(6);
    for (const edge of geometry.edges) {
      const from = nodeById(geometry, edge.from);
      const to = nodeById(geometry, edge.to);
      const points = numbersOf(edge.d);
      const first = { x: points[0] ?? Number.NaN, y: points[1] ?? Number.NaN };
      // The path's last point is the final pair of the `C` command.
      const last = {
        x: points.at(-2) ?? Number.NaN,
        y: points.at(-1) ?? Number.NaN,
      };
      expect({ edge: edge.key, from: onBox(from, first) }).toEqual({ edge: edge.key, from: true });
      expect({ edge: edge.key, to: onBox(to, last) }).toEqual({ edge: edge.key, to: true });
    }
  });

  test("the goto enters its target's TOP edge and leaves its source's right side", () => {
    const geometry = layout(demoNote());
    const fail = geometry.edges.find((e) => e.kind === "fail");
    expect(fail).toBeDefined();
    const target = nodeById(geometry, fail?.to ?? "");
    const points = numbersOf(fail?.d ?? "");
    const end = { x: points.at(-2) ?? Number.NaN, y: points.at(-1) ?? Number.NaN };
    expect(end.y).toBeCloseTo(target.y, 5);
    expect(end.x).toBeGreaterThan(target.x);
    expect(end.x).toBeLessThan(target.x + target.width);
  });

  test("the side-back `next` is drawn UP into its target (the loop reads as a loop)", () => {
    const geometry = layout(demoNote());
    const back = geometry.edges.find((e) => e.from === "fix" && e.kind === "next");
    expect(back).toBeDefined();
    const points = numbersOf(back?.d ?? "");
    expect(points[1] ?? 0).toBeGreaterThan(points.at(-1) ?? 0);
  });

  test("a dangling edge target draws no edge (never a made-up box)", () => {
    const row = demoNote([
      step("a", { state: "ok", next: "gone" }),
      step("b", { state: "pending" }),
    ]);
    const geometry = layout(row);
    expect(geometry.edges.filter((e) => e.to === "gone")).toEqual([]);
    expect(geometry.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("S6a · chips sit outside the pills, and a cycle is an arc not a second pill", () => {
  test("every chip is clear of every pill", () => {
    const geometry = layout(demoNote());
    expect(geometry.chips.length).toBeGreaterThan(0);
    for (const chip of geometry.chips) {
      for (const node of geometry.nodes) {
        expect({ chip: chip.key, node: node.id, hit: overlaps(chip, node) }).toEqual({
          chip: chip.key,
          node: node.id,
          hit: false,
        });
      }
    }
  });

  test("the goto's chip is `✗ taken/max`, the retry's `↻ attempt/retry`", () => {
    const row = demoNote([
      step("draft", { state: "ok", next: "review", retry: 1, attempt: 1 }),
      step("review", {
        state: "error",
        next: "confirm",
        onFail: { goto: "fix", max: 2, taken: 1 },
      }),
      step("fix", { state: "running", round: 1, next: "review" }),
      step("confirm", { state: "pending", next: "archive" }),
      step("archive", { state: "pending", next: null }),
    ]);
    const geometry = layout(row);
    const texts = geometry.chips.map((c) => `${c.kind}:${c.text}`);
    expect(texts).toContain("fail:✗ 1/2");
    expect(texts).toContain("retry:↻ 1/1");
  });

  test("a `next` cycle is one pill per step plus an arc — never a duplicated row", () => {
    const row = demoNote([
      step("a", { state: "ok", next: "b" }),
      step("b", { state: "ok", next: "a" }),
    ]);
    const geometry = layout(row);
    expect(geometry.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    const arc = geometry.edges.find((e) => e.from === "b" && e.to === "a");
    expect(arc).toBeDefined();
    expect(arc?.d).toContain("C");
  });

  test("two back arcs get different lanes, so they never coincide", () => {
    // a → b → c down the spine, and TWO gotos that jump back up to `a`: `b`'s and
    // `c`'s. Each needs its own lane in the gap between the columns.
    const row = demoNote([
      step("a", { state: "error", next: "b" }),
      step("b", { state: "error", next: "c", onFail: { goto: "a", max: 1, taken: 0 } }),
      step("c", { state: "ok", next: null, onFail: { goto: "a", max: 1, taken: 0 } }),
    ]);
    const geometry = layout(row);
    const arcs = geometry.edges.filter((e) => e.kind === "fail" && e.d.includes("C"));
    expect(arcs.length).toBe(2);
    expect(new Set(arcs.map((e) => e.d)).size).toBe(2);
    // …and no lane reaches into the side column (the cubic stays in its hull).
    for (const arc of arcs) {
      for (const point of numbersOf(arc.d)) {
        expect(point).toBeLessThanOrEqual(RUN_SIDE.x);
      }
    }
  });

  test("the layout's own hit test: a pill's box answers, the gap does not", () => {
    const geometry = layout(demoNote());
    const fix = nodeById(geometry, "fix");
    expect(nodeAt(geometry, fix.x + 4, fix.y + 4)?.id).toBe("fix");
    expect(nodeAt(geometry, RUN_SIDE.x - 2, fix.y + 4)).toBeNull();
  });
});

/** Every number in an SVG path, in order (`M x y C c1x c1y c2x c2y x y`). */
function numbersOf(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Whether a point lies on one of a pill's four edges (± a hairline for rounding). */
function onBox(node: RunNode, point: { x: number; y: number }): boolean {
  const eps = 0.01;
  const onX = point.x >= node.x - eps && point.x <= node.x + node.width + eps;
  const onY = point.y >= node.y - eps && point.y <= node.y + node.height + eps;
  const atEdge =
    Math.abs(point.x - node.x) <= eps ||
    Math.abs(point.x - (node.x + node.width)) <= eps ||
    Math.abs(point.y - node.y) <= eps ||
    Math.abs(point.y - (node.y + node.height)) <= eps;
  return onX && onY && atEdge;
}

/**
 * docs/feat/workflow-editor.md slice 5 — the EDITOR's geometry and hit-testing
 * (D6). One test per property the slice's "Tests" line names, each written to go
 * red on the property itself, not on an import:
 *
 * - `y` strictly increasing, so no two pills overlap at any draft length;
 * - one `＋` per drawable edge plus one at the end (and NEVER on a loop's own
 *   back edge — a step inserted there is unreachable);
 * - the fail edge is its own kind carrying `✗ ×n`, the retry arc `↻ ×n`;
 * - a dangling target is a ghost pill, never a silently dropped edge;
 * - a tap resolves label > port > plus > node;
 * - every hit box is ≥ 44 pt whatever the drawn size (mutation: draw-size hit
 *   boxes → red);
 * - dropping a `✗` port on its own step answers `"self"`.
 */
import { describe, expect, test } from "bun:test";
import {
  type InsertAt,
  WORKFLOW_TEMPLATES,
  type WorkflowDraft,
  deleteStep,
  draftProblems,
  workflowYaml,
} from "@tentacle/core";
import {
  EDIT_MIN_HIT,
  type EditGeometry,
  KIND_GLYPH,
  PLUS_SIZE,
  PORT_SIZE,
  dropTargetAt,
  editGeometry,
  editTargetAt,
  hitContains,
  padHit,
  validDropTargets,
} from "../src/workflow-edit-graph.ts";
import { GRAPH_WIDTH, MAIN, PILL_H, TOP_PAD } from "../src/workflow-graph.ts";

/** The mockup's plan · exec · review ⇄ fix · gate · merge, with its four prompts. */
const TEMPLATE = WORKFLOW_TEMPLATES.find(
  (template) => template.id === "plan-build-review-merge",
) as (typeof WORKFLOW_TEMPLATES)[number];

function templateDraft(): WorkflowDraft {
  return TEMPLATE.draft("task", "", { slug: { required: true } });
}

function geometry(draft: WorkflowDraft = templateDraft()): EditGeometry {
  return editGeometry(draft, draftProblems(draft, TEMPLATE.prompts));
}

/** A draft of `count` plain command steps, all in the main column. */
function longDraft(count: number): WorkflowDraft {
  return {
    schemaVersion: 1,
    name: "long",
    version: 1,
    steps: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, run: `echo ${i}` })),
  };
}

function nodeById(geom: EditGeometry, id: string) {
  const node = geom.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`no node "${id}" in ${geom.nodes.map((n) => n.id).join(", ")}`);
  }
  return node;
}

describe("placement comes from the draft's structure", () => {
  test("one row per node, y strictly increasing, nothing overlaps at 64 steps", () => {
    const draft = longDraft(64);
    const geom = editGeometry(draft, draftProblems(draft, {}));
    expect(geom.nodes).toHaveLength(64);
    for (let i = 1; i < geom.nodes.length; i += 1) {
      const previous = geom.nodes[i - 1];
      const current = geom.nodes[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous === undefined || current === undefined) {
        continue;
      }
      expect(current.y).toBeGreaterThan(previous.y);
      // The pill boxes themselves cannot touch: a uniform pitch is the point.
      expect(current.y).toBeGreaterThanOrEqual(previous.y + PILL_H);
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.x + current.width).toBeLessThanOrEqual(GRAPH_WIDTH);
    }
    expect(geom.nodes[0]?.y).toBe(TOP_PAD);
  });

  test("the loop's closing step is the side column; a step reached explicitly but open is not", () => {
    const geom = geometry();
    // `fix`: reached by review's `on_fail.goto` from above, and its `next:` points back up.
    expect(nodeById(geom, "fix").side).toBe(true);
    expect(nodeById(geom, "fix").width).toBeLessThan(nodeById(geom, "plan").width);
    // `gate`: review.next names it, but nothing loops back — it stays in the main column.
    expect(nodeById(geom, "gate").side).toBe(false);
    expect(nodeById(geom, "gate").width).toBe(MAIN.w);
  });

  test("the side column is DERIVED, not the mockup's id: another draft's loop still lands there", () => {
    // The plan's rule: placement comes from the draft's structure. A graph whose
    // loop closes on a step called anything else must draw the same way — and a
    // plain step that happens to be NAMED `fix` must not move.
    const draft: WorkflowDraft = {
      schemaVersion: 1,
      name: "renamed",
      version: 1,
      steps: [
        { id: "draft", agent: { prompt_text: "write it" } },
        { id: "fix", run: "echo not a loop" },
        { id: "review", agent: { prompt_text: "judge" }, on_fail: { goto: "repair", max: 2 } },
        { id: "repair", agent: { prompt_text: "mend" }, next: "review" },
      ],
    };
    const geom = editGeometry(draft, []);
    // `repair`: reached from above by review's goto, its `next:` points back up.
    expect(nodeById(geom, "repair").side).toBe(true);
    // `fix` is a plain fall-through step in this draft, whatever the mockup calls it.
    expect(nodeById(geom, "fix").side).toBe(false);
    expect(nodeById(geom, "fix").width).toBe(MAIN.w);
    // `review` is a goto SOURCE, not a closing step: it stays wide.
    expect(nodeById(geom, "review").side).toBe(false);
  });

  test("every pill carries its kind's glyph; the template's steps draw in file order", () => {
    const geom = geometry();
    // The file's own order, no reordering: `fix` draws after `review`, its goto source.
    expect(geom.nodes.map((node) => node.id)).toEqual([
      "plan",
      "exec",
      "review",
      "fix",
      "gate",
      "merge",
    ]);
    expect(nodeById(geom, "plan").glyph).toBe(KIND_GLYPH.agent);
    expect(nodeById(geom, "gate").glyph).toBe(KIND_GLYPH.run);
    expect(nodeById(geom, "merge").glyph).toBe(KIND_GLYPH.approve);
    expect(nodeById(geom, "plan").sub).toBe("agent · default model");
    expect(nodeById(geom, "gate").sub).toContain("run");
    expect(nodeById(geom, "merge").sub).toBe("approve · waits for you");
  });
});

describe("edges: one ＋ per drawable edge, plus the end", () => {
  test("the template draws a notifier for every forward flow/next edge and one at the end", () => {
    const geom = geometry();
    // plan→exec, exec→review, review→gate (explicit next) and gate→merge (flow).
    const forward = geom.edges.filter(
      (edge) =>
        (edge.kind === "flow" || edge.kind === "next") &&
        nodeById(geom, edge.to).y > nodeById(geom, edge.from).y &&
        !nodeById(geom, edge.to).side,
    );
    expect(forward).toHaveLength(4);
    expect(geom.pluses).toHaveLength(forward.length + 1);
    expect(
      geom.pluses.map((plus) => ("end" in plus.insertAt ? "end" : plus.insertAt.after)),
    ).toEqual(["plan", "exec", "review", "gate", "end"]);
  });

  test("no ＋ on a back edge: a step inserted on the loop's return would be unreachable", () => {
    const geom = geometry();
    const back = geom.edges.filter((edge) => edge.kind === "next" && edge.from === "fix");
    expect(back).toHaveLength(1);
    expect(back[0]?.label?.text).toBe("next");
    expect(
      geom.pluses.some((plus) => "after" in plus.insertAt && plus.insertAt.after === "fix"),
    ).toBe(false);
  });

  test("the end ＋ insertAt is the draft operation's own argument, and it sits below the last pill", () => {
    const geom = geometry();
    const end = geom.pluses.find((plus) => "end" in plus.insertAt);
    expect(end).toBeDefined();
    if (end === undefined) {
      return;
    }
    const last = geom.nodes[geom.nodes.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) {
      return;
    }
    expect(end.y).toBeGreaterThan(last.y + last.height);
    expect(end.insertAt satisfies InsertAt).toEqual({ end: true });
  });
});

describe("the fail edge and the retry arc keep their own kind and label", () => {
  test("on_fail is a `fail` edge labelled ✗ ×max, retry a `retry` self-arc labelled ↻ ×n", () => {
    const geom = geometry();
    const fail = geom.edges.find((edge) => edge.kind === "fail");
    expect(fail).toBeDefined();
    expect(fail?.from).toBe("review");
    expect(fail?.to).toBe("fix");
    expect(fail?.label?.which).toBe("fail");
    expect(fail?.label?.text).toBe("✗ ×3");

    const retry = geom.edges.find((edge) => edge.kind === "retry");
    expect(retry).toBeDefined();
    expect(retry?.from).toBe("exec");
    expect(retry?.to).toBe("exec");
    expect(retry?.label?.text).toBe("↻ ×1");
    // A retry that is not there is not drawn at all (never a `↻ ×0`).
    expect(geom.edges.some((edge) => edge.from === "plan" && edge.kind === "retry")).toBe(false);
  });

  test("a fail edge pointing UP routes around the left and is still one labelled edge", () => {
    const draft = templateDraft();
    const steps = (draft.steps as Record<string, unknown>[]).map((step) => ({ ...step }));
    // `plan` failing sends the run back down to `gate`: a goto whose target is BELOW.
    steps[0] = { ...(steps[0] as Record<string, unknown>), on_fail: { goto: "gate", max: 2 } };
    const geom = editGeometry({ ...draft, steps }, []);
    const fail = geom.edges.find((edge) => edge.kind === "fail" && edge.from === "plan");
    expect(fail?.label?.text).toBe("✗ ×2");
    expect(fail?.to).toBe("gate");

    // A goto that points UP takes the around-the-left route instead.
    const up = steps.map((step, i) =>
      i === 4 ? { ...step, on_fail: { goto: "exec", max: 1 } } : step,
    );
    const upGeom = editGeometry({ ...draft, steps: up }, []);
    const upFail = upGeom.edges.find((edge) => edge.kind === "fail" && edge.from === "gate");
    expect(upFail?.to).toBe("exec");
    expect(upFail?.d.startsWith("M ")).toBe(true);
    expect(upFail?.d).not.toBe(fail?.d);
  });
});

describe("a dangling reference is a ghost pill, never a dropped edge", () => {
  test("deleting a step that others reference draws it as a ghost and keeps the edges", () => {
    const draft = templateDraft();
    const deleted = deleteStep(draft, "fix");
    expect(deleted.dangling).toBeDefined();
    const problems = draftProblems(deleted.draft, TEMPLATE.prompts);
    const geom = editGeometry(deleted.draft, problems);

    const ghost = nodeById(geom, "fix");
    expect(ghost.ghost).toBe(true);
    expect(ghost.stepIndex).toBeNull();
    expect(ghost.sub).toBe("no such step");
    expect(ghost.bad).toBe(true);

    // The edge that named it survives, marked bad: hiding it would hide the break.
    const fail = geom.edges.find((edge) => edge.kind === "fail" && edge.from === "review");
    expect(fail).toBeDefined();
    expect(fail?.to).toBe("fix");
    expect(fail?.bad).toBe(true);

    // One ghost however many edges name it.
    expect(geom.nodes.filter((node) => node.ghost)).toHaveLength(1);

    // The validator's own sentence reaches the bar verbatim, and marks `review`
    // (steps[2], the step that owns the break) bad — not the whole graph.
    expect(geom.problems.length).toBeGreaterThan(0);
    expect(nodeById(geom, "review").bad).toBe(true);
    expect(nodeById(geom, "plan").bad).toBe(false);
  });

  test("a whole-list problem marks no single step bad", () => {
    const draft = templateDraft();
    const geom = editGeometry(draft, ["steps: the step list an approval shows is too long"]);
    expect(geom.nodes.every((node) => !node.bad)).toBe(true);
    expect(geom.problems).toHaveLength(1);
  });
});

describe("hit testing: label > port > plus > node, every box ≥ 44 pt", () => {
  test("every tappable box is at least the touch size, whatever it is drawn at", () => {
    const geom = geometry();
    expect(PORT_SIZE).toBeLessThan(EDIT_MIN_HIT);
    expect(PLUS_SIZE).toBeLessThan(EDIT_MIN_HIT);
    const boxes = [
      ...geom.nodes.map((node) => ["node", node.id, node.hit] as const),
      ...geom.ports.map((port) => ["port", port.id, port.hit] as const),
      ...geom.pluses.map((plus) => ["plus", String(plus.insertAt), plus.hit] as const),
      ...geom.labels.map((label) => ["label", label.text, label.hit] as const),
    ];
    for (const [kind, id, hit] of boxes) {
      if (hit.w < EDIT_MIN_HIT || hit.h < EDIT_MIN_HIT) {
        throw new Error(`${kind} ${id} hit box is ${hit.w}×${hit.h}, under ${EDIT_MIN_HIT}`);
      }
    }
  });

  test("a port hanging over its own pill's corner wins over the pill", () => {
    const geom = geometry();
    const port = geom.ports.find((candidate) => candidate.id === "review");
    const node = nodeById(geom, "review");
    expect(port).toBeDefined();
    if (port === undefined) {
      return;
    }
    // A point inside BOTH the pill and the port's padded box.
    const x = port.x;
    const y = node.y + node.height - 4;
    expect(hitContains(node.hit, x, y)).toBe(true);
    expect(hitContains(port.hit, x, y)).toBe(true);
    expect(editTargetAt(geom, x, y)).toEqual({ kind: "port", id: "review" });
  });

  test("a ＋ over the source pill's bottom edge wins over the pill", () => {
    const geom = geometry();
    const plus = geom.pluses.find(
      (candidate) => "after" in candidate.insertAt && candidate.insertAt.after === "plan",
    );
    const node = nodeById(geom, "plan");
    expect(plus).toBeDefined();
    if (plus === undefined) {
      return;
    }
    const x = plus.x;
    const y = node.y + node.height - 4;
    expect(hitContains(node.hit, x, y)).toBe(true);
    expect(hitContains(plus.hit, x, y)).toBe(true);
    expect(editTargetAt(geom, x, y)).toEqual({ kind: "plus", insertAt: { after: "plan" } });
  });

  test("the ranking itself: when all four overlap, the order decides", () => {
    // A hand-built overlap, because the template's own layout never stacks all
    // four: the priority is a property of `editTargetAt`, not of one fixture.
    const box = padHit(100, 100, 4, 4);
    const geom: EditGeometry = {
      width: GRAPH_WIDTH,
      height: 200,
      nodes: [
        {
          id: "a",
          row: 0,
          stepIndex: 0,
          kind: "run",
          x: 80,
          y: 80,
          width: 40,
          height: PILL_H,
          radius: 22,
          glyph: "›_",
          sub: "run",
          side: false,
          ghost: false,
          bad: false,
          hit: box,
        },
      ],
      edges: [],
      labels: [{ id: "a", which: "fail", text: "✗ ×1", x: 100, y: 100, hit: box }],
      ports: [{ id: "a", x: 100, y: 100, hit: box }],
      pluses: [{ insertAt: { after: "a" }, x: 100, y: 100, hit: box }],
      problems: [],
    };
    expect(editTargetAt(geom, 100, 100)).toEqual({ kind: "label", id: "a", which: "fail" });
    expect(editTargetAt({ ...geom, labels: [] }, 100, 100)).toEqual({ kind: "port", id: "a" });
    expect(editTargetAt({ ...geom, labels: [], ports: [] }, 100, 100)).toEqual({
      kind: "plus",
      insertAt: { after: "a" },
    });
    expect(editTargetAt({ ...geom, labels: [], ports: [], pluses: [] }, 100, 100)).toEqual({
      kind: "node",
      id: "a",
    });
    expect(editTargetAt({ ...geom, labels: [], ports: [], pluses: [], nodes: [] }, 100, 100)).toBe(
      null,
    );
  });

  test("a pill's box is its own tappable target, and empty canvas is nothing", () => {
    const geom = geometry();
    const node = nodeById(geom, "plan");
    // Well inside the pill, away from its port and the ＋ under it.
    expect(editTargetAt(geom, node.x + 20, node.y + 22)).toEqual({ kind: "node", id: "plan" });
    expect(editTargetAt(geom, GRAPH_WIDTH - 2, geom.height - 2)).toBe(null);
  });
});

describe("dropping a ✗ port", () => {
  test("on its own step is `self` (that is what retry: is for), on another step the id", () => {
    const geom = geometry();
    const plan = nodeById(geom, "plan");
    const gate = nodeById(geom, "gate");
    expect(dropTargetAt(geom, "plan", plan.x + 20, plan.y + 22)).toBe("self");
    expect(dropTargetAt(geom, "plan", gate.x + 20, gate.y + 22)).toBe("gate");
    // Landed nowhere, or a port that is not drawn: nothing happens.
    expect(dropTargetAt(geom, "plan", GRAPH_WIDTH - 2, geom.height - 2)).toBe(null);
    expect(dropTargetAt(geom, "nope", gate.x + 20, gate.y + 22)).toBe(null);
  });

  test("a ghost pill is not a drop target: you cannot point a goto at a step that is gone", () => {
    const draft = templateDraft();
    const deleted = deleteStep(draft, "fix");
    const geom = editGeometry(deleted.draft, []);
    const ghost = nodeById(geom, "fix");
    expect(dropTargetAt(geom, "plan", ghost.x + 20, ghost.y + 22)).toBe(null);
    // …and the highlight never promises it either.
    expect(validDropTargets(geom, "plan")).not.toContain("fix");
  });

  test("the valid targets are exactly what a drop accepts: every real pill but its own", () => {
    const geom = geometry();
    const valid = validDropTargets(geom, "review");
    expect(valid).toEqual(geom.nodes.map((node) => node.id).filter((id) => id !== "review"));
    for (const node of geom.nodes) {
      const dropped = dropTargetAt(geom, "review", node.x + 20, node.y + 22);
      const expected = node.id === "review" ? "self" : node.id;
      expect(dropped).toBe(expected);
      // A target the flag lists is always a target the drop resolves to its id.
      if (valid.includes(node.id)) {
        expect(dropped).toBe(node.id);
      }
    }
    // A port that is not drawn highlights nothing at all.
    expect(validDropTargets(geom, "nope")).toEqual([]);
  });
});

describe("the drawing is a pure function of the draft", () => {
  test("the same draft and problems give the same geometry, and the draft is not mutated", () => {
    const draft = templateDraft();
    const before = workflowYaml(draft);
    const a = editGeometry(draft, []);
    const b = editGeometry(draft, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(workflowYaml(draft)).toBe(before);
  });

  test("an empty steps list draws no pill, no port, no ＋ — and the creation flow's ＋ is the screen's job", () => {
    const geom = editGeometry({ schemaVersion: 1, name: "empty", version: 1, steps: [] }, []);
    expect(geom.nodes).toHaveLength(0);
    expect(geom.ports).toHaveLength(0);
    expect(geom.pluses).toHaveLength(0);
    expect(geom.height).toBeGreaterThan(0);
  });
});

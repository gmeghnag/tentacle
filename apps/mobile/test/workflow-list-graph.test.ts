/**
 * S7 of docs/feat/agent-workflows.md — the Elenco and the 2C graph, as the plan's
 * "Tests" section states them: "list rows / `needsUser`; graph geometry".
 *
 * The mockup is the spec (`docs/feat/agent-workflows/diagram.html`), and these pin
 * the two properties the mockup cannot state because it hard-codes one run:
 * - a state we do not know is never relabelled into one we do ("shape + glyph +
 *   word, never hue alone" — and never a neighbour's word);
 * - two pills never overlap, whatever the names or the width of the run, because
 *   the graph's `y` is a uniform pitch rather than the mockup's hand-placed one.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowListRow, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import {
  BADGE,
  BADGE_INSET,
  GRAPH_WIDTH,
  type GraphGeometry,
  PILL_H,
  graphGeometry,
  graphHeader,
  nodeAt,
  nodeSubtitle,
} from "../src/workflow-graph.ts";
import {
  type ElencoRun,
  elencoRow,
  elencoSections,
  fromListRow,
  fromSessionRun,
  needsUserCount,
  positionOf,
  stateLook,
} from "../src/workflow-list.ts";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef123456";

function step(id: string, state: string, extra: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  return {
    id,
    kind: "agent",
    where: "local",
    state,
    attempt: 0,
    round: 0,
    next: null,
    onFail: null,
    retry: 0,
    ...extra,
  };
}

/** The mockup's `task · cron-tool` run, as the session's own `workflows` row carries it. */
function mockRun(): WorkflowRow {
  return {
    runId: "wf-1",
    name: "task",
    version: 3,
    hash: HASH,
    state: "running",
    tokens: 1_200_000,
    budget: 3_000_000,
    startedAt: 1_000,
    history: [],
    historyDropped: 0,
    steps: [
      step("plan", "ok"),
      step("exec", "ok"),
      // Only the step ENTERED through `on_fail` carries the round: `fix` is the goto's
      // target, `review` the step it left (its "1 of 3" is the review's own reason).
      step("review", "error"),
      step("fix", "running", { round: 1, maxRound: 3 }),
      step("review 2", "waiting"),
      step("gate", "pending", { kind: "run", model: undefined }),
      step("merge", "needs-approval", { kind: "approve" }),
    ],
  };
}

describe("a wire state becomes a glyph, a word and a tone (mockup `G`/`W`)", () => {
  test("every known state has all three, and a running one is the only live glyph", () => {
    const looks = ["ok", "error", "running", "waiting", "needs-approval", "stopped", "pending"].map(
      stateLook,
    );
    for (const look of looks) {
      expect(look.tone).not.toBeNull();
      expect(look.glyph.length).toBeGreaterThan(0);
      expect(look.word.length).toBeGreaterThan(0);
    }
    expect(looks.filter((l) => l.live)).toHaveLength(1);
    expect(stateLook("running").live).toBe(true);
  });

  test("an UNKNOWN state is printed as it arrived, never coerced into a neighbour", () => {
    // A newer daemon's state word must not read as `waiting`: that is a claim about
    // whether the run needs the person, and the phone does not know it.
    const look = stateLook("archived-by-hand");
    expect(look.tone).toBeNull();
    expect(look.word).toBe("archived-by-hand");
    expect(look.live).toBe(false);
  });

  test("a state word is flattened to one plain line (it may come from a pod, §7)", () => {
    expect(stateLook("weird\nstate").word).toBe("weird state");
  });
});

describe("an Elenco row (mockup 1)", () => {
  test("`position` names the step we are AT, counting from one, from the steps", () => {
    const row = elencoRow(fromSessionRun(mockRun()), 1_000 + 23 * 60_000);
    // The running step is `fix`, the fourth: the mockup's "4 di 7".
    expect(row.position).toBe("4 of 7");
  });

  test("with only a summary there is no step to point at, so it counts the finished ones", () => {
    const listRow: WorkflowListRow = {
      sessionId: "s1",
      runId: "wf-1",
      name: "task",
      state: "running",
      step: "fix",
      done: 2,
      total: 7,
      needsUser: false,
      startedAt: 1_000,
    };
    // `workflow/list` does not say WHERE `fix` sits in the file, only that it is the
    // one running; inventing "3 of 7" from a done count would be a guess.
    expect(positionOf(fromListRow(listRow))).toBe("2 of 7");
  });

  test("a live run says how long it has been going, an ended one how long it took", () => {
    const live = elencoRow(fromSessionRun(mockRun()), 1_000 + 23 * 60_000);
    expect(live.when).toBe("for 23m 00s");
    const ended = elencoRow(
      fromSessionRun({ ...mockRun(), state: "ok", endedAt: 1_000 + 90_000 }),
      0,
    );
    expect(ended.when).toBe("took 1m 30s");
  });

  test("the step strip exists only where the shape carries steps, and blinks only where it runs", () => {
    const full = elencoRow(fromSessionRun(mockRun()), 1_000);
    expect(full.strip?.map((c) => c.glyph).join("")).toBe("✓✓✗▸○○?");
    expect(full.strip?.filter((c) => c.live)).toHaveLength(1);
    // The summary shape has no steps at all: the row says nothing rather than
    // drawing seven blank cells.
    const summary = elencoRow(
      fromListRow({
        sessionId: "s1",
        runId: "wf-1",
        name: "task",
        state: "running",
        done: 2,
        total: 7,
        needsUser: false,
        startedAt: 1_000,
      }),
      1_000,
    );
    expect(summary.strip).toBeNull();
  });

  test("version and hash come from the run's own row, and are ABSENT when it does not carry them", () => {
    expect(elencoRow(fromSessionRun(mockRun()), 1_000).version).toBe("task v3 · a1b2c3d");
    const summary = elencoRow(
      fromListRow({
        sessionId: "s1",
        runId: "wf-1",
        name: "task",
        state: "ok",
        done: 7,
        total: 7,
        needsUser: false,
        startedAt: 1_000,
      }),
      1_000,
    );
    // "task vundefined" would be a lie; the mockup's line is simply not drawn.
    expect(summary.version).toBeNull();
  });
});

describe("the Elenco's sections (mockup 1: live first)", () => {
  test("live runs keep the daemon's order; ended ones are newest first", () => {
    const runs: ElencoRun[] = [
      {
        runId: "old",
        name: "a",
        state: "ok",
        done: 1,
        total: 1,
        needsUser: false,
        startedAt: 1,
        endedAt: 10,
      },
      {
        runId: "live1",
        name: "b",
        state: "running",
        done: 0,
        total: 2,
        needsUser: false,
        startedAt: 20,
      },
      {
        runId: "new",
        name: "c",
        state: "ok",
        done: 1,
        total: 1,
        needsUser: false,
        startedAt: 2,
        endedAt: 30,
      },
      {
        runId: "live2",
        name: "d",
        state: "waiting",
        done: 1,
        total: 3,
        needsUser: true,
        startedAt: 5,
      },
    ];
    const sections = elencoSections(runs, 40);
    expect(sections.live.map((r) => r.key)).toEqual(["live1", "live2"]);
    // The run that just finished sits at the TOP of its section, not buried.
    expect(sections.finished.map((r) => r.key)).toEqual(["new", "old"]);
  });
});

describe("`needsUser` (the hub's signal)", () => {
  test("it counts every live run that waits on the person, and no ended one", () => {
    const runs: ElencoRun[] = [
      {
        runId: "a",
        name: "a",
        state: "needs-approval",
        done: 3,
        total: 7,
        needsUser: true,
        startedAt: 1,
      },
      {
        runId: "b",
        name: "b",
        state: "waiting",
        done: 1,
        total: 7,
        needsUser: false,
        startedAt: 1,
      },
      {
        runId: "c",
        name: "c",
        state: "running",
        done: 1,
        total: 7,
        needsUser: false,
        startedAt: 1,
      },
      // Ended: it can wait forever without needing anyone.
      {
        runId: "d",
        name: "d",
        state: "waiting",
        done: 1,
        total: 7,
        needsUser: true,
        startedAt: 1,
        endedAt: 9,
      },
    ];
    expect(needsUserCount(runs)).toBe(2);
  });

  test("a daemon's own `needsUser` is honoured even for a state word we do not know", () => {
    // The daemon knows better than a spelling this build has never seen.
    const runs: ElencoRun[] = [
      {
        runId: "a",
        name: "a",
        state: "awaiting-human",
        done: 0,
        total: 1,
        needsUser: true,
        startedAt: 1,
      },
    ];
    expect(needsUserCount(runs)).toBe(1);
  });
});

describe("the 2C graph (mockup section 2C)", () => {
  const graph = graphGeometry(mockRun().steps);

  test("one node per step, in the file's order, each with its state's tone", () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "plan",
      "exec",
      "review",
      "fix",
      "review 2",
      "gate",
      "merge",
    ]);
    expect(graph.nodes.map((n) => n.tone)).toEqual([
      "ok",
      "ok",
      "error",
      "running",
      "waiting",
      "waiting",
      "approval",
    ]);
  });

  test("NO two pills overlap: `y` is a uniform pitch, whatever the run", () => {
    // The mockup hand-places its seven nodes; a real run has any names, 1..64 steps.
    const many = Array.from({ length: 64 }, (_v, i) => step(`s${i}`, i === 63 ? "running" : "ok"));
    for (const g of [graph, graphGeometry(many), graphGeometry([])]) {
      const sorted = [...g.nodes].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev === undefined || cur === undefined) {
          continue;
        }
        // Strictly below the previous pill's bottom edge: not "mostly", never.
        expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.height);
      }
    }
  });

  test("the loop is placed from the WIRE's round data, not from the mockup's ids", () => {
    // The mockup matches `id === "review"`/`"fix"`. A workflow may name them
    // anything, and the goto fact the driver records is `round`/`maxRound` on the
    // step ENTERED through `on_fail` — the target, never the step it left.
    const renamed = graphGeometry([
      step("critique", "error"),
      step("patch", "running", { round: 1, maxRound: 3 }),
    ]);
    const critique = renamed.nodes.find((n) => n.id === "critique");
    const patch = renamed.nodes.find((n) => n.id === "patch");
    expect(critique?.loopSource).toBe(true);
    expect(patch?.loopTarget).toBe(true);
    expect(patch?.loopLabel).toBe("↻ 1 of 3");
    expect(renamed.edges.some((e) => e.kind === "back")).toBe(true);
  });

  test("a plain step is never marked as a loop's source or target", () => {
    const plain = graphGeometry([step("a", "ok"), step("b", "running")]);
    expect(plain.nodes.every((n) => !n.loopSource && !n.loopTarget)).toBe(true);
    expect(plain.edges.some((e) => e.kind === "back")).toBe(false);
  });

  test("the loop's two nodes sit on opposite sides, so the dashed edge has room", () => {
    const source = graph.nodes.find((n) => n.id === "review");
    const target = graph.nodes.find((n) => n.id === "fix");
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    if (source === undefined || target === undefined) {
      return;
    }
    // Narrower than the main flow, and horizontally clear of each other.
    expect(source.x).toBeLessThan(64);
    expect(target.x).toBeGreaterThan(64);
    expect(target.x).toBeGreaterThanOrEqual(source.x + source.width - 40);
  });

  test("a step that has not started is a dashed edge; the running one is not", () => {
    const entrance = graph.edges.filter((e) => e.kind !== "back");
    const intoRunning = entrance.find((e) => e.to === "fix");
    const intoPending = entrance.find((e) => e.to === "gate");
    expect(intoRunning?.kind).toBe("flow");
    expect(intoPending?.kind).toBe("future");
  });

  test("the drawing is authored at the mockup's width and grows in HEIGHT only", () => {
    expect(GRAPH_WIDTH).toBe(318);
    expect(graph.width).toBe(GRAPH_WIDTH);
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(GRAPH_WIDTH);
      expect(node.height).toBe(PILL_H);
    }
    // The height follows the content: a longer run is taller, never wider.
    expect(graph.height).toBeGreaterThan(graphGeometry(mockRun().steps.slice(0, 3)).height);
  });

  test("every edge's path is real SVG starting at a move", () => {
    for (const edge of graph.edges) {
      expect(edge.d.startsWith("M ")).toBe(true);
      expect(edge.d).toContain("C ");
      expect(edge.d).not.toContain("NaN");
      expect(edge.d).not.toContain("undefined");
    }
  });

  test("the badge sits centred on the pill's own middle", () => {
    expect(BADGE_INSET * 2 + BADGE).toBe(PILL_H);
  });

  test("a tap resolves to the pill it landed on, and to nothing between pills", () => {
    const node = graph.nodes[1];
    if (node === undefined) {
      throw new Error("the fixture has a second node");
    }
    expect(nodeAt(graph, node.x + 2, node.y + 2)?.id).toBe(node.id);
    expect(nodeAt(graph, node.x + node.width - 1, node.y + node.height - 1)?.id).toBe(node.id);
    // The gap between two pills is nobody's.
    expect(nodeAt(graph, node.x + 2, node.y + node.height + 4)).toBeNull();
    // Off the drawing entirely.
    expect(nodeAt({ ...graph, nodes: [] }, 0, 0)).toBeNull();
  });

  test("a node's subtitle is the state's WORD plus its model and where, flattened", () => {
    const running = mockRun().steps.find((s) => s.id === "fix");
    if (running === undefined) {
      throw new Error("the fixture has a running step");
    }
    expect(nodeSubtitle({ ...running, model: "deepseek" })).toBe("in progress · deepseek · local");
    // An absent model is absent, not an empty segment.
    expect(nodeSubtitle({ ...running, model: undefined })).toBe("in progress · local");
  });

  test("the header says the run's name over its version, hash and position", () => {
    const header = graphHeader(
      { name: "task", version: 3, hash: HASH, state: "running" },
      "4 of 7",
    );
    expect(header.title).toBe("task");
    expect(header.subtitle).toBe("task v3 · a1b2c3d · 4 of 7");
  });

  test("an empty run draws an empty canvas, not a crash", () => {
    const empty: GraphGeometry = graphGeometry([]);
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
    expect(empty.height).toBeGreaterThan(0);
  });
});

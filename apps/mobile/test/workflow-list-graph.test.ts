/**
 * docs/feat/agent-workflows.md S7's ELENCO — the list, its sections and its
 * `needsUser` signal — plus (docs/fix/workflows-ux.md S6b) the METRICS the two
 * graphs share. Its 2C graph section pinned the run's file-order placement, which
 * S6b deleted along with the guess: the drawing's own suite now lives in
 * `workflow-run-layout.test.ts`, and what is left here is what did not move.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowListRow, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import {
  BADGE,
  BADGE_INSET,
  GRAPH_WIDTH,
  LOOP_SOURCE,
  LOOP_TARGET,
  MAIN,
  NODE_GAP,
  PILL_H,
  PILL_RADIUS,
  PITCH,
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

/**
 * docs/fix/workflows-ux.md S6b: the RUN's graph geometry is no longer here. The
 * suite that stood in this place (`graphGeometry`, `graphHeader`, `nodeSubtitle`,
 * `nodeAt`) pinned the GUESS the slice retires — pills in file order, the loop read
 * off `maxRound` — so it went with the code. What it proved and still matters is
 * proved where the drawing now lives: `workflow-run-layout.test.ts` (placement from
 * the definition, no overlap, edges on the boxes, the hit test).
 *
 * What stays in this file is the METRICS the editor's graph still shares, because a
 * badge off-centre or a width that disagreed between the two graphs would show as a
 * jump when a draft is opened over a run.
 */
describe("the metrics both graphs share", () => {
  test("the state badge sits centred on the pill's own middle", () => {
    expect(BADGE_INSET * 2 + BADGE).toBe(PILL_H);
  });

  test("a pill is one touch target tall and fully rounded, and the pitch leaves the mockup's gap", () => {
    expect(PILL_H).toBe(44);
    expect(PILL_RADIUS).toBe(PILL_H / 2);
    expect(PITCH).toBe(PILL_H + NODE_GAP);
    expect(NODE_GAP).toBe(26);
  });

  test("the three columns all fit inside the graph, and the loop's are narrower", () => {
    // The editor's columns share row BANDS on purpose (a draft's `on_fail` target is
    // a step of the same chain), so they may overlap on x; what must hold is that no
    // pill overhangs the drawing and that the loop's two are the narrow ones.
    for (const column of [MAIN, LOOP_SOURCE, LOOP_TARGET]) {
      expect(column.x).toBeGreaterThanOrEqual(0);
      expect(column.x + column.w).toBeLessThanOrEqual(GRAPH_WIDTH);
    }
    expect(LOOP_SOURCE.w).toBeLessThan(MAIN.w);
    expect(LOOP_TARGET.w).toBeLessThan(MAIN.w);
  });
});

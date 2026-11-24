/**
 * `workflow-runs-controller.ts` (docs/feat/workflows-ui.md D4, slice 3): the
 * computer's run list — when it is read, what an older daemon or a dropped link
 * leave on screen, and the figure the hub badges. Pure, fake client and clock.
 */
import { describe, expect, test } from "bun:test";
import type {
  WorkflowCatalogueResult,
  WorkflowDefRow,
  WorkflowListResult,
  WorkflowListRow,
} from "@tentacle/protocol";
import { NO_WORKFLOWS_HERE } from "../src/hub-actions.ts";
import {
  type CatalogueFigure,
  RUNS_DEBOUNCE_MS,
  type RunsState,
  WORKFLOWS_OFFLINE,
  WORKFLOWS_UPDATE_TENTACLE,
  catalogueFigure,
  createWorkflowRunsController,
  workflowsHub,
} from "../src/workflow-runs-controller.ts";

const row = (over: Partial<WorkflowListRow> = {}): WorkflowListRow => ({
  sessionId: "s1",
  title: "fix the build",
  runId: "wf-1",
  name: "task",
  state: "running",
  step: "build",
  done: 1,
  total: 3,
  needsUser: false,
  startedAt: 1_000,
  ...over,
});

type Answer = WorkflowListResult | { unsupported: true } | Error;

/** A fake client: each `load` takes the next scripted answer, resolved by the test. */
function harness(answers: Answer[] = []) {
  const pending: { answer: Answer; resolve: () => void }[] = [];
  let loads = 0;
  const notices = new Set<() => void>();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const controller = createWorkflowRunsController({
    load: () => {
      loads += 1;
      const answer = answers.shift() ?? { runs: [] };
      return new Promise((resolve, reject) => {
        pending.push({
          answer,
          resolve: () => (answer instanceof Error ? reject(answer) : resolve(answer)),
        });
      });
    },
    onNotice: (fn) => {
      notices.add(fn);
      return () => notices.delete(fn);
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return {
        cancel: () => {
          t.live = false;
        },
      };
    },
  });
  /** Settle the oldest load in flight and let its continuation run. */
  async function settle(): Promise<void> {
    pending.shift()?.resolve();
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }
  function notice(): void {
    for (const fn of notices) {
      fn();
    }
  }
  function fire(): void {
    for (const t of timers.splice(0)) {
      if (t.live) {
        t.fn();
      }
    }
  }
  return {
    controller,
    settle,
    notice,
    fire,
    timers,
    notices,
    get loads() {
      return loads;
    },
  };
}

describe("when the list is read (focus, pull, notice)", () => {
  test("focus reads it once; the rows become Elenco runs", async () => {
    const h = harness([{ runs: [row()] }]);
    expect(h.controller.state().kind).toBe("loading");
    h.controller.focus();
    expect(h.loads).toBe(1);
    await h.settle();
    const s = h.controller.state();
    expect(s.kind).toBe("ready");
    expect(s.runs.map((r) => r.runId)).toEqual(["wf-1"]);
    expect(s.runs[0]?.sessionId).toBe("s1");
  });

  test("a pull reads it again", async () => {
    const h = harness([{ runs: [] }, { runs: [row()] }]);
    h.controller.focus();
    await h.settle();
    h.controller.pull();
    expect(h.loads).toBe(2);
    await h.settle();
    expect(h.controller.state().runs).toHaveLength(1);
  });

  test("notices are DEBOUNCED: a burst of frames is one read, 500 ms after the last", async () => {
    const h = harness([{ runs: [] }, { runs: [row()] }]);
    h.controller.focus();
    await h.settle();
    h.notice();
    h.notice();
    h.notice();
    expect(h.loads).toBe(1);
    expect(RUNS_DEBOUNCE_MS).toBe(500);
    expect(h.timers.filter((t) => t.live)).toHaveLength(1);
    expect(h.timers.find((t) => t.live)?.ms).toBe(RUNS_DEBOUNCE_MS);
    h.fire();
    expect(h.loads).toBe(2);
  });

  test("one read at a time: a pull during a read is ONE more read after it, not two in flight", async () => {
    const h = harness([{ runs: [] }, { runs: [row()] }]);
    h.controller.focus();
    h.controller.pull();
    h.controller.pull();
    expect(h.loads).toBe(1);
    await h.settle();
    expect(h.loads).toBe(2);
    await h.settle();
    expect(h.controller.state().runs).toHaveLength(1);
    expect(h.loads).toBe(2);
  });

  test("blur stops listening: no notice reads while the screen is away", async () => {
    const h = harness();
    h.controller.focus();
    await h.settle();
    h.notice();
    h.controller.blur();
    expect(h.notices.size).toBe(0);
    h.fire();
    expect(h.loads).toBe(1);
  });
});

describe("what a failure leaves on screen", () => {
  test("an older daemon (`MethodNotFound`) says so, never an empty list", async () => {
    const h = harness([{ unsupported: true }]);
    h.controller.focus();
    await h.settle();
    expect(h.controller.state()).toMatchObject({ kind: "unsupported", runs: [] });
    expect(WORKFLOWS_UPDATE_TENTACLE).toBe("Update tentacle on this computer");
  });

  test("link down: the LAST list stays, with an offline line — no spinner loop, no new read", async () => {
    const h = harness([{ runs: [row()] }, new Error("not connected to the daemon")]);
    h.controller.focus();
    await h.settle();
    h.controller.pull();
    await h.settle();
    const s = h.controller.state();
    expect(s.kind).toBe("ready");
    expect(s.runs.map((r) => r.runId)).toEqual(["wf-1"]);
    expect(s.offline).toBe(WORKFLOWS_OFFLINE);
    expect(h.loads).toBe(2);
    // The next good read clears the line.
    h.controller.pull();
    await h.settle();
    expect(h.controller.state().offline).toBeNull();
  });

  test("link down on the FIRST read: an error state with the reason, not a spinner", async () => {
    const h = harness([new Error("not connected to the daemon")]);
    h.controller.focus();
    await h.settle();
    expect(h.controller.state()).toMatchObject({
      kind: "error",
      error: "not connected to the daemon",
    });
  });

  test("a read that lands after dispose changes nothing", async () => {
    const h = harness([{ runs: [row()] }]);
    h.controller.focus();
    h.controller.dispose();
    await h.settle();
    expect(h.controller.state().kind).toBe("loading");
    expect(h.notices.size).toBe(0);
  });
});

describe("workflowsHub: the hub's figure (D4, D6)", () => {
  const READY_EMPTY: RunsState = { kind: "ready", runs: [], offline: null };
  const ONE_FILE: CatalogueFigure = { known: true, count: 1, unavailable: null };
  const NO_FILE: CatalogueFigure = { known: true, count: 0, unavailable: null };
  const UNKNOWN: CatalogueFigure = { known: false, count: 0, unavailable: null };

  test("unknown (loading, error) is undefined — the item is neither dimmed nor badged", () => {
    expect(workflowsHub({ kind: "loading", runs: [], offline: null })).toBeUndefined();
    expect(workflowsHub({ kind: "error", runs: [], offline: null, error: "x" })).toBeUndefined();
  });

  test("an older daemon → dimmed `Update tentacle` (a version is not an empty project)", () => {
    expect(workflowsHub({ kind: "unsupported", runs: [], offline: null })).toEqual({
      needYou: 0,
      empty: WORKFLOWS_UPDATE_TENTACLE,
    });
    // The catalogue cannot rescue it: a daemon that has no run list cannot start one.
    expect(workflowsHub({ kind: "unsupported", runs: [], offline: null }, ONE_FILE)).toEqual({
      needYou: 0,
      empty: WORKFLOWS_UPDATE_TENTACLE,
    });
  });

  test("no run but a workflow FILE → NOT dimmed (defect 4: the first start starts here)", () => {
    expect(workflowsHub(READY_EMPTY, ONE_FILE)).toEqual({ needYou: 0, empty: null });
  });

  test("no run and a catalogue known to be EMPTY → dimmed `No workflows in this project`", () => {
    expect(NO_WORKFLOWS_HERE).toBe("No workflows in this project");
    expect(workflowsHub(READY_EMPTY, NO_FILE)).toEqual({ needYou: 0, empty: NO_WORKFLOWS_HERE });
  });

  test("an UNKNOWN catalogue never dims (not read, older daemon, a failed read)", () => {
    expect(workflowsHub(READY_EMPTY, UNKNOWN)).toEqual({ needYou: 0, empty: null });
    // The screen before its first attach: no catalogue at all.
    expect(workflowsHub(READY_EMPTY)).toEqual({ needYou: 0, empty: null });
  });

  test("a catalogue this session cannot run says so (`unavailable`, a pod's daemon)", () => {
    const pod: CatalogueFigure = {
      known: true,
      count: 0,
      unavailable: WORKFLOWS_OFFLINE,
    };
    expect(workflowsHub(READY_EMPTY, pod)).toEqual({ needYou: 0, empty: WORKFLOWS_OFFLINE });
  });

  test("a run is something to open whatever the catalogue says", () => {
    const h = harness([{ runs: [row()] }]);
    h.controller.focus();
    return h.settle().then(() => {
      expect(workflowsHub(h.controller.state(), NO_FILE)).toEqual({ needYou: 0, empty: null });
    });
  });

  test("the badge counts the live runs that wait on the person", async () => {
    const h = harness([
      {
        runs: [
          row({ runId: "a", state: "needs-approval", needsUser: true }),
          row({ runId: "b" }),
          row({ runId: "c", state: "waiting", needsUser: true, endedAt: 2_000 }),
        ],
      },
    ]);
    h.controller.focus();
    await h.settle();
    expect(workflowsHub(h.controller.state(), NO_FILE)).toEqual({ needYou: 1, empty: null });
  });
});

describe("catalogueFigure: the catalogue as the hub's fact (D6)", () => {
  const answer = (over: Partial<WorkflowCatalogueResult> = {}): WorkflowCatalogueResult => ({
    workflows: [],
    dir: "/p",
    ...over,
  });
  const def = (name: string, ok: boolean): WorkflowDefRow => ({
    name,
    path: `.tentacle/workflows/${name}.yaml`,
    ok,
    ...(ok ? { hash: "a".repeat(64) } : { errors: ["bad yaml"] }),
  });

  test("not read, an older daemon and a failed read are all UNKNOWN", () => {
    expect(catalogueFigure(null)).toEqual({ known: false, count: 0, unavailable: null });
    expect(catalogueFigure({ unsupported: true })).toEqual({
      known: false,
      count: 0,
      unavailable: null,
    });
  });

  test("a read folder is KNOWN, and every listed file counts — a broken one too", () => {
    expect(catalogueFigure(answer())).toEqual({ known: true, count: 0, unavailable: null });
    expect(catalogueFigure(answer({ workflows: [def("demo-note", true)] }))).toMatchObject({
      known: true,
      count: 1,
    });
    // A broken YAML is still a workflow in this project: the start screen shows
    // its errors, so the item must open — never "No workflows in this project".
    const broken = catalogueFigure(answer({ workflows: [def("a", false), def("b", false)] }));
    expect(broken).toEqual({ known: true, count: 2, unavailable: null });
    expect(workflowsHub({ kind: "ready", runs: [], offline: null }, broken)).toEqual({
      needYou: 0,
      empty: null,
    });
  });

  test("`unavailable` keeps its own text (a pod's daemon), never `no workflows`", () => {
    expect(catalogueFigure(answer({ unavailable: "workflows run only on a laptop" }))).toEqual({
      known: true,
      count: 0,
      unavailable: "workflows run only on a laptop",
    });
  });
});

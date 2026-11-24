/**
 * `workflow-runs-controller.ts` (docs/feat/workflows-ui.md D4, slice 3): the
 * computer's run list — when it is read, what an older daemon or a dropped link
 * leave on screen, and the figure the hub badges. Pure, fake client and clock.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowListResult, WorkflowListRow } from "@tentacle/protocol";
import { NO_WORKFLOW_RUNS } from "../src/hub-actions.ts";
import {
  RUNS_DEBOUNCE_MS,
  WORKFLOWS_OFFLINE,
  WORKFLOWS_UPDATE_TENTACLE,
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

describe("workflowsHub: the hub's figure (D4)", () => {
  test("unknown (loading, error) is undefined — the item is neither dimmed nor badged", () => {
    expect(workflowsHub({ kind: "loading", runs: [], offline: null })).toBeUndefined();
    expect(workflowsHub({ kind: "error", runs: [], offline: null, error: "x" })).toBeUndefined();
  });

  test("no run → dimmed `No workflow runs`; an older daemon → dimmed `Update tentacle`", () => {
    expect(workflowsHub({ kind: "ready", runs: [], offline: null })).toEqual({
      needYou: 0,
      empty: NO_WORKFLOW_RUNS,
    });
    expect(workflowsHub({ kind: "unsupported", runs: [], offline: null })).toEqual({
      needYou: 0,
      empty: WORKFLOWS_UPDATE_TENTACLE,
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
    expect(workflowsHub(h.controller.state())).toEqual({ needYou: 1, empty: null });
  });
});

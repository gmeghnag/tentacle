/**
 * Slice 4 of docs/feat/workflows-ui.md (D5): the DETAIL's data — a step's
 * `prompt` and `report`, which a `workflows` row deliberately does not carry, read
 * with `session/workflow_step` and held by the run controller
 * (`workflow-run-controller.ts`'s `openStep`/`closeStep`).
 *
 * The properties pinned here are the ones a naive fetch gets wrong:
 * - one read in flight per step (a re-render storm is not a request storm), and a
 *   loaded detail is never re-read;
 * - a late read for a step NO LONGER selected lands on ITS step, never the open one;
 * - "not available" (an empty answer), "an older daemon" and a failed read are
 *   DIFFERENT states, and none substitutes another step's text;
 * - the kv rows come from the ROW, so they are final before the read lands.
 */
import { describe, expect, test } from "bun:test";
import type {
  WorkflowResult,
  WorkflowRow,
  WorkflowStepResult,
  WorkflowStepRow,
} from "@tentacle/protocol";
import type { CardAsk } from "../src/workflow-run-controller.ts";
import { type RunMode, createWorkflowRunController } from "../src/workflow-run-controller.ts";

const step = (id: string, state: string, over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  kind: "agent",
  where: "local",
  state,
  attempt: 0,
  round: 0,
  ...over,
});

const run = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  runId: "wf-1",
  name: "task",
  version: 1,
  hash: "a".repeat(64),
  state: "ok",
  tokens: 0,
  startedAt: 1_000,
  steps: [step("build", "ok"), step("review", "error"), step("merge", "ok")],
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  attempt: 0,
  round: 0,
  live: false,
  prompt: "the resolved prompt",
  report: "the report",
  ...over,
});

function harness(
  opts: {
    stepReply?: WorkflowStepResult | { unsupported: true };
    stepThrows?: string;
  } = {},
) {
  const feed = new Set<(rows: readonly WorkflowRow[]) => void>();
  const stepCalls: { runId: string; stepId: string; attempt?: number }[] = [];
  const settle: (() => void)[] = [];
  let held = false;
  let mode: RunMode = "graph";
  const session = {
    onWorkflows(fn: (rows: readonly WorkflowRow[]) => void) {
      feed.add(fn);
      return () => feed.delete(fn);
    },
    async workflow(_action: unknown): Promise<WorkflowResult | { ok: false; reason: string }> {
      return { ok: true };
    },
    workflowStep(
      runId: string,
      stepId: string,
      attempt?: number,
    ): Promise<WorkflowStepResult | { unsupported: true }> {
      stepCalls.push({ runId, stepId, ...(attempt === undefined ? {} : { attempt }) });
      if (opts.stepThrows !== undefined) {
        return Promise.reject(new Error(opts.stepThrows));
      }
      const answer = opts.stepReply ?? { detail: detail() };
      if (!held) {
        return Promise.resolve(answer);
      }
      return new Promise((resolve) => settle.push(() => resolve(answer)));
    },
  };
  const controller = createWorkflowRunController({
    runId: "wf-1",
    sessionId: "s1",
    borrowed: false,
    open: async () => ({ ok: true as const, session }),
    leave: () => {},
    asks: {
      current: (): CardAsk | null => null,
      answerFor: () => "sent",
      subscribe: () => () => {},
    },
    mode: {
      get: () => mode,
      set: (m) => {
        mode = m;
      },
    },
  });
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  return {
    controller,
    flush,
    push: (rows: readonly WorkflowRow[]) => {
      for (const fn of feed) fn(rows);
    },
    stepCalls,
    hold: () => {
      held = true;
    },
    release: async () => {
      held = false;
      for (const fn of settle.splice(0)) fn();
      await flush();
    },
  };
}

async function ready(h: ReturnType<typeof harness>): Promise<void> {
  h.controller.start();
  await h.flush();
  h.push([run()]);
}

const detailOf = (h: ReturnType<typeof harness>, id: string) =>
  h.controller.state().steps.find((s) => s.step.id === id)?.detail;

describe("a step's detail: read on demand, held per step", () => {
  test("`openStep` reads that step's detail for THIS run and holds it", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toEqual([{ runId: "wf-1", stepId: "review" }]);
    expect(detailOf(h, "review")).toEqual({ kind: "loaded", detail: detail() });
    expect(h.controller.state().openStepId).toBe("review");
  });

  test("the attempt asked for is passed through (a step that ran twice)", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review", 1);
    await h.flush();
    expect(h.stepCalls).toEqual([{ runId: "wf-1", stepId: "review", attempt: 1 }]);
  });

  test("ONE read in flight per step: a second open while it flies does not refetch", async () => {
    const h = harness();
    await ready(h);
    h.hold();
    h.controller.openStep("review");
    h.controller.openStep("review");
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toHaveLength(1);
    await h.release();
    expect(h.stepCalls).toHaveLength(1);
  });

  test("a detail already loaded is not re-read when the step is reopened", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toHaveLength(1);
  });

  test("a LATE read for a step no longer selected lands on ITS step, never the open one", async () => {
    const h = harness();
    await ready(h);
    h.hold();
    h.controller.openStep("review");
    // The person moves on before the read lands: `build` is the open step now.
    h.controller.openStep("build");
    expect(h.controller.state().openStepId).toBe("build");
    await h.release();
    expect(detailOf(h, "review")?.kind).toBe("loaded");
    expect(detailOf(h, "build")?.kind).toBe("loaded");
    expect(h.controller.state().openStepId).toBe("build");
  });
});

describe("the four answers a read can give, kept DISTINCT", () => {
  test("`{}` (never ran, or its entry left the retained log) says so — it is not silence", async () => {
    const h = harness({ stepReply: {} });
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    expect(detailOf(h, "review")).toEqual({ kind: "missing" });
  });

  test("an older daemon (`{unsupported:true}`) says update tentacle, never `missing`", async () => {
    const h = harness({ stepReply: { unsupported: true } });
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    expect(detailOf(h, "review")).toEqual({ kind: "unsupported" });
  });

  test("a rejected read is a `failed` detail with its reason — never a stuck skeleton", async () => {
    const h = harness({ stepThrows: "link down" });
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    expect(detailOf(h, "review")).toEqual({ kind: "failed", reason: "link down" });
  });

  test("a handle with no `workflowStep` (an older build) says update tentacle, sending nothing", async () => {
    const controller = createWorkflowRunController({
      runId: "wf-1",
      sessionId: "s1",
      borrowed: false,
      open: async () => ({
        ok: true as const,
        session: {
          onWorkflows: (fn: (rows: readonly WorkflowRow[]) => void) => {
            fn([run()]);
            return () => {};
          },
          workflow: async () => ({ ok: true as const }),
        },
      }),
      leave: () => {},
      asks: null,
      mode: { get: () => "graph" as RunMode, set: () => {} },
    });
    controller.start();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    controller.openStep("review");
    expect(controller.state().steps.find((s) => s.step.id === "review")?.detail).toEqual({
      kind: "unsupported",
    });
  });

  test("a step this run does not have is never read (a stale tap sends nothing)", async () => {
    const h = harness();
    await ready(h);
    h.push([run({ runId: "wf-2" })]);
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toEqual([]);
    expect(h.controller.state().steps).toHaveLength(0);
  });
});

describe("the paint while a read is in flight: the skeleton, from the row", () => {
  test("a selected step is `loading` in the SAME state() call that starts the read", async () => {
    const h = harness();
    await ready(h);
    h.hold();
    h.controller.openStep("review");
    expect(detailOf(h, "review")).toEqual({ kind: "loading" });
    await h.release();
  });

  test("the kv rows above the log block never depend on the read (they come from the row)", async () => {
    const h = harness();
    await ready(h);
    const before = h.controller.state().steps.find((s) => s.step.id === "review")?.step;
    h.controller.openStep("review");
    await h.flush();
    const after = h.controller.state().steps.find((s) => s.step.id === "review")?.step;
    if (before === undefined || after === undefined) {
      throw new Error("the feed carries the run's steps");
    }
    expect(after).toEqual(before);
  });

  test("closing the detail keeps the loaded record (a reopen paints at once)", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    h.controller.closeStep();
    expect(h.controller.state().openStepId).toBeNull();
    h.controller.openStep("review");
    expect(detailOf(h, "review")).toEqual({ kind: "loaded", detail: detail() });
    expect(h.stepCalls).toHaveLength(1);
  });

  test("a re-run of the step drops its stale detail (the old prompt is not the new one)", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    await h.controller.rerun("review");
    expect(detailOf(h, "review")).toBeUndefined();
  });
});

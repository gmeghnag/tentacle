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
  next: null,
  onFail: null,
  retry: 0,
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
  history: [],
  historyDropped: 0,
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
  let paints = 0;
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
    onChange: () => {
      paints += 1;
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
    /** How many times the screen was told to repaint. */
    paints: () => paints,
    reply: (next: WorkflowStepResult | { unsupported: true }) => {
      opts.stepReply = next;
    },
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
    h.controller.openStep("review", { attempt: 1 });
    await h.flush();
    expect(h.stepCalls).toEqual([{ runId: "wf-1", stepId: "review", attempt: 1 }]);
    // The visit is kept for the nav bar (S7: position + neighbours are per visit).
    expect(h.controller.state().openVisit).toEqual({ attempt: 1 });
  });

  test("S7 · a visit of an EARLIER goto round reads the latest, never that round's attempt", async () => {
    // The read selects by attempt alone: review round 0 attempt 0 would match the
    // round-1 execution's attempt 0 — so an older round's visit names no attempt.
    const opened = async (visit: { attempt: number; round: number }) => {
      const h = harness();
      h.controller.start();
      await h.flush();
      h.push([run({ steps: [step("review", "ok", { round: 1 })] })]);
      h.controller.openStep("review", visit);
      await h.flush();
      return h;
    };
    const older = await opened({ attempt: 0, round: 0 });
    expect(older.stepCalls).toEqual([{ runId: "wf-1", stepId: "review" }]);
    expect(older.controller.state().openVisit).toEqual({ attempt: 0, round: 0 });
    const current = await opened({ attempt: 0, round: 1 });
    expect(current.stepCalls).toEqual([{ runId: "wf-1", stepId: "review", attempt: 0 }]);
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

  test("a LIVE detail is not final: reopened after the step ended, it is read again", async () => {
    // review round 2, #1: a `live:true` record was cached forever ("running now:").
    const h = harness({ stepReply: { detail: detail({ live: true, report: "partial" }) } });
    h.controller.start();
    await h.flush();
    h.push([run({ state: "running", steps: [step("a", "running")] })]);
    h.controller.openStep("a");
    await h.flush();
    h.controller.closeStep();
    h.push([run({ steps: [step("a", "ok")] })]);
    h.reply({ detail: detail({ report: "final" }) });
    h.controller.openStep("a");
    // The held live text stays on screen while the fresh read flies (no skeleton flash).
    expect(detailOf(h, "a")).toEqual({
      kind: "loaded",
      detail: detail({ live: true, report: "partial" }),
    });
    await h.flush();
    expect(h.stepCalls).toHaveLength(2);
    expect(detailOf(h, "a")).toEqual({ kind: "loaded", detail: detail({ report: "final" }) });
  });

  test("a held detail of an OLDER attempt is read again (a rerun started elsewhere)", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    h.push([run({ steps: [step("review", "error", { attempt: 1 })] })]);
    h.reply({ detail: detail({ attempt: 1, report: "second" }) });
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toHaveLength(2);
    expect(detailOf(h, "review")).toEqual({
      kind: "loaded",
      detail: detail({ attempt: 1, report: "second" }),
    });
  });

  test("a held detail of an older goto ROUND is read again", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    h.push([run({ steps: [step("review", "error", { round: 1 })] })]);
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toHaveLength(2);
  });

  test("an explicit attempt already held (ended) is not re-read", async () => {
    const h = harness({ stepReply: { detail: detail({ attempt: 0 }) } });
    h.controller.start();
    await h.flush();
    h.push([run({ steps: [step("review", "error", { attempt: 1 })] })]);
    h.controller.openStep("review", { attempt: 0 });
    await h.flush();
    h.controller.openStep("review", { attempt: 0 });
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

/**
 * docs/fix/mobile-workflow-run-jank.md defect 2: the screen repaints only on
 * `onChange`, so an open that reads nothing (a held final detail, a read in
 * flight) must still say that the layer is open.
 */
describe("every open repaints, whether or not it reads", () => {
  /** Paints caused by the open itself, before anything async can land. */
  const paintsOn = (h: ReturnType<typeof harness>, open: () => void): number => {
    const before = h.paints();
    open();
    return h.paints() - before;
  };

  test("an ended step reopened after Back repaints, with no second read", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review");
    await h.flush();
    h.controller.closeStep();
    expect(paintsOn(h, () => h.controller.openStep("review"))).toBeGreaterThan(0);
    expect(h.controller.state().openStepId).toBe("review");
    await h.flush();
    expect(h.stepCalls).toHaveLength(1);
  });

  test("a step reopened while its read is in flight repaints, with one request", async () => {
    const h = harness();
    await ready(h);
    h.hold();
    h.controller.openStep("review");
    h.controller.closeStep();
    expect(paintsOn(h, () => h.controller.openStep("review"))).toBeGreaterThan(0);
    expect(detailOf(h, "review")).toEqual({ kind: "loading" });
    await h.release();
    expect(h.stepCalls).toHaveLength(1);
    expect(detailOf(h, "review")?.kind).toBe("loaded");
  });

  test("a VISIT open of a held detail repaints too (list rows and arrows)", async () => {
    const h = harness();
    await ready(h);
    h.controller.openStep("review", { attempt: 0 });
    await h.flush();
    h.controller.closeStep();
    const open = () => h.controller.openStep("review", { attempt: 0, round: 0 });
    expect(paintsOn(h, open)).toBeGreaterThan(0);
    expect(h.controller.state().openVisit).toEqual({ attempt: 0, round: 0 });
    expect(h.stepCalls).toHaveLength(1);
  });

  test("a tap for a step no longer on the feed repaints, with no card and no read", async () => {
    const h = harness();
    await ready(h);
    expect(paintsOn(h, () => h.controller.openStep("ghost"))).toBeGreaterThan(0);
    expect(h.controller.state().steps.some((s) => s.step.id === "ghost")).toBe(false);
    expect(h.stepCalls).toEqual([]);
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

/**
 * docs/fix/workflows-ux.md S7/D5: a step that NEVER RAN has no execution to read.
 * The daemon answers `{}` for it, so the old path sent a `workflowStep` request for
 * a detail that cannot exist and painted a `missing` record ("no longer available")
 * — a false story about a step that simply was not run. The projection already
 * knows (`phase: "skipped"`), so the screen must not ask at all.
 */
describe("S7 · a not-run step sends no read, and says why in words", () => {
  /** demo-note as run ① ended: review passed first try, so `fix` never ran. */
  const ranRun = (): WorkflowRow =>
    run({
      state: "ok",
      endedAt: 2_000,
      steps: [
        step("collect", "ok", { kind: "run", next: "draft" }),
        step("draft", "ok", { next: "review" }),
        step("review", "ok", { next: "confirm", onFail: { goto: "fix", max: 2, taken: 0 } }),
        step("fix", "pending", { next: "review" }),
        step("confirm", "pending", { kind: "approve", next: "archive" }),
        step("archive", "pending", { kind: "run", next: null }),
      ],
    });
  const notRunOf = (h: ReturnType<typeof harness>, id: string) =>
    h.controller.state().steps.find((s) => s.step.id === id)?.detail;

  test("the not-run step is `notRun` and NOTHING is sent for it", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([ranRun()]);
    h.controller.openStep("fix");
    await h.flush();
    expect(h.stepCalls).toEqual([]);
    expect(notRunOf(h, "fix")).toEqual({ kind: "notRun" });
  });

  test("…while a step that DID run is still read (the guard is the projection, not the ended run)", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([ranRun()]);
    h.controller.openStep("review");
    await h.flush();
    expect(h.stepCalls).toEqual([{ runId: "wf-1", stepId: "review" }]);
    expect(notRunOf(h, "review")).toEqual({ kind: "loaded", detail: detail() });
  });

  test("a not-run step never reads `loading` or `missing` (nothing is on its way)", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([ranRun()]);
    h.controller.openStep("fix");
    // The SAME state() call that opens it: no skeleton, no "no longer available".
    expect(notRunOf(h, "fix")).toEqual({ kind: "notRun" });
    await h.flush();
    expect(notRunOf(h, "fix")).toEqual({ kind: "notRun" });
  });

  test("a step the run still says will run is NOT treated as not-run", async () => {
    // A live run: `confirm` is merely not yet, so a read is legitimate (the daemon
    // answers what it has) — the guard is `skipped` alone.
    const h = harness();
    h.controller.start();
    await h.flush();
    h.push([
      run({
        state: "running",
        steps: [step("collect", "ok", { next: "confirm" }), step("confirm", "pending")],
      }),
    ]);
    h.controller.openStep("confirm");
    await h.flush();
    expect(h.stepCalls).toEqual([{ runId: "wf-1", stepId: "confirm" }]);
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

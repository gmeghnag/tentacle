/**
 * The shared run projection (docs/fix/workflows-ux.md D2, slice S5): the four
 * mockup scenarios as fixtures, so every phase, trace, chip and "not run"
 * sentence is pinned to what the owner approved — and the d1b5faaa bug (a step
 * that never ran shown as "waiting" inside the chain) is killed at its root.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import {
  type WorkflowProjection,
  notRunWhy,
  runProjection,
  summary,
  timeline,
} from "../src/workflow-run-graph.ts";

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

/** demo-note: collect → draft(retry 1) → review(on_fail goto fix, max 2) → fix(next review) → confirm(approve) → archive. */
function demoNote(extra: Partial<WorkflowRow> = {}, steps?: WorkflowStepRow[]): WorkflowRow {
  const row: WorkflowRow = {
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
    ...extra,
  };
  return row;
}

/** Scenario ① (final-v3): review passed first try, `fix` never ran, the run is over. */
const RUN_ONE = demoNote({
  history: [
    { step: "collect", attempt: 0, round: 0, state: "ok", durationMs: 400 },
    { step: "draft", attempt: 0, round: 0, state: "ok", durationMs: 18_200 },
    { step: "review", attempt: 0, round: 0, state: "ok", durationMs: 9_600 },
    { step: "confirm", attempt: 0, round: 0, state: "ok", durationMs: 5_100 },
    { step: "archive", attempt: 0, round: 0, state: "ok", durationMs: 200 },
  ],
});

/** Scenario ②: review fails once, the goto fires, fix runs, review passes on round 2. */
const RUN_TWO = demoNote({
  tokens: 41_700,
  endedAt: 69_000,
  history: [
    { step: "collect", attempt: 0, round: 0, state: "ok", durationMs: 400 },
    { step: "draft", attempt: 0, round: 0, state: "error", durationMs: 3_100 },
    { step: "draft", attempt: 1, round: 0, state: "ok", durationMs: 14_700 },
    { step: "review", attempt: 0, round: 1, state: "error", durationMs: 8_900 },
    { step: "fix", attempt: 0, round: 1, state: "ok", durationMs: 14_300 },
    { step: "review", attempt: 0, round: 2, state: "ok", durationMs: 7_200 },
    { step: "confirm", attempt: 0, round: 0, state: "ok", durationMs: 12_000 },
    { step: "archive", attempt: 0, round: 0, state: "ok", durationMs: 200 },
  ],
  steps: [
    step("collect", { kind: "run", state: "ok", next: "draft", durationMs: 400 }),
    step("draft", { state: "ok", next: "review", retry: 1, attempt: 1, durationMs: 14_700 }),
    step("review", {
      state: "ok",
      next: "confirm",
      round: 2,
      onFail: { goto: "fix", max: 2, taken: 1 },
      durationMs: 7_200,
    }),
    step("fix", { state: "ok", round: 1, next: "review", durationMs: 14_300 }),
    step("confirm", { kind: "approve", state: "ok", next: "archive", durationMs: 12_000 }),
    step("archive", { kind: "run", state: "ok", next: null, durationMs: 200 }),
  ],
});

/** Scenario ③: live, waiting on the person at `confirm`; `archive` not yet, `fix` not run. */
const RUN_THREE = demoNote({
  state: "needs-approval",
  endedAt: undefined,
  steps: [
    step("collect", { kind: "run", state: "ok", next: "draft", durationMs: 400 }),
    step("draft", { state: "ok", next: "review", retry: 1, durationMs: 18_200 }),
    step("review", {
      state: "ok",
      next: "confirm",
      onFail: { goto: "fix", max: 2, taken: 0 },
      durationMs: 9_600,
    }),
    step("fix", { state: "pending", next: "review" }),
    step("confirm", { kind: "approve", state: "needs-approval", next: "archive" }),
    step("archive", { kind: "run", state: "pending", next: null }),
  ],
  history: [
    { step: "collect", attempt: 0, round: 0, state: "ok", durationMs: 400 },
    { step: "draft", attempt: 0, round: 0, state: "ok", durationMs: 18_200 },
    { step: "review", attempt: 0, round: 0, state: "ok", durationMs: 9_600 },
  ],
});

/** Scenario ④: live, running `fix` after review failed; review→fix is the edge in flight. */
const RUN_FOUR = demoNote({
  state: "running",
  endedAt: undefined,
  steps: [
    step("collect", { kind: "run", state: "ok", next: "draft", durationMs: 400 }),
    step("draft", { state: "ok", next: "review", retry: 1, durationMs: 18_200 }),
    step("review", {
      state: "error",
      next: "confirm",
      round: 1,
      onFail: { goto: "fix", max: 2, taken: 1 },
      durationMs: 8_900,
    }),
    step("fix", { state: "running", round: 1, next: "review", live: "edit notes/demo-note.md" }),
    step("confirm", { kind: "approve", state: "pending", next: "archive" }),
    step("archive", { kind: "run", state: "pending", next: null }),
  ],
  history: [
    { step: "collect", attempt: 0, round: 0, state: "ok", durationMs: 400 },
    { step: "draft", attempt: 0, round: 0, state: "ok", durationMs: 18_200 },
    { step: "review", attempt: 0, round: 1, state: "error", durationMs: 8_900 },
  ],
});

const phaseOf = (p: WorkflowProjection, id: string): string | undefined =>
  p.steps.find((s) => s.id === id)?.phase;

const traceOf = (
  p: WorkflowProjection,
  kind: string,
  from: string,
  to: string,
): string | undefined =>
  p.edges.find((e) => e.kind === kind && e.from === from && e.to === to)?.trace;

describe("runProjection — phases", () => {
  test("① an ended run's never-run step is skipped, never later (the d1b5faaa bug)", () => {
    const p = runProjection(RUN_ONE);
    expect(phaseOf(p, "fix")).toBe("skipped");
    expect(phaseOf(p, "collect")).toBe("ok");
    expect(p.live).toBe(false);
    // The root cause in one line: `pending` + an ENDED run can never be "not yet".
    expect(p.steps.filter((s) => s.phase === "later")).toEqual([]);
  });

  test("② the goto's target ran, so it is ok on both sides", () => {
    const p = runProjection(RUN_TWO);
    expect(phaseOf(p, "fix")).toBe("ok");
    expect(phaseOf(p, "review")).toBe("ok");
  });

  test("③ live: the unreachable fix is skipped, the reachable archive is later", () => {
    const p = runProjection(RUN_THREE);
    expect(p.live).toBe(true);
    expect(phaseOf(p, "confirm")).toBe("ask");
    expect(phaseOf(p, "archive")).toBe("later");
    expect(phaseOf(p, "fix")).toBe("skipped");
  });

  test("④ live: review failed, its goto is still possible, so fix is running and confirm later", () => {
    const p = runProjection(RUN_FOUR);
    expect(phaseOf(p, "review")).toBe("error");
    expect(phaseOf(p, "fix")).toBe("running");
    expect(phaseOf(p, "confirm")).toBe("later");
    expect(phaseOf(p, "archive")).toBe("later");
  });

  test("an unknown wire word is kept verbatim as its own phase", () => {
    const row = demoNote({ state: "invented", endedAt: undefined }, [
      step("merge", { state: "queued" }),
    ]);
    const p = runProjection(row);
    expect(phaseOf(p, "merge")).toBe("unknown");
    expect(p.steps[0]?.word).toBe("queued");
  });

  test("a cancelled run: the cut step is stopped, the rest not run", () => {
    const row = demoNote({ state: "stopped", stopReason: "cancelled" }, [
      step("collect", { kind: "run", state: "ok", next: "draft" }),
      step("draft", { state: "stopped", next: "review" }),
      step("review", { state: "pending", next: "confirm" }),
      step("confirm", { kind: "approve", state: "pending", next: "archive" }),
      step("archive", { kind: "run", state: "pending", next: null }),
    ]);
    const p = runProjection(row);
    expect(phaseOf(p, "draft")).toBe("stopped");
    expect(phaseOf(p, "review")).toBe("skipped");
    expect(phaseOf(p, "archive")).toBe("skipped");
    expect(summary(p, 5_000).word).toBe("Stopped · cancelled");
  });
});

describe("runProjection — edge traces and chips", () => {
  test("① every pass edge was taken, the goto and the retry never", () => {
    const p = runProjection(RUN_ONE);
    expect(traceOf(p, "next", "collect", "draft")).toBe("taken");
    expect(traceOf(p, "next", "review", "confirm")).toBe("taken");
    expect(traceOf(p, "fail", "review", "fix")).toBe("never");
    expect(traceOf(p, "retry", "draft", "draft")).toBe("never");
  });

  test("② the goto and the retry were taken, with their chips", () => {
    const p = runProjection(RUN_TWO);
    expect(traceOf(p, "fail", "review", "fix")).toBe("taken");
    expect(traceOf(p, "next", "fix", "review")).toBe("taken");
    expect(traceOf(p, "retry", "draft", "draft")).toBe("taken");
    const goto = p.edges.find((e) => e.kind === "fail" && e.from === "review");
    expect(goto?.chip).toBe("✗ 1/2");
    const retry = p.edges.find((e) => e.kind === "retry" && e.from === "draft");
    expect(retry?.chip).toBe("↻ 1/1");
    expect(summary(p, 5_000).line2).toContain("1 loop");
  });

  test("③ review passed, so its goto can no longer fire: never, its target not run", () => {
    const p = runProjection(RUN_THREE);
    expect(traceOf(p, "next", "confirm", "archive")).toBe("later");
    expect(traceOf(p, "next", "review", "confirm")).toBe("taken");
    expect(traceOf(p, "fail", "review", "fix")).toBe("never");
  });

  test("④ the goto in flight is go, the pass edge it skipped is later", () => {
    const p = runProjection(RUN_FOUR);
    expect(traceOf(p, "fail", "review", "fix")).toBe("go");
    expect(traceOf(p, "next", "review", "confirm")).toBe("later");
    expect(traceOf(p, "next", "fix", "review")).toBe("later");
    expect(p.edges.find((e) => e.kind === "fail" && e.from === "review")?.chip).toBe("✗ 1/2");
  });

  test("a LIVE run whose goto is spent does not make its target 'not yet'", () => {
    // The plan's mutation target: drop the `taken < max` term from reachability and
    // the exhausted goto still reaches `fix`, which then reads "not yet" forever.
    const row = demoNote({ state: "error", endedAt: undefined }, [
      step("collect", { kind: "run", state: "ok", next: "review" }),
      step("review", {
        state: "error",
        next: "confirm",
        round: 2,
        maxRound: 2,
        onFail: { goto: "fix", max: 2, taken: 2 },
        reason: "review already ran 2/2 times",
      }),
      step("fix", { state: "pending", next: "review" }),
      step("confirm", { kind: "approve", state: "pending", next: null }),
    ]);
    const p = runProjection(row);
    expect(phaseOf(p, "fix")).toBe("skipped");
    expect(notRunWhy(p, "fix")?.text).toBe("Not run — the run went another way.");
  });

  test("an exhausted goto is taken and never possible again", () => {
    const row = demoNote({ state: "error" }, [
      step("collect", { kind: "run", state: "ok", next: "review" }),
      step("review", {
        state: "error",
        next: null,
        round: 2,
        maxRound: 2,
        onFail: { goto: "fix", max: 2, taken: 2 },
        reason: "review already ran 2/2 times",
      }),
      step("fix", { state: "ok", round: 2, next: "review" }),
    ]);
    const p = runProjection(row);
    const goto = p.edges.find((e) => e.kind === "fail" && e.from === "review");
    expect(goto?.trace).toBe("taken");
    expect(goto?.chip).toBe("✗ 2/2");
    // The target ran, so it is not "not run".
    expect(phaseOf(p, "fix")).toBe("ok");
    // ... and with the counter at max nothing downstream is "later" on an ended run anyway.
    expect(phaseOf(p, "review")).toBe("error");
  });
});

describe("notRunWhy — the sentences the owner approved", () => {
  test("① fix: only entered by a goto whose source passed first try", () => {
    const why = notRunWhy(runProjection(RUN_ONE), "fix");
    expect(why?.text).toBe("Not run — review passed on its first try.");
    expect(why?.small).toBe("fix runs only when review fails, up to 2 times.");
  });

  test("① a step that did run has no why", () => {
    expect(notRunWhy(runProjection(RUN_ONE), "review")).toBeNull();
  });

  test("the run stopped before a step: it ended at the cut step", () => {
    const row = demoNote({ state: "stopped", stopReason: "timeout" }, [
      step("collect", { kind: "run", state: "ok", next: "draft" }),
      step("draft", { state: "stopped", next: "review" }),
      step("review", { state: "pending", next: "confirm" }),
    ]);
    expect(notRunWhy(runProjection(row), "review")?.text).toBe("Not run — the run ended at draft.");
  });

  test("a source that passed on a later round is not called a first try", () => {
    const row = demoNote({}, [
      step("review", {
        state: "ok",
        round: 2,
        next: "confirm",
        onFail: { goto: "fix", max: 2, taken: 1 },
      }),
      step("confirm", { kind: "approve", state: "ok", next: null }),
      step("fix", { state: "pending", next: "review" }),
    ]);
    const why = notRunWhy(runProjection(row), "fix");
    expect(why?.text).toBe("Not run — review passed on round 2.");
    expect(why?.small).toBe("fix runs only when review fails, up to 2 times.");
  });

  test("no goto at all, unreachable: the fallback sentence", () => {
    const row = demoNote({ state: "ok" }, [
      step("collect", { kind: "run", state: "ok", next: null }),
      step("draft", { state: "pending", next: null }),
    ]);
    expect(notRunWhy(runProjection(row), "draft")?.text).toBe(
      "Not run — the run went another way.",
    );
  });
});

describe("timeline — view B", () => {
  test("② every visit in order, then nothing left", () => {
    const t = timeline(runProjection(RUN_TWO));
    expect(t.rows.map((r) => `${r.step}:${r.phase}:${r.meta}`)).toEqual([
      "collect:ok:done",
      "draft:error:failed · try 1",
      "draft:ok:done · try 2",
      "review:error:failed · round 1 → fix",
      "fix:ok:done · round 1",
      "review:ok:done · round 2",
      "confirm:ok:approved",
      "archive:ok:done",
    ]);
    expect(t.next).toEqual([]);
    expect(t.notRun).toEqual([]);
  });

  test("③ the visit so far, then Next, then Not run — each with its why", () => {
    const t = timeline(runProjection(RUN_THREE));
    expect(t.rows.map((r) => r.step)).toEqual(["collect", "draft", "review", "confirm"]);
    expect(t.rows.at(-1)?.meta).toBe("needs you");
    expect(t.next.map((r) => `${r.step}:${r.meta}`)).toEqual(["archive:after confirm"]);
    expect(t.notRun.map((r) => r.step)).toEqual(["fix"]);
    expect(t.notRun[0]?.why?.text).toBe("Not run — review passed on its first try.");
  });

  test("① the whole run, and its unused branch in the tail", () => {
    const t = timeline(runProjection(RUN_ONE));
    expect(t.rows.map((r) => r.step)).toEqual(["collect", "draft", "review", "confirm", "archive"]);
    expect(t.notRun.map((r) => r.step)).toEqual(["fix"]);
  });

  test("a capped history says how many earlier visits it is not showing", () => {
    const row = demoNote({ historyDropped: 3 }, [
      step("collect", { kind: "run", state: "ok", next: null }),
    ]);
    const t = timeline(
      runProjection({
        ...row,
        history: [{ step: "collect", attempt: 0, round: 0, state: "ok" }],
      }),
    );
    expect(t.droppedNote).toBe("3 earlier steps not shown");
  });

  test("a 64-step chain projects without a cycle or a duplicate", () => {
    const steps = Array.from({ length: 64 }, (_, i) =>
      step(`s${i}`, {
        kind: "run",
        state: i === 0 ? "ok" : "pending",
        next: i === 63 ? null : `s${i + 1}`,
      }),
    );
    const p = runProjection(demoNote({ state: "ok" }, steps));
    expect(p.steps).toHaveLength(64);
    expect(p.edges.filter((e) => e.kind === "next")).toHaveLength(63);
    expect(p.steps.filter((s) => s.phase === "skipped")).toHaveLength(63);
  });
});

describe("summary — the top strip", () => {
  test("① done, the total time, the tokens and how many steps ran", () => {
    const s = summary(runProjection(RUN_ONE), 999_000);
    expect(s.phase).toBe("ok");
    expect(s.word).toBe("Done");
    expect(s.time).toBe("36s");
    expect(s.line2).toBe("21.4k tokens · 5 of 6 steps ran");
  });

  test("② one loop counted from the goto's own counter", () => {
    expect(summary(runProjection(RUN_TWO), 0).line2).toBe(
      "41.7k tokens · 6 of 6 steps ran · 1 loop",
    );
  });

  test("③ live: tokens so far and which step it is on", () => {
    const s = summary(runProjection(RUN_THREE), 73_000);
    expect(s.phase).toBe("ask");
    expect(s.word).toBe("Needs approval");
    expect(s.time).toBe("1m 12s");
    expect(s.line2).toBe("21.4k tokens so far · step 5 of 6");
  });

  test("a budget is stated as a budget, an unknown run word kept verbatim", () => {
    const row = demoNote({ state: "invented", budget: 40_000, endedAt: 61_000 });
    const s = summary(runProjection(row), 0);
    expect(s.word).toBe("invented");
    expect(s.phase).toBe("unknown");
    expect(s.line2).toBe("21.4k of 40k tokens · 5 of 6 steps ran");
  });
});

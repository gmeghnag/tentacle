import { describe, expect, test } from "bun:test";
import type { KnownLogEntry } from "@tentacle/protocol";
import type { ChatMessage } from "../src/model.ts";
import {
  type CarriedUnitEntry,
  WORK_UNIT_MAX_ENDED,
  WORK_UNIT_REASON_MAX_CHARS,
  WORK_UNIT_RESULTS_BUDGET_CHARS,
  WORK_UNIT_RESULT_MAX_CHARS,
  type WorkUnit,
  boundEndedUnits,
  turnResult,
  unifyTurn,
  unifyWorkflow,
  unitEndBody,
  unitsFromSegment,
} from "../src/work-unit.ts";

type Entry = KnownLogEntry | CarriedUnitEntry;
type Body = Record<string, unknown> & { type: string };

/** A segment: each body gets `seq`/`id`/`ts` (ts = 1000 + its index). */
function segment(...bodies: Body[]): Entry[] {
  return bodies.map((b, i) => ({ seq: i + 1, id: `i/${i + 1}`, ts: 1000 + i, ...b }) as never);
}
const base = (count = 0, turn?: string): Body => ({
  type: "base",
  critical: true,
  inc: "i",
  reason: "create",
  count,
  ...(turn !== undefined ? { turn } : {}),
});
const msg = (role: ChatMessage["role"], content: string, extra: object = {}): Body => ({
  type: "message",
  critical: true,
  message: { role, content, ...extra },
});
const calls = [{ id: "c1", name: "run", arguments: "{}" }];
const start = (turnId: string): Body => ({ type: "turn_start", turnId });
const end = (turnId: string, stopReason = "end_turn"): Body => ({
  type: "turn_end",
  turnId,
  stopReason,
});
const wfStart = (runId: string, turnId?: string): Body => ({
  type: "workflow_start",
  runId,
  name: "n",
  version: 1,
  hash: "a".repeat(64),
  path: "p",
  inputs: [],
  by: "user",
  ...(turnId !== undefined ? { turnId } : {}),
});
const wfStep = (runId: string, report?: string): Body => ({
  type: "workflow_step",
  runId,
  stepId: "s",
  attempt: 0,
  round: 0,
  state: "ok",
  reason: "",
  where: "local",
  tokens: 0,
  durationMs: 0,
  ...(report !== undefined ? { report } : {}),
});
const wfEnd = (runId: string, state: string, stopReason?: string, reason = "done"): Body => ({
  type: "workflow_end",
  runId,
  state,
  reason,
  ...(stopReason !== undefined ? { stopReason } : {}),
});
const unit = (id: string, over: Partial<WorkUnit> = {}): WorkUnit => ({
  kind: "turn",
  id,
  state: "completed",
  native: "end_turn",
  endedAt: 1,
  ...over,
});
const carried = (u: WorkUnit): Body => ({ type: "unit_end", critical: false, ...unitEndBody(u) });

describe("unifyTurn (native → unified, row by row)", () => {
  const rows: [string, string, string | undefined][] = [
    ["end_turn", "completed", undefined],
    ["max_tokens", "completed", "stopped: max_tokens"],
    ["max_iterations", "completed", "stopped: max_iterations"],
    ["max_token_budget", "completed", "stopped: max_token_budget"],
    ["cancelled", "canceled", undefined],
    ["error", "failed", "the turn failed"],
    // A newer build's word never breaks a reader.
    ["paused_by_moon", "failed", "ended: paused_by_moon"],
  ];
  for (const [stopReason, state, reason] of rows) {
    test(`${stopReason} → ${state}`, () => {
      const got = unifyTurn({ turnId: "t", stopReason, endedAt: 5 });
      expect(got.state).toBe(state as never);
      expect(got.native).toBe(stopReason);
      expect(got.reason).toBe(reason as never);
      expect(got.waitingFor).toBeUndefined();
    });
  }

  test("open: working; a pending ask → waiting:permission", () => {
    expect(unifyTurn({ turnId: "t" })).toEqual({
      kind: "turn",
      id: "t",
      state: "working",
      native: "running",
    });
    expect(unifyTurn({ turnId: "t", asking: true })).toMatchObject({
      state: "waiting",
      waitingFor: "permission",
    });
  });

  test("an ended turn is never waiting, whatever the ask flag says", () => {
    const got = unifyTurn({ turnId: "t", stopReason: "cancelled", asking: true });
    expect(got.state).toBe("canceled");
    expect(got.waitingFor).toBeUndefined();
  });
});

describe("unifyWorkflow (native → unified, row by row)", () => {
  type Row = [string, string | undefined, boolean, string, string | undefined, string];
  const rows: Row[] = [
    // state, stopReason, ended, unified, waitingFor, native
    ["needs-approval", undefined, false, "waiting", "approval", "needs-approval"],
    ["waiting", undefined, false, "waiting", "permission", "waiting"],
    ["running", undefined, false, "working", undefined, "running"],
    ["ok", undefined, true, "completed", undefined, "ok"],
    ["error", undefined, true, "failed", undefined, "error"],
    ["stopped", "cancelled", true, "canceled", undefined, "stopped:cancelled"],
    ["stopped", "budget", true, "failed", undefined, "stopped:budget"],
    ["stopped", "timeout", true, "failed", undefined, "stopped:timeout"],
    ["stopped", "interrupted", true, "failed", undefined, "stopped:interrupted"],
    ["stopped", "changed", true, "failed", undefined, "stopped:changed"],
    ["stopped", undefined, true, "failed", undefined, "stopped"],
    ["stopped", "some_new_why", true, "failed", undefined, "stopped:some_new_why"],
    ["dancing", undefined, false, "working", undefined, "dancing"],
    ["dancing", undefined, true, "failed", undefined, "dancing"],
    // A non-terminal word on an ended run is not "still working".
    ["running", undefined, true, "failed", undefined, "running"],
    ["constructor", undefined, false, "working", undefined, "constructor"],
  ];
  for (const [state, stopReason, ended, unified, waitingFor, native] of rows) {
    test(`${native}${ended ? " (ended)" : ""} → ${unified}`, () => {
      const got = unifyWorkflow({
        runId: "wf-1",
        state,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(ended ? { endedAt: 9 } : {}),
      });
      expect(got.state).toBe(unified as never);
      expect(got.waitingFor).toBe(waitingFor as never);
      expect(got.native).toBe(native);
    });
  }

  test("reason: the machine's sentence on one line; a failure without one names its word", () => {
    const got = unifyWorkflow({
      runId: "wf-1",
      origin: "task-1",
      state: "stopped",
      stopReason: "budget",
      reason: "over\n  budget",
      endedAt: 2,
    });
    expect(got.reason).toBe("over budget");
    expect(got.origin).toBe("task-1");
    const bare = unifyWorkflow({
      runId: "wf-1",
      state: "stopped",
      stopReason: "budget",
      endedAt: 2,
    });
    expect(bare.reason).toBe("ended: stopped:budget");
  });

  test("reason is capped", () => {
    const got = unifyWorkflow({
      runId: "wf-1",
      state: "error",
      reason: "x".repeat(WORK_UNIT_REASON_MAX_CHARS * 2),
      endedAt: 1,
    });
    expect(got.reason?.length).toBeLessThanOrEqual(WORK_UNIT_REASON_MAX_CHARS);
  });
});

describe("turnResult (the final round only)", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: "previous turn's answer" },
    { role: "user", content: "go" },
    { role: "assistant", content: "let me check", toolCalls: calls },
    { role: "tool", content: "ok", toolCallId: "c1" },
    { role: "assistant", content: "done: 42" },
  ];

  test("the last assistant message of the span, never earlier rounds", () => {
    expect(turnResult(history, { from: 1, to: 5 })).toBe("done: 42");
  });

  test("a final round without text has no result (not the previous round's preamble)", () => {
    const silent: ChatMessage[] = [...history, { role: "assistant", content: "" }];
    expect(turnResult(silent, { from: 1, to: 6 })).toBeUndefined();
  });

  test("no assistant message in the span: nothing from before it", () => {
    expect(turnResult(history, { from: 1, to: 2 })).toBeUndefined();
    expect(turnResult(history, { from: 5, to: 5 })).toBeUndefined();
  });

  test("a span past the history is clamped", () => {
    expect(turnResult(history, { from: -3, to: 99 })).toBe("done: 42");
  });

  test("capped at the per-result bound", () => {
    const big: ChatMessage[] = [
      { role: "assistant", content: "y".repeat(WORK_UNIT_RESULT_MAX_CHARS * 3) },
    ];
    expect(turnResult(big, { from: 0, to: 1 })?.length).toBeLessThanOrEqual(
      WORK_UNIT_RESULT_MAX_CHARS,
    );
  });
});

describe("unitsFromSegment — native entries", () => {
  test("two turns: each has its own final round, stamps and state", () => {
    const { ended, open } = unitsFromSegment(
      segment(
        base(),
        start("t1"),
        msg("user", "a"),
        msg("assistant", "first"),
        end("t1"),
        start("t2"),
        msg("user", "b"),
        end("t2", "cancelled"),
      ),
    );
    expect(open).toEqual([]);
    expect(ended).toEqual([
      {
        kind: "turn",
        id: "t1",
        state: "completed",
        native: "end_turn",
        startedAt: 1001,
        endedAt: 1004,
        result: "first",
      },
      {
        kind: "turn",
        id: "t2",
        state: "canceled",
        native: "cancelled",
        startedAt: 1005,
        endedAt: 1007,
      },
    ]);
  });

  test("a turn with no end is open, never a phantom success", () => {
    const { ended, open } = unitsFromSegment(
      segment(base(), start("t1"), msg("user", "a"), msg("assistant", "partial")),
    );
    expect(ended).toEqual([]);
    expect(open).toEqual([
      { kind: "turn", id: "t1", state: "working", native: "running", startedAt: 1001 },
    ]);
  });

  test("the result is read where the turn ended: a later replace does not rewrite it", () => {
    const { ended } = unitsFromSegment(
      segment(base(), start("t1"), msg("assistant", "answer"), end("t1"), {
        type: "replace",
        critical: true,
        index: 0,
        message: { role: "assistant", content: "rewritten later" },
      }),
    );
    expect(ended[0]?.result).toBe("answer");
  });

  test("a segment cut mid-turn (base.turn): the span starts after the base's messages", () => {
    const bodies = [base(2, "t1"), msg("user", "summary"), msg("assistant", "carried history")];
    expect(unitsFromSegment(segment(...bodies)).open.map((u) => u.id)).toEqual(["t1"]);
    // No new assistant round: the base's text is not this turn's answer.
    expect(unitsFromSegment(segment(...bodies, end("t1"))).ended[0]?.result).toBeUndefined();
    const answered = unitsFromSegment(segment(...bodies, msg("assistant", "final"), end("t1")));
    expect(answered.ended[0]).toMatchObject({ id: "t1", state: "completed", result: "final" });
    expect(answered.open).toEqual([]);
  });

  test("an end with neither a start nor base.turn: the unit, but no result to attribute", () => {
    const { ended } = unitsFromSegment(
      segment(base(1), msg("assistant", "whose?"), end("t9", "error")),
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ id: "t9", state: "failed" });
    expect(ended[0]?.result).toBeUndefined();
  });

  test("a workflow run: origin, end reason + the LAST step report as its result", () => {
    const { ended, open } = unitsFromSegment(
      segment(
        base(),
        wfStart("wf-1", "task-1"),
        wfStep("wf-1", "report one"),
        wfStep("wf-1", "report two"),
        wfEnd("wf-1", "ok", undefined, "all steps passed"),
        wfStart("wf-2"),
      ),
    );
    expect(ended).toEqual([
      {
        kind: "workflow",
        id: "wf-1",
        origin: "task-1",
        state: "completed",
        native: "ok",
        reason: "all steps passed",
        startedAt: 1001,
        endedAt: 1004,
        result: "all steps passed\n\nreport two",
      },
    ]);
    expect(open).toEqual([
      { kind: "workflow", id: "wf-2", state: "working", native: "running", startedAt: 1005 },
    ]);
  });

  test("a rerun of an ended run (same id) is open again, without the old report", () => {
    const bodies = [
      base(),
      wfStart("wf-1", "task-1"),
      wfStep("wf-1", "old report"),
      wfEnd("wf-1", "stopped", "cancelled"),
      wfStart("wf-1", "task-2"),
    ];
    const rerun = unitsFromSegment(segment(...bodies));
    expect(rerun.ended).toEqual([]);
    expect(rerun.open[0]).toMatchObject({ id: "wf-1", origin: "task-2" });
    const done = unitsFromSegment(segment(...bodies, wfEnd("wf-1", "ok", undefined, "fine")));
    expect(done.ended[0]?.result).toBe("fine");
  });

  test("a step or end without its start closes nothing", () => {
    expect(unitsFromSegment(segment(base(), wfStep("wf-7", "x"), wfEnd("wf-7", "ok")))).toEqual({
      ended: [],
      open: [],
    });
  });

  test("a turn and a run with the same id string stay two units", () => {
    const { ended } = unitsFromSegment(
      segment(base(), start("wf-1"), end("wf-1"), wfStart("wf-1"), wfEnd("wf-1", "ok")),
    );
    expect(ended.map((u) => u.kind)).toEqual(["turn", "workflow"]);
  });
});

describe("unitsFromSegment — carried unit_end entries", () => {
  const turn = unit("t0", { startedAt: 1, endedAt: 2, result: "old answer" });
  const run: WorkUnit = {
    kind: "workflow",
    id: "wf-1",
    origin: "task-1",
    state: "failed",
    native: "stopped:budget",
    reason: "over budget",
    startedAt: 3,
    endedAt: 4,
    resultDropped: true,
  };

  test("carries round-trip to the identical unit", () => {
    expect(unitsFromSegment(segment(base(), carried(turn), carried(run)))).toEqual({
      ended: [turn, run],
      open: [],
    });
  });

  test("a native derivation survives carry after carry unchanged", () => {
    const native = unitsFromSegment(
      segment(base(), start("t1"), msg("assistant", "r"), end("t1", "max_tokens")),
    ).ended;
    const again = unitsFromSegment(segment(base(), ...native.map(carried))).ended;
    const twice = unitsFromSegment(segment(base(), ...again.map(carried))).ended;
    expect(twice).toEqual(native);
  });

  test("a carried unit and a native one in one segment, in end order", () => {
    const { ended } = unitsFromSegment(
      segment(base(), carried(turn), start("t1"), msg("assistant", "new"), end("t1")),
    );
    expect(ended.map((u) => [u.id, u.result])).toEqual([
      ["t0", "old answer"],
      ["t1", "new"],
    ]);
  });

  test("unknown words from a newer build never break the reader", () => {
    const { ended } = unitsFromSegment(
      segment(
        base(),
        { ...carried(turn), unitId: "a", state: "exploded", native: "weird" },
        // A carried unit is ENDED: a non-terminal word cannot make it "working".
        { ...carried(turn), unitId: "b", state: "working" },
        // A kind this build does not know is skipped.
        { ...carried(turn), unitId: "c", kind: "subagent" },
      ),
    );
    expect(ended.map((u) => [u.id, u.state, u.native])).toEqual([
      ["a", "failed", "weird"],
      ["b", "failed", "end_turn"],
    ]);
  });

  test("unitEndBody caps every text and refuses an open unit", () => {
    const body = unitEndBody(
      unit("t", {
        reason: "r".repeat(WORK_UNIT_REASON_MAX_CHARS * 2),
        result: "s".repeat(WORK_UNIT_RESULT_MAX_CHARS * 2),
      }),
    );
    expect(body.reason?.length).toBeLessThanOrEqual(WORK_UNIT_REASON_MAX_CHARS);
    expect(body.result?.length).toBeLessThanOrEqual(WORK_UNIT_RESULT_MAX_CHARS);
    expect(() =>
      unitEndBody({ kind: "turn", id: "t", state: "working", native: "running" }),
    ).toThrow("not ended");
  });
});

describe("bounds", () => {
  test(`the ${WORK_UNIT_MAX_ENDED + 1}th ended unit drops the oldest`, () => {
    const many = Array.from({ length: WORK_UNIT_MAX_ENDED + 1 }, (_, i) => unit(`t${i}`));
    const kept = boundEndedUnits(many);
    expect(kept).toHaveLength(WORK_UNIT_MAX_ENDED);
    expect(kept[0]?.id).toBe("t1");
    expect(kept.at(-1)?.id).toBe(`t${WORK_UNIT_MAX_ENDED}`);
  });

  test("the result budget is spent newest first; over budget keeps state and reason", () => {
    const fits = WORK_UNIT_RESULTS_BUDGET_CHARS / WORK_UNIT_RESULT_MAX_CHARS;
    const many = Array.from({ length: fits + 2 }, (_, i) =>
      unit(`t${i}`, { result: "z".repeat(WORK_UNIT_RESULT_MAX_CHARS), reason: "why" }),
    );
    const kept = boundEndedUnits(many);
    expect(kept).toHaveLength(fits + 2);
    for (const old of kept.slice(0, 2)) {
      expect(old.result).toBeUndefined();
      expect(old).toMatchObject({ resultDropped: true, state: "completed", reason: "why" });
    }
    expect(kept.slice(2).every((u) => u.result !== undefined && !u.resultDropped)).toBe(true);
    // Idempotent: the table is bounded again at every carry.
    expect(boundEndedUnits(kept)).toEqual(kept);
  });

  test("unitsFromSegment applies both bounds", () => {
    const bodies: Body[] = [base()];
    for (let i = 0; i <= WORK_UNIT_MAX_ENDED; i++) {
      bodies.push(start(`t${i}`), msg("assistant", "z".repeat(2048)), end(`t${i}`));
    }
    const { ended } = unitsFromSegment(segment(...bodies));
    expect(ended).toHaveLength(WORK_UNIT_MAX_ENDED);
    expect(ended[0]?.id).toBe("t1");
    const total = ended.reduce((n, u) => n + (u.result?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(WORK_UNIT_RESULTS_BUDGET_CHARS);
    expect(ended[0]?.resultDropped).toBe(true);
    expect(ended.at(-1)?.result?.length).toBe(2048);
  });
});

import { describe, expect, test } from "bun:test";
import {
  Method,
  RequestSchemas,
  SnapshotResultSchema,
  UPDATE_CLASS,
  WorkflowParamsSchema,
  isKnownUpdateType,
  isMethodName,
} from "../src/index.ts";

// docs/feat/agent-workflows.md Slice 3 (D5): the wire of workflow runs — one
// display update, an optional snapshot field, two additive methods.

const row = {
  runId: "wf-2",
  name: "task",
  version: 1,
  hash: "0".repeat(64),
  state: "stopped",
  stopReason: "timeout",
  reason: "a step's ask waited 12h",
  tokens: 0,
  startedAt: 5,
  endedAt: 9,
  steps: [{ id: "merge", kind: "approve", where: "local", state: "stopped", attempt: 0, round: 0 }],
};

describe("workflow wire", () => {
  test("`workflows` is a known DISPLAY update (an older client skips it, nothing hangs)", () => {
    expect(isKnownUpdateType("workflows")).toBe(true);
    expect(UPDATE_CLASS.workflows).toBe("display");
  });

  test("the snapshot carries the runs; absent stays absent (an older daemon)", () => {
    const withRuns = SnapshotResultSchema.safeParse({ messages: [], workflows: [row] });
    expect(withRuns.success && withRuns.data.workflows).toEqual([row]);
    const without = SnapshotResultSchema.safeParse({ messages: [] });
    expect(without.success && without.data.workflows).toBeUndefined();
  });

  test("session/workflow and workflow/list are registered request methods", () => {
    expect(Method.Workflow).toBe("session/workflow");
    expect(Method.WorkflowList).toBe("workflow/list");
    expect(isMethodName("session/workflow")).toBe(true);
    expect(isMethodName("workflow/list")).toBe(true);
    expect(RequestSchemas[Method.Workflow].params).toBe(WorkflowParamsSchema);
    const list = RequestSchemas[Method.WorkflowList].result.safeParse({
      runs: [
        {
          sessionId: "s",
          runId: "wf-1",
          name: "task",
          state: "needs-approval",
          step: "merge",
          done: 6,
          total: 7,
          needsUser: true,
          startedAt: 1,
        },
      ],
    });
    expect(list.success).toBe(true);
  });

  test("session/workflow params: a start needs a turn id; a bad run id / name is refused", () => {
    const ok = (p: unknown) => WorkflowParamsSchema.safeParse(p).success;
    expect(
      ok({
        sessionId: "s",
        action: "start",
        name: "task",
        inputs: [{ name: "slug", value: "x" }],
        turnId: "t1",
      }),
    ).toBe(true);
    expect(ok({ sessionId: "s", action: "start", name: "task" })).toBe(false);
    expect(ok({ sessionId: "s", action: "start", name: "../etc", turnId: "t1" })).toBe(false);
    expect(ok({ sessionId: "s", action: "stop", runId: "wf-1" })).toBe(true);
    expect(ok({ sessionId: "s", action: "stop", runId: "sa-1" })).toBe(false);
    expect(ok({ sessionId: "s", action: "resume", runId: "wf-1", turnId: "t2" })).toBe(true);
    expect(
      ok({ sessionId: "s", action: "rerun_step", runId: "wf-1", stepId: "gate", turnId: "t3" }),
    ).toBe(true);
    expect(ok({ sessionId: "s", action: "explode", runId: "wf-1" })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  Method,
  RequestSchemas,
  SnapshotResultSchema,
  UPDATE_CLASS,
  WorkflowCatalogueParamsSchema,
  WorkflowCatalogueResultSchema,
  WorkflowParamsSchema,
  WorkflowResultSchema,
  WorkflowStepParamsSchema,
  WorkflowStepResultSchema,
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

// docs/feat/workflows-ui.md slice 1a (D1): one step execution's detail — an
// ADDITIVE display-adjacent read, so no PROTOCOL_VERSION note is due.
describe("session/workflow_step", () => {
  test("is a registered request method, with its own param/result schemas", () => {
    expect(Method.WorkflowStep).toBe("session/workflow_step");
    expect(isMethodName("session/workflow_step")).toBe(true);
    expect(RequestSchemas[Method.WorkflowStep].params).toBe(WorkflowStepParamsSchema);
    expect(RequestSchemas[Method.WorkflowStep].result).toBe(WorkflowStepResultSchema);
  });

  test("params: a bad run id / step id / negative attempt is refused", () => {
    // Mutation: drop `nonnegative()` → the `attempt: -1` case goes green.
    const ok = (p: unknown) => WorkflowStepParamsSchema.safeParse(p).success;
    expect(ok({ sessionId: "s", runId: "wf-1", stepId: "plan" })).toBe(true);
    expect(ok({ sessionId: "s", runId: "wf-1", stepId: "plan", attempt: 0, round: 2 })).toBe(true);
    expect(ok({ sessionId: "s", runId: "sa-1", stepId: "plan" })).toBe(false);
    expect(ok({ sessionId: "s", runId: "wf-1", stepId: "Not A Step" })).toBe(false);
    expect(ok({ sessionId: "s", runId: "wf-1", stepId: "plan", attempt: -1 })).toBe(false);
    expect(ok({ sessionId: "s", runId: "wf-1", stepId: "plan", round: 1.5 })).toBe(false);
  });

  test("a result with NO detail is valid (the 'not available' answer)", () => {
    expect(WorkflowStepResultSchema.safeParse({}).success).toBe(true);
  });

  test("a detail round-trips, and a display field is bounded exactly as the log caps it", () => {
    const detail = {
      attempt: 1,
      round: 0,
      live: false,
      state: "ok",
      verdict: "pass",
      reason: "planned",
      prompt: "plan it",
      report: "the report",
      tokens: 12,
      durationMs: 34,
    };
    const parsed = WorkflowStepResultSchema.safeParse({ detail });
    expect(parsed.success && parsed.data.detail).toEqual(detail);
    // `reason` is the LOG's cap (2 KiB), not a fresh number of its own.
    const big = { ...detail, reason: "x".repeat(2 * 1024 + 1) };
    expect(WorkflowStepResultSchema.safeParse({ detail: big }).success).toBe(false);
    // A free word stays a free word (a newer daemon's state is not refused).
    const newer = { ...detail, state: "paused-by-daemon" };
    expect(WorkflowStepResultSchema.safeParse({ detail: newer }).success).toBe(true);
  });
});

// docs/feat/workflows-ui.md slice 5a (D6): the catalogue, plus the two ADDITIVE
// fields on the existing start/result (`hash`, `refusal`) — neither moves
// PROTOCOL_VERSION (an older peer drops an unknown field, and an older daemon
// answers `MethodNotFound`).
describe("session/workflow_catalogue + start{hash}", () => {
  test("the catalogue is a registered request method with its own schemas", () => {
    expect(Method.WorkflowCatalogue).toBe("session/workflow_catalogue");
    expect(isMethodName("session/workflow_catalogue")).toBe(true);
    expect(RequestSchemas[Method.WorkflowCatalogue].params).toBe(WorkflowCatalogueParamsSchema);
    expect(RequestSchemas[Method.WorkflowCatalogue].result).toBe(WorkflowCatalogueResultSchema);
    expect(WorkflowCatalogueParamsSchema.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(WorkflowCatalogueParamsSchema.safeParse({}).success).toBe(false);
  });

  test("a catalogue result round-trips: valid rows, an invalid row with its errors, the folder", () => {
    const result = {
      workflows: [
        {
          name: "task",
          path: ".tentacle/workflows/task.yaml",
          ok: true,
          version: 3,
          description: "does the thing",
          hash: "a".repeat(64),
          approved: false,
          inputs: [
            { name: "slug", required: true },
            { name: "note", required: false, default: "x" },
          ],
          steps: [{ id: "build", kind: "run", where: "local", command: "make test" }],
        },
        {
          name: "broken",
          path: ".tentacle/workflows/broken.yaml",
          ok: false,
          errors: ["steps[0].run: is not a command"],
        },
      ],
      dir: "/Users/me/proj/.tentacle/workflows",
      gitIgnored: false,
    };
    const parsed = WorkflowCatalogueResultSchema.safeParse(result);
    expect(parsed.success && parsed.data).toEqual(result);
  });

  test("the nullable-ish members: truncated is `true` only, `elsewhere` is display-only", () => {
    // Mutation: `truncated: z.boolean()` → the `false` case goes green and an
    // older client would show "truncated" beside a complete list.
    expect(
      WorkflowCatalogueResultSchema.safeParse({ workflows: [], dir: "/p", truncated: true })
        .success,
    ).toBe(true);
    expect(
      WorkflowCatalogueResultSchema.safeParse({ workflows: [], dir: "/p", truncated: false })
        .success,
    ).toBe(false);
    const elsewhere = {
      workflows: [],
      dir: "/Users/me/proj/apps/mobile/.tentacle/workflows",
      elsewhere: { dir: "/Users/me/proj/.tentacle/workflows", count: 3 },
    };
    const parsed = WorkflowCatalogueResultSchema.safeParse(elsewhere);
    expect(parsed.success && parsed.data.elsewhere).toEqual(elsewhere.elsewhere);
    // `unavailable` is a distinct answer from an empty folder, never a list.
    const unavailable = WorkflowCatalogueResultSchema.safeParse({
      workflows: [],
      dir: "/POD",
      unavailable: "workflows run only on a laptop or serve session",
    });
    expect(unavailable.success).toBe(true);
  });

  test("a row's caps hold (a pod-supplied label is cut daemon-side, not by the UI)", () => {
    const row = (extra: Record<string, unknown>) =>
      WorkflowCatalogueResultSchema.safeParse({
        workflows: [{ name: "t", path: "p", ok: true, ...extra }],
        dir: "/p",
      });
    expect(row({ errors: ["x".repeat(301)] }).success).toBe(false);
    expect(
      row({ steps: [{ id: "s", kind: "run", where: "local", command: "x".repeat(4097) }] }).success,
    ).toBe(false);
    expect(row({ hash: "not-a-hash" }).success).toBe(false);
    expect(row({}).success).toBe(true);
  });

  test("start takes an optional sha-256 `hash`; absent stays absent (today's behaviour)", () => {
    const start = (extra: Record<string, unknown>) =>
      WorkflowParamsSchema.safeParse({
        sessionId: "s",
        action: "start",
        name: "task",
        turnId: "t1",
        ...extra,
      });
    expect(start({ hash: "b".repeat(64) }).success).toBe(true);
    expect(start({}).success).toBe(true);
    expect(start({ hash: "short" }).success).toBe(false);
    // Only `start` carries it: stop / resume / rerun_step never pin a hash.
    expect(
      WorkflowParamsSchema.safeParse({
        sessionId: "s",
        action: "stop",
        runId: "wf-1",
        hash: "b".repeat(64),
      }).success,
    ).toBe(true);
  });

  test("the result carries an optional free-word `refusal`, and the run id it names", () => {
    const parsed = WorkflowResultSchema.safeParse({
      ok: false,
      refusal: "changed",
      runId: "wf-2",
      reason: "workflows/task.yaml changed since you opened it",
    });
    expect(parsed.success && parsed.data.refusal).toBe("changed");
    // A newer daemon's word is carried as sent (never an enum the UI rejects).
    const newer = WorkflowResultSchema.safeParse({ ok: false, refusal: "paused-by-policy" });
    expect(newer.success && newer.data.refusal).toBe("paused-by-policy");
    // …but it stays a bounded word: a sentence is not a refusal code.
    expect(WorkflowResultSchema.safeParse({ ok: false, refusal: "it changed!" }).success).toBe(
      false,
    );
    expect(WorkflowResultSchema.safeParse({ ok: true, runId: "wf-1" }).success).toBe(true);
  });
});

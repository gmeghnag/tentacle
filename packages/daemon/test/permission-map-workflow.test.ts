/**
 * docs/fix/mobile-ask-surfaces.md S1b (`permission-map.ts`, D1): the requester's
 * structured `workflow` reaches the wire — field by field, never by trust — and
 * an ask with none carries none. Each test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { PermissionRequestUpdateSchema, QuestionRequestUpdateSchema } from "@tentacle/protocol";
import {
  toAskUpdate,
  toPermissionRequestUpdate,
  toQuestionRequestUpdate,
} from "../src/permission-map.ts";

const req: PermissionRequest = { tool: "shell", level: "ask", title: "Run", input: {} };
const wf = { name: "rassegna", runId: "wf-1", stepId: "generate", index: 1, count: 5 };

describe("toPermissionRequestUpdate carries the workflow origin", () => {
  test("the five fields travel as given", () => {
    // Mutation: drop the new argument at a call site → absent here.
    const update = toPermissionRequestUpdate("r1", "c1", req, undefined, wf);
    expect(update.workflow).toEqual(wf);
    expect(PermissionRequestUpdateSchema.safeParse(update).success).toBe(true);
  });

  test("a name alone is a whole origin (a schedule approval has no run)", () => {
    const update = toPermissionRequestUpdate("r1", "c1", req, undefined, { name: "task" });
    expect(update.workflow).toEqual({ name: "task" });
    // Absent keys stay ABSENT: a `runId: undefined` would be a fabricated null.
    expect(Object.keys(update.workflow ?? {})).toEqual(["name"]);
  });

  test("absent stays absent: an ordinary ask is unchanged", () => {
    // Mutation: unconditional `workflow: {...}` → the key appears on every ask.
    const update = toPermissionRequestUpdate("r1", "c1", req);
    expect("workflow" in update).toBe(false);
  });

  test("built field by field: nothing a requester put beside the five keys reaches the wire", () => {
    // Mutation: `workflow: {...workflow}` → the extra key survives.
    const forged = { ...wf, trusted: true, kind: "main" } as unknown as typeof wf;
    const update = toPermissionRequestUpdate("r1", "c1", req, undefined, forged);
    expect(update.workflow).toEqual(wf);
    expect(Object.keys(update.workflow ?? {}).sort()).toEqual([
      "count",
      "index",
      "name",
      "runId",
      "stepId",
    ]);
  });

  test("a workflow whose name is not a string is dropped, never put on the blocking update", () => {
    // A pod-supplied payload: the schema would refuse it, and this update is
    // blocking (AGENTS §7) — so it is dropped here, and the ask still parses.
    const bad = { name: 42 } as unknown as typeof wf;
    const update = toPermissionRequestUpdate("r1", "c1", req, undefined, bad);
    expect("workflow" in update).toBe(false);
    expect(PermissionRequestUpdateSchema.safeParse(update).success).toBe(true);
  });

  test("hostile numbers and an over-long name still parse (display only, no bounds added here)", () => {
    // P1: the client bounds it. A `.max()`/`.int()` here would make a blocking
    // update unparseable — the ask would vanish, not truncate.
    const update = toPermissionRequestUpdate("r1", "c1", req, undefined, {
      ...wf,
      name: "x".repeat(10_000),
      index: 1.5,
      count: Number.MAX_SAFE_INTEGER,
    });
    expect(PermissionRequestUpdateSchema.safeParse(update).success).toBe(true);
  });
});

// docs/fix/a2a-question-workflow-label.md: a remote agent's QUESTION carries the
// same origin, through the same field-by-field builder.
const question: PermissionRequest = {
  kind: "question",
  tool: "a2a:acme",
  level: "ask",
  title: "acme asks",
  detail: "Remote question: which branch?",
  input: {},
  reply: { maxChars: 4000 },
};

describe("toQuestionRequestUpdate carries the workflow origin too", () => {
  test("the five fields travel as given", () => {
    // Mutation: the three-argument call in `toAskUpdate` (absent here) → red.
    const update = toQuestionRequestUpdate("r1", "c1", question, undefined, wf);
    expect(update.workflow).toEqual(wf);
    expect(QuestionRequestUpdateSchema.safeParse(update).success).toBe(true);
  });

  test("absent stays absent: a non-workflow question is unchanged", () => {
    // Mutation: an unconditional `workflow: {...}` → the key appears on every question.
    const update = toQuestionRequestUpdate("r1", "c1", question);
    expect("workflow" in update).toBe(false);
  });

  test("built field by field: a forged origin loses what it put beside the five keys", () => {
    // Mutation: `workflow: {...workflow}` → the extra key survives.
    const forged = { ...wf, trusted: true } as unknown as typeof wf;
    const update = toQuestionRequestUpdate("r1", "c1", question, undefined, forged);
    expect(update.workflow).toEqual(wf);
    // Mutation: no string-`name` test → a pod's non-string name reaches the wire.
    const bad = { name: 42 } as unknown as typeof wf;
    expect("workflow" in toQuestionRequestUpdate("r1", "c1", question, undefined, bad)).toBe(false);
  });

  test("toAskUpdate forwards it to BOTH branches", () => {
    // Mutation: `toQuestionRequestUpdate(requestId, toolCallId, req, agent)` → red
    // on the question half (this is repro line 1).
    const asQuestion = toAskUpdate("r-q", "c1", question, undefined, wf);
    expect(asQuestion.type).toBe("question_request");
    expect(asQuestion.workflow).toEqual(wf);
    const asApproval = toAskUpdate("r-p", "c1", req, undefined, wf);
    expect(asApproval.type).toBe("permission_request");
    expect(asApproval.workflow).toEqual(wf);
  });
});

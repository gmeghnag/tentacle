import { describe, expect, test } from "bun:test";
import * as protocol from "../src/index.ts";
import { Method, RequestSchemas, isMethodName } from "../src/index.ts";

// docs/feat/mobile-workflows-landing.md D1: two ADDITIVE methods. Neither moves
// PROTOCOL_VERSION (an older daemon answers `MethodNotFound`, which the client
// maps to `unsupported`), so there is no `protocol.d/` note.

const hash = "a".repeat(64);

/** Read through the namespace so a missing export is a red ASSERTION, not a load error. */
function schema(name: string): { safeParse(v: unknown): { success: boolean; data?: unknown } } {
  const found = (protocol as Record<string, unknown>)[name] as
    | { safeParse(v: unknown): { success: boolean; data?: unknown } }
    | undefined;
  expect(found).toBeDefined();
  return found ?? { safeParse: () => ({ success: false }) };
}

const parses = (name: string, value: unknown): boolean => schema(name).safeParse(value).success;

describe("session/workflow_approve + session/workflow_delete are registered methods", () => {
  test("both names, with their own param/result schemas", () => {
    const methods = Method as Record<string, string>;
    expect(methods.WorkflowApprove).toBe("session/workflow_approve");
    expect(methods.WorkflowDelete).toBe("session/workflow_delete");
    expect(isMethodName("session/workflow_approve")).toBe(true);
    expect(isMethodName("session/workflow_delete")).toBe(true);
    const registry = RequestSchemas as unknown as Record<
      string,
      { params: unknown; result: unknown } | undefined
    >;
    const exports = protocol as unknown as Record<string, unknown>;
    expect(registry["session/workflow_approve"]?.params).toBe(exports.WorkflowApproveParamsSchema);
    expect(registry["session/workflow_approve"]?.result).toBe(exports.WorkflowApproveResultSchema);
    expect(registry["session/workflow_delete"]?.params).toBe(exports.WorkflowDeleteParamsSchema);
    expect(registry["session/workflow_delete"]?.result).toBe(exports.WorkflowDeleteResultSchema);
    expect(RequestSchemas).toBeDefined();
  });
});

describe("session/workflow_approve", () => {
  const params = { sessionId: "s", name: "task", hash, turnId: "t1" };

  test("params: the hash the person SAW and a turn id are required", () => {
    const ok = (p: unknown) => parses("WorkflowApproveParamsSchema", p);
    expect(ok(params)).toBe(true);
    expect(ok({ sessionId: "s", name: "task", turnId: "t1" })).toBe(false);
    expect(ok({ sessionId: "s", name: "task", hash })).toBe(false);
    expect(ok({ ...params, hash: "abc" })).toBe(false);
    expect(ok({ ...params, name: "../etc" })).toBe(false);
  });

  test("params and result strip an unknown field (forward compatibility)", () => {
    expect(schema("WorkflowApproveParamsSchema").safeParse({ ...params, later: 1 }).data).toEqual(
      params,
    );
    expect(
      schema("WorkflowApproveResultSchema").safeParse({ ok: true, asked: true, later: 1 }).data,
    ).toEqual({ ok: true, asked: true });
  });

  test("result: asked / approved / a refusal word with its run", () => {
    const ok = (r: unknown) => parses("WorkflowApproveResultSchema", r);
    expect(ok({ ok: true, approved: true })).toBe(true);
    expect(ok({ ok: false, refusal: "running", reason: "wf-1 waits", runId: "wf-1" })).toBe(true);
    // A newer daemon's word is carried, never rejected.
    expect(ok({ ok: false, refusal: "some_new_word" })).toBe(true);
    expect(ok({ asked: true })).toBe(false);
    expect(ok({ ok: false, refusal: "NOT A WORD" })).toBe(false);
  });
});

describe("session/workflow_delete", () => {
  test("params: the hash is optional (a broken file has none) and never malformed", () => {
    const ok = (p: unknown) => parses("WorkflowDeleteParamsSchema", p);
    expect(ok({ sessionId: "s", name: "task", hash })).toBe(true);
    expect(ok({ sessionId: "s", name: "task" })).toBe(true);
    expect(ok({ sessionId: "s", name: "task", hash: "abc" })).toBe(false);
    expect(ok({ sessionId: "s", name: "../task" })).toBe(false);
    expect(ok({ name: "task" })).toBe(false);
  });

  test("result: the removed path and the schedules that still start it", () => {
    const result = { ok: true, path: ".tentacle/workflows/task.yaml", schedules: ["sc-1"] };
    expect(schema("WorkflowDeleteResultSchema").safeParse({ ...result, later: 1 }).data).toEqual(
      result,
    );
    expect(parses("WorkflowDeleteResultSchema", { ok: false, refusal: "gone" })).toBe(true);
  });
});

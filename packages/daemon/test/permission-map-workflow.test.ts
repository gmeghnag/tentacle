/**
 * docs/fix/mobile-ask-surfaces.md S1b (`permission-map.ts`, D1): the requester's
 * structured `workflow` reaches the wire — field by field, never by trust — and
 * an ask with none carries none. Each test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { PermissionRequestUpdateSchema } from "@tentacle/protocol";
import { toPermissionRequestUpdate } from "../src/permission-map.ts";

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

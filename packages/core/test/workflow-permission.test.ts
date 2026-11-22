import { describe, expect, test } from "bun:test";
import { type PermissionRequest, autoApproves } from "../src/permission.ts";

// docs/feat/agent-workflows.md D3 (decision 3): auto-accept answers a run's
// TOOL asks, never a `workflow_approve` (the hash approval and the approve step).
const ask = (kind?: PermissionRequest["kind"]): PermissionRequest => ({
  ...(kind !== undefined ? { kind } : {}),
  tool: kind === "workflow_approve" ? "workflow_approve" : "shell",
  level: "ask",
  title: "t",
  input: {},
});

describe("autoApproves and workflow_approve", () => {
  test("a workflow_approve is never auto-approved, even on the own turn", () => {
    expect(autoApproves(ask("workflow_approve"))).toBe(false);
    expect(autoApproves(ask("workflow_approve"), true)).toBe(false);
  });

  test("a tool ask on the own turn still is", () => {
    expect(autoApproves(ask())).toBe(true);
    expect(autoApproves(ask("tool"))).toBe(true);
  });
});

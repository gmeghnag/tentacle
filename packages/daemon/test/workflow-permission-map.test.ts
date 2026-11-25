import { describe, expect, test } from "bun:test";
import { WORKFLOW_APPROVE_TOOL } from "@tentacle/core";
import { permissionOptions } from "../src/permission-map.ts";

// docs/feat/agent-workflows.md D3: a workflow_approve (hash approval, approve
// step) is allow-once or deny — never a lasting answer.
describe("permissionOptions for workflow_approve", () => {
  test("offers no allow_always", () => {
    const kinds = permissionOptions({
      kind: "workflow_approve",
      tool: WORKFLOW_APPROVE_TOOL,
      level: "ask",
      title: "Merge",
      input: {},
    }).map((o) => o.kind);
    expect(kinds).toEqual(["allow_once", "reject_once"]);
  });

  test("an ordinary tool ask still does", () => {
    const kinds = permissionOptions({ tool: "shell", level: "ask", title: "Run", input: {} }).map(
      (o) => o.kind,
    );
    expect(kinds).toContain("allow_always");
  });
});

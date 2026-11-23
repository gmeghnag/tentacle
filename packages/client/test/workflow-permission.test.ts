import { describe, expect, test } from "bun:test";
import { autoApproves } from "@tentacle/core";
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import { toPermissionRequest } from "../src/permission-router.ts";

// docs/feat/agent-workflows.md D3 (decision 3): the wire tool `workflow_approve`
// becomes the laptop-internal kind auto-accept never answers. The opposite
// direction (a daemon naming an ordinary ask `workflow_approve`) only asks MORE.
const update = (tool: string): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId: "r1",
  toolCallId: "wf-1",
  tool,
  title: "Run workflow task v3 (hash 3f2a1b9c)",
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
});

describe("workflow_approve on the client", () => {
  test("maps to kind workflow_approve, which auto-accept refuses", () => {
    const req = toPermissionRequest(update("workflow_approve"));
    expect(req.kind).toBe("workflow_approve");
    expect(autoApproves(req, true)).toBe(false);
  });

  test("a run step's tool ask stays a plain tool ask (auto-accept may answer it)", () => {
    const req = toPermissionRequest(update("shell"));
    expect(req.kind).toBeUndefined();
    expect(autoApproves(req, true)).toBe(true);
  });
});

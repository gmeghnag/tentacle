import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_TOOL, autoApproves, onceOnlyAsk } from "@tentacle/core";
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import { toPermissionRequest } from "../src/permission-router.ts";

// docs/feat/browser-inspect.md B5 (owner Q3): a browser action ask is read off
// the wire tool, and the session's auto-accept never answers it.
const update = (tool: string): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId: "r1",
  toolCallId: "c1",
  tool,
  title: "Click “Delete” on example.com",
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
});

describe("browser_action on the client", () => {
  test("maps to kind browser_action, which auto-accept refuses and which is once-only", () => {
    const req = toPermissionRequest(update(BROWSER_ACTION_TOOL));
    expect(req.kind).toBe("browser_action");
    expect(autoApproves(req, true)).toBe(false);
    expect(onceOnlyAsk(req)).toBe(true);
  });

  test("an ordinary tool ask is unchanged", () => {
    const req = toPermissionRequest(update("browser_read"));
    expect(req.kind).toBeUndefined();
    expect(autoApproves(req, true)).toBe(true);
    expect(onceOnlyAsk(req)).toBe(false);
  });
});

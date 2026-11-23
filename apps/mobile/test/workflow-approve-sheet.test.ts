import { describe, expect, test } from "bun:test";
import { type PermissionRequest, WORKFLOW_APPROVE_TOOL } from "@tentacle/core";
import { sheetOptions } from "../src/permission-sheet.ts";

// The daemon offers a `workflow_approve` allow-once / deny only: an
// `allow_always` from the phone is rejected "option not offered".
const approve = (reply: boolean): PermissionRequest => ({
  kind: "workflow_approve",
  tool: WORKFLOW_APPROVE_TOOL,
  level: "ask",
  title: "Merge feat/x",
  input: {},
  ...(reply ? { reply: { maxChars: 2000 } } : {}),
});

describe("phone sheet for a workflow_approve ask", () => {
  test("offers allow-once and deny, never allow_always", () => {
    expect(sheetOptions(approve(false)).map((o) => o.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  test("keeps the reply option when the asker takes one", () => {
    expect(sheetOptions(approve(true)).map((o) => o.optionId)).toEqual([
      "allow_once",
      "reject_once",
      "reply",
    ]);
  });
});

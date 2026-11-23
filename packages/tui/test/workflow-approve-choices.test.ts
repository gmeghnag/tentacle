import { describe, expect, test } from "bun:test";
import { type PermissionRequest, WORKFLOW_APPROVE_TOOL } from "@tentacle/core";
import { buildPermissionChoices } from "../src/permission-ui.ts";

// The daemon offers a `workflow_approve` allow-once / deny only
// (`daemon/src/permission-map.ts`); an "always" choice here would send
// `allow_always`, which the daemon rejects as "option not offered" — the
// human's approval of a merge step would error instead of landing.
const approve = (reply: boolean): PermissionRequest => ({
  kind: "workflow_approve",
  tool: WORKFLOW_APPROVE_TOOL,
  level: "ask",
  title: "Merge feat/x",
  input: {},
  ...(reply ? { reply: { maxChars: 2000 } } : {}),
});

describe("TUI choices for a workflow_approve ask", () => {
  test("no session-scoped (always) choice; once and deny remain", () => {
    const choices = buildPermissionChoices(approve(false));
    expect(choices.some((c) => c.response.allowed && c.response.scope === "session")).toBe(false);
    expect(choices.map((c) => c.response)).toEqual([
      { allowed: true, scope: "once" },
      { allowed: false },
    ]);
  });

  test("the reply option stays when the asker takes one", () => {
    const choices = buildPermissionChoices(approve(true));
    expect(choices.some((c) => c.response.allowed && c.response.scope === "session")).toBe(false);
    expect(choices.some((c) => c.reply === true)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_TOOL } from "@tentacle/core";
import { buildPermissionChoices } from "../src/permission-ui.ts";

// The daemon offers a browser action allow-once / deny only: an "always"
// choice here would be refused as "option not offered".
describe("buildPermissionChoices for browser_action", () => {
  test("offers no session-wide choice", () => {
    const choices = buildPermissionChoices({
      kind: "browser_action",
      tool: BROWSER_ACTION_TOOL,
      level: "ask",
      title: "Submit a form on example.com",
      input: {},
    });
    expect(choices.some((c) => c.response.scope === "session")).toBe(false);
    expect(choices.map((c) => c.response.allowed)).toEqual([true, false]);
  });
});

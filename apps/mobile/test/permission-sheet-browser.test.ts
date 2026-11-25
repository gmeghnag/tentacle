import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_TOOL } from "@tentacle/core";
import { sheetOptions } from "../src/permission-sheet.ts";

// The daemon offers a browser action allow-once / deny only (browser-inspect B5).
describe("sheetOptions for browser_action", () => {
  test("offers no allow_always", () => {
    const ids = sheetOptions({
      kind: "browser_action",
      tool: BROWSER_ACTION_TOOL,
      level: "ask",
      title: "Click “Delete” on example.com",
      input: {},
    }).map((o) => o.optionId);
    expect(ids).toEqual(["allow_once", "reject_once"]);
  });
});

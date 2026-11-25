import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_TOOL } from "@tentacle/core";
import { permissionOptions } from "../src/permission-map.ts";

// docs/feat/browser-inspect.md B5: a browser action is allow-once or deny —
// never a lasting answer (acting as the user on the web).
describe("permissionOptions for browser_action", () => {
  test("offers no allow_always", () => {
    const kinds = permissionOptions({
      kind: "browser_action",
      tool: BROWSER_ACTION_TOOL,
      level: "ask",
      title: "Click “Pay” on shop.example",
      input: {},
    }).map((o) => o.kind);
    expect(kinds).toEqual(["allow_once", "reject_once"]);
  });
});

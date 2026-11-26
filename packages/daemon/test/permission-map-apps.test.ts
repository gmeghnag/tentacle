/**
 * docs/feat/session-apps-publish.md D3: the daemon offers a publish ask
 * allow-once or deny only. An option not offered is refused and the ask stays
 * pending, so no client can create an «always» rule. Mutation: drop
 * `app_publish` from `onceOnlyAsk` → red.
 */
import { describe, expect, test } from "bun:test";
import { APP_PUBLISH_TOOL, type PermissionRequest } from "@tentacle/core";
import { permissionOptions, toPermissionRequestUpdate } from "../src/permission-map.ts";

const publish: PermissionRequest = {
  kind: "app_publish",
  tool: APP_PUBLISH_TOOL,
  level: "ask",
  title: 'Publish "Demo" as a public web page?',
  input: {},
};

describe("permission options of a publish ask", () => {
  test("allow once or deny, nothing else — a suggestion adds no «always»", () => {
    expect(permissionOptions(publish).map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(
      permissionOptions({ ...publish, suggestion: { prefix: "x" } }).map((o) => o.kind),
    ).toEqual(["allow_once", "reject_once"]);
  });

  test("the wire ask carries the tool name the client rebuilds the kind from", () => {
    const update = toPermissionRequestUpdate("r1", "c1", publish);
    expect(update.tool).toBe("app_publish");
    expect(update.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });
});

/**
 * `model/slots` is gone (docs/feat/models-map.md, owner 2026-11-08): the
 * sub-agent cap is the user's `subagents.maxParallel`, no server is asked. A
 * removed method is breaking, so the version moved: an older peer fails at
 * `initialize` with a clean VersionMismatch instead of a MethodNotFound later.
 */
import { describe, expect, test } from "bun:test";
import { Method, RequestSchemas } from "../src/methods.ts";
import { PROTOCOL_VERSION } from "../src/version.ts";

describe("no model/slots (protocol 18)", () => {
  test("the method and its schemas are removed", () => {
    expect(Object.values(Method)).not.toContain("model/slots");
    expect(Object.keys(RequestSchemas)).not.toContain("model/slots");
  });

  test("the removal bumped the protocol", () => {
    expect(PROTOCOL_VERSION).toBe(18);
  });
});

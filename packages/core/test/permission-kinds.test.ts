/**
 * docs/feat/a2a.md slice S5: which ask kinds an external caller (A2A / MCP)
 * may ever answer. Mutation: mark `workflow_approve` (or any lasting kind)
 * `once` → red.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_ANSWER, type PermissionKind, externalMayAnswer } from "../src/permission.ts";

describe("external answer table", () => {
  test("only a tool ask is caller-answerable; every lasting kind is owner-only", () => {
    expect(EXTERNAL_ANSWER).toEqual({
      tool: "once",
      hooks_trust: "owner-only",
      session_hop: "owner-only",
      workflow_approve: "owner-only",
      browser_action: "owner-only",
    });
    const kinds = Object.keys(EXTERNAL_ANSWER) as PermissionKind[];
    expect(kinds.filter((k) => externalMayAnswer(k))).toEqual(["tool"]);
  });

  test("an unknown (unmapped) kind is never answerable", () => {
    expect(externalMayAnswer(undefined)).toBe(false);
  });
});

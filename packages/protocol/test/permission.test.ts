import { describe, expect, test } from "bun:test";
import { RequestPermissionParamsSchema, RequestPermissionResultSchema } from "../src/index.ts";

describe("permission request", () => {
  test("accepts a request with at least one option", () => {
    const r = RequestPermissionParamsSchema.safeParse({
      sessionId: "s1",
      toolCallId: "t1",
      title: "Run shell command",
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
    });
    expect(r.success).toBe(true);
  });

  test("rejects a request with no options", () => {
    const r = RequestPermissionParamsSchema.safeParse({
      sessionId: "s1",
      toolCallId: "t1",
      title: "x",
      options: [],
    });
    expect(r.success).toBe(false);
  });

  test("outcome: selected needs an optionId", () => {
    expect(
      RequestPermissionResultSchema.safeParse({ outcome: { outcome: "selected", optionId: "a" } })
        .success,
    ).toBe(true);
    expect(
      RequestPermissionResultSchema.safeParse({ outcome: { outcome: "selected" } }).success,
    ).toBe(false);
  });

  test("outcome: cancelled", () => {
    expect(
      RequestPermissionResultSchema.safeParse({ outcome: { outcome: "cancelled" } }).success,
    ).toBe(true);
  });
});

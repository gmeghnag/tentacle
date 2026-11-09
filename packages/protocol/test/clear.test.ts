import { describe, expect, test } from "bun:test";
import {
  ClearParamsSchema,
  ClearResultSchema,
  HistoryReplacedSchema,
  Method,
  PROTOCOL_VERSION,
  RequestSchemas,
} from "../src/index.ts";

// docs/feat/clear-keeps-jobs.md — T1.
describe("session/clear (protocol 21)", () => {
  test("history_replaced accepts reason `clear`", () => {
    expect(
      HistoryReplacedSchema.safeParse({ type: "history_replaced", reason: "clear" }).success,
    ).toBe(true);
    expect(
      HistoryReplacedSchema.safeParse({ type: "history_replaced", reason: "nope" }).success,
    ).toBe(false);
  });

  test("session/clear is a registered method with its schemas", () => {
    expect(Method.Clear).toBe("session/clear");
    expect(RequestSchemas[Method.Clear]).toBeDefined();
    expect(ClearParamsSchema.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(ClearParamsSchema.safeParse({}).success).toBe(false);
    expect(ClearResultSchema.safeParse({ before: 5, after: 1 }).success).toBe(true);
    expect(ClearResultSchema.safeParse({ before: -1, after: 1 }).success).toBe(false);
  });

  test("the new `mandatory` reason bumped the protocol to 21", () => {
    expect(PROTOCOL_VERSION as number).toBeGreaterThanOrEqual(21);
  });
});

import { describe, expect, test } from "bun:test";
import {
  Method,
  Notification,
  NotificationSchemas,
  RequestSchemas,
  isMethodName,
  isNotificationName,
} from "../src/index.ts";

describe("method registry", () => {
  test("every request method has params+result schemas", () => {
    for (const name of Object.values(Method)) {
      expect(RequestSchemas[name]).toBeDefined();
      expect(RequestSchemas[name].params).toBeDefined();
      expect(RequestSchemas[name].result).toBeDefined();
    }
  });

  test("every notification method has a params schema", () => {
    for (const name of Object.values(Notification)) {
      expect(NotificationSchemas[name]).toBeDefined();
    }
  });

  test("type guards", () => {
    expect(isMethodName("initialize")).toBe(true);
    expect(isMethodName("session/update")).toBe(false);
    expect(isNotificationName("session/update")).toBe(true);
    expect(isNotificationName("initialize")).toBe(false);
  });

  test("registry schema validates a real payload", () => {
    const schema = RequestSchemas[Method.Initialize].params;
    expect(schema.safeParse({ protocolVersion: 1, clientCapabilities: {} }).success).toBe(true);
    expect(schema.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });
});

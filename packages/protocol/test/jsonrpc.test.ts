import { describe, expect, test } from "bun:test";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcSuccessResponseSchema,
} from "../src/index.ts";

describe("JSON-RPC envelopes", () => {
  test("accepts a well-formed request", () => {
    const parsed = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: "abc",
      method: "session/new",
      params: { cwd: "/tmp" },
    });
    expect(parsed.method).toBe("session/new");
  });

  test("rejects a request without an id", () => {
    const r = JsonRpcRequestSchema.safeParse({ jsonrpc: "2.0", method: "x" });
    expect(r.success).toBe(false);
  });

  test("rejects a request with the wrong jsonrpc version", () => {
    const r = JsonRpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "x" });
    expect(r.success).toBe(false);
  });

  test("notification must not carry an id (strict)", () => {
    expect(
      JsonRpcNotificationSchema.safeParse({ jsonrpc: "2.0", method: "session/update" }).success,
    ).toBe(true);
    expect(
      JsonRpcNotificationSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "session/update" })
        .success,
    ).toBe(false);
  });

  test("success response may not also carry an error (strict)", () => {
    expect(
      JsonRpcSuccessResponseSchema.safeParse({ jsonrpc: "2.0", id: 1, result: {} }).success,
    ).toBe(true);
    expect(
      JsonRpcSuccessResponseSchema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -1, message: "x" },
      }).success,
    ).toBe(false);
  });

  test("error response allows a null id", () => {
    const parsed = JsonRpcErrorResponseSchema.parse({
      jsonrpc: "2.0",
      id: null,
      error: { code: JsonRpcErrorCode.ParseError, message: "parse error" },
    });
    expect(parsed.error.code).toBe(-32700);
  });

  test("message union parses each frame kind", () => {
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "m" },
      { jsonrpc: "2.0", method: "n" },
      { jsonrpc: "2.0", id: 1, result: 42 },
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } },
    ];
    for (const f of frames) {
      expect(JsonRpcMessageSchema.safeParse(f).success).toBe(true);
    }
  });

  test("constants", () => {
    expect(JSONRPC_VERSION).toBe("2.0");
    expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
  });
});

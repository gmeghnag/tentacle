import { describe, expect, test } from "bun:test";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcSuccessResponseSchema,
  parseJsonRpcMessage,
} from "../src/index.ts";

describe("JSON-RPC envelopes", () => {
  test("accepts a well-formed request", () => {
    const parsed = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: "abc",
      method: "session/open",
      params: { cwd: "/tmp" },
    });
    expect(parsed.method).toBe("session/open");
  });

  test("rejects a request without an id", () => {
    const r = JsonRpcRequestSchema.safeParse({ jsonrpc: "2.0", method: "x" });
    expect(r.success).toBe(false);
  });

  test("rejects a request with the wrong jsonrpc version", () => {
    const r = JsonRpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "x" });
    expect(r.success).toBe(false);
  });

  test("a frame with `method` and an `id` is a request; without, a notification", () => {
    expect(
      JsonRpcNotificationSchema.safeParse({ jsonrpc: "2.0", method: "session/update" }).success,
    ).toBe(true);
    const r = parseJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "session/update" });
    expect(r.success && "id" in r.data && r.data.id).toBe(1);
  });

  test("a response may not carry both result and error (ambiguous)", () => {
    expect(
      JsonRpcSuccessResponseSchema.safeParse({ jsonrpc: "2.0", id: 1, result: {} }).success,
    ).toBe(true);
    expect(
      parseJsonRpcMessage({
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

describe("parseJsonRpcMessage: classified by the members present (v10 forward compat)", () => {
  test("each kind tolerates (and strips) an unknown member", () => {
    const cases = [
      { jsonrpc: "2.0", id: 1, method: "m", params: {} },
      { jsonrpc: "2.0", method: "m" },
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: 1, message: "x" } },
    ];
    for (const frame of cases) {
      const r = parseJsonRpcMessage({ ...frame, extra: 1 });
      expect(r.success).toBe(true);
      expect(r.success ? (r.data as unknown) : null).toEqual(frame);
    }
  });

  test("ambiguous or classless frames are rejected", () => {
    for (const frame of [
      { jsonrpc: "2.0", id: 1, method: "m", result: {} },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "1.0", id: 1, method: "m" },
      { jsonrpc: "2.0", id: null, method: "m" },
      "x",
      null,
    ]) {
      expect(parseJsonRpcMessage(frame).success).toBe(false);
    }
  });
});

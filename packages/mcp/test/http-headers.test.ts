import { describe, expect, test } from "bun:test";
import {
  encodeHeaderValue,
  headerParams,
  paramHeaders,
  standardHeaders,
} from "../src/http-headers.ts";

describe("encodeHeaderValue (spec examples)", () => {
  test.each([
    ["us-west1", "us-west1"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
  ])("%p → %p", (value, encoded) => {
    expect(encodeHeaderValue(value)).toBe(encoded);
  });
});

describe("standardHeaders", () => {
  test("Mcp-Method always; Mcp-Name from name or uri on the three named methods", () => {
    expect(standardHeaders("tools/list", {})).toEqual({ "mcp-method": "tools/list" });
    expect(standardHeaders("tools/call", { name: "get_weather" })).toEqual({
      "mcp-method": "tools/call",
      "mcp-name": "get_weather",
    });
    expect(standardHeaders("prompts/get", { name: "p" })["mcp-name"]).toBe("p");
    expect(standardHeaders("resources/read", { uri: "file:///a b" })["mcp-name"]).toBe(
      "file:///a b",
    );
    expect(standardHeaders("tools/call", { name: "météo" })["mcp-name"]).toBe(
      encodeHeaderValue("météo"),
    );
  });
});

const prop = (type: unknown, header?: unknown) => ({
  type,
  ...(header !== undefined ? { "x-mcp-header": header } : {}),
});

describe("headerParams", () => {
  test("collects annotations on (nested) statically reachable primitive properties", () => {
    const result = headerParams({
      type: "object",
      properties: {
        region: prop("string", "Region"),
        query: prop("string"),
        opts: {
          type: "object",
          properties: { dry: prop("boolean", "Dry"), n: prop(["integer", "null"], "N") },
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      params: [
        { header: "Region", path: ["region"] },
        { header: "Dry", path: ["opts", "dry"] },
        { header: "N", path: ["opts", "n"] },
      ],
    });
  });

  test("a property literally named x-mcp-header is a property, not an annotation", () => {
    expect(headerParams({ properties: { "x-mcp-header": prop("string") } })).toEqual({
      ok: true,
      params: [],
    });
  });

  test("data keywords (default/examples/const) are not searched", () => {
    expect(
      headerParams({ properties: { a: { type: "object", default: { "x-mcp-header": "!" } } } }),
    ).toEqual({ ok: true, params: [] });
  });

  test.each([
    ["empty", { properties: { a: prop("string", "") } }],
    ["not a token", { properties: { a: prop("string", "Bad Name") } }],
    ["CR/LF", { properties: { a: prop("string", "A\r\nX") } }],
    ["number type", { properties: { a: prop("number", "A") } }],
    ["object type", { properties: { a: { type: "object", "x-mcp-header": "A" } } }],
    [
      "duplicate (case-insensitive)",
      { properties: { a: prop("string", "A"), b: prop("string", "a") } },
    ],
    ["under items", { properties: { a: { type: "array", items: prop("string", "A") } } }],
    ["under oneOf", { properties: { a: { oneOf: [prop("string", "A")] } } }],
    [
      "in $defs (via $ref)",
      { $defs: { R: prop("string", "A") }, properties: { a: { $ref: "#/$defs/R" } } },
    ],
    ["on the root", { type: "string", "x-mcp-header": "A" }],
  ])("invalid: %s", (_name, schema) => {
    expect(headerParams(schema).ok).toBe(false);
  });
});

describe("paramHeaders", () => {
  const params = [
    { header: "Region", path: ["region"] },
    { header: "Dry", path: ["opts", "dry"] },
    { header: "N", path: ["opts", "n"] },
  ];

  test("mirrors present values; absent and null are omitted; values are encoded", () => {
    expect(paramHeaders(params, { region: "東京", opts: { dry: false, n: 42 } })).toEqual({
      "mcp-param-region": encodeHeaderValue("東京"),
      "mcp-param-dry": "false",
      "mcp-param-n": "42",
    });
    expect(paramHeaders(params, { opts: { n: null } })).toEqual({});
    expect(paramHeaders(params, undefined)).toEqual({});
  });

  test("a non-integer or unsafe number is not mirrored", () => {
    expect(paramHeaders(params, { opts: { n: 1.5 } })).toEqual({});
    expect(paramHeaders(params, { opts: { n: 2 ** 60 } })).toEqual({});
  });
});

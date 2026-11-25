import { describe, expect, test } from "bun:test";
import { buildPayload } from "../src/index.ts";
import { toDraft2020 } from "../src/json-schema-2020.ts";

describe("toDraft2020 (Anthropic input_schema must be draft 2020-12)", () => {
  test("exclusiveMinimum: true + minimum → numeric exclusiveMinimum", () => {
    expect(toDraft2020({ type: "integer", exclusiveMinimum: true, minimum: 0 })).toEqual({
      type: "integer",
      exclusiveMinimum: 0,
    });
  });

  test("exclusiveMaximum: true + maximum → numeric exclusiveMaximum", () => {
    expect(toDraft2020({ type: "number", exclusiveMaximum: true, maximum: 9 })).toEqual({
      type: "number",
      exclusiveMaximum: 9,
    });
  });

  test("boolean false is dropped; the bound stays inclusive", () => {
    expect(toDraft2020({ type: "integer", exclusiveMinimum: false, minimum: 1 })).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  test("a dangling boolean flag with no bound is dropped", () => {
    expect(toDraft2020({ type: "integer", exclusiveMinimum: true })).toEqual({ type: "integer" });
  });

  test("nullable: true → type array with null (and enum gains null)", () => {
    expect(toDraft2020({ type: "string", nullable: true })).toEqual({ type: ["string", "null"] });
    expect(toDraft2020({ type: "string", enum: ["a"], nullable: true })).toEqual({
      type: ["string", "null"],
      enum: ["a", null],
    });
  });

  test("nullable without a type → anyOf with null", () => {
    expect(toDraft2020({ nullable: true, enum: ["a"] })).toEqual({
      anyOf: [{ enum: ["a"] }, { type: "null" }],
    });
  });

  test("tuple items → prefixItems", () => {
    expect(toDraft2020({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toEqual(
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
      },
    );
  });

  test("recurses into properties, items, anyOf, $defs; does not mutate the input", () => {
    const input = {
      type: "object",
      properties: {
        a: { type: "array", items: { type: "integer", exclusiveMinimum: true, minimum: 0 } },
        b: { anyOf: [{ type: "string", nullable: true }] },
      },
      $defs: { d: { type: "integer", exclusiveMinimum: true, minimum: 2 } },
    };
    const copy = structuredClone(input);
    expect(toDraft2020(input)).toEqual({
      type: "object",
      properties: {
        a: { type: "array", items: { type: "integer", exclusiveMinimum: 0 } },
        b: { anyOf: [{ type: ["string", "null"] }] },
      },
      $defs: { d: { type: "integer", exclusiveMinimum: 2 } },
    });
    expect(input).toEqual(copy);
  });

  test("a property NAMED like a keyword is left alone", () => {
    const s = {
      type: "object",
      properties: { nullable: { type: "boolean" }, items: { type: "string" } },
    };
    expect(toDraft2020(s)).toEqual(s);
  });

  test("the Anthropic payload carries the normalised schema", () => {
    const payload = buildPayload("m", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "t",
          description: "d",
          parameters: {
            type: "object",
            properties: { n: { type: "integer", exclusiveMinimum: true, minimum: 0 } },
          },
        },
      ],
    }) as { tools: { input_schema: unknown }[] };
    expect(payload.tools[0]?.input_schema).toEqual({
      type: "object",
      properties: { n: { type: "integer", exclusiveMinimum: 0 } },
    });
  });
});

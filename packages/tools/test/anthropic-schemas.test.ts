import { describe, expect, test } from "bun:test";
import { buildPayload } from "../../providers/src/anthropic-provider.ts";
import { ToolRegistry, builtinTools } from "../src/index.ts";

// Structural draft 2020-12 check for the keywords the OpenAPI-3 output gets wrong.
function violations(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => violations(n, `${path}[${i}]`, out));
  } else if (typeof node === "object" && node !== null) {
    const o = node as Record<string, unknown>;
    for (const k of ["exclusiveMinimum", "exclusiveMaximum"]) {
      if (k in o && typeof o[k] !== "number") out.push(`${path}.${k} is ${typeof o[k]}`);
    }
    if ("nullable" in o && typeof o.nullable === "boolean") out.push(`${path}.nullable`);
    if (Array.isArray(o.items)) out.push(`${path}.items is an array`);
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" && typeof v === "object" && v !== null) {
        for (const [n, s] of Object.entries(v)) violations(s, `${path}.properties.${n}`, out);
      } else violations(v, `${path}.${k}`, out);
    }
  }
  return out;
}

describe("Anthropic wire tools are draft 2020-12", () => {
  test("every built-in tool's input_schema is valid", () => {
    const reg = new ToolRegistry();
    for (const t of builtinTools) reg.register(t);
    const payload = buildPayload("m", {
      messages: [{ role: "user", content: "hi" }],
      tools: reg.definitions(),
    }) as { tools: { name: string; input_schema: unknown }[] };
    expect(payload.tools.length).toBe(builtinTools.length);
    const bad = payload.tools.flatMap((t) => violations(t.input_schema, t.name, []));
    expect(bad).toEqual([]);
  });
});

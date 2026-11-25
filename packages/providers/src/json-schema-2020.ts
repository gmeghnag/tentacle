/**
 * Normalise a tool's JSON Schema to draft 2020-12, the dialect the Anthropic
 * API validates `input_schema` against. Tool schemas come from
 * `zod-to-json-schema` with `target: "openApi3"` (and from MCP servers), whose
 * OpenAPI-3.0 / draft-04 idioms are not valid 2020-12:
 *
 *  - `exclusiveMinimum|Maximum: true` + `minimum|maximum: n` → `exclusiveMinimum: n`
 *    (`false` is dropped, the bound stays inclusive);
 *  - `nullable: true` → `"null"` added to `type` (or wrapped in `anyOf`);
 *  - `items: [a, b]` (tuple) → `prefixItems`.
 *
 * Pure and non-mutating; applied only on the Anthropic wire, so the OpenAI
 * provider keeps receiving the schema unchanged.
 */

type Json = Record<string, unknown>;

const drop = (o: Json, k: string): void => {
  delete o[k];
};
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// Keywords whose value is a subschema, a list of subschemas, or a map of subschemas.
const SCHEMA_KEYS = [
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "prefixItems",
];
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
];

export function toDraft2020(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toDraft2020);
  if (!isObj(schema)) return schema;
  const out: Json = { ...schema };

  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    const f = out[flag];
    if (f === true) {
      if (typeof out[bound] === "number") {
        out[flag] = out[bound];
        drop(out, bound);
      } else drop(out, flag);
    } else if (f === false) {
      drop(out, flag);
    }
  }

  if (Array.isArray(out.items)) {
    out.prefixItems = out.items;
    drop(out, "items");
    if ("additionalItems" in out) {
      out.items = out.additionalItems;
      drop(out, "additionalItems");
    }
  }

  const nullable = out.nullable;
  drop(out, "nullable");

  for (const k of SCHEMA_KEYS) {
    if (k in out && (isObj(out[k]) || Array.isArray(out[k]))) out[k] = toDraft2020(out[k]);
  }
  for (const k of SCHEMA_LIST_KEYS)
    if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(toDraft2020);
  for (const k of SCHEMA_MAP_KEYS) {
    const m = out[k];
    if (isObj(m))
      out[k] = Object.fromEntries(Object.entries(m).map(([n, s]) => [n, toDraft2020(s)]));
  }

  if (nullable === true) {
    if (typeof out.type === "string") {
      out.type = [out.type, "null"];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    } else if (Array.isArray(out.type)) {
      if (!out.type.includes("null")) out.type = [...out.type, "null"];
    } else {
      return { anyOf: [out, { type: "null" }] };
    }
  }
  return out;
}

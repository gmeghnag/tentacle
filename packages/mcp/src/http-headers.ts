/**
 * Streamable HTTP request-metadata headers (MCP 2026-07-28), as pure functions:
 * the standard `Mcp-Method` / `Mcp-Name` mirror of a request body, and the
 * `x-mcp-header` tool-parameter mirror (`Mcp-Param-{name}`), plus the value
 * encoding both share. The transport only wires these in.
 */

const SENTINEL = /^=\?base64\?.*\?=$/s;
// RFC 9110 field-name token (`1*tchar`).
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean"]);
// Keywords whose values are subschemas. An `x-mcp-header` found through any of
// them is not statically reachable from the root (only `properties` chains are).
const SUBSCHEMA_KEYWORDS = new Set([
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "$defs",
  "definitions",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "dependentSchemas",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True for a value that may go into a header as-is (visible ASCII, space, tab; no edge whitespace). */
function isHeaderSafe(value: string): boolean {
  if (value !== value.trim()) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!(c === 0x09 || (c >= 0x20 && c <= 0x7e))) {
      return false;
    }
  }
  return true;
}

/** Encode a header value, using `=?base64?…?=` when it is not plain-safe or looks like the sentinel. */
export function encodeHeaderValue(value: string): string {
  if (isHeaderSafe(value) && !SENTINEL.test(value)) {
    return value;
  }
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Mcp-Method` (every request) and `Mcp-Name` (`tools/call`, `prompts/get`, `resources/read`). */
export function standardHeaders(method: string, params: unknown): Record<string, string> {
  const headers: Record<string, string> = { "mcp-method": method };
  const p = isObject(params) ? params : {};
  const name =
    method === "tools/call" || method === "prompts/get"
      ? p.name
      : method === "resources/read"
        ? p.uri
        : undefined;
  if (typeof name === "string") {
    headers["mcp-name"] = encodeHeaderValue(name);
  }
  return headers;
}

/** One `x-mcp-header` annotation: the header name part and the property path to its value. */
export interface HeaderParam {
  readonly header: string;
  readonly path: readonly string[];
}

export type HeaderParamsResult =
  | { readonly ok: true; readonly params: readonly HeaderParam[] }
  | { readonly ok: false; readonly reason: string };

function primitiveType(type: unknown): boolean {
  if (typeof type === "string") {
    return PRIMITIVE_TYPES.has(type);
  }
  // A nullable primitive (`["string", "null"]`): a null value just omits the header.
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    return nonNull.length === 1 && PRIMITIVE_TYPES.has(String(nonNull[0]));
  }
  return false;
}

/**
 * Collect a tool `inputSchema`'s `x-mcp-header` annotations, or the reason the
 * definition is invalid (the client must then drop the tool). Rules: a
 * non-empty token, unique case-insensitively, on a string/integer/boolean
 * property reachable from the root through `properties` keys only.
 */
export function headerParams(schema: unknown): HeaderParamsResult {
  const found: { header: unknown; path: readonly string[] | null; type: unknown }[] = [];
  const walk = (node: unknown, path: readonly string[] | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, null);
      }
      return;
    }
    if (!isObject(node)) {
      return;
    }
    if ("x-mcp-header" in node) {
      found.push({ header: node["x-mcp-header"], path, type: node.type });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isObject(value)) {
        for (const [prop, sub] of Object.entries(value)) {
          walk(sub, path ? [...path, prop] : null);
        }
      } else if (SUBSCHEMA_KEYWORDS.has(key)) {
        // Maps of subschemas (`$defs`, `patternProperties`, …) and single ones alike.
        const isMap = key === "$defs" || key === "definitions" || key.endsWith("Properties");
        const isSchemaMap =
          isMap && key !== "additionalProperties" && key !== "unevaluatedProperties";
        if (isSchemaMap && isObject(value)) {
          for (const sub of Object.values(value)) {
            walk(sub, null);
          }
        } else {
          walk(value, null);
        }
      }
    }
  };
  walk(schema, []);

  const params: HeaderParam[] = [];
  const seen = new Set<string>();
  for (const { header, path, type } of found) {
    if (typeof header !== "string" || header === "") {
      return { ok: false, reason: "x-mcp-header must be a non-empty string" };
    }
    if (!TOKEN.test(header)) {
      return { ok: false, reason: `x-mcp-header "${header}" is not a valid header token` };
    }
    if (path === null || path.length === 0) {
      return {
        ok: false,
        reason: `x-mcp-header "${header}" is not on a statically reachable property`,
      };
    }
    if (!primitiveType(type)) {
      return {
        ok: false,
        reason: `x-mcp-header "${header}" is not on a string/integer/boolean property`,
      };
    }
    const key = header.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, reason: `x-mcp-header "${header}" is not unique` };
    }
    seen.add(key);
    params.push({ header, path });
  }
  return { ok: true, params };
}

/** The `Mcp-Param-{name}` headers for a `tools/call`'s arguments (absent/null values omitted). */
export function paramHeaders(
  params: readonly HeaderParam[],
  args: unknown,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, path } of params) {
    let value: unknown = args;
    for (const key of path) {
      value = isObject(value) ? value[key] : undefined;
    }
    let text: string | undefined;
    if (typeof value === "string") {
      text = value;
    } else if (typeof value === "boolean") {
      text = value ? "true" : "false";
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      text = String(value);
    }
    if (text !== undefined) {
      headers[`mcp-param-${header.toLowerCase()}`] = encodeHeaderValue(text);
    }
  }
  return headers;
}

/**
 * `tentacle config`'s pure value layer (docs/feat/config-set.md): type a value
 * by the SCHEMA LEAF (owner answer Q5), decide what is a secret and how it is
 * printed (eval A4), and say what a write applies to (A6).
 *
 * The type is never guessed from the text: the walker's `KeyNode.type` decides
 * (`config-keys.ts`), so `maxIterations=true` is a type error rather than a
 * stored string, and no second type table exists to drift.
 *
 * Secrets come from the registry (`key-docs.ts`, pinned by its T7), which already
 * covers the `profiles.*` mirror — one lookup serves `set`, `get` and `list`.
 */
import { type KeyNode, resolveKeyPath } from "./config-keys.ts";
import { type KeyDoc, keyDoc } from "./key-docs.ts";

/** What a typed value became, or why the text was refused (one line). */
export type TypedValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const refuse = (error: string): TypedValue => ({ ok: false, error });

/** A JSON object (not an array, not `null`). */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `JSON.parse`, or a marker for "not JSON". */
function json(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The words an enum accepts, quoted, for the refusal message. */
const listed = (values: readonly string[]): string => values.map((v) => `"${v}"`).join(", ");

function typeEnum(node: KeyNode, text: string, values: readonly string[]): TypedValue {
  const trimmed = text.trim();
  return values.includes(trimmed)
    ? { ok: true, value: trimmed }
    : refuse(`must be one of: ${listed(values)}`);
}

function typeString(text: string): TypedValue {
  // A leading `"` that parses as a JSON string IS that string, so a quote never
  // silently becomes part of a path or a URL (eval A3). Anything else is the raw
  // text: the user asked for no quoting, and the schema decides the rest.
  if (text.startsWith('"')) {
    const parsed = json(text);
    if (parsed.ok && typeof parsed.value === "string") {
      return { ok: true, value: parsed.value };
    }
  }
  return { ok: true, value: text };
}

function typeArray(text: string): TypedValue {
  const parsed = json(text.trim());
  return parsed.ok && Array.isArray(parsed.value)
    ? { ok: true, value: parsed.value }
    : refuse('must be a JSON array, e.g. ["/tmp","~/scratch"]');
}

function typeObject(text: string): TypedValue {
  const parsed = json(text.trim());
  return parsed.ok && isObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : refuse('must be a JSON object, e.g. {"key":"value"}');
}

/**
 * Owner Q5 / eval A3's table: the leaf's own type decides how the text is read.
 * A union (`enum|array`, `readOnlyTools`) tries its members in order.
 */
export function typeConfigValue(node: KeyNode, text: string): TypedValue {
  const trimmed = text.trim();
  const types = node.type.split("|").map((t) => t.trim());
  if (types.length > 1) {
    const members = types.filter((t) => t !== node.type);
    for (const member of members) {
      const attempt = typeConfigValue({ ...node, type: member }, text);
      if (attempt.ok) {
        return attempt;
      }
    }
    return refuse(
      node.values !== undefined && node.values.length > 0
        ? `must be one of: ${listed(node.values)}, or a JSON array`
        : `must be a value of type ${types.join(" or ")}`,
    );
  }
  switch (node.type) {
    case "boolean":
      if (trimmed === "true" || trimmed === "false") {
        return { ok: true, value: trimmed === "true" };
      }
      return refuse("must be true or false");
    case "integer":
      return /^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))
        ? { ok: true, value: Number(trimmed) }
        : refuse("must be an integer");
    case "number":
      return trimmed !== "" && Number.isFinite(Number(trimmed))
        ? { ok: true, value: Number(trimmed) }
        : refuse("must be a number");
    case "enum":
      return typeEnum(node, text, node.values ?? []);
    case "array":
      return typeArray(text);
    case "object":
    case "map":
      return typeObject(text);
    case "string":
      return typeString(text);
    default: {
      // A leaf type the walker reports but no rule covers: read it as JSON when
      // it is JSON, else as the raw text, and let the schema refuse what it
      // cannot hold. (`config-value.test.ts` pins that this never happens today.)
      const parsed = json(trimmed);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: true, value: text };
    }
  }
}

/** The registry entry for a concrete key (`mcpServers.fs.env.TOKEN` → its `*` entry). */
export function docForKey(key: string): KeyDoc | undefined {
  const node = resolveKeyPath(key);
  return node === undefined ? undefined : keyDoc(node.path);
}

/** Is `key` a path the SCHEMA knows at all (a leaf, a section, a map entry)? */
export function isKnownKey(key: string): boolean {
  return resolveKeyPath(key) !== undefined;
}

/** `true` = the value IS a credential; `"values"` = every value under it is. */
export function secretOf(key: string): true | "values" | undefined {
  return docForKey(key)?.secret;
}

/**
 * Whether a value on ARGV must be refused for this key (owner Q6 / eval A4).
 * `model.apiKeyCommand` is marked secret in the registry because it *can* embed
 * a credential, but setting the command itself from argv is the documented,
 * safe way to do it — refusing it would remove the preferred path.
 */
export function isArgvRefusedSecret(key: string): boolean {
  const doc = docForKey(key);
  if (doc?.secret === undefined) {
    return false;
  }
  // The documented safe form is `apiKeyCommand`, so an argv value there is the
  // whole point; only a key whose own value IS a credential is refused.
  return !key.endsWith("apiKeyCommand");
}

const MASK = "***";
const ARRAY_MASK = "[***]";

/**
 * The mask a value at `segments` gets, or `undefined` when it is a plain setting:
 * a secret leaf/array from the registry (eval A4), OR a key the registry/schema
 * does not know at all (owner Q-B, HIGH-2's sibling) — a value pasted into the
 * wrong slot is not a setting, and `list` is what a user pastes into a bug
 * report.
 */
function maskOf(segments: readonly string[]): "***" | "[***]" | undefined {
  const key = segments.join(".");
  if (key === "") {
    return undefined;
  }
  const secret = secretOf(key);
  if (secret === "values") {
    return ARRAY_MASK;
  }
  if (secret === true) {
    return MASK;
  }
  return isKnownKey(key) ? undefined : MASK;
}

/**
 * A stored value as `get`/`list` may print it: the JSON the file holds, except
 * that a secret leaf is `***`, a secret array (`args`) is `[***]`, and an
 * unknown key's value is `***` — never a prefix, never a length (eval A4: no
 * error or output contains a secret value). An object recurses, so
 * `get mcpServers.fs` masks inside it.
 */
export function renderStored(value: unknown, segments: readonly string[]): string {
  const mask = maskOf(segments);
  if (mask !== undefined) {
    return mask;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value) ?? "[]";
  }
  if (isObject(value)) {
    const parts = Object.entries(value).map(
      ([name, child]) => `${JSON.stringify(name)}:${renderStored(child, [...segments, name])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The same tree with every masked node replaced by its mask: `"***"` for a
 * secret leaf or an unknown key, `["***"]` for a secret array.
 *
 * This is the ONLY source of a printed stored value (HIGH-2): `get --json`
 * emitted `found.value` raw for an object, so `get model --json` printed the
 * stored `apiKey`. `renderStored` is this tree re-serialized for people,
 * `get --json`/`list --json` are the same tree for machines, and neither ever
 * sees the raw value it replaces.
 */
export function maskStored(value: unknown, segments: readonly string[] = []): unknown {
  const mask = maskOf(segments);
  if (mask !== undefined) {
    return mask === ARRAY_MASK ? [MASK] : MASK;
  }
  if (Array.isArray(value)) {
    // An array is a LEAF: its entries are values, not addressable keys, so there
    // is no segmented path under it to mask (`hooks` is one such list).
    return value;
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      out[name] = maskStored(child, [...segments, name]);
    }
    return out;
  }
  return value;
}

/**
 * Every registry-secret path a value would create UNDER `segments` (HIGH-1):
 * `{"apiKey":"sk-x"}` at `model` → `["model.apiKey"]`. The same walk as
 * `flattenStored`/`renderStored`, so there is no second table of secrets.
 * `apiKeyCommand` is exempt by the same rule argv refusal uses (owner Q6/A4:
 * setting the command itself is the documented safe form).
 */
export function secretPathsIn(value: unknown, segments: readonly string[] = []): readonly string[] {
  const key = segments.join(".");
  if (key !== "" && isArgvRefusedSecret(key)) {
    // A secret ARRAY (`args`) is refused wholesale; a secret leaf is the value.
    return [key];
  }
  const found: string[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (!isObject(node)) {
      return;
    }
    for (const [name, child] of Object.entries(node)) {
      const childPath = [...path, name];
      const childKey = childPath.join(".");
      if (isArgvRefusedSecret(childKey)) {
        found.push(childKey);
        continue;
      }
      walk(child, childPath);
    }
  };
  walk(value, segments);
  return found;
}

/** One `key = value` line of `config list`. */
export interface StoredLine {
  readonly path: string;
  /** The value, already masked where the key is a secret (or unknown). */
  readonly text: string;
  /** The same, as a value: what `list --json` serializes (never the raw one). */
  readonly value: unknown;
}

/**
 * The file's settings, flattened to one line per leaf — `a.b.c` — sorted by path
 * (stable, greppable output whatever the file's key order), with every secret
 * masked. An array is a leaf (one line, JSON); an object recurses. A profile is
 * listed the same way, under `profiles.<name>.…`.
 */
export function flattenStored(
  value: unknown,
  prefix: readonly string[] = [],
): readonly StoredLine[] {
  return flattenInOrder(value, prefix).sort((a, b) => a.path.localeCompare(b.path));
}

/** The value at `segments` as it may be printed: the mask, or the value. */
const printedValue = (value: unknown, segments: readonly string[]): unknown => {
  const mask = maskOf(segments);
  if (mask === undefined) {
    return value;
  }
  return mask === ARRAY_MASK ? [MASK] : MASK;
};

function flattenInOrder(value: unknown, prefix: readonly string[]): StoredLine[] {
  if (!isObject(value)) {
    return prefix.length === 0
      ? []
      : [
          {
            path: prefix.join("."),
            text: renderStored(value, prefix),
            value: printedValue(value, prefix),
          },
        ];
  }
  const entries = Object.entries(value);
  if (entries.length === 0 && prefix.length > 0) {
    return [{ path: prefix.join("."), text: "{}", value: {} }];
  }
  return entries.flatMap(([name, child]) => {
    const segments = [...prefix, name];
    // A mask (a secret, or a key the schema does not know — owner Q-B) stops the
    // walk: one masked line, never a leaf-by-leaf leak, and never a masked parent
    // with its children beside it.
    return maskOf(segments) !== undefined
      ? [
          {
            path: segments.join("."),
            text: renderStored(child, segments),
            value: printedValue(child, segments),
          },
        ]
      : flattenInOrder(child, segments);
  });
}

/** A `[A-Za-z0-9_.-]` name, non-empty: what an unambiguous dotted path can hold. */
const SEGMENT = /^[A-Za-z0-9_$-]+$/;

/**
 * A user-given dotted key → its segments (eval A5). A map entry's name must be a
 * plain name so the dotted form stays unambiguous; a bracket form for a name
 * with a `.` in it is future work (recorded as debt).
 */
export function checkSegments(
  input: string,
):
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (input === "") {
    return { ok: false, error: "no key given" };
  }
  const segments = input.split(".");
  const empty = segments.findIndex((segment) => segment === "");
  if (empty >= 0) {
    return {
      ok: false,
      error: `"${input}" has an empty segment (segment ${empty + 1})`,
    };
  }
  const bad = segments.find((segment) => !SEGMENT.test(segment));
  if (bad !== undefined) {
    return {
      ok: false,
      error: `"${bad}" is not a plain key name (use letters, digits, "_", "-" and ".")`,
    };
  }
  return { ok: true, segments };
}

/**
 * The one line printed after a successful write (eval A6): config is read once at
 * start, so a change never reaches a running session, and whether a pod gets the
 * value is the registry's `carried`.
 */
export function appliesToText(doc: KeyDoc): string {
  const carried =
    doc.carried === "no"
      ? "not carried to a pod: one there uses its own"
      : "carried to a pod for a session opened after this (a pod session already open keeps its own)";
  return `applies to sessions started after this — a running \`serve\` keeps its value until restarted; ${carried}`;
}

/**
 * Read the config schema as a key tree: which paths are leaves, which are
 * sections, and what a leaf accepts. Pure introspection of the zod schema
 * (`schema.ts`), so nothing here has to be kept in sync by hand: add a key to
 * the schema and `key-docs.test.ts`'s T1 fails until the registry documents it.
 *
 * Also the two path helpers the CLI shares: a concrete path resolved to the
 * registry's canonical one (`mcpServers.fs.command` → `mcpServers.*.command`,
 * a map's free segment written `*`), and the nearest keys for a typo.
 *
 * Build-time-free and side-effect-free: no I/O, no registry import.
 */
import { FileConfigSchema } from "./schema.ts";

/** What a schema path is: a single value, or a node with children. */
export type KeyNodeKind = "leaf" | "section";

/** One path of the config schema. */
export interface KeyNode {
  /** The canonical path; a map's free segment is written `*`. */
  readonly path: string;
  readonly kind: KeyNodeKind;
  /** `boolean`, `string`, `integer`, `number`, `enum`, `array`, `map`, `object`, … */
  readonly type: string;
  /** Allowed values, for an `enum` (or a literal, merged across union branches). */
  readonly values?: readonly string[];
}

/** The parts of a zod type this module reads. Structural, so no zod import. */
interface ZodLike {
  readonly _def: { readonly typeName: string; readonly [key: string]: unknown };
}

const typeName = (t: ZodLike): string => t._def.typeName;

const innerOf = (t: ZodLike): ZodLike | undefined => {
  const method = (t as unknown as { innerType?: () => ZodLike }).innerType;
  const byMethod = typeof method === "function" ? method.call(t) : undefined;
  const byField = t._def.innerType as ZodLike | undefined;
  return byMethod ?? byField;
};

const shapeOf = (t: ZodLike): Record<string, ZodLike> | undefined =>
  (t as unknown as { shape?: Record<string, ZodLike> }).shape;

const optionsOf = (t: ZodLike): readonly ZodLike[] | undefined =>
  (t as unknown as { options?: readonly ZodLike[] }).options;

const valueSchemaOf = (t: ZodLike): ZodLike | undefined =>
  (t as unknown as { valueSchema?: ZodLike }).valueSchema;

const elementOf = (t: ZodLike): ZodLike | undefined =>
  (t as unknown as { element?: ZodLike }).element;

const literalOf = (t: ZodLike): unknown => (t as unknown as { value?: unknown }).value;

const checksOf = (t: ZodLike): readonly { readonly kind: string }[] =>
  (t._def.checks ?? []) as readonly { readonly kind: string }[];

/** Peel `optional`/`nullable`/`effects`/`default`/`catch` down to the real shape. */
function unwrap(t: ZodLike): ZodLike {
  let current = t;
  for (let i = 0; i < 32; i++) {
    const name = typeName(current);
    if (
      name !== "ZodOptional" &&
      name !== "ZodNullable" &&
      name !== "ZodEffects" &&
      name !== "ZodDefault" &&
      name !== "ZodCatch" &&
      name !== "ZodReadonly" &&
      name !== "ZodBranded" &&
      name !== "ZodPipeline"
    ) {
      return current;
    }
    const next = innerOf(current);
    if (next === undefined) {
      return current;
    }
    current = next;
  }
  return current;
}

/** A node as the walker sees it; a record's children are its `*` entry. */
type Desc =
  | {
      readonly kind: "section";
      readonly type: string;
      readonly fields: readonly (readonly [string, Desc])[];
    }
  | { readonly kind: "leaf"; readonly type: string; readonly values?: readonly string[] };

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const leafType = (t: ZodLike): Desc => {
  const name = typeName(t);
  switch (name) {
    case "ZodString":
      return { kind: "leaf", type: "string" };
    case "ZodNumber":
      return {
        kind: "leaf",
        type: checksOf(t).some((c) => c.kind === "int") ? "integer" : "number",
      };
    case "ZodBoolean":
      return { kind: "leaf", type: "boolean" };
    case "ZodEnum":
      return {
        kind: "leaf",
        type: "enum",
        values: optionsOf(t)?.map(String) ?? [],
      };
    case "ZodLiteral":
      return { kind: "leaf", type: "enum", values: [String(literalOf(t))] };
    case "ZodArray":
      return { kind: "leaf", type: "array" };
    case "ZodRecord":
      return { kind: "leaf", type: "map" };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (optionsOf(t) ?? []).map((option) => describe(option));
      return mergeLeaves(options);
    }
    default:
      return { kind: "leaf", type: name.replace(/^Zod/, "").toLowerCase() };
  }
};

/** Merge leaf descriptions (a field present in several union branches). */
function mergeLeaves(options: readonly Desc[]): Desc {
  const types = unique(options.map((o) => (o.kind === "section" ? "object" : o.type)));
  const values = unique(
    options.flatMap((o) => (o.kind === "leaf" && o.values !== undefined ? o.values : [])),
  );
  return {
    kind: "leaf",
    type: types.join("|"),
    ...(values.length > 0 ? { values } : {}),
  };
}

/** Describe one schema node (already unwrapped by the caller when needed). */
function describe(raw: ZodLike): Desc {
  const t = unwrap(raw);
  const name = typeName(t);
  if (name === "ZodObject") {
    const shape = shapeOf(t) ?? {};
    return {
      kind: "section",
      type: "object",
      fields: Object.entries(shape).map(([key, value]) => [key, describe(value)] as const),
    };
  }
  if (name === "ZodDiscriminatedUnion" || name === "ZodUnion") {
    const options = optionsOf(t) ?? [];
    const sections = options
      .map((option) => unwrap(option))
      .filter((o) => typeName(o) === "ZodObject");
    if (sections.length === options.length && sections.length > 0) {
      return mergeSections(sections);
    }
    return leafType(t);
  }
  if (name === "ZodRecord") {
    const value = valueSchemaOf(t);
    // A map has one child: its `*` entry, whatever the values are.
    return {
      kind: "section",
      type: "map",
      fields: value === undefined ? [] : [["*", describe(value)] as const],
    };
  }
  return leafType(t);
}

/** A discriminated union of objects: the union of their fields, first branch first. */
function mergeSections(sections: readonly ZodLike[]): Desc {
  const fields = new Map<string, Desc>();
  for (const section of sections) {
    const shape = shapeOf(unwrap(section)) ?? {};
    for (const [key, value] of Object.entries(shape)) {
      const next = describe(value);
      const previous = fields.get(key);
      if (previous === undefined) {
        fields.set(key, next);
        continue;
      }
      fields.set(
        key,
        previous.kind === "leaf" && next.kind === "leaf"
          ? mergeLeaves([previous, next])
          : previous.kind === next.kind
            ? previous
            : next,
      );
    }
  }
  return { kind: "section", type: "object", fields: [...fields.entries()] };
}

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/**
 * Every path of a zod schema, depth-first in the schema's own order. A node
 * with children (an object, a map, a union of objects) is a `section`; a
 * settable single value is a `leaf`. The ROOT object is the file itself, so
 * its fields are the top-level keys — there is no `""` path.
 */
export function schemaKeyNodes(schema: ZodLike): readonly KeyNode[] {
  const out: KeyNode[] = [];
  const root = unwrap(schema);
  if (typeName(root) !== "ZodObject") {
    throw new Error(`not a config schema: ${typeName(root)}`);
  }
  pushFields(
    Object.entries(shapeOf(root) ?? {}).map(([key, value]) => [key, describe(value)] as const),
    "",
    out,
  );
  return out;
}

/** Every path of the user's `config.jsonc` schema (`FileConfigSchema`). */
export function configKeyNodes(): readonly KeyNode[] {
  return schemaKeyNodes(FileConfigSchema as unknown as ZodLike);
}

const segments = (path: string): string[] => path.split(".");

/** A concrete path's segments; `undefined` if it is malformed (empty segments, spaces). */
function usableSegments(input: string): string[] | undefined {
  if (input === "") {
    return undefined;
  }
  const parts = segments(input);
  return parts.every((s) => s !== "" && s.trim() === s) ? parts : undefined;
}

/** Does a canonical (`*`-bearing) path match a concrete one, segment by segment? */
function matches(canonical: readonly string[], concrete: readonly string[]): boolean {
  return (
    canonical.length === concrete.length &&
    canonical.every((segment, i) => segment === "*" || segment === concrete[i])
  );
}

/**
 * A user-given concrete path → the schema node it names. `mcpServers.fs.command`
 * and `mcpServers.*.command` are the same node; `modle` and `model.` are nothing.
 */
export function resolveKeyPath(input: string): KeyNode | undefined {
  const concrete = usableSegments(input);
  if (concrete === undefined) {
    return undefined;
  }
  const wanted = concrete.join("\u0000");
  return configKeyNodes().find(
    (node) =>
      segments(node.path).join("\u0000") === wanted || matches(segments(node.path), concrete),
  );
}

function pushFields(
  fields: readonly (readonly [string, Desc])[],
  path: string,
  out: KeyNode[],
): void {
  for (const [key, desc] of fields) {
    pushField(key, desc, path, out);
  }
}

function pushField(key: string, desc: Desc, path: string, out: KeyNode[]): void {
  const childPath = join(path, key);
  if (desc.kind === "section") {
    out.push({ path: childPath, kind: "section", type: desc.type });
    pushFields(desc.fields, childPath, out);
    return;
  }
  out.push({
    path: childPath,
    kind: "leaf",
    type: desc.type,
    ...(desc.values !== undefined ? { values: desc.values } : {}),
  });
}

/** Levenshtein distance over two strings (no early exit: inputs are short). */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitute);
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

/**
 * A typo's distance from a canonical path: compare segment by segment, in
 * place. A `*` segment matches whatever the user wrote for free, a same-named
 * segment is free, a different one costs its own edit distance, and a whole
 * extra/missing segment costs {@link SEGMENT_COST}. Positional on purpose — a
 * general insert/delete alignment would call `zebra` "close to"
 * `mcpServers.*` (drop a segment, let `*` match the typo, for free).
 */
function pathDistance(canonical: readonly string[], concrete: readonly string[]): number {
  let cost = Math.abs(canonical.length - concrete.length) * SEGMENT_COST;
  const shared = Math.min(canonical.length, concrete.length);
  for (let i = 0; i < shared; i++) {
    const left = canonical[i] ?? "";
    const right = concrete[i] ?? "";
    cost += left === "*" || left === right ? 0 : editDistance(left, right);
  }
  return cost;
}

/** What one whole extra/missing path segment costs, in {@link pathDistance}. */
const SEGMENT_COST = 2;
/** How close a typo must be to be suggested at all. */
const MAX_DISTANCE = 2;
/** …or, sharing the first segment (a sibling under a known section), how far. */
const MAX_SIBLING_DISTANCE = 3;

/**
 * Up to `max` paths a likely typo meant: closest first, never a guess when
 * nothing is close. A map's `*` matches whatever the user wrote there.
 */
export function nearestKeys(input: string, paths: readonly string[], max = 3): readonly string[] {
  const concrete = usableSegments(input);
  if (concrete === undefined || paths.length === 0) {
    return [];
  }
  const scored: { path: string; distance: number }[] = [];
  for (const path of paths) {
    const canonical = segments(path);
    const distance = pathDistance(canonical, concrete);
    const sameRoot = canonical[0] === concrete[0];
    if (distance <= MAX_DISTANCE || (sameRoot && distance <= MAX_SIBLING_DISTANCE)) {
      scored.push({ path, distance });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
  return unique(scored.map((s) => s.path)).slice(0, max);
}

/**
 * `TENTACLE_*` names `@tentacle/config` reads that belong to no key: the
 * config dir, the profile selector, and the two folder overrides (hook env,
 * package dir). T3b's reverse scan requires every other name to be a registry
 * `env`.
 */
export const NON_KEY_ENV: readonly string[] = [
  "TENTACLE_CONFIG_DIR",
  "TENTACLE_PACKAGE_DIR",
  "TENTACLE_PROFILE",
  "TENTACLE_PROJECT_DIR",
];

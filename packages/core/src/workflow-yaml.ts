/**
 * The workflow draft's canonical YAML (docs/feat/workflow-editor.md D1).
 *
 * A draft is the workflow mapping itself — the value `Bun.YAML.parse` gives,
 * not a second model — plus its prompt files beside it. `workflowYaml` turns it
 * back into bytes in a FIXED key order, and `isCanonical` says whether a file on
 * disk already has those bytes (false = a save rewrites its layout/comments,
 * owner answer 3).
 *
 * Why a hand-written emitter and not a YAML library: `@tentacle/core` is in the
 * phone's bundle, where a YAML writer is a dependency it does not have. Emitting
 * is the easy half — a string is written `plain` ONLY when a conservative
 * pattern proves YAML reads it back as that same string, and is JSON-quoted
 * otherwise (a JSON string is a YAML double-quoted scalar in YAML 1.2). The
 * round trip `parse(workflowYaml(d)) === d` is the property, and it is pinned by
 * `core/test/workflow-yaml.test.ts` over every hostile string we could name.
 *
 * Pure: no I/O, no clock, no React.
 */
import {
  WORKFLOW_DEFAULT_MAX_STEP_RUNS,
  WORKFLOW_DEFAULT_WAIT_MS,
  parseWorkflowDuration,
  workflowStructureProblem,
} from "./workflow-spec.ts";

/** What an editor holds: the parsed workflow mapping, as YAML gave it. */
export type WorkflowDraft = Readonly<Record<string, unknown>>;

/** Key order = the order of the `zWorkflow` schema (a diff reads as the schema). */
const ROOT_ORDER = ["schemaVersion", "name", "version", "description", "inputs", "budget", "steps"];
const STEP_ORDER = [
  "id",
  "agent",
  "run",
  "approve",
  "where",
  "timeout",
  "retry",
  "on_fail",
  "next",
];
const AGENT_ORDER = ["prompt", "prompt_text", "model", "type", "tokens"];
const APPROVE_ORDER = ["title", "detail"];
const ON_FAIL_ORDER = ["goto", "max"];
const WHERE_ORDER = ["docker"];
const INPUT_ORDER = ["required", "default"];
const BUDGET_ORDER = ["tokens", "wait", "max_step_runs"];

/** Scalars YAML 1.1/1.2 resolve to something other than the string itself. */
const RESERVED = new Set([
  "",
  "~",
  "null",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "=",
  "<<",
]);

/** Numbers, in every base and shape YAML reads as a number. */
const NUMERIC =
  /^[-+]?(\d[\d_]*(\.[\d_]*)?([eE][-+]?\d+)?|0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\.[0-9_]+)$/;

/** Dates/times YAML's resolver may turn into a timestamp. */
const DATE_LIKE = /^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}:\d{2}(:\d{2})?$/;

/** Letters/digits to start; a bounded punctuation set inside. Nothing exotic. */
const PLAIN_BODY = /^[A-Za-z0-9_][A-Za-z0-9 _\-.,/:()@+]*$/;

/** A string YAML reads back unchanged when written bare. */
function plainSafe(text: string): boolean {
  if (!PLAIN_BODY.test(text)) return false;
  if (text !== text.trim()) return false;
  if (text.includes(": ") || text.endsWith(":") || text.includes(" #")) return false;
  if (RESERVED.has(text.toLowerCase())) return false;
  if (NUMERIC.test(text) || DATE_LIKE.test(text)) return false;
  return true;
}

/** C0 controls but tab and newline: YAML refuses them raw (a block holds them raw). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are the point
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f]/;

/** Half a UTF-16 pair: no YAML escape names it, so no file can hold it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A string that survives a `|-` literal block: every line non-empty and free of
 * leading/trailing whitespace, no CR or other C0 control (only tab), and no
 * trailing newline (`|-` strips it). Anything less is JSON-quoted — ugly in a
 * file, never wrong (JSON escapes every control).
 */
function blockSafe(text: string): boolean {
  if (!text.includes("\n") || RAW_CONTROL.test(text) || text.endsWith("\n")) return false;
  if (LONE_SURROGATE.test(text)) return false;
  return text.split("\n").every((line) => line !== "" && line.trim() === line);
}

/**
 * The emitter is total over what YAML can hold; a lone surrogate it cannot, so
 * it throws (naming the path) rather than write bytes that never load back.
 */
function quoted(text: string, path: string): string {
  if (LONE_SURROGATE.test(text)) {
    throw new Error(`${path}: a lone UTF-16 surrogate cannot be written as YAML`);
  }
  return JSON.stringify(text);
}

function scalarText(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (value === Number.POSITIVE_INFINITY) return ".inf";
    if (value === Number.NEGATIVE_INFINITY) return "-.inf";
    return String(value);
  }
  if (typeof value === "string") return plainSafe(value) ? value : quoted(value, path);
  // Not reachable from a parsed workflow; refuse rather than write a guess.
  throw new Error(`workflowYaml: cannot write a ${typeof value} as a scalar`);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key order for the mapping at `path`, unknown keys sorted after. */
function orderFor(path: string): readonly string[] {
  if (path === "root") return ROOT_ORDER;
  if (/\.steps\[\d+\]$/.test(path)) return STEP_ORDER;
  if (/\.steps\[\d+\]\.agent$/.test(path)) return AGENT_ORDER;
  if (/\.steps\[\d+\]\.approve$/.test(path)) return APPROVE_ORDER;
  if (/\.steps\[\d+\]\.on_fail$/.test(path)) return ON_FAIL_ORDER;
  if (/\.steps\[\d+\]\.where$/.test(path)) return WHERE_ORDER;
  if (/^root\.inputs\.[^.[\]]+$/.test(path)) return INPUT_ORDER;
  if (path === "root.budget") return BUDGET_ORDER;
  return [];
}

/**
 * A value equal to the schema's default is left out: the mockup's rule is that
 * defaults never land in the file (a `wait: 12h` typed in is the same file as
 * one without it, so it canonicalises away).
 */
function isDefault(path: string, key: string, value: unknown): boolean {
  if (path !== "root.budget") return false;
  if (key === "wait") {
    return typeof value === "string" && parseWorkflowDuration(value) === WORKFLOW_DEFAULT_WAIT_MS;
  }
  if (key === "max_step_runs") return value === WORKFLOW_DEFAULT_MAX_STEP_RUNS;
  return false;
}

/** The mapping's entries for emission: defaults dropped, `undefined` dropped. */
function entriesOf(value: Record<string, unknown>, path: string): [string, unknown][] {
  const order = orderFor(path);
  const unknownKeys = Object.keys(value)
    .filter((key) => !order.includes(key))
    .sort();
  const keys = [...order.filter((key) => key in value), ...unknownKeys];
  return keys
    .filter((key) => value[key] !== undefined && !isDefault(path, key, value[key]))
    .map((key) => [key, value[key]] as [string, unknown]);
}

/** One `key:` line and its body. */
function emitPair(head: string, value: unknown, indent: number, path: string): string[] {
  if (isMapping(value)) {
    const entries = entriesOf(value, path);
    // A mapping whose every key was a default (`budget: {wait: 12h}`) is
    // dropped whole: the point of the rule is that the KEY does not land.
    if (entries.length === 0 && Object.keys(value).length > 0) return [];
    if (entries.length === 0) return [`${head} {}`];
    return [head, ...emitMapping(entries, indent + 2, path)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${head} []`];
    return [head, ...emitSequence(value, indent + 2, path)];
  }
  if (typeof value === "string" && blockSafe(value)) {
    const pad = " ".repeat(indent + 2);
    return [`${head} |-`, ...value.split("\n").map((line) => `${pad}${line}`)];
  }
  return [`${head} ${scalarText(value, path)}`];
}

function emitMapping(
  entries: readonly [string, unknown][],
  indent: number,
  path: string,
): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const [key, value] of entries) {
    const keyText = plainSafe(key) ? key : quoted(key, `${path}.${key}`);
    out.push(...emitPair(`${pad}${keyText}:`, value, indent, `${path}.${key}`));
  }
  return out;
}

function emitSequence(items: readonly unknown[], indent: number, path: string): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const [i, item] of items.entries()) {
    const at = `${path}[${i}]`;
    if (isMapping(item)) {
      const entries = entriesOf(item, at);
      if (entries.length === 0) {
        out.push(`${pad}- {}`);
        continue;
      }
      const body = emitMapping(entries, indent + 2, at);
      const [first, ...rest] = body;
      if (first === undefined) {
        out.push(`${pad}- {}`);
        continue;
      }
      out.push(`${pad}- ${first.trimStart()}`, ...rest);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        out.push(`${pad}- []`);
        continue;
      }
      out.push(`${pad}-`, ...emitSequence(item, indent + 2, at));
      continue;
    }
    out.push(...emitPair(`${pad}-`, item, indent, at));
  }
  return out;
}

/** The draft as canonical YAML bytes, one trailing newline. */
export function workflowYaml(draft: WorkflowDraft): string {
  const entries = entriesOf(draft, "root");
  const lines = emitMapping(entries, 0, "root");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * `true` when the file already holds the emitter's bytes (a BOM aside), so a
 * save rewrites nothing. `false` means comments or a layout of its own are about
 * to be replaced — the Review screen warns and shows the patch (owner answer 3).
 */
export function isCanonical(text: string, draft: WorkflowDraft): boolean {
  const bare = text.startsWith("\ufeff") ? text.slice(1) : text;
  return bare === workflowYaml(draft);
}

/**
 * The draft an editor opens: the STRUCTURAL check only (`workflowStructureProblem`
 * — types and shape), so a file whose `next:` names a missing step still opens
 * and shows that as a problem, while a non-mapping or a wrong-typed field does
 * not (there is nothing to edit; the bar says why). Defaults are dropped, so the
 * draft in hand is the file a save would write.
 */
export function asDraft(raw: unknown): { draft: WorkflowDraft } | { unreadable: string } {
  const problem = workflowStructureProblem(raw);
  if (problem !== undefined) return { unreadable: problem };
  const mapping = { ...(raw as Record<string, unknown>) };
  const budget = mapping.budget;
  if (!isMapping(budget)) return { draft: mapping };
  const kept = entriesOf(budget, "root.budget");
  if (kept.length === Object.keys(budget).length) return { draft: mapping };
  // A budget that was ALL defaults goes with its key (the file a save writes
  // does not carry it); anything else keeps only the keys that survive.
  const { budget: _allDefaults, ...rest } = mapping;
  return {
    draft: kept.length === 0 ? rest : { ...rest, budget: Object.fromEntries(kept) },
  };
}

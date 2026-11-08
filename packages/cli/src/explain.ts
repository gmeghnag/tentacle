/**
 * `tentacle explain [key] [--all] [--json]` (docs/feat/config-explain.md,
 * docs/eval/config-cli.md task 2). PURE: it reads the key registry and nothing
 * else — no `config.jsonc`, no env, no I/O — so it works offline, on a broken
 * config, and in CI (eval Q8 = (a): the effective value is `config show`'s job).
 *
 * It navigates BY LEVEL, as the owner asked:
 *   explain              → the top-level keys, one line each, a section with
 *                          its count of direct sub-keys;
 *   explain <section>    → the section's summary, then its direct children;
 *   explain <leaf>       → the full card;
 *   explain --all        → every leaf, flat and sorted, for grep.
 *
 * Every rendering decision (which level, what a line says, what a card holds)
 * lives here, not in `main.ts`: the component is only `out`/`err` plus the exit
 * code (AGENTS §7: logic in pure modules, components only render).
 */
import {
  KEY_DOCS,
  type KeyDoc,
  type KeyKind,
  type KeyScope,
  configKeyNodes,
  directChildren,
  keyDoc,
  leafPaths,
  nearestKeys,
  resolveKeyPath,
  topLevelKeys,
} from "@tentacle/config";

/** One node, flattened for printing (text or JSON). */
export interface ExplainEntry {
  readonly path: string;
  readonly kind: KeyKind;
  readonly summary: string;
  readonly scope: KeyScope;
  readonly carried: KeyDoc["carried"];
  readonly type?: string;
  readonly values?: readonly string[];
  /** The built-in default as a value (`4`, `true`, `"read-only"`, `["/tmp"]`). */
  readonly default?: unknown;
  readonly env?: string;
  /** `true` when the env var is inverted (a truthy value turns the setting OFF). */
  readonly envInverts?: true;
  readonly flag?: string;
  readonly secret?: true | "values";
  readonly example?: string;
  readonly details?: string;
  /** The number of DIRECT sub-keys, for a section. */
  readonly subKeys?: number;
}

/** What `explain` was asked and what it found. */
export type ExplainResult =
  | {
      readonly ok: true;
      readonly level: "top" | "section" | "leaf" | "all";
      /** The section asked about (its own summary heads the output), if any. */
      readonly section?: ExplainEntry;
      readonly entries: readonly ExplainEntry[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly suggestions: readonly string[];
    };

const MAX_SUGGESTIONS = 3;

/** The canonical registry paths a typo is scored against. */
function allPaths(): readonly string[] {
  return [...Object.keys(KEY_DOCS), ...configKeyNodes().map((node) => node.path)].filter(
    (path, index, all) => all.indexOf(path) === index,
  );
}

/** A registry entry → the print model, with its raw default. */
function entryOf(path: string): ExplainEntry | undefined {
  const doc = keyDoc(path);
  if (doc === undefined) {
    return undefined;
  }
  const fallback = doc.default?.();
  const children = doc.kind === "section" ? directChildren(path) : [];
  return {
    path,
    kind: doc.kind,
    summary: doc.summary,
    scope: doc.scope,
    carried: doc.carried,
    ...(doc.type !== undefined ? { type: doc.type } : {}),
    ...(doc.values !== undefined ? { values: doc.values } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(doc.env !== undefined ? { env: doc.env } : {}),
    ...(doc.envInverts === true ? { envInverts: true as const } : {}),
    ...(doc.flag !== undefined ? { flag: doc.flag } : {}),
    ...(doc.secret !== undefined ? { secret: doc.secret } : {}),
    ...(doc.example !== undefined ? { example: doc.example } : {}),
    ...(doc.details !== undefined ? { details: doc.details } : {}),
    ...(children.length > 0 ? { subKeys: children.length } : {}),
  };
}

function entriesOf(paths: readonly string[]): readonly ExplainEntry[] {
  return paths
    .map((path) => entryOf(path))
    .filter((entry): entry is ExplainEntry => entry !== undefined);
}

const fail = (error: string, suggestions: readonly string[] = []): ExplainResult => ({
  ok: false,
  error,
  suggestions,
});

/**
 * Answer `explain <key>`. A key resolves through the schema, so a map's free
 * segment works as written (`mcpServers.fs.command`) and the answer names the
 * canonical path (`mcpServers.*.command`).
 */
export function explain(
  key: string | undefined,
  opts: { readonly all?: boolean } = {},
): ExplainResult {
  const all = opts.all === true;
  if (key === undefined) {
    if (all) {
      return {
        ok: true,
        level: "all",
        entries: entriesOf(leafPaths().filter((path) => !path.startsWith("profiles.*."))),
      };
    }
    return { ok: true, level: "top", entries: entriesOf(topLevelKeys()) };
  }
  if (all) {
    return fail(`--all lists every key; give one or the other, not both (--all with "${key}")`);
  }
  const trimmed = key.trim();
  const node = resolveKeyPath(trimmed);
  if (node === undefined) {
    return fail(`unknown config key "${key}"`, nearestKeys(trimmed, allPaths(), MAX_SUGGESTIONS));
  }
  const entry = entryOf(node.path);
  if (entry === undefined) {
    // A schema path with no registry entry: T1 makes this unreachable, and if
    // it ever happens the message must not pretend to know the key.
    return fail(`no documentation for "${node.path}"`, nearestKeys(trimmed, allPaths()));
  }
  if (entry.kind === "section") {
    return {
      ok: true,
      level: "section",
      section: entry,
      entries: entriesOf(directChildren(entry.path)),
    };
  }
  return { ok: true, level: "leaf", entries: [entry] };
}

/** A default value rendered short, for a `= …` on a list line or a card. */
function shortDefault(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? "" : rendered;
}

/** The widest path a `(N sub-keys)` / `= default` column has to fit under. */
const COLUMN = 44;

/**
 * One key of a list (the top level, a section's children): ONE line — the
 * path, its sub-key count or its short default, then its summary.
 */
function listLine(entry: ExplainEntry, width: number): string {
  const lead = listLead(entry);
  return `${lead}${" ".repeat(Math.max(2, width - lead.length))}${entry.summary}`;
}

/** The left column of a list line: the indented path, and its count/default. */
function listLead(entry: ExplainEntry): string {
  const marker =
    entry.subKeys !== undefined
      ? ` (${entry.subKeys} sub-key${entry.subKeys === 1 ? "" : "s"})`
      : entry.default !== undefined && shortDefault(entry.default).length <= 24
        ? ` = ${shortDefault(entry.default)}`
        : "";
  return `  ${entry.path}${marker}`;
}

/** The width the path column of one list needs, so the summaries line up. */
function columnOf(entries: readonly ExplainEntry[]): number {
  return Math.max(COLUMN, ...entries.map((entry) => listLead(entry).length + 2));
}

/** Where a leaf may be written: the top-level file, a profile, or both. */
function scopeText(scope: KeyScope): string {
  if (scope === "user") {
    return "the top-level config.jsonc only (never in a profile)";
  }
  if (scope === "profile") {
    return "a profile only";
  }
  return "the file and a profile";
}

/** Whether, and how, the laptop carries the key into a pod. */
function carriedText(carried: KeyDoc["carried"]): string {
  if (carried === "pinned") {
    return "carried to a pod (pinned: the laptop decides, beating the pod's own file and env)";
  }
  if (carried === "workspace") {
    return "carried to a pod (workspace: the laptop's value is the lowest layer)";
  }
  return "not carried: a pod uses its own value";
}

/** The full card: every fact the owner asked for, one labelled line each. */
function cardLines(entry: ExplainEntry): string[] {
  const out: string[] = [`${entry.path}`, "", entry.summary];
  if (entry.details !== undefined) {
    out.push("", entry.details);
  }
  out.push("");
  if (entry.type !== undefined) {
    out.push(`  type         ${entry.type}`);
  }
  if (entry.values !== undefined && entry.values.length > 0) {
    out.push(`  values       ${entry.values.join(" | ")}`);
  }
  if (entry.secret !== undefined) {
    out.push(
      `  secret       yes — never printed (masked as ***); open the file to read it${
        entry.secret === "values" ? " (every value under this key is masked)" : ""
      }`,
    );
  }
  out.push(
    `  default      ${entry.default === undefined ? "unset (see above)" : shortDefault(entry.default)}`,
  );
  out.push(`  env          ${envText(entry)}`);
  out.push(`  flag         ${entry.flag ?? "—"}`);
  out.push(`  carried      ${carriedText(entry.carried)}`);
  out.push(`  scope        ${scopeText(entry.scope)}`);
  if (entry.example !== undefined) {
    out.push(`  example      ${oneLine(entry.example)}`);
  }
  return out;
}

function envText(entry: ExplainEntry): string {
  if (entry.env === undefined) {
    return "— (file only)";
  }
  return entry.envInverts === true
    ? `${entry.env} (inverted: a truthy value turns the setting OFF)`
    : entry.env;
}

/** An example value on one line: a multi-line array/object is collapsed. */
function oneLine(example: string): string {
  return example
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The text the command prints (STDOUT: this is the command's data). An error
 * renders as `""` — `main` prints it on STDERR with its suggestions, so the
 * data stream stays free of prose.
 */
export function renderExplainText(result: ExplainResult): string {
  if (!result.ok) {
    return "";
  }
  if (result.level === "leaf") {
    return `${cardLines(result.entries[0] as ExplainEntry).join("\n")}\n`;
  }
  if (result.level === "all") {
    return `${result.entries.map((entry) => entry.path).join("\n")}\n`;
  }
  const head =
    result.level === "section" && result.section !== undefined
      ? [`${result.section.path} — ${result.section.summary}`, ""]
      : [];
  const column = columnOf(result.entries);
  return `${[...head, ...result.entries.map((entry) => listLine(entry, column))].join("\n")}\n`;
}

/** The same model as JSON (STDOUT), for scripts and editors. */
export function renderExplainJson(result: ExplainResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** The error line `main` prints on STDERR, suggestions included. */
export function explainErrorText(result: ExplainResult): string {
  if (result.ok) {
    return "";
  }
  const hint =
    result.suggestions.length === 0
      ? "\nrun `tentacle explain` for the top-level keys"
      : `\ndid you mean ${result.suggestions.join(", ")}?`;
  return `[error] ${result.error}${hint}\n`;
}

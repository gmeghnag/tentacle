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
  /** The default as TEXT, when it is runtime state (`$TMPDIR` and `/tmp`). */
  readonly defaultText?: string;
  readonly env?: string;
  /** How the env var is written (`:"-separated; empty = []`), when it matters. */
  readonly envNote?: string;
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
      /**
       * The key was a sentence, not a path: the user meant it as a prompt
       * (review O1). The way back is `tentacle -- <prompt>`, and only the
       * caller knows the whole argv, so it builds that line (`promptHint`).
       */
      readonly prompt?: true;
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
    ...(doc.defaultText !== undefined ? { defaultText: doc.defaultText } : {}),
    ...(doc.env !== undefined ? { env: doc.env } : {}),
    ...(doc.envNote !== undefined ? { envNote: doc.envNote } : {}),
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

const fail = (
  error: string,
  suggestions: readonly string[] = [],
  prompt?: true,
): ExplainResult => ({
  ok: false,
  error,
  suggestions,
  ...(prompt === true ? { prompt: true as const } : {}),
});

/**
 * `explain` is a subcommand, so a word that names one is never a prompt
 * (docs/feat/config-explain.md, review O1 — the owner accepted it). The way
 * back is `tentacle -- <prompt>`, and an error that leaves the user stuck is
 * the half of the trade-off that is not acceptable: say it, exactly. `words`
 * are the argv after `tentacle`, i.e. the prompt the old build would have sent.
 */
export function promptHint(words: readonly string[]): string {
  return `to send this as a prompt, use: tentacle -- ${words.join(" ")}`;
}

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
    // A whole sentence is not a typo: it is a prompt the user expected to be
    // sent (O1). Suggesting keys would be noise, so the caller gets `prompt`
    // and answers with the way back instead of a "did you mean".
    if (/\s/.test(trimmed)) {
      return fail(`unknown config key "${key}"`, [], true);
    }
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
function shortDefault(entry: ExplainEntry): string {
  if (entry.defaultText !== undefined) {
    return entry.defaultText;
  }
  const rendered = JSON.stringify(entry.default);
  return rendered === undefined ? "" : rendered;
}

/** The width `explain` fits its output to when the terminal does not say. */
export const DEFAULT_WIDTH = 80;

/** The least room a summary is given beside its path before the column is capped. */
const MIN_SUMMARY = 24;

/**
 * Greedy word wrap. A word longer than the width (a long path, a URL) is kept
 * whole: breaking it mid-token would make it unsearchable, which is the one
 * thing this output is for.
 */
function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= limit) {
      line = `${line} ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  lines.push(line);
  return lines;
}

/** The narrowest path column worth aligning to (a short list still lines up). */
const MIN_COLUMN = 24;

/**
 * One key of a list (the top level, a section's children): the path, its
 * sub-key count or its short default, then its summary — wrapped to `width`,
 * with the continuation under the summary column so the path reads as a left
 * margin (review LOW 6: at 80 columns the old form ran to 108 and the terminal
 * then broke it mid-word).
 */
function listLines(entry: ExplainEntry, column: number, width: number): string[] {
  const lead = listLead(entry);
  const pad = column - lead.length;
  if (pad < 2) {
    // The path is wider than the column: the annotation goes under it rather
    // than pushing the line past the width.
    return [lead, ...wrap(entry.summary, width - 2).map((line) => `  ${line}`)];
  }
  const cont = " ".repeat(column);
  const wrapped = wrap(entry.summary, width - column);
  return wrapped.map((line, i) =>
    i === 0 ? `${lead}${" ".repeat(pad)}${line}` : `${cont}${line}`,
  );
}

/** The left column of a list line: the indented path, and its count/default. */
function listLead(entry: ExplainEntry): string {
  const fallback = shortDefault(entry);
  const marker =
    entry.subKeys !== undefined
      ? ` (${entry.subKeys} sub-key${entry.subKeys === 1 ? "" : "s"})`
      : entry.default !== undefined && fallback.length <= 24
        ? ` = ${fallback}`
        : "";
  return `  ${entry.path}${marker}`;
}

/**
 * The width of the path column: wide enough for this list's leads, never so
 * wide that a summary has no room left on a narrow terminal.
 */
function columnOf(entries: readonly ExplainEntry[], width: number): number {
  const wanted = Math.max(MIN_COLUMN, ...entries.map((entry) => listLead(entry).length + 2));
  return Math.max(4, Math.min(wanted, width - MIN_SUMMARY));
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

/** The indent of a card's labelled lines (`  type         …`). */
const LABEL = 15;

/** One labelled card line, its value wrapped under the label. */
function field(label: string, value: string, width: number): string[] {
  const head = `  ${label.padEnd(LABEL - 2)}`;
  const wrapped = wrap(value, width - LABEL);
  return wrapped.map((line, i) => (i === 0 ? `${head}${line}` : `${" ".repeat(LABEL)}${line}`));
}

/** The full card: every fact the owner asked for, one labelled line each. */
function cardLines(entry: ExplainEntry, width: number): string[] {
  const out: string[] = [entry.path, "", ...wrap(entry.summary, width)];
  if (entry.details !== undefined) {
    out.push("", ...wrap(entry.details, width));
  }
  out.push("");
  if (entry.type !== undefined) {
    out.push(...field("type", entry.type, width));
  }
  if (entry.values !== undefined && entry.values.length > 0) {
    out.push(...field("values", entry.values.join(" | "), width));
  }
  if (entry.secret !== undefined) {
    out.push(
      ...field(
        "secret",
        `yes — never printed (masked as ***); open the file to read it${
          entry.secret === "values" ? " (every value under this key is masked)" : ""
        }`,
        width,
      ),
    );
  }
  out.push(
    ...field(
      "default",
      entry.default === undefined && entry.defaultText === undefined
        ? "unset (see above)"
        : shortDefault(entry),
      width,
    ),
  );
  out.push(...field("env", envText(entry), width));
  out.push(...field("flag", entry.flag ?? "—", width));
  out.push(...field("carried", carriedText(entry.carried), width));
  out.push(...field("scope", scopeText(entry.scope), width));
  if (entry.example !== undefined) {
    out.push(...field("example", oneLine(entry.example), width));
  }
  return out;
}

function envText(entry: ExplainEntry): string {
  if (entry.env === undefined) {
    return "— (file only)";
  }
  const value =
    entry.envInverts === true
      ? `${entry.env} (inverted: a truthy value turns the setting OFF)`
      : entry.env;
  return entry.envNote !== undefined ? `${value} (${entry.envNote})` : value;
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
 *
 * `opts.width` is the terminal's width, read by `main` and passed in so this
 * stays pure (review LOW 6). 80 when the terminal does not say.
 */
export function renderExplainText(
  result: ExplainResult,
  opts: { readonly width?: number } = {},
): string {
  if (!result.ok) {
    return "";
  }
  const width = opts.width !== undefined && opts.width > 0 ? opts.width : DEFAULT_WIDTH;
  if (result.level === "leaf") {
    return `${cardLines(result.entries[0] as ExplainEntry, width).join("\n")}\n`;
  }
  if (result.level === "all") {
    return `${result.entries.map((entry) => entry.path).join("\n")}\n`;
  }
  const head =
    result.level === "section" && result.section !== undefined
      ? [
          ...wrap(`${result.section.path} — ${result.section.summary}`, width),
          "",
          ...(result.section.details !== undefined
            ? [...wrap(result.section.details, width), ""]
            : []),
        ]
      : [];
  const column = columnOf(result.entries, width);
  const lines = result.entries.flatMap((entry) => listLines(entry, column, width));
  return `${[...head, ...lines].join("\n")}\n`;
}

/** The same model as JSON (STDOUT), for scripts and editors. */
export function renderExplainJson(result: ExplainResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * The error line `main` prints on STDERR, suggestions (or the caller's
 * `promptHint`) included.
 */
export function explainErrorText(
  result: ExplainResult,
  opts: { readonly hint?: string } = {},
): string {
  if (result.ok) {
    return "";
  }
  // An explicit hint wins: it is the answer the user needs (`tentacle -- …`),
  // not a guess at a key they did not mean. It always sits on its own line.
  const hint =
    opts.hint !== undefined
      ? `\n${opts.hint}`
      : result.suggestions.length === 0
        ? "\nrun `tentacle explain` for the top-level keys"
        : `\ndid you mean ${result.suggestions.join(", ")}?`;
  return `[error] ${result.error}${hint}\n`;
}

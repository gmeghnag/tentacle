import { randomUUID } from "node:crypto";
/**
 * `tentacle config set/unset/get/list/path` — the write path and its thin I/O
 * (docs/feat/config-set.md).
 *
 * Everything that decides is pure and lives elsewhere: the argv model
 * (`config-args.ts`), the edit plan with its validate-before-write and text
 * re-check (`@tentacle/config`'s `config-edit.ts`), the typing, secrets, masking
 * and the "applies to" line (`config-value.ts`). THIS file only touches files,
 * behind {@link ConfigFs} — an injectable seam, so the atomic-write and
 * read-modify-write failures (eval T11/T12) are tested without real timing or
 * real permission games.
 *
 * Safety rules that are not negotiable here (eval A3/A4):
 *  - validate BEFORE writing: a refused edit leaves the file byte-identical;
 *  - atomic: temp in the same dir + rename, the original's mode, 0600 for a new
 *    file, a new dir 0700, a symlink written THROUGH (realpath, the link stays);
 *  - re-stat right before the rename; a change → re-read and retry ONCE, then
 *    "changed while editing" — never a lost edit;
 *  - no output, and no error, ever contains a secret value.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type EditOp,
  KEY_DOCS,
  appliesToText,
  checkSegments,
  configKeyNodes,
  docForKey,
  flattenStored,
  isArgvRefusedSecret,
  nearestKeys,
  parseConfigText,
  planConfigEdit,
  readPath,
  renderStored,
  resolveKeyPath,
  secretOf,
  typeConfigValue,
  validateFileConfig,
} from "@tentacle/config";
import type { ConfigOp } from "./config-args.ts";

/** What `stat` says about the config file. */
export interface FileStat {
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly kind: "file" | "other";
}

/**
 * The file operations `config` needs, so a test can make the rename fail, the
 * file change under a write, or the path be a symlink (eval T11/T12).
 */
export interface ConfigFs {
  readText(path: string): string;
  stat(path: string): FileStat;
  /** What is at `path`: a regular file, a symlink, another kind, or nothing. */
  kind(path: string): "file" | "symlink" | "other" | "missing";
  realpath(path: string): string;
  /** `mkdir -p` with mode 0700. */
  ensureDir(dir: string): void;
  /** Write a temp file BESIDE `path` and return its name. */
  writeTemp(path: string, text: string, mode: number): string;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";

/** The real filesystem. The only place here that imports `node:fs` mutators. */
export const nodeConfigFs: ConfigFs = {
  readText: (path) => readFileSync(path, "utf8"),
  stat: (path) => {
    const s = statSync(path);
    return { mode: s.mode, mtimeMs: s.mtimeMs, size: s.size, kind: s.isFile() ? "file" : "other" };
  },
  kind: (path) => {
    try {
      const s = lstatSync(path);
      if (s.isSymbolicLink()) return "symlink";
      return s.isFile() ? "file" : "other";
    } catch (error) {
      return codeOf(error) === "ENOENT" ? "missing" : "other";
    }
  },
  realpath: (path) => realpathSync(path),
  ensureDir: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
  writeTemp: (path, text, mode) => {
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    writeFileSync(temp, text, { mode });
    // `writeFileSync`'s mode is masked by the umask; an existing file's exact bits
    // (0640, say) and a secret file's 0600 are the point, so set them.
    chmodSync(temp, mode);
    return temp;
  },
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

export interface ConfigRunInput {
  readonly op: ConfigOp;
  /** The user file: `<configDir>/config.jsonc`. */
  readonly configPath: string;
  /** `--profile <name>`: target `profiles.<name>.` in the same file. */
  readonly profile?: string;
  readonly json: boolean;
  /** `--yes`: skip the confirmation of a destructive unset. */
  readonly yes: boolean;
  /** Is stdin a terminal (a bare `config <key>` prompts only then)? */
  readonly isStdinTerminal: boolean;
  readonly fs?: ConfigFs;
  /** The y/N question (`main` supplies one on a terminal, with `--yes` skipping). */
  readonly ask?: (prompt: string) => Promise<string>;
  /** stdin to EOF (`config <key> -`). */
  readonly readStdin?: () => Promise<string>;
  /** A hidden prompt on a terminal (no echo: the value may be a key). */
  readonly readSecret?: (prompt: string) => Promise<string>;
}

export interface ConfigRunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const MAX_SUGGESTIONS = 3;

/** Every canonical path a typo is scored against (registry + schema walker). */
const allPaths = (): readonly string[] => [
  ...new Set([...Object.keys(KEY_DOCS), ...configKeyNodes().map((node) => node.path)]),
];

const line = (text: string): string => `${text}\n`;

/** `**`-free mention of a path: the config file as the user wrote it. */
const shown = (path: string): string => `\`${path}\``;

/**
 * One trailing newline trimmed, and nothing else: `printf 'sk-x\n' | tentacle
 * config model.apiKey -` stores `sk-x`, while a value that really ends in a
 * newline is not silently reshaped beyond that (eval A4).
 */
const trimOneNewline = (text: string): string =>
  text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;

interface Target {
  /** The concrete segments in the file (`profiles.work.model.model`). */
  readonly segments: readonly string[];
  /** The canonical registry path (`profiles.*.model.model`). */
  readonly canonical: string;
  /** The key as the user wrote it, for messages. */
  readonly key: string;
}

const unknownKey = (key: string): ConfigRunResult => {
  const suggestions = nearestKeys(key, allPaths(), MAX_SUGGESTIONS);
  const hint =
    suggestions.length === 0
      ? "run `tentacle explain` to see the top-level keys"
      : `did you mean ${suggestions.join(", ")}?`;
  return { code: 1, out: "", err: line(`[error] unknown config key "${key}"`) + line(hint) };
};

/** A key + the target file → its concrete segments and its canonical path. */
function resolveTarget(key: string, profile: string | undefined): Target | ConfigRunResult {
  const checked = checkSegments(key);
  if (!checked.ok) {
    return { code: 1, out: "", err: line(`[error] ${checked.error}`) };
  }
  const segments =
    profile !== undefined ? ["profiles", profile, ...checked.segments] : [...checked.segments];
  const concrete = segments.join(".");
  const node = resolveKeyPath(concrete);
  if (node === undefined) {
    return unknownKey(key);
  }
  return { segments, canonical: node.path, key };
}

const isRunResult = (value: Target | ConfigRunResult): value is ConfigRunResult =>
  "code" in value && "err" in value;

/** The config file's text and stat as READ, or a refusal to read it. */
type Snapshot =
  | {
      readonly ok: true;
      /** Where the bytes really live (the symlink target, or the path itself). */
      readonly real: string;
      readonly text: string;
      readonly existed: boolean;
      /** The stamp a write re-checks right before its rename. */
      readonly stamp: { readonly mtimeMs: number; readonly size: number } | undefined;
      readonly mode: number;
      readonly createdDir: boolean;
    }
  | { readonly ok: false; readonly result: ConfigRunResult };

/**
 * Locate the real file (a symlink is written THROUGH, its target renamed over,
 * so a dotfiles link survives), refuse anything that is not a regular file, and
 * read it with its stamp.
 */
function readSnapshot(fs: ConfigFs, configPath: string): Snapshot {
  const kind = fs.kind(configPath);
  if (kind === "other") {
    return {
      ok: false,
      result: {
        code: 1,
        out: "",
        err: line(`[error] ${shown(configPath)} is not a regular file — nothing was changed`),
      },
    };
  }
  let real = configPath;
  if (kind === "symlink") {
    try {
      real = fs.realpath(configPath);
    } catch (error) {
      return {
        ok: false,
        result: {
          code: 1,
          out: "",
          err: line(
            `[error] ${shown(configPath)}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        },
      };
    }
    const targetKind = fs.kind(real);
    if (targetKind === "other") {
      return {
        ok: false,
        result: {
          code: 1,
          out: "",
          err: line(`[error] ${shown(real)} is not a regular file — nothing was changed`),
        },
      };
    }
  }
  if (fs.kind(real) === "missing") {
    return {
      ok: true,
      real,
      text: "",
      existed: false,
      stamp: undefined,
      mode: 0o600,
      createdDir: false,
    };
  }
  let text: string;
  let stat: FileStat;
  try {
    stat = fs.stat(real);
    if (stat.kind !== "file") {
      return {
        ok: false,
        result: {
          code: 1,
          out: "",
          err: line(`[error] ${shown(real)} is not a regular file — nothing was changed`),
        },
      };
    }
    text = fs.readText(real);
  } catch (error) {
    return {
      ok: false,
      result: {
        code: 1,
        out: "",
        err: line(
          `[error] cannot read ${shown(real)}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      },
    };
  }
  return {
    ok: true,
    real,
    text,
    existed: true,
    stamp: { mtimeMs: stat.mtimeMs, size: stat.size },
    mode: modeOf(fs, real, stat),
    createdDir: false,
  };
}

/**
 * The mode to keep: the file's own, or — through a symlink — its TARGET's (a
 * link's own bits are meaningless, and `stat` follows links on some systems but
 * not all, so ask explicitly).
 */
function modeOf(fs: ConfigFs, real: string, stat: FileStat): number {
  const mode = stat.mode & 0o777;
  if (mode !== 0) {
    return mode;
  }
  try {
    return fs.stat(real).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/** The refusal line(s) of a failed plan: the error, every detail, the hint. */
function planRefusal(
  error: string,
  extra: { details?: readonly string[]; hint?: string },
  key: string,
): ConfigRunResult {
  const lines = [
    line(`[error] ${error}`),
    ...(extra.details ?? []).map((detail) => line(`  ${detail}`)),
  ];
  const hint =
    extra.hint ?? `nothing was changed; check the key's schema with: tentacle explain ${key}`;
  return { code: 1, out: "", err: lines.join("") + line(hint) };
}

/**
 * Write `text` to `real` atomically. `stale` means the world moved since our
 * read: the file's stamp changed (or it appeared where there was none), so the
 * caller re-reads and retries ONCE (eval T12), then refuses — never a lost edit.
 */
function writeOnce(
  fs: ConfigFs,
  real: string,
  text: string,
  mode: number,
  stamp: { readonly mtimeMs: number; readonly size: number } | undefined,
):
  | { readonly kind: "written" }
  | { readonly kind: "stale" }
  | { readonly kind: "failed"; readonly result: ConfigRunResult } {
  let temp: string;
  try {
    temp = fs.writeTemp(real, text, mode);
  } catch (error) {
    return {
      kind: "failed",
      result: {
        code: 1,
        out: "",
        err: line(
          `[error] cannot write in ${shown(dirname(real))}: ${error instanceof Error ? error.message : String(error)} — nothing was changed`,
        ),
      },
    };
  }
  // The window between our read and this rename is the whole race: re-check
  // (mtime + size, or absence) right before the only visible change.
  if (stamp !== undefined) {
    let now: FileStat | undefined;
    try {
      now = fs.stat(real);
    } catch {
      now = undefined;
    }
    if (now === undefined || now.mtimeMs !== stamp.mtimeMs || now.size !== stamp.size) {
      fs.remove(temp);
      return { kind: "stale" };
    }
  } else if (fs.kind(real) !== "missing") {
    // There was no file when we read; if one appeared (another `config set`, a
    // `tentacle` run scaffolding it) our text is not based on it — re-read.
    fs.remove(temp);
    return { kind: "stale" };
  }
  try {
    fs.rename(temp, real);
  } catch (error) {
    fs.remove(temp);
    return {
      kind: "failed",
      result: {
        code: 1,
        out: "",
        err: line(
          `[error] cannot replace ${shown(real)}: ${error instanceof Error ? error.message : String(error)} — nothing was changed`,
        ),
      },
    };
  }
  return { kind: "written" };
}

/**
 * The key as it appears in the file, for messages: `--profile work` writes one
 * level down, so `model.model` lands at `profiles.work.model.model`.
 */
const where = (target: Target): string => target.segments.join(".");

/** The raw value of a `set`, from argv, stdin, or a prompt (owner Q6/A4). */
async function valueText(
  op: Extract<ConfigOp, { kind: "set" }>,
  input: ConfigRunInput,
  secret: boolean,
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly result: ConfigRunResult }
> {
  const source = op.value;
  if (source.from === "argv") {
    return { ok: true, text: source.text };
  }
  const fromStdin = async (): Promise<
    { ok: true; text: string } | { ok: false; result: ConfigRunResult }
  > => {
    if (input.readStdin === undefined) {
      return {
        ok: false,
        result: {
          code: 1,
          out: "",
          err: line(
            "[error] no value: stdin cannot be read here — pass the value, or `-` for stdin",
          ),
        },
      };
    }
    return { ok: true, text: trimOneNewline(await input.readStdin()) };
  };
  if (source.from === "stdin") {
    return fromStdin();
  }
  // No value given: a hidden prompt on a terminal (the value may be a key), else
  // stdin — a pipe is how a script hands it over.
  if (!input.isStdinTerminal) {
    return fromStdin();
  }
  if (secret && input.readSecret !== undefined) {
    return { ok: true, text: trimOneNewline(await input.readSecret(`${op.key}: `)) };
  }
  if (input.ask !== undefined) {
    return { ok: true, text: trimOneNewline(await input.ask(`${op.key}: `)) };
  }
  return fromStdin();
}

/** Is the value at `segments` something that destroys more than one setting? */
function isDestructive(text: string, segments: readonly string[]): boolean {
  const parsed = parseConfigText(text);
  if (!parsed.ok) {
    return false;
  }
  const current = readPath(parsed.value, segments);
  return current.found && typeof current.value === "object" && current.value !== null;
}

const yesAnswer = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

/** `set` / `unset`: the read → plan → confirm → write flow. */
async function write(
  op: Extract<ConfigOp, { kind: "set" | "unset" }>,
  input: ConfigRunInput,
): Promise<ConfigRunResult> {
  const fs = input.fs ?? nodeConfigFs;
  const target = resolveTarget(op.key, input.profile);
  if (isRunResult(target)) {
    return target;
  }
  const doc = docForKey(target.segments.join("."));
  if (doc === undefined) {
    return unknownKey(op.key);
  }
  if (op.kind === "set" && op.value.from === "argv" && isArgvRefusedSecret(op.key)) {
    // Owner Q6 / eval A4: a secret on argv leaks into shell history and `ps`.
    return {
      code: 1,
      out: "",
      err:
        line(
          `[error] refusing a secret on the command line: "${op.key}" would be visible in your shell history and in \`ps\``,
        ) +
        line(`read it from stdin instead:  printf '%s\\n' "$KEY" | tentacle config ${op.key} -`) +
        line(`or with no value, it is prompted for without echo:  tentacle config ${op.key}`) +
        line(
          `better: store a command that prints it — tentacle config model.apiKeyCommand "pass show tentacle" (see \`tentacle explain model.apiKeyCommand\`)`,
        ),
    };
  }

  let snapshot = readSnapshot(fs, input.configPath);
  if (!snapshot.ok) {
    return snapshot.result;
  }

  let editOp: EditOp;
  let printedValue: string | undefined;
  /** The value was given but empty: a string leaf's `min(1)` then refuses it, and
   * the useful answer is `unset` (eval A3, owner Q4). */
  let emptyValue = false;
  if (op.kind === "set") {
    const raw = await valueText(op, input, secretOf(target.segments.join(".")) !== undefined);
    if (!raw.ok) {
      return raw.result;
    }
    emptyValue = raw.text === "";
    const node = resolveKeyPath(target.segments.join("."));
    if (node === undefined) {
      return unknownKey(op.key);
    }
    const typed = typeConfigValue(node, raw.text);
    if (!typed.ok) {
      // The value is NOT echoed: for a secret leaf that would leak it (eval A4).
      return {
        code: 1,
        out: "",
        err:
          line(`[error] ${op.key}: ${typed.error}`) +
          (raw.text === ""
            ? line(
                `an empty value is not a setting — to remove the key, use: tentacle config unset ${op.key}`,
              )
            : line(`nothing was changed; \`tentacle explain ${op.key}\` shows its type`)),
      };
    }
    editOp = { kind: "set", value: typed.value };
    printedValue = renderStored(typed.value, target.segments);
  } else {
    const parsed = parseConfigText(snapshot.text);
    const exists = parsed.ok ? readPath(parsed.value, target.segments) : { found: false as const };
    if (!exists.found) {
      return {
        code: 1,
        out: "",
        err: line(
          `[error] ${op.key} is not set in ${shown(input.configPath)} — nothing was changed`,
        ),
      };
    }
    if (!input.yes && isDestructive(snapshot.text, target.segments)) {
      const what =
        target.canonical.startsWith("profiles.*") && target.segments.length === 2
          ? "profile"
          : "section";
      if (input.ask === undefined) {
        return {
          code: 1,
          out: "",
          err: line(
            `[error] unsetting ${op.key} removes a whole ${what} — pass --yes to do it without asking`,
          ),
        };
      }
      const answer = await input.ask(`unset ${op.key} (a whole ${what})? [y/N] `);
      if (!yesAnswer(answer)) {
        return { code: 1, out: "", err: line("not changed.") };
      }
    }
    editOp = { kind: "delete" };
  }

  // The plan, from the text as read: parse → apply in memory → validate the
  // whole file → text edit → re-verify. A refusal writes nothing.
  const unsetHint = emptyValue
    ? `an empty value is not a setting — to REMOVE the key, use: tentacle config unset ${where(target)}`
    : undefined;
  const refusalOf = (failure: { error: string; details?: readonly string[]; hint?: string }) =>
    planRefusal(
      failure.error,
      { ...failure, ...(unsetHint !== undefined ? { hint: unsetHint } : {}) },
      target.key,
    );
  let plan = planConfigEdit({ text: snapshot.text, segments: target.segments, op: editOp });
  let attempts = 0;
  for (;;) {
    if (!plan.ok) {
      return refusalOf(plan);
    }
    if (!snapshot.existed) {
      try {
        fs.ensureDir(dirname(snapshot.real));
      } catch (error) {
        return {
          code: 1,
          out: "",
          err: line(
            `[error] cannot create ${shown(dirname(snapshot.real))}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
    }
    const written = writeOnce(fs, snapshot.real, plan.text, snapshot.mode, snapshot.stamp);
    if (written.kind === "written") {
      break;
    }
    if (written.kind === "failed") {
      return written.result;
    }
    // Changed while editing: ONE retry from a re-read (its value may be anything,
    // so the plan is rebuilt, not reused), then the honest refusal.
    attempts++;
    if (attempts > 1) {
      return {
        code: 1,
        out: "",
        err: line(
          `[error] ${shown(input.configPath)} changed while editing — nothing was changed; try again`,
        ),
      };
    }
    snapshot = readSnapshot(fs, input.configPath);
    if (!snapshot.ok) {
      return snapshot.result;
    }
    plan = planConfigEdit({ text: snapshot.text, segments: target.segments, op: editOp });
  }

  const out: string[] = [];
  // Say where it landed: with `--profile` the key in the file is one level down.
  if (op.kind === "set") {
    const value = printedValue === "***" ? "" : ` = ${printedValue}`;
    out.push(line(`set ${where(target)}${value} in ${shown(input.configPath)}`));
  } else {
    out.push(line(`unset ${where(target)} in ${shown(input.configPath)}`));
  }
  out.push(line(appliesToText(doc)));
  const err: string[] = [];
  const secret = secretOf(target.segments.join("."));
  if (op.kind === "set" && secret !== undefined) {
    const mode = (snapshot.mode & 0o777).toString(8).padStart(4, "0");
    out.push(line(`stored in plaintext in ${shown(input.configPath)}, mode ${mode}`));
    if ((snapshot.mode & 0o077) !== 0) {
      // Warn, never chmod silently (eval A4): the file is the user's, and only
      // the write itself is ours.
      err.push(
        line(
          `[warning] ${shown(input.configPath)} is readable by other users (mode ${mode}); it now holds a secret — chmod 600 it`,
        ),
      );
    }
  }
  return { code: 0, out: out.join(""), err: err.join("") };
}

/** `get`: the value AS STORED, masked when secret, exit 1 when it is not set. */
function get(input: ConfigRunInput, op: Extract<ConfigOp, { kind: "get" }>): ConfigRunResult {
  const fs = input.fs ?? nodeConfigFs;
  const target = resolveTarget(op.key, input.profile);
  if (isRunResult(target)) {
    return target;
  }
  if (fs.kind(input.configPath) === "missing") {
    return { code: 1, out: "", err: line(`[error] no config file at ${shown(input.configPath)}`) };
  }
  const snapshot = readSnapshot(fs, input.configPath);
  if (!snapshot.ok) {
    return snapshot.result;
  }
  const parsed = parseConfigText(snapshot.text);
  if (!parsed.ok) {
    return planRefusal(parsed.error, parsed, target.key);
  }
  const found = readPath(parsed.value, target.segments);
  if (!found.found) {
    const doc = docForKey(target.segments.join("."));
    const fallback =
      doc?.defaultText ?? (doc?.default === undefined ? undefined : JSON.stringify(doc.default()));
    return {
      code: 1,
      out: "",
      err:
        line(`[error] ${op.key} is not set in ${shown(input.configPath)}`) +
        (fallback !== undefined ? line(`default: ${fallback}`) : ""),
    };
  }
  const mask = renderStored(found.value, target.segments);
  if (input.json) {
    const value = mask === "***" || mask === "[***]" ? mask : found.value;
    return {
      code: 0,
      out: `${JSON.stringify({ key: target.segments.join("."), value })}\n`,
      err: "",
    };
  }
  return { code: 0, out: line(mask), err: "" };
}

/** `list`: every setting the file holds, one `key = value` line, secrets masked. */
function list(input: ConfigRunInput): ConfigRunResult {
  const fs = input.fs ?? nodeConfigFs;
  if (fs.kind(input.configPath) === "missing") {
    return { code: 0, out: "", err: line(`[error] no config file at ${shown(input.configPath)}`) };
  }
  const snapshot = readSnapshot(fs, input.configPath);
  if (!snapshot.ok) {
    return snapshot.result;
  }
  const parsed = parseConfigText(snapshot.text);
  if (!parsed.ok) {
    return planRefusal(parsed.error, parsed, "the file");
  }
  const scope =
    input.profile === undefined
      ? parsed.value
      : (readPath(parsed.value, ["profiles", input.profile]) as { found: boolean; value?: unknown })
          .value;
  if (input.profile !== undefined && scope === undefined) {
    return {
      code: 1,
      out: "",
      err: line(`[error] no profile "${input.profile}" in ${shown(input.configPath)}`),
    };
  }
  const prefix = input.profile === undefined ? [] : ["profiles", input.profile];
  const lines = flattenStored(scope, prefix);
  if (input.json) {
    const entries = lines.map(
      (entry) =>
        `${JSON.stringify(entry.path)}: ${entry.text === "***" || entry.text === "[***]" ? JSON.stringify(entry.text) : entry.text}`,
    );
    return { code: 0, out: entries.length === 0 ? "{}\n" : `{${entries.join(",")}}\n`, err: "" };
  }
  if (lines.length === 0) {
    return { code: 0, out: "", err: line(`no settings in ${shown(input.configPath)}`) };
  }
  return {
    code: 0,
    out: `${lines.map((entry) => `${entry.path} = ${entry.text}`).join("\n")}\n`,
    err: "",
  };
}

/** Answer one `tentacle config` invocation. Pure logic above; I/O only here. */
export async function runConfig(input: ConfigRunInput): Promise<ConfigRunResult> {
  const op = input.op;
  switch (op.kind) {
    case "path":
      return { code: 0, out: line(input.configPath), err: "" };
    case "list":
      return list(input);
    case "get":
      return get(input, op);
    case "set":
    case "unset":
      return write(op, input);
  }
}

/** Re-exported so `main.ts` needs one import for the run's input type only. */
export type { ConfigOp };

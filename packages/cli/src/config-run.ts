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
  type KeyNode,
  appliesToText,
  checkSegments,
  configKeyNodes,
  docForKey,
  flattenStored,
  isArgvRefusedSecret,
  maskStored,
  nearestKeys,
  parseConfigText,
  planConfigEdit,
  readPath,
  renderStored,
  resolveKeyPath,
  secretOf,
  secretPathsIn,
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
  /** What is at `path`: a regular file, a symlink, another kind, or nothing.
   * Any OTHER failure (EACCES, ELOOP, …) is thrown, so its real message and path
   * reach the user instead of reading as "not a regular file" (LOW-8). */
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
      // ONLY ENOENT means "nothing there": anything else (EACCES on the
      // directory, ELOOP, ENAMETOOLONG) is a real failure and must say so
      // (LOW-8), never read as "not a regular file".
      if (codeOf(error) === "ENOENT") {
        return "missing";
      }
      throw error;
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
  /** A hidden prompt on a terminal (no echo: the value may be a key). A
   * resolved `undefined` means the user cancelled (Ctrl+C / EOF). */
  readonly readSecret?: (prompt: string) => Promise<string | undefined>;
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

/**
 * The refusal for a secret given on ARGV (owner Q6 / eval A4): it would be
 * visible in shell history and in `ps`. `paths` are the concrete registry paths
 * that carry the secret — the key itself, or any key INSIDE an object/array
 * value (HIGH-1: `config model='{"apiKey":"sk-x"}'` leaked the key through a
 * parent). They are PATHS, never the value.
 */
function secretOnArgv(key: string, paths: readonly string[]): ConfigRunResult {
  const which =
    paths.length === 1 && paths[0] === key
      ? `"${key}"`
      : `${paths.map((path) => `"${path}"`).join(", ")} (in the value for "${key}")`;
  const leaf = paths[0] ?? key;
  return {
    code: 1,
    out: "",
    err:
      line(
        `[error] refusing a secret on the command line: ${which} would be visible in your shell history and in \`ps\``,
      ) +
      line(`read it from stdin instead:  printf '%s\\n' "$KEY" | tentacle config ${leaf} -`) +
      line(`or with no value, it is prompted for without echo:  tentacle config ${leaf}`) +
      line(
        `better: store a command that prints it — tentacle config model.apiKeyCommand "pass show tentacle" (see \`tentacle explain model.apiKeyCommand\`)`,
      ),
  };
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
 * `fs.kind`, with an lstat failure that is not ENOENT reported as itself, with
 * the path (LOW-8): EACCES on the directory used to read as "not a regular
 * file", which blames the wrong thing. Only `nodeConfigFs` decides what ENOENT
 * means; every other kind of failure comes out here as a refusal.
 */
function kindOf(
  fs: ConfigFs,
  path: string,
):
  | { readonly ok: true; readonly value: "file" | "symlink" | "other" | "missing" }
  | { readonly ok: false; readonly result: ConfigRunResult } {
  try {
    return { ok: true, value: fs.kind(path) };
  } catch (error) {
    return {
      ok: false,
      result: {
        code: 1,
        out: "",
        err: line(
          `[error] cannot read ${shown(path)}: ${error instanceof Error ? error.message : String(error)} — nothing was changed`,
        ),
      },
    };
  }
}

const notRegularFile = (path: string): Snapshot => ({
  ok: false,
  result: {
    code: 1,
    out: "",
    err: line(`[error] ${shown(path)} is not a regular file — nothing was changed`),
  },
});

/**
 * Locate the real file (a symlink is written THROUGH, its target renamed over,
 * so a dotfiles link survives), refuse anything that is not a regular file, and
 * read it with its stamp.
 */
function readSnapshot(fs: ConfigFs, configPath: string): Snapshot {
  const kind = kindOf(fs, configPath);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === "other") {
    return notRegularFile(configPath);
  }
  let real = configPath;
  if (kind.value === "symlink") {
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
    const targetKind = kindOf(fs, real);
    if (!targetKind.ok) {
      return targetKind;
    }
    if (targetKind.value === "other") {
      return notRegularFile(real);
    }
  }
  const realKind = kindOf(fs, real);
  if (!realKind.ok) {
    return realKind;
  }
  if (realKind.value === "missing") {
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
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: false; readonly result: ConfigRunResult }
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
  const asked = async (ask: (prompt: string) => Promise<string | undefined>) => {
    // `undefined` is a CANCEL (Ctrl+C / EOF at the prompt, LOW-7): neither an
    // empty value (which the schema would answer with "use unset") nor a write.
    const answer = await ask(`${op.key}: `);
    return answer === undefined
      ? ({ ok: false, cancelled: true } as const)
      : { ok: true as const, text: trimOneNewline(answer) };
  };
  if (secret && input.readSecret !== undefined) {
    return asked(input.readSecret);
  }
  if (input.ask !== undefined) {
    return asked(input.ask);
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

/**
 * A key that holds a whole object (a section, a map, an object-typed leaf) rather
 * than one typed value: owner Q-D, the value is JSON and cannot be prompted for.
 */
const isObjectNode = (node: KeyNode): boolean =>
  node.kind === "section" ||
  node.type.split("|").some((type) => type.trim() === "object" || type.trim() === "map");

/**
 * Owner Q-D: a section/map/object key given no value. Nothing is written, and the
 * way to LOOK at it is `get` — `unset` deletes the whole section, which is not
 * what "show me this" means. Keeping the `unset` hint for a leaf given `""`.
 */
const objectNeedsValue = (path: string): ConfigRunResult => ({
  code: 1,
  out: "",
  err: line(`[error] ${path} needs a JSON object value; show it with: tentacle config get ${path}`),
});

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
    return secretOnArgv(op.key, [op.key]);
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
    const node = resolveKeyPath(target.segments.join("."));
    if (node === undefined) {
      return unknownKey(op.key);
    }
    // No value given at a TERMINAL, for a key that holds an object: there is
    // nothing useful to type at a one-line prompt, so say so before asking
    // (owner Q-D). A PIPE is still a value (`… | tentacle config subagents`).
    if (isObjectNode(node) && op.value.from === "prompt" && input.isStdinTerminal) {
      return objectNeedsValue(where(target));
    }
    const raw = await valueText(op, input, secretOf(target.segments.join(".")) !== undefined);
    if (!raw.ok) {
      // A cancel at the hidden prompt is not an error to explain: 130 is what a
      // Ctrl+C answers everywhere else in the CLI (LOW-7).
      return "cancelled" in raw && raw.cancelled
        ? { code: 130, out: "", err: line("cancelled") }
        : raw.result;
    }
    emptyValue = raw.text === "";
    // An object given an empty value (`subagents ""`, an empty `-`) is the same
    // answer: it is a JSON object, and `unset` is not what the user asked for.
    if (emptyValue && isObjectNode(node)) {
      return objectNeedsValue(where(target));
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
    // HIGH-1: a secret INSIDE an argv value (an object or array holding an
    // `apiKey`, a token, an `args` list) is on argv just the same. Asked of the
    // TYPED value at its target path, with the registry walk — no second table.
    if (op.value.from === "argv") {
      const secretPaths = secretPathsIn(typed.value, target.segments);
      if (secretPaths.length > 0) {
        return secretOnArgv(op.key, secretPaths);
      }
    }
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
  // HIGH-2: every form renders the MASKED tree, never `found.value` — an object
  // used to be emitted raw by `--json`, so `get model --json` printed the key.
  const masked = maskStored(found.value, target.segments);
  if (input.json) {
    return {
      code: 0,
      out: `${JSON.stringify({ key: target.segments.join("."), value: masked })}\n`,
      err: "",
    };
  }
  return { code: 0, out: line(renderStored(masked, target.segments)), err: "" };
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
    // HIGH-2: the VALUE the walk produced (already masked), never a re-read.
    const entries = lines.map(
      (entry) => `${JSON.stringify(entry.path)}: ${JSON.stringify(entry.value)}`,
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

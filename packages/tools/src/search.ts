/**
 * The pure core of `search` (docs/feat/explore-search.md, Design 3c): every
 * decision that could make the two engines disagree silently is taken here, on
 * strings, with no I/O and no `Tool` — so it is unit-testable without a
 * subprocess (AGENTS §7, "logic lives in pure modules").
 *
 * The pipeline is `validateSearchInput` → `buildSearchPlan(input, engine)` →
 * `parseSearchOutput(raw, stderr, exitCode, plan)` → `renderSearchResult`. The
 * ONE `sh -c` string a plan carries is built from a fixed flag list plus
 * single-quoted arguments, so nothing in the input is ever interpreted by the
 * shell: pattern and path are data.
 */
import { classifyPattern } from "./search-dialect.ts";

/** Raw cap on the pipe (256 KiB + 1 byte of slack, so JS can SEE the cap was hit). */
export const RAW_CAP = 262145;
/** Hard ceiling for `max_results`, whatever the model asks (F11). */
export const MAX_RESULTS_CEILING = 1000;
/** Default count bound (owner Q5 a). */
export const DEFAULT_MAX_RESULTS = 100;
/** Byte bound of the rendered hits; below the 16000-char spill threshold (Design 5). */
export const MAX_BYTES = 12000;
/** Per-line cap, so one minified line cannot eat the byte budget. */
export const MAX_LINE = 300;
/** Names pruned from the walk on both engines. `.git` is pruned as `.git` only. */
export const PRUNE: readonly string[] = [".git", "node_modules", "dist"];
/** `env.exec` gets a wall-clock bound; a search is not a build (F5). */
export const SEARCH_TIMEOUT_MS = 20000;
/** The probe's own bound: it carries no `ctx.signal` (M4). */
export const PROBE_TIMEOUT_MS = 5000;
/** `HostExecution` reports a killed process as this (builtins.ts:312-315). */
export const KILLED_EXIT_CODE = 124;

export type SearchEngine = "rg" | "grep";
export type OutputMode = "content" | "files";

/** The tool's validated input. */
export interface SearchInput {
  readonly pattern?: string;
  readonly glob?: string;
  readonly path: string;
  readonly output_mode: OutputMode;
  readonly fixed_strings: boolean;
  readonly ignore_case: boolean;
  readonly max_results: number;
}

/** The engine facts the capability probe learns, once per environment. */
export interface EngineFacts {
  readonly engine: SearchEngine;
  /** Whether `grep -I` actually filters binaries (busybox accepts and ignores it). */
  readonly binaryFilter: boolean;
}

/** A refusal — never a silent rewrite, never a throw (Failure modes). */
export interface SearchRefusal {
  readonly message: string;
}

/** `shq`: POSIX single-quoting, the only form in which the shell interprets nothing. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** True for a C0 control or DEL — the class `wireLine`/`oneLineText` drop (F9). */
function isControlCode(code: number): boolean {
  return (code < 32 && code !== 9) || code === 127;
}

/** True for any control character except `\t`, which indentation needs (M7b). */
function hasControlChar(text: string): boolean {
  for (const char of text) {
    if (isControlCode(char.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Confinement (H7/Q6 a) and the field rules, in the pure module. Returns the
 * normalised input or a refusal naming the rule. `cwd` is the workspace root:
 * the `ExecutionEnvironment` contract has no other (precondition 7).
 */
export function validateSearchInput(raw: {
  pattern?: string;
  glob?: string;
  path?: string;
  output_mode?: OutputMode;
  fixed_strings?: boolean;
  ignore_case?: boolean;
  max_results?: number;
}): { ok: true; input: SearchInput } | { ok: false; refusal: SearchRefusal } {
  const outputMode = raw.output_mode ?? "content";
  const pattern = raw.pattern;
  const glob = raw.glob;

  for (const [field, value] of [
    ["pattern", pattern],
    ["glob", glob],
    ["path", raw.path],
  ] as const) {
    if (value !== undefined && hasControlChar(value)) {
      return {
        ok: false,
        refusal: {
          message: `\`${field}\` contains a control character (NUL, a newline or a carriage return); a search is single-line — search for one line and use \`fs_read path:start:end\` for context.`,
        },
      };
    }
  }

  if (outputMode === "content" && (pattern === undefined || pattern === "")) {
    return {
      ok: false,
      refusal: { message: "`pattern` is required when `output_mode` is `content`." },
    };
  }
  if (outputMode === "files" && (pattern === undefined || pattern === "") && !glob) {
    return {
      ok: false,
      refusal: {
        message:
          "in `output_mode: files` give `glob` (list matching file names) or `pattern` (list files CONTAINING it).",
      },
    };
  }
  if (glob !== undefined) {
    const bad = globProblem(glob);
    if (bad !== undefined) {
      return { ok: false, refusal: { message: bad } };
    }
  }

  const confined = confinePath(raw.path ?? ".");
  if (!confined.ok) {
    return { ok: false, refusal: { message: confined.message } };
  }

  const requested = raw.max_results ?? DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(Math.max(1, Math.trunc(requested)), MAX_RESULTS_CEILING);
  return {
    ok: true,
    input: {
      ...(pattern !== undefined && pattern !== "" ? { pattern } : {}),
      ...(glob !== undefined && glob !== "" ? { glob } : {}),
      path: confined.path,
      output_mode: outputMode,
      fixed_strings: raw.fixed_strings ?? false,
      ignore_case: raw.ignore_case ?? false,
      max_results: maxResults,
    },
  };
}

/**
 * `glob` is a BASENAME glob (H5) — enforced, not documented: rg matching a
 * `src`-anchored recursive glob matched NOTHING (measured), so a `/` is a
 * mistake to point at `path`, and a leading `!` negates on rg and is literal
 * on `find`.
 */
function globProblem(glob: string): string | undefined {
  if (glob.includes("/")) {
    return "`glob` is a file-name pattern, not a path: put the directory in `path` instead (e.g. path `src`, glob `a*.ts`).";
  }
  if (glob.startsWith("!")) {
    return "`glob` cannot start with `!` (ripgrep negates, find does not): narrow `path` instead.";
  }
  if (glob === ".." || glob.includes("..")) {
    return "`glob` cannot contain `..`.";
  }
  return undefined;
}

/**
 * Q6 (a): refuse an absolute path and any path whose normalised form climbs out
 * of the workspace. A recursive, prompt-free search DISCOVERS paths, so it may
 * not name one outside the workspace (AGENTS §7, "a pod is not trusted").
 */
function confinePath(path: string): { ok: true; path: string } | { ok: false; message: string } {
  if (path.startsWith("/")) {
    return {
      ok: false,
      message:
        "`path` must stay inside the workspace: an absolute path is refused (a recursive search DISCOVERS paths, which a prompt-free tool may not name; owner Q6 a). Use a workspace-relative path.",
    };
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return {
          ok: false,
          message:
            "`path` climbs out of the workspace with `..`; a search may only walk inside it. Use a workspace-relative path.",
        };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  // Every relative path is `./`-prefixed: `find -dash.ts` is an error on all
  // three engines while `find ./-dash.ts` works (M1, measured). `./` itself
  // stays `./`: `find .` is the walk we want.
  return { ok: true, path: segments.length === 0 ? "." : `./${segments.join("/")}` };
}

/**
 * Escape the metacharacters `find -path` treats as a PATTERN (M1). Measured: a
 * hidden metachar root (`.hid[x]`) prunes itself to zero results unescaped and
 * returns its files escaped, on busybox, alpine, debian and BSD.
 */
function pathGlobEscape(path: string): string {
  return path.replaceAll(/[\\*?[]/g, (char) => `\\${char}`);
}

/**
 * The `.gitignore` rules the fallback cannot honour (Design 3b): top-level
 * literal names become prunes (what `find -name` can do), everything else is
 * counted for the note. Never an error (F13).
 */
export function classifyGitignore(text: string): {
  readonly prunes: readonly string[];
  readonly unexpressible: readonly string[];
} {
  const prunes: string[] = [];
  const unexpressible: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    // A rule anchored to the root is a bare name; anything else is not a
    // top-level literal name, so `find -name` cannot express it.
    const topLevel = /^(\/?)([A-Za-z0-9._-]+)\/?$/.exec(line);
    const name = topLevel?.[2];
    if (line.startsWith("!") || name === undefined || name === "." || name === "..") {
      unexpressible.push(line);
      continue;
    }
    if (/[*?[]/.test(name)) {
      unexpressible.push(line);
      continue;
    }
    prunes.push(name);
  }
  return { prunes, unexpressible };
}

/** What a plan owes the renderer besides its command. */
export interface SearchPlan {
  readonly command: string;
  readonly engine: SearchEngine;
  readonly input: SearchInput;
  /** A pattern rewritten for the fallback (`\d → [0-9]`), one note each. */
  readonly notes: readonly string[];
  /** `.gitignore` rules the fallback cannot apply (fallback only). */
  readonly ignoreNote?: string;
}

/**
 * Build the ONE `sh -c` string for an input, on an engine (Design 3).
 *
 * Shape, identical on both: a POSIX existence pre-check (status **3** +
 * `TENTACLE_MISSING`), the walk, its status carried out on stderr
 * (`TENTACLE_RC=`, since `| head -c` loses it — POSIX `sh` has no `pipefail`),
 * then `| head -c RAW_CAP` as a memory backstop.
 */
export function buildSearchPlan(
  input: SearchInput,
  engine: SearchEngine,
  facts: {
    readonly gitignore?: {
      readonly prunes: readonly string[];
      readonly unexpressible: readonly string[];
    };
    readonly binaryFilter?: boolean;
  } = {},
): { ok: true; plan: SearchPlan } | { ok: false; refusal: SearchRefusal } {
  const notes: string[] = [];
  let pattern = input.pattern;
  if (pattern !== undefined && engine === "grep") {
    const classification = classifyPattern(pattern, input.fixed_strings);
    if (classification.kind === "refused") {
      return {
        ok: false,
        refusal: {
          message: `pattern not supported on the POSIX-grep engine (this image has no ripgrep): ${classification.reason}`,
        },
      };
    }
    if (classification.kind === "translated") {
      pattern = classification.text;
      notes.push(`pattern rewritten for grep: ${classification.notes.join(", ")}`);
    }
  }
  // A pattern containing `-e`-looking text is safe: it is never in flag position.
  const effective: SearchInput = pattern === input.pattern ? input : { ...input, pattern };

  const filesWithMatches = effective.output_mode === "files" && effective.pattern !== undefined;
  const listing = effective.output_mode === "files" && effective.pattern === undefined;

  const extraPrunes = (facts.gitignore?.prunes ?? []).filter((name) => !PRUNE.includes(name));
  const prunes = [...PRUNE, ...extraPrunes];
  // A prune the caller NAMED in `path` is exempt on both sides (measured parity
  // for `.`, `src/node_modules`, `node_modules`, `./.config`): asking for it
  // must search it. Scoped inside the workspace by the confinement rule above.
  const named = new Set(
    effective.path
      .replace(/^\.\//, "")
      .split("/")
      .filter((s) => s !== "."),
  );
  const activePrunes = prunes.filter((name) => !named.has(name));

  let ignoreNote: string | undefined;
  const unexpressible = facts.gitignore?.unexpressible ?? [];
  if (engine === "grep" && unexpressible.length > 0) {
    const shown = unexpressible.slice(0, 3).join(", ");
    ignoreNote = `${unexpressible.length} .gitignore rule${unexpressible.length === 1 ? "" : "s"} (${shown}${unexpressible.length > 3 ? ", …" : ""}) ${unexpressible.length === 1 ? "is" : "are"} not applied on this engine; results may differ`;
  }

  const walk = buildWalk(effective, engine, {
    pattern: pattern ?? "",
    activePrunes,
    filesWithMatches,
    listing,
    binaryFilter: facts.binaryFilter ?? false,
  });

  const preCheck = `if [ ! -f ${shq(effective.path)} ] && [ ! -d ${shq(effective.path)} ] && [ ! -L ${shq(effective.path)} ]; then printf 'TENTACLE_MISSING\\n' >&2; exit 3; fi`;
  const command = `${preCheck}; { ${walk} ; printf 'TENTACLE_RC=%s\\n' "$?" >&2; } | head -c ${RAW_CAP}`;
  return {
    ok: true,
    plan: {
      command,
      engine,
      input: effective,
      notes,
      ...(ignoreNote !== undefined ? { ignoreNote } : {}),
    },
  };
}

/** One `-prune` clause per pruned name, the ROOT itself exempted (M1). */
function nameClause(name: string, escapedRoot: string): string {
  return `\\( -name ${shq(name)} ! -path ${shq(escapedRoot)} \\) -prune -o`;
}

/**
 * rg skips hidden entries by default and `find` does not, so the fallback gets
 * the same rule — as a prune on the basename `.*`, exempting the root and any
 * hidden name the caller NAMED in `path` (asking for `./.config` must search
 * it). Measured (M1): a hidden metachar root self-prunes to zero unless the
 * `-path` operand is escaped, which `pathGlobEscape` does.
 */
function hiddenPrune(escapedRoot: string): string {
  // The root is exempted through the ESCAPED `-path` operand, so asking for a
  // hidden directory (`.hidx`, `.hid[x]`) searches it — and a metachar root
  // does not prune itself (measured: unescaped `.hid[x]` returns zero).
  return `\\( -name '.*' ! -path ${shq(escapedRoot)} \\) -prune -o`;
}

interface WalkOptions {
  readonly pattern: string;
  readonly activePrunes: readonly string[];
  readonly filesWithMatches: boolean;
  readonly listing: boolean;
  readonly binaryFilter: boolean;
}

/**
 * The walk itself, one verb per engine and mode (Design 3). Flags are a FIXED
 * list — nothing from the input reaches flag position: the pattern always
 * follows `-e` (or `-F -e`), the path always follows `--` on rg, and on `find`
 * it is `./`-prefixed so it can never be read as an option (M1, measured:
 * `find -dash.ts` fails on all three engines, `find ./-dash.ts` works).
 */
function buildWalk(input: SearchInput, engine: SearchEngine, options: WalkOptions): string {
  const path = shq(input.path);
  const pattern = shq(options.pattern);
  const glob = input.glob !== undefined ? shq(input.glob) : undefined;
  if (engine === "rg") {
    const flags = ["--no-require-git", "--sort path"];
    if (input.ignore_case) {
      flags.push("--ignore-case");
    }
    if (input.fixed_strings) {
      flags.push("--fixed-strings");
    }
    // The same NAMES are excluded on both engines (P8): rg's own `.gitignore`
    // handling is additive, never replaced (that is what keeps it fast).
    const globs = options.activePrunes.map((name) => `-g ${shq(`!**/${name}/**`)}`);
    const include =
      glob !== undefined ? [`${input.ignore_case ? "--iglob" : "--glob"} ${glob}`] : [];
    if (options.listing) {
      // `files` without a pattern: list file names (the glob is the filter).
      return ["rg --files", ...flags, ...include, ...globs, `-- ${path}`].join(" ");
    }
    if (options.filesWithMatches) {
      return [
        "rg --files-with-matches",
        ...flags,
        ...include,
        ...globs,
        `-e ${pattern}`,
        `-- ${path}`,
      ].join(" ");
    }
    return [
      "rg --no-heading --line-number --color=never --with-filename",
      "--max-columns 1200 --max-columns-preview",
      ...flags,
      ...include,
      ...globs,
      `-e ${pattern}`,
      `-- ${path}`,
    ].join(" ");
  }
  // The fallback: `find -H` (follow the ARGUMENT only, like rg, never the walk),
  // one `-prune` clause per name, each exempting the root through an ESCAPED
  // `-path` operand (a `-path` is a pattern — M1, measured), plus a hidden-entry
  // prune because rg skips hidden entries by default and `find` does not.
  const root = pathGlobEscape(input.path);
  const hideHidden = hiddenPrune(root);
  const prunes = [...options.activePrunes.map((name) => nameClause(name, root)), hideHidden]
    .filter((clause) => clause !== "")
    .join(" ");
  const nameFlag = glob !== undefined ? `${input.ignore_case ? "-iname" : "-name"} ${glob}` : "";
  const find = ["find -H", path, prunes, "-type f", nameFlag]
    .filter((part) => part !== "")
    .join(" ");
  if (options.listing) {
    return `${find} -print`;
  }
  const binary = options.binaryFilter ? "-I" : "";
  // `-F` REPLACES `-E`: passing both is an error on GNU (`grep -E -F` -> rc 2),
  // measured here — a literal search is `-F` alone.
  const dialect = input.fixed_strings ? "-F" : "-E";
  const caseless = input.ignore_case ? "-i" : "";
  const grep = [
    "grep",
    options.filesWithMatches ? "-l" : "-n -H",
    binary,
    caseless,
    "-s",
    dialect,
    `-e ${pattern}`,
    "--",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return `${find} -exec ${grep} {} +`;
}

/** One hit, before rendering. `line` is 0 in `files` mode (no line number). */
export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** What `parseSearchOutput` learned. `parseError` is a first-class outcome (H2). */
export interface ParsedSearch {
  readonly hits: readonly SearchHit[];
  /** The engine's status, carried out on stderr (`TENTACLE_RC=`) because the pipe loses it (H3). */
  readonly status: number | undefined;
  readonly missingPath: boolean;
  readonly parseError?: string;
  /** Lines dropped as binary (`binary file matches`, a NUL byte) — F6. */
  readonly binaryMatches: number;
  /** The raw stream hit the cap: the subset is INCOMPLETE, not "the first N" (M3). */
  readonly rawCapped: boolean;
  /** Per-path counts seen in the whole buffer, for the `[more matches in: …]` digest (H6). */
  readonly counts: readonly (readonly [string, number])[];
  /** Engine noise that is not an error (`find: … terminated by signal 13`). */
  readonly noise: readonly string[];
}

/**
 * The three grammars a grep/rg reports a bad pattern in (H2). Measured: busybox
 * says `bad regex`, GNU `Unmatched ( or \(`, BSD `brackets ([ ]) not balanced`,
 * rg `regex parse error`, and GNU also only WARNS on stderr for `(?i)`.
 */
const REGEX_ERROR =
  /(bad regex|invalid regular expression|Unmatched|not balanced|warning:|regex parse error|trailing backslash|repetition-operator)/i;
const SIGPIPE_NOISE = /terminated by signal 13|write error: Broken pipe/;

/** Strip C0/DEL controls but KEEP `\t` (M7b: otherwise every indented hit is mangled). */
function stripControls(text: string): string {
  let out = "";
  for (const char of text) {
    if (!isControlCode(char.codePointAt(0) ?? 0)) {
      out += char;
    }
  }
  return out;
}

/**
 * Parse an engine's stdout/stderr into hits + the facts the renderer needs.
 * `rawCapped` is decided from the RAW byte/char length the caller saw, so a cut
 * stream is never presented as complete (M3).
 */
export function parseSearchOutput(
  raw: string,
  stderr: string,
  outputMode: OutputMode,
  filesWithMatches: boolean,
): ParsedSearch {
  const statusMatch = /TENTACLE_RC=(\d+)/.exec(stderr);
  const status = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : undefined;
  const missingPath = stderr.includes("TENTACLE_MISSING");
  const noise: string[] = [];
  let parseError: string | undefined;
  for (const line of stderr.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("TENTACLE_RC=") || text === "TENTACLE_MISSING") {
      continue;
    }
    if (SIGPIPE_NOISE.test(text)) {
      noise.push(text);
      continue;
    }
    if (REGEX_ERROR.test(text)) {
      parseError ??= text;
      continue;
    }
    noise.push(text);
  }

  const rawCapped = raw.length >= RAW_CAP;
  const body = rawCapped ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
  const hits: SearchHit[] = [];
  const counts = new Map<string, number>();
  let binaryMatches = 0;
  for (const line of body.split("\n")) {
    if (line === "") {
      continue;
    }
    if (/binary file .* matches/i.test(line)) {
      binaryMatches += 1;
      continue;
    }
    const parsed = parseLine(line, outputMode, filesWithMatches);
    if (parsed === undefined) {
      binaryMatches += 1;
      continue;
    }
    hits.push(parsed);
    counts.set(parsed.path, (counts.get(parsed.path) ?? 0) + 1);
  }
  return {
    hits,
    status,
    missingPath,
    ...(parseError !== undefined ? { parseError } : {}),
    binaryMatches,
    rawCapped,
    counts: [...counts.entries()],
    noise,
  };
}

/** One engine line → a hit, or undefined for a line carrying a NUL (a binary match). */
function parseLine(
  line: string,
  outputMode: OutputMode,
  filesWithMatches: boolean,
): SearchHit | undefined {
  if (line.includes("\u0000")) {
    return undefined;
  }
  if (outputMode === "files" && !filesWithMatches) {
    // A bare path. `./`-normalised so rg's `p` and find's `./p` render the same.
    return { path: normalizeHitPath(line), line: 0, text: "" };
  }
  if (filesWithMatches) {
    return { path: normalizeHitPath(line), line: 0, text: "" };
  }
  // `path:line:text` — the path may itself hold `:` (a Windows-less unix path
  // rarely does) so the FIRST `:<digits>:` wins.
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return {
    path: normalizeHitPath(match[1]),
    line: Number(match[2]),
    text: stripControls(match[3] ?? ""),
  };
}

/** Both engines' spelling reduced to `./rel` so the two paths render identically. */
function normalizeHitPath(path: string): string {
  const trimmed = stripControls(path);
  return trimmed.startsWith("./") || trimmed.startsWith("/") ? trimmed : `./${trimmed}`;
}

/** What `renderSearchResult` needs beyond the parse: the plan it came from. */
export interface RenderOptions {
  readonly input: SearchInput;
  readonly engine: SearchEngine;
  readonly notes?: readonly string[];
  readonly ignoreNote?: string;
  readonly timedOut?: boolean;
}

/**
 * The header, then the sorted + bounded hits, then the markers — the ONE
 * renderer over both engines, so the SHAPE cannot depend on the engine
 * (Design, "Output format").
 */
export function renderSearchResult(
  parsed: ParsedSearch,
  options: RenderOptions,
): {
  readonly content: string;
  readonly isError: boolean;
} {
  const { input } = options;
  const header = headerFor(input);
  const engine = `(engine=${options.engine})`;
  const notes = [...(options.notes ?? [])];
  if (options.ignoreNote !== undefined) {
    notes.push(options.ignoreNote);
  }

  if (parsed.missingPath) {
    return {
      content: [
        `${header}  ${engine}`,
        `path not found: ${input.path}`,
        ...notes.map(noteLine),
      ].join("\n"),
      isError: true,
    };
  }
  if (options.timedOut) {
    return {
      content: [
        `${header}  ${engine}`,
        `[search timed out or was interrupted after ${SEARCH_TIMEOUT_MS / 1000}s — narrow the pattern or path, or pass a smaller \`max_results\`]`,
        ...notes.map(noteLine),
      ].join("\n"),
      isError: true,
    };
  }
  if (parsed.parseError !== undefined) {
    return {
      content: [
        `${header}  ${engine}`,
        `pattern rejected by the engine: ${parsed.parseError}`,
        "Retry with `fixed_strings: true` for a literal search, or simplify the pattern.",
        ...notes.map(noteLine),
      ].join("\n"),
      isError: true,
    };
  }

  const sorted = [...parsed.hits].sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
  );
  const lines: string[] = [];
  let bytes = 0;
  let countCut = sorted.length > input.max_results;
  let byteCut = false;
  const kept: SearchHit[] = [];
  for (const [index, hit] of sorted.entries()) {
    if (index >= input.max_results) {
      countCut = true;
      break;
    }
    const line = renderHit(hit, input.output_mode);
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + cost > MAX_BYTES) {
      byteCut = true;
      break;
    }
    bytes += cost;
    kept.push(hit);
    lines.push(line);
  }

  const tail: string[] = [];
  // A cut raw stream is a NONDETERMINISTIC subset, so "first N" would be a lie:
  // the INCOMPLETE marker replaces the count/byte markers (M3).
  if (countCut && !parsed.rawCapped) {
    // The cut files and how many more matched each: the "where else do I look"
    // answer, computed from lines already buffered (H6), capped to 5 entries.
    const keptPaths = new Set(kept.map((hit) => hit.path));
    const rest = parsed.counts
      .filter(([path]) => !keptPaths.has(path) || countOf(parsed, path) > countIn(kept, path))
      .map(([path, count]) => [path, count - countIn(kept, path)] as const)
      .filter(([, more]) => more > 0)
      // Count desc, then PATH ASC: the two engines' walk orders differ, so a tie
      // broken by arrival order would make the digest engine-dependent.
      .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]));
    const digest = rest.slice(0, 5).map(([path, more]) => `${path} ${more}`);
    const moreFiles = rest.length - digest.length;
    tail.push(
      `[search truncated: first ${kept.length} matches — narrow the pattern or path]${
        digest.length > 0
          ? `\n[more matches in: ${digest.join(", ")}${moreFiles > 0 ? `, …+${moreFiles} files` : ""}]`
          : ""
      }`,
    );
  }
  if (byteCut) {
    tail.push(`[search truncated: ${MAX_BYTES} bytes — narrow the pattern or path]`);
  }
  if (parsed.rawCapped) {
    tail.push("[search truncated at 256 KiB — results are INCOMPLETE, not the first N]");
  }
  if (parsed.binaryMatches > 0) {
    tail.push(`[binary files matched (${parsed.binaryMatches}) — not shown]`);
  }

  if (lines.length === 0) {
    // An explicit sentence, not an empty body: an empty result is the most
    // common answer and an empty string reads like a failure.
    return {
      content: `${[`${header}  ${engine}`, ...notes.map(noteLine), ...tail].join("\n")}\n\nno matches`,
      isError: false,
    };
  }
  return {
    content: [`${header}  ${engine}`, ...notes.map(noteLine), ...lines, ...tail].join("\n"),
    isError: false,
  };
}

function noteLine(note: string): string {
  return `[note: ${note}]`;
}

function countOf(parsed: ParsedSearch, path: string): number {
  return parsed.counts.find(([candidate]) => candidate === path)?.[1] ?? 0;
}

function countIn(hits: readonly SearchHit[], path: string): number {
  return hits.filter((hit) => hit.path === path).length;
}

/** One hit → its rendered line, capped at `MAX_LINE` characters (Bounds step 5). */
function renderHit(hit: SearchHit, outputMode: OutputMode): string {
  // Both `files` shapes (a glob listing and files-with-matches) are bare paths.
  if (outputMode === "files") {
    return hit.path;
  }
  return `${hit.path}:${hit.line}:${truncateLine(hit.text)}`;
}

function truncateLine(text: string): string {
  if (text.length <= MAX_LINE) {
    return text;
  }
  return `${text.slice(0, MAX_LINE - 1)}…`;
}

/** The three header shapes, so a child can tell the modes apart without guessing. */
function headerFor(input: SearchInput): string {
  const where = input.path;
  if (input.output_mode === "content") {
    return `[search ${JSON.stringify(input.pattern ?? "")} in ${where}]`;
  }
  if (input.pattern !== undefined) {
    return `[files containing ${JSON.stringify(input.pattern)} in ${where}]`;
  }
  return `[files ${input.glob ?? ""} in ${where}]`;
}

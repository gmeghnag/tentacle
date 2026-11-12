/**
 * The `search` tool: one bounded, read-only walk of the workspace, on `rg` when
 * the image has it and on POSIX `find`+`grep` when it does not (docs/feat/
 * explore-search.md). All the decisions live in `search.ts` (the pure module);
 * this file is the I/O half: the capability probe and its cache, `ctx.env.exec`,
 * and F14's single retry.
 */
import type { ExecutionEnvironment, Tool, ToolContext, ToolResult } from "@tentacle/core";
import { z } from "zod";
import { pathConcurrency } from "./concurrency.ts";
import {
  type EngineFacts,
  KILLED_EXIT_CODE,
  PROBE_TIMEOUT_MS,
  SEARCH_TIMEOUT_MS,
  type SearchEngine,
  type SearchInput,
  buildSearchPlan,
  classifyGitignore,
  oneWireLine,
  parseSearchOutput,
  renderSearchResult,
  validateSearchInput,
} from "./search.ts";

/** One process, once per environment: is it rg, and does `grep -I` really filter? */
const PROBE_COMMAND = [
  "if rg --version >/dev/null 2>&1; then printf 'TENTACLE_ENGINE=rg\\n'; else printf 'TENTACLE_ENGINE=grep\\n'; fi",
  "grep -E -H -e _t_ -- /dev/null >/dev/null 2>&1; printf 'TENTACLE_GREP_CAPS=%s\\n' \"$?\"",
  "printf 'a\\000needle\\n' | grep -I -q -e needle - >/dev/null 2>&1; printf 'TENTACLE_BINFILTER=%s\\n' \"$?\"",
].join("; ");

/**
 * The probe's answer, or `undefined` when the probe was not definitive. ONLY a
 * definitive answer is cached (M4): a rejection, a timeout, an abort or
 * unparseable output caches nothing, so one transient failure cannot pin the
 * slow path (and the demote step, `grep`, IS definitive).
 */
interface Probed extends EngineFacts {
  /** `grep -E … /dev/null` returned 2: the fallback's own options are unusable. */
  readonly grepBroken: boolean;
}

const probeCache = new WeakMap<ExecutionEnvironment, Probed>();

function parseProbe(stdout: string, stderr: string, exitCode: number): Probed | undefined {
  if (exitCode !== 0) {
    return undefined;
  }
  const facts = `${stdout}\n${stderr}`;
  const engine = /TENTACLE_ENGINE=(rg|grep)/.exec(facts)?.[1];
  const binaryFilter = /TENTACLE_BINFILTER=(\d+)/.exec(facts)?.[1];
  const grepCaps = /TENTACLE_GREP_CAPS=(\d+)/.exec(facts)?.[1];
  if (engine === undefined || binaryFilter === undefined) {
    return undefined;
  }
  return {
    engine: engine as SearchEngine,
    binaryFilter: Number(binaryFilter) === 1,
    // rc 1 is the normal "no match"; anything else means the options were refused.
    grepBroken: grepCaps !== undefined && Number(grepCaps) > 1,
  };
}

/**
 * The env's engine facts. The probe carries its OWN timeout and NO
 * `ctx.signal` (M4): a turn cancelled during the first search must not cache a
 * failed probe.
 */
async function engineFor(env: ExecutionEnvironment): Promise<Probed | undefined> {
  const cached = probeCache.get(env);
  if (cached) {
    return cached;
  }
  const result = await env.exec(PROBE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS });
  const probed = parseProbe(result.stdout, result.stderr, result.exitCode);
  if (probed) {
    probeCache.set(env, probed);
  }
  return probed;
}

/** F14/M4: rg was chosen but broke. Demote the cache so the NEXT call skips it. */
function demoteCache(env: ExecutionEnvironment): void {
  probeCache.set(env, { engine: "grep", binaryFilter: false, grepBroken: false });
}

/** Test seam: forget what an env probed (the cache is per env, per process). */
export function forgetProbedEngine(env: ExecutionEnvironment): void {
  probeCache.delete(env);
}

const searchInput = z
  .object({
    pattern: z
      .string()
      .optional()
      .describe(
        "Regex to find (POSIX ERE). `\\d`, `\\w`, `\\s` work; `(?…)`, `\\p{…}`, `{n,m}` and lazy quantifiers are refused on images without ripgrep — use `fixed_strings` or POSIX classes there. In `files` mode WITH a pattern: list the files CONTAINING it.",
      ),
    glob: z
      .string()
      .optional()
      .describe(
        "File-NAME glob, e.g. `*.ts` or `a*.ts` (no `/`, no `**`, no leading `!`, no `{a,b}` brace alternation — put the directory in `path`). Restricts a content search, or is the file list in `files` mode.",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Workspace-relative file or directory to search (default `.`). Absolute paths and `..` are refused.",
      ),
    output_mode: z
      .enum(["content", "files"])
      .optional()
      .describe("`content` (default): matching lines. `files`: matching paths only."),
    fixed_strings: z
      .boolean()
      .optional()
      .describe("Treat `pattern` as a literal string instead of a regex."),
    ignore_case: z.boolean().optional().describe("Case-insensitive match."),
    max_results: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max hits to return (default 100, capped at 1000)."),
  })
  .superRefine((value, ctx) => {
    // ONE source of truth: the pure module decides every field rule (control
    // characters, the mode requirements, the basename-glob rule, confinement),
    // and the schema surfaces its message as a validation error — so the model
    // reads the reason in the tool's own vocabulary, before any I/O.
    const validated = validateSearchInput(value);
    if (!validated.ok) {
      const field = validated.refusal.message.startsWith("`glob`")
        ? "glob"
        : validated.refusal.message.startsWith("`path`")
          ? "path"
          : "pattern";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: validated.refusal.message,
      });
    }
  });

export const searchTool: Tool<z.infer<typeof searchInput>> = {
  name: "search",
  description:
    "Search the workspace: matching lines (`content`) or file paths (`files`), bounded and read-only. Prefer this over reading files to locate a symbol, string or file. Output is capped at 100 hits / 12000 bytes with an explicit truncation marker; a `no matches` line means the walk found nothing. The header names the engine (`rg`, or `grep` on images without ripgrep — there `\\d`/`\\w`/`\\s` are translated and lookaround/`{n,m}`/lazy patterns are refused).",
  inputSchema: searchInput,
  // It cannot touch anything: a bounded, read-only walk inside the workspace
  // (owner Q6 a confines `path`, and the schema has no free-form command).
  permission: "none",
  // A read-class key, so `readOnlyType("explore")` keeps saying yes
  // (subagent.ts:556) — a tool without one is `exclusive`, which would make
  // every `explore` child a "writer" for the round scheduler.
  concurrency: pathConcurrency("read"),
  async execute(input, ctx): Promise<ToolResult> {
    const validated = validateSearchInput(input);
    if (!validated.ok) {
      return { content: validated.refusal.message, isError: true };
    }
    const searchInputValue = validated.input;

    const probed = await engineFor(ctx.env);
    if (probed === undefined) {
      // Not definitive: use the fallback for THIS call and cache nothing (M4).
      return runSearch(searchInputValue, { engine: "grep", binaryFilter: false }, ctx);
    }
    if (probed.engine === "grep" && probed.grepBroken) {
      return {
        content:
          "this image's `grep` does not support `-E`/`-H`, so `search` cannot run here; use `fs_read` and the `shell` tool instead.",
        isError: true,
      };
    }
    return runSearch(searchInputValue, probed, ctx);
  },
};

/**
 * Build → exec → parse → render, with F14's single retry: rg failing in an
 * engine-shaped, non-regex way demotes the cached engine and re-runs ONCE on the
 * fallback. A parse error is a user error — reported, never retried (H2).
 */
async function runSearch(
  input: SearchInput,
  facts: EngineFacts,
  ctx: ToolContext,
): Promise<ToolResult> {
  const gitignore = await readGitignore(ctx);
  const outcome = await execPlan(input, facts, gitignore, ctx);
  if (outcome.retry) {
    demoteCache(ctx.env);
    const fallback = await execPlan(input, { engine: "grep", binaryFilter: false }, gitignore, ctx);
    if (!fallback.rendered) {
      return { content: fallback.refusal ?? "search failed", isError: true };
    }
    return {
      // H2: the retry reason is raw rg stderr (a pod names its own
      // directories), so it is stripped and bounded like every other field.
      content: `${fallback.rendered.content}\n[note: ripgrep failed (${oneWireLine(outcome.retry)}); this result came from the POSIX fallback]`,
      isError: fallback.rendered.isError,
    };
  }
  if (!outcome.rendered) {
    return { content: outcome.refusal ?? "search failed", isError: true };
  }
  return { content: outcome.rendered.content, isError: outcome.rendered.isError };
}

interface ExecOutcome {
  readonly rendered?: { content: string; isError: boolean };
  readonly refusal?: string;
  /** Set when rg failed engine-shaped: demote and retry once (F14). */
  readonly retry?: string;
}

async function execPlan(
  input: SearchInput,
  facts: EngineFacts,
  gitignore: { prunes: readonly string[]; unexpressible: readonly string[] },
  ctx: ToolContext,
): Promise<ExecOutcome> {
  const built = buildSearchPlan(input, facts.engine, {
    gitignore,
    binaryFilter: facts.binaryFilter,
  });
  if (!built.ok) {
    return { refusal: built.refusal.message };
  }
  const result = await ctx.env.exec(built.plan.command, {
    signal: ctx.signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  const filesWithMatches = input.output_mode === "files" && input.pattern !== undefined;
  const parsed = parseSearchOutput(
    result.stdout,
    result.stderr,
    input.output_mode,
    filesWithMatches,
  );
  if (
    facts.engine === "rg" &&
    parsed.parseError === undefined &&
    parsed.globError === undefined &&
    isEngineFailure(result, parsed)
  ) {
    return { retry: firstEngineLine(result.stderr) };
  }
  return {
    rendered: renderSearchResult(parsed, {
      input,
      engine: facts.engine,
      notes: built.plan.notes,
      ...(built.plan.ignoreNote !== undefined ? { ignoreNote: built.plan.ignoreNote } : {}),
      ...(result.exitCode === KILLED_EXIT_CODE && !parsed.missingPath ? { timedOut: true } : {}),
    }),
  };
}

/**
 * An ENGINE-shaped failure: rg said so, with a status that is not "no match" —
 * and NOT a per-PATH condition (M3).
 *
 * A permission error, an `IO error` or a `No such file` names a file the walk
 * met; it says nothing about rg's dialect, so demoting the whole session on it
 * would pin the POSIX fallback (and its narrower pattern set) for every later
 * search — the silent-demotion direction M4 exists to prevent. F14 is "rg was
 * chosen but broke" (a wrapper on `PATH`, a broken binary): that is a failure
 * carrying no path.
 *
 * O4: a GLOB the model wrote is the same shape of user error as a bad pattern.
 * `rg: error parsing glob '*['` arrives with status 2, and demoting on it pinned
 * the session to the fallback for one typo — and made the later dialect
 * refusals lie ("this image has no ripgrep"). `parseSearchOutput` classifies it
 * as `globError` (the ONE `GLOB_ERROR` regex) and the caller excludes it here,
 * so a glob refusal never reaches this function.
 */
function isEngineFailure(
  result: { stdout: string; stderr: string; exitCode: number },
  parsed: { hits: readonly unknown[]; status: number | undefined },
): boolean {
  const status = parsed.status ?? result.exitCode;
  const named = /(^|\n)rg[:\s]/.test(result.stderr);
  // A path-shaped message is the walk's environment, not rg's dialect.
  const perPath = /(Permission denied|IO error|No such file or directory)/i.test(result.stderr);
  // rc 1 is grep's/rg's "no match"; 124 is our own kill (reported, not retried).
  return named && status >= 2 && status !== KILLED_EXIT_CODE && !perPath;
}

function firstEngineLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.startsWith("rg"));
  return line ?? "rg failed";
}

/**
 * The workspace root's `.gitignore`, for prunes and the note (Design 3b). A
 * missing or unreadable file is not an error (F13): no note, no prunes.
 */
async function readGitignore(ctx: ToolContext): Promise<{
  prunes: readonly string[];
  unexpressible: readonly string[];
}> {
  try {
    const text = await ctx.env.readFile(".gitignore");
    return classifyGitignore(text);
  } catch {
    return { prunes: [], unexpressible: [] };
  }
}

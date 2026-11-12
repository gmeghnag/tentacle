/**
 * The I/O layer: locate the config directory, scaffold it on first run, read
 * and validate `config.jsonc` + `PROMPT.md`, then merge via the pure
 * `resolveConfig` and, if needed, resolve the API key by running
 * `apiKeyCommand`. The secret is only ever held in memory and never logged.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import {
  AGENTS_FILENAME,
  CONFIG_FILENAME,
  DEFAULT_CONFIG_JSONC,
  DEFAULT_SYSTEM_PROMPT,
  MAX_AGENT_TASK_DESCRIPTION_BYTES,
  PROMPT_FILENAME,
} from "./defaults.ts";
import { type ProjectHooks, discoverProjectHooks } from "./hooks-scan.ts";
import { type PublishedModels, type ResolvedModel, publishedModelNames } from "./models.ts";
import {
  type PackageHook,
  type PackageInfo,
  escapingSymlink,
  mergePackageContributions,
  scanPackages,
} from "./packages.ts";
import { applyProfile } from "./profile.ts";
import {
  type ApiKeySource,
  type Env,
  type ResolvedConfig,
  agentsMdEnabled,
  composeSystemPrompt,
  resolveConfig,
  skillsEnabled,
} from "./resolve.ts";
import { type FileConfig, FileConfigSchema } from "./schema.ts";
import { scanSkills, skillRoots } from "./skills-scan.ts";
import { type SkillInfo, catalogCapDiagnostic, mergeSkills, slashCapDiagnostic } from "./skills.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Runs a shell command and returns its stdout. Injectable for tests. */
export type CommandRunner = (command: string, signal?: AbortSignal) => Promise<string>;

/** How long a key command may run with no terminal to answer it (the relay's launcher waits 60 s). */
const NO_TERMINAL_KEY_TIMEOUT_MS = 10_000;

/**
 * The user's config file, parsed, validated and with the selected profile folded
 * over it — and NOTHING else: no scaffold, no prompt file, no key command
 * (docs/feat/tui-light-theme.md Q6). `loadConfig` calls this, so the parse stays
 * in one place; `connect` calls it alone, because it needs `tui.theme` and has no
 * model config to build.
 */
export async function readFileConfig(options: {
  readonly env?: Env;
  readonly configDir?: string;
  readonly profile?: string;
}): Promise<FileConfig> {
  const env = options.env ?? process.env;
  const home = env.HOME ?? homedir();
  const configDir = resolveConfigDir(options.configDir, env, home);
  const configPath = join(configDir, CONFIG_FILENAME);
  const parsedFile = await readAndValidateConfigFile(configPath);
  const profile = options.profile ?? (env.TENTACLE_PROFILE || undefined);
  const applied = applyProfile(parsedFile, profile);
  if (!applied.ok) {
    throw new ConfigError(`${configPath}: ${applied.reason}`);
  }
  return applied.config;
}

/**
 * Read + JSONC-parse + validate the config file at `configPath`. A missing file is
 * `{}`; anything unreadable is a `ConfigError` naming the file and the first
 * issue. Shared by `loadConfig` and `readFileConfig`.
 */
async function readAndValidateConfigFile(configPath: string): Promise<FileConfig> {
  if (!(await pathExists(configPath))) {
    return {};
  }
  const raw = parseConfigFile(await readFile(configPath, "utf8"), configPath);
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const removedCwd =
      issue?.code === "unrecognized_keys" && issue.keys.includes("cwd")
        ? " — `cwd` was removed: tentacle works in the folder it is launched from"
        : "";
    throw new ConfigError(`Invalid ${configPath}: ${issue?.message ?? "unknown"}${removedCwd}`);
  }
  return parsed.data;
}

export interface LoadConfigOptions {
  readonly env?: Env;
  /** Explicit config directory (overrides env / XDG / `~/.config`). */
  readonly configDir?: string;
  /** Launch directory, used as the default workspace. */
  readonly cwd?: string;
  /** Create the config dir + template files when missing (default `true`). */
  readonly scaffold?: boolean;
  /** How to run `apiKeyCommand` (default: `/bin/sh -c` via `Bun.spawn`). */
  readonly runCommand?: CommandRunner;
  /** The profile to apply (`--profile`); beats `TENTACLE_PROFILE`. */
  readonly profile?: string;
  /** The model id (`--model`), on the active profile's endpoint; beats `TENTACLE_MODEL`. */
  readonly model?: string;
  /**
   * A load that needs no key: a pod daemon's (`serve --model-proxy`,
   * `--resident-status`, `--resident-stop`) and a command that never calls a
   * model (`ps`, `rm`, `hooks`, `package`: `modeUsesModel`,
   * docs/fix/key-commands-only-for-model-commands.md). It neither runs `apiKeyCommand` nor reads
   * `agentTaskDescriptionFile`, the values the laptop decides that could fail a
   * load, so neither runs code in a pod nor stops the daemon for something it
   * never uses (docs/feat/config-carry.md).
   */
  readonly podDaemon?: boolean;
  /**
   * A process with no terminal: the detached relay, which serves the pod's
   * named model calls (docs/feat/models-map-pod.md D6). The main key as usual.
   * Of the entries, only the PUBLISHED ones run their command, each bounded by
   * `timeoutMs`; one that fails, is empty or runs out of time leaves that entry
   * keyless (the laptop then refuses the name) and is told to `report`, never
   * stopping the load: nobody is there to answer a prompt.
   */
  readonly modelKeysNoTerminal?: {
    readonly report: (name: string, line: string) => void;
    readonly timeoutMs?: number;
  };
}

export interface TentacleConfig {
  readonly provider: ResolvedConfig["provider"];
  readonly baseURL: string;
  readonly model: string;
  /** Whether a model names each session (default false; on a pod always the laptop's, carried). */
  readonly autoTitle: boolean;
  /** The model id that names sessions when `autoTitle`; unset → `model`. */
  readonly titleModel?: string;
  readonly cwd: string;
  readonly maxIterations: number;
  readonly contextWindow: number;
  /** Tell the model how full its context is (on a pod: its own env and file, else the laptop's, carried). */
  readonly contextAwareness: ResolvedConfig["contextAwareness"];
  /** The model's `context_reset` tool and its cap (on a pod: its own env and file, else the laptop's, carried). */
  readonly contextReset: ResolvedConfig["contextReset"];
  readonly maxTokens?: number;
  /**
   * `model.maxImageBytes`: raw bytes one image may have on this model's wire
   * (docs/feat/attachments-core.md, review H1). Unset → the provider's default.
   */
  readonly maxImageBytes?: number;
  /**
   * `model.images`: whether this model takes images at all
   * (docs/feat/attachments-prompt.md D4). Unset → the provider's default.
   */
  readonly images?: boolean;
  readonly systemPrompt: string;
  /** The identity part of `systemPrompt`: with `agentsMdContent`, what a recompose needs. */
  readonly promptIdentity: string;
  /** The AGENTS.md text read at start, whether or not it was folded into `systemPrompt`. */
  readonly agentsMdContent?: string;
  readonly subagentsEnabled: boolean;
  readonly subagentMaxIterations: number;
  /** How a parent's `agent_task` calls may overlap (read by `feat/parallel-agents`; on a pod the laptop's, carried). */
  readonly subagentExecution: ResolvedConfig["subagentExecution"];
  /** At most this many sub-agents at once (read by `feat/parallel-agents`; on a pod the laptop's, carried). */
  readonly subagentMaxParallel: number;
  /** May a running background sub-agent message the agent (docs/feat/agent-message-two-way.md; carried, pinned). */
  readonly subagentsTwoWay: boolean;
  /** A custom `agent_task` description, resolved (read by `feat/parallel-agents`; on a pod the laptop's, carried). */
  readonly agentTaskDescription?: string;
  /**
   * The `models` entries, keys resolved (docs/feat/models-map.md). Laptop/serve
   * only: never carried to a pod, never printed; a pod daemon runs no key command.
   */
  readonly models: Readonly<Record<string, ResolvedModel>>;
  /** `subagents.types.<type>.model`: type → `models` name. */
  readonly subagentModels: Readonly<Record<string, string>>;
  /** `subagents.selectableModels` (`[]` = off). */
  readonly selectableModels: readonly string[];
  /**
   * Over the model tunnel: what the laptop published (docs/feat/models-map-pod.md).
   * Never loaded from a file: only the laptop's carried settings set it.
   */
  readonly publishedModels?: PublishedModels;
  readonly maxInlineOutputChars: number;
  /** Days a spilled tool output is kept; `<= 0` = never swept. */
  readonly toolOutputRetentionDays: number;
  readonly redactSecrets: boolean;
  readonly summarizeLargeOutput: boolean;
  readonly dedupOutput: boolean;
  readonly tabulateJson: boolean;
  readonly autoWake: boolean;
  /** How a round's tool calls may overlap (on a pod: its own env and file, else the laptop's, carried). */
  readonly toolExecution: ResolvedConfig["toolExecution"];
  /**
   * Where `fs_write` may write besides the project, `~` expanded
   * (docs/feat/write-tmpdir.md). Daemon-side; NOT carried to a pod.
   */
  readonly writableDirs: readonly string[];
  /** The configured default engine of `run`/`attach` (file/profile); absent = unset. */
  readonly engine?: ResolvedConfig["engine"];
  /** The configured `run --rm` default (file/profile); absent = the CLI default (false: kept). */
  readonly rm?: ResolvedConfig["rm"];
  /** `run --detach`'s settings (file/profile); absent = the relay's defaults. */
  readonly detach?: ResolvedConfig["detach"];
  /** The configured workspace-mount hide list (file/profile); absent = the CLI default list. */
  readonly mount?: ResolvedConfig["mount"];
  /** The configured TUI palette (file or profile); absent = `auto` (the TUI probes). */
  readonly tui?: ResolvedConfig["tui"];
  /** The laptop's session-log settings (file or profile); absent = defaults (`keepSuperseded` false). */
  readonly sessions?: ResolvedConfig["sessions"];
  /**
   * The configured `apiKeyCommand` (the command, never its output): the CLI
   * hides the key FILE it reads from a workspace mount.
   */
  readonly apiKeyCommand?: string;
  /** The user's hooks, then the enabled packages' (tagged with `source`). */
  readonly hooks: readonly (ResolvedConfig["hooks"][number] | PackageHook)[];
  /** The user's servers plus the packages' (`<pkg>-<server>`; the user's win a clash). */
  readonly mcpServers: ResolvedConfig["mcpServers"];
  /** Enabled, valid installed packages (docs/feat/packages.md), by name. */
  readonly packages: readonly PackageInfo[];
  /** The config's `packages` map (after the profile): `false` = disabled. */
  readonly packagesEnabled: Readonly<Record<string, boolean>>;
  /** The packages' `agents/` dirs, read after `<configDir>/agents` (first wins). */
  readonly packageAgentDirs: readonly string[];
  /** Packages skipped (malformed) and contributions ignored (name clash), for the user. */
  readonly packageDiagnostics: readonly string[];
  readonly apiKey?: string;
  readonly configDir: string;
  readonly configPath: string;
  readonly promptPath: string;
  /** Whether `systemPromptFile` named `promptPath`: then a missing file is an error, not the default. */
  readonly promptFileRequired: boolean;
  /** Whether a per-repo AGENTS.md is folded into the prompt (the start-up decision, kept for a refresh). */
  readonly agentsMdEnabled: boolean;
  /** Whether skills are discovered (the start-up decision, kept for a refresh). */
  readonly skillsEnabled: boolean;
  /** Resolved path of the auto-loaded AGENTS.md, if one was folded into the prompt. */
  readonly agentsPath?: string;
  /**
   * Discovered Agent Skills, after precedence (empty when disabled), including
   * the ones hidden from the model (`disable-model-invocation`). Built once:
   * a new skill needs a restart (or a context reset: `refreshSessionContext`).
   */
  readonly skills: readonly SkillInfo[];
  /** Skill discovery problems (skipped, shadowed, ignored fields) for the user. */
  readonly skillDiagnostics: readonly string[];
  /**
   * The repo's `.agents/hooks.json` hooks (docs/feat/hooks-project-trust.md),
   * absent when none. They run only once the user trusts them.
   */
  readonly projectHooks?: ProjectHooks;
  /** Project hooks files skipped (malformed, unreadable) for the user. */
  readonly projectHooksDiagnostics: readonly string[];
  /**
   * `TENTACLE_PROJECT_DIR` for every hook (docs/feat/hook-env-dirs.md): the
   * repo root (`.git` holder), else the folder of the nearest project hooks
   * file, else `cwd`.
   */
  readonly projectDir: string;
  /** The profile applied from the config file (`--profile` / `TENTACLE_PROFILE`), if any. */
  readonly profile?: string;
  readonly sources: ResolvedConfig["sources"] & { readonly apiKey: ApiKeySource };
}

function expandTilde(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  return p;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the nearest `AGENTS.md` walking up from `startDir`. Stops at the first
 * hit, at the repo root (a `.git` directory — never escaping the repo), or at
 * the filesystem root; the step bound guards against a symlink loop. Returns
 * the absolute path, or undefined when none is found.
 */
async function findAgentsFile(startDir: string): Promise<string | undefined> {
  let dir = resolvePath(startDir);
  for (let i = 0; i < 40; i++) {
    const candidate = join(dir, AGENTS_FILENAME);
    if (await pathExists(candidate)) {
      return candidate;
    }
    // Reached the repo root without a hit → stop; don't read a parent repo's rules.
    if (await pathExists(join(dir, ".git"))) {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined; // filesystem root
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Read the identity prompt file. A missing file is `undefined` (the default
 * prompt applies) unless `required` — an explicit `systemPromptFile` — then it
 * is a `ConfigError`.
 */
async function readPromptFile(promptPath: string, required: boolean): Promise<string | undefined> {
  if (await pathExists(promptPath)) {
    return readFile(promptPath, "utf8");
  }
  if (required) {
    throw new ConfigError(`systemPromptFile not found: ${promptPath}`);
  }
  return undefined;
}

/**
 * The nearest AGENTS.md from `startDir` and its text. Best-effort: an
 * unreadable file is no content (it must never fail a start-up or a reset).
 */
async function readAgentsMd(
  startDir: string,
): Promise<{ file: string | undefined; content: string | undefined }> {
  const file = await findAgentsFile(startDir);
  if (!file) {
    return { file, content: undefined };
  }
  try {
    return { file, content: await readFile(file, "utf8") };
  } catch {
    return { file, content: undefined };
  }
}

export interface DiscoverSkillsInput {
  readonly launchCwd: string;
  readonly home: string;
  readonly configDir: string;
  /** Package `skills/` dirs (user scope), after every root the user owns. */
  readonly packageSkillRoots: readonly string[];
  /** Disabled → no I/O at all. */
  readonly enabled: boolean;
}

/**
 * Discover Agent Skills from the launch folder (the same root as AGENTS.md) and
 * the user scopes. Best-effort like AGENTS.md: problems are diagnostics, never
 * a failure. The one scan shared by start-up (`loadConfig`) and a context reset
 * (`refreshSessionContext`).
 */
export async function discoverSkills(
  input: DiscoverSkillsInput,
): Promise<{ skills: SkillInfo[]; diagnostics: string[] }> {
  if (!input.enabled) {
    return { skills: [], diagnostics: [] };
  }
  const scan = await scanSkills(
    await skillRoots(input.launchCwd, input.home, input.configDir, input.packageSkillRoots),
  );
  const merged = mergeSkills(scan.candidates);
  const diagnostics = [...scan.diagnostics, ...merged.diagnostics];
  for (const capped of [catalogCapDiagnostic(merged.skills), slashCapDiagnostic(merged.skills)]) {
    if (capped) {
      diagnostics.push(capped);
    }
  }
  return { skills: merged.skills, diagnostics };
}

/** The part of a session's context that comes from files, read again. */
export interface RefreshedSessionContext {
  /** The composed system prompt: identity, AGENTS.md, skills catalog. */
  readonly systemPrompt: string;
  readonly skills: readonly SkillInfo[];
  readonly skillDiagnostics: readonly string[];
}

/**
 * Re-read the FILES that make a session's system prompt and skill set —
 * `PROMPT.md` (or env `TENTACLE_SYSTEM_PROMPT`), the nearest `AGENTS.md`, every
 * skill folder (package `skills/` dirs included, even one created since the
 * start) — applying the start-up's SETTINGS (`systemPromptFile`, `loadAgentsMd`,
 * `loadSkills`, the installed-package list) as kept in `config`: `config.jsonc`
 * is not re-read. Same composition as `loadConfig` (`composeSystemPrompt`,
 * `discoverSkills`), so on an unchanged disk it returns exactly
 * `config.systemPrompt` and `config.skills`. Throws `ConfigError` when a
 * required prompt file is gone.
 */
export async function refreshSessionContext(
  config: Pick<
    TentacleConfig,
    | "cwd"
    | "configDir"
    | "promptPath"
    | "promptFileRequired"
    | "agentsMdEnabled"
    | "skillsEnabled"
    | "packages"
  >,
  env: Env = process.env,
): Promise<RefreshedSessionContext> {
  const fromFile = await readPromptFile(config.promptPath, config.promptFileRequired);
  // Same precedence as `resolveConfig`: env > the prompt file > the default.
  const identity = env.TENTACLE_SYSTEM_PROMPT ?? fromFile ?? DEFAULT_SYSTEM_PROMPT;
  const discovered = await rediscoverSkills(config, env);
  const agents = config.agentsMdEnabled ? await readAgentsMd(config.cwd) : undefined;
  const composed = composeSystemPrompt({
    identity,
    agentsMd: agents?.content,
    agentsEnabled: config.agentsMdEnabled,
    skills: discovered.skills,
  });
  return {
    systemPrompt: composed.systemPrompt,
    skills: discovered.skills,
    skillDiagnostics: discovered.diagnostics,
  };
}

/**
 * Re-read every skill folder (package `skills/` dirs included, even one
 * created since the start) with the start-up's SETTINGS as kept in `config`
 * (`loadSkills`, the installed-package list; `config.jsonc` is not re-read):
 * the skills half of `refreshSessionContext`, shared by a context reset and
 * the user's rescan (docs/feat/skills-hot-reload.md). On an unchanged disk it
 * returns exactly `config.skills`.
 */
export async function rediscoverSkills(
  config: Pick<TentacleConfig, "cwd" | "configDir" | "skillsEnabled" | "packages">,
  env: Env = process.env,
): Promise<{ skills: SkillInfo[]; diagnostics: string[] }> {
  // A package's tree is checked again as at start-up (`loadPackage`): one that
  // now holds a symlink out of it (or is gone) contributes no skill. Only
  // when skills are on: off = no I/O, as `discoverSkills`.
  const packageSkillRoots: string[] = [];
  const packageDiagnostics: string[] = [];
  for (const p of config.skillsEnabled ? config.packages : []) {
    let escaping: string | undefined;
    try {
      escaping = await escapingSymlink(p.dir);
    } catch (error) {
      packageDiagnostics.push(
        `package ${p.name}: skills skipped (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (escaping !== undefined) {
      packageDiagnostics.push(
        `package ${p.name}: skills skipped (${escaping} points outside the package)`,
      );
      continue;
    }
    // Derived from the package's dir, not the start-up `skillsDir` (which
    // exists only if the folder existed then).
    packageSkillRoots.push(join(p.dir, "skills"));
  }
  const discovered = await discoverSkills({
    launchCwd: config.cwd,
    home: env.HOME ?? homedir(),
    configDir: config.configDir,
    packageSkillRoots,
    enabled: config.skillsEnabled,
  });
  return {
    skills: discovered.skills,
    diagnostics: [...packageDiagnostics, ...discovered.diagnostics],
  };
}

/**
 * The config dir `loadConfig` would use, without loading or scaffolding
 * anything (for commands that need only the dir, e.g. `tentacle update`).
 */
export function configDirFromEnv(env: Env = process.env): string {
  return resolveConfigDir(undefined, env, env.HOME ?? homedir());
}

function resolveConfigDir(override: string | undefined, env: Env, home: string): string {
  if (override) {
    return resolvePath(expandTilde(override, home));
  }
  if (env.TENTACLE_CONFIG_DIR) {
    return resolvePath(expandTilde(env.TENTACLE_CONFIG_DIR, home));
  }
  if (env.XDG_CONFIG_HOME) {
    return resolvePath(expandTilde(env.XDG_CONFIG_HOME, home), "tentacle");
  }
  return join(home, ".config", "tentacle");
}

/** A key command that exited non-zero: `message` carries its stderr (strict loads); `code` alone is safe to log. */
class KeyCommandExit extends ConfigError {
  constructor(
    readonly code: number,
    detail: string,
  ) {
    super(`apiKeyCommand exited with code ${code}: ${detail}`);
  }
}

async function defaultRunner(command: string, signal?: AbortSignal): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    ...(signal ? { signal } : {}),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new KeyCommandExit(code, stderr.trim() || "(no stderr)");
  }
  return stdout;
}

/** A path a config key names: relative to the config dir, absolute, or `~/…`. */
function configRelativePath(value: string, configDir: string, home: string): string {
  const p = expandTilde(value, home);
  return isAbsolute(p) ? p : join(configDir, p);
}

/**
 * The custom `agent_task` description, resolved once at start: the inline text
 * or the file's, trimmed. Empty, over the cap, or an unreadable file →
 * `ConfigError`, in every runtime: a text valid locally never fails only on `run`.
 */
async function resolveAgentTaskDescription(
  subagents: FileConfig["subagents"],
  configDir: string,
  home: string,
  podDaemon: boolean,
): Promise<string | undefined> {
  const check = (raw: string, setting: string): string => {
    const text = raw.trim();
    if (text === "") {
      throw new ConfigError(`${setting} is empty`);
    }
    if (Buffer.byteLength(text) > MAX_AGENT_TASK_DESCRIPTION_BYTES) {
      throw new ConfigError(`${setting} is over ${MAX_AGENT_TASK_DESCRIPTION_BYTES} bytes`);
    }
    return text;
  };
  if (subagents?.agentTaskDescription !== undefined) {
    try {
      return check(subagents.agentTaskDescription, "subagents.agentTaskDescription");
    } catch (error) {
      // The laptop decides this value: it must not be able to kill a pod's daemon.
      if (podDaemon) {
        return undefined;
      }
      throw error;
    }
  }
  if (subagents?.agentTaskDescriptionFile === undefined || podDaemon) {
    return undefined;
  }
  const path = configRelativePath(subagents.agentTaskDescriptionFile, configDir, home);
  const setting = `subagents.agentTaskDescriptionFile (${path})`;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `${setting} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return check(raw, setting);
}

function parseConfigFile(text: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new ConfigError(`Failed to parse ${path}: ${detail}`);
  }
  return value ?? {};
}

/**
 * A key command under a deadline. The abort kills the shell; the race is what
 * ends the wait, because a grandchild can keep the pipe the read is awaiting
 * open long after the shell died (docs/feat/models-map-pod.md, Probe 2).
 */
async function runBounded(run: CommandRunner, command: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      reject(
        new ConfigError(`apiKeyCommand did not finish within ${seconds}s (it may need a terminal)`),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(command, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `models` entries' keys (docs/feat/models-map.md A5, owner Q4): every
 * DISTINCT own command runs once, in parallel, here — before any TUI, like the
 * main key (a prompting command never lands on Ink's screen). The main
 * command's output is reused, never re-run. An inherited entry gets the main
 * model's final key. `run` undefined (a pod daemon load) → no command runs and
 * a command-keyed entry keeps no key (never used over the tunnel). A failure
 * names the entry (sorted first) and carries stderr only, never a key.
 * `noTerminal` (a detached relay): only the published entries' commands run,
 * bounded, and a failure leaves those entries keyless and is reported.
 */
async function resolveModelKeys(
  models: ResolvedConfig["models"],
  main: { readonly apiKey: string | undefined; readonly apiKeyCommand: string | undefined },
  run: CommandRunner | undefined,
  noTerminal?: {
    readonly published: ReadonlySet<string>;
    readonly report: (name: string, line: string) => void;
    readonly timeoutMs: number;
  },
): Promise<Record<string, ResolvedModel>> {
  const names = Object.keys(models).sort();
  const outputs = new Map<string, string>();
  if (main.apiKeyCommand !== undefined && main.apiKey !== undefined && run !== undefined) {
    outputs.set(main.apiKeyCommand, main.apiKey);
  }
  if (run !== undefined) {
    const eligible = names.filter((name) => noTerminal?.published.has(name) ?? true);
    const owner = new Map<string, string>();
    for (const name of eligible) {
      const command = models[name]?.apiKeyCommand;
      if (command !== undefined && !outputs.has(command) && !owner.has(command)) {
        owner.set(command, name);
      }
    }
    /** command → what went wrong, after the `models.<name>.` prefix. */
    const failed = new Map<string, string>();
    await Promise.all(
      [...owner].map(async ([command, name]) => {
        let key: string;
        try {
          key = noTerminal
            ? (await runBounded(run, command, noTerminal.timeoutMs)).trim()
            : (await run(command)).trim();
        } catch (error) {
          if (noTerminal) {
            // Only our own text, never what the command printed: a non-zero exit
            // reports its code alone (its stderr stays out of relay.log).
            failed.set(
              command,
              error instanceof KeyCommandExit
                ? `apiKeyCommand exited with code ${error.code}`
                : error instanceof ConfigError
                  ? error.message
                  : "apiKeyCommand failed",
            );
            return;
          }
          if (error instanceof ConfigError) {
            throw new ConfigError(`models.${name}.${error.message}`);
          }
          throw error;
        }
        if (key === "") {
          if (noTerminal) {
            failed.set(command, "apiKeyCommand produced an empty key");
            return;
          }
          throw new ConfigError(`models.${name}.apiKeyCommand produced an empty key`);
        }
        outputs.set(command, key);
      }),
    );
    for (const name of eligible) {
      const command = models[name]?.apiKeyCommand;
      const message = command !== undefined ? failed.get(command) : undefined;
      if (message !== undefined) {
        noTerminal?.report(name, `models.${name}.${message}`);
      }
    }
  }
  const out: Record<string, ResolvedModel> = {};
  for (const name of names) {
    const entry = models[name];
    if (entry === undefined) {
      continue;
    }
    const { apiKey: _drop, ...rest } = entry;
    const key =
      entry.apiKeySource === "inherited"
        ? main.apiKey
        : entry.apiKeySource === "command" && entry.apiKeyCommand !== undefined
          ? outputs.get(entry.apiKeyCommand)
          : entry.apiKey;
    out[name] = key !== undefined ? { ...rest, apiKey: key } : rest;
  }
  return out;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<TentacleConfig> {
  const base = options.env ?? process.env;
  // `--model` is TENTACLE_MODEL's CLI twin: resolved from a COPY, so no child
  // process (nor the caller) ever sees it in its environment.
  const env = options.model !== undefined ? { ...base, TENTACLE_MODEL: options.model } : base;
  const home = env.HOME ?? homedir();
  const launchCwd = options.cwd ?? process.cwd();
  const scaffold = options.scaffold ?? true;
  const runCommand = options.runCommand ?? defaultRunner;

  const configDir = resolveConfigDir(options.configDir, env, home);
  const configPath = join(configDir, CONFIG_FILENAME);
  const defaultPromptPath = join(configDir, PROMPT_FILENAME);

  if (scaffold) {
    await mkdir(configDir, { recursive: true });
    if (!(await pathExists(configPath))) {
      await writeFile(configPath, DEFAULT_CONFIG_JSONC, "utf8");
    }
    if (!(await pathExists(defaultPromptPath))) {
      await writeFile(defaultPromptPath, DEFAULT_SYSTEM_PROMPT, "utf8");
    }
  }

  const parsedFile = await readAndValidateConfigFile(configPath);

  // Fold the selected profile over the base BEFORE anything reads the file
  // config (prompt file, key command, MCP servers downstream).
  const profile = options.profile ?? (env.TENTACLE_PROFILE || undefined);
  const applied = applyProfile(parsedFile, profile);
  if (!applied.ok) {
    throw new ConfigError(`${configPath}: ${applied.reason}`);
  }
  const fileConfig = applied.config;

  // Resolve the prompt file: explicit `systemPromptFile` (relative to the
  // config dir) or the default `PROMPT.md`.
  const promptPath = fileConfig.systemPromptFile
    ? configRelativePath(fileConfig.systemPromptFile, configDir, home)
    : defaultPromptPath;
  const promptFileRequired = fileConfig.systemPromptFile !== undefined;
  const promptFromFile = await readPromptFile(promptPath, promptFileRequired);
  const agentTaskDescription = await resolveAgentTaskDescription(
    fileConfig.subagents,
    configDir,
    home,
    options.podDaemon === true,
  );

  // Auto-load a per-repo AGENTS.md from the launch workspace (best-effort: an
  // unreadable file must never crash startup over an optional convenience). The
  // compose/enable decision is pure and lives in resolveConfig.
  const { file: agentsFile, content: agentsMd } = await readAgentsMd(launchCwd);

  // Installed packages (user scope: installing is the trust decision, D11).
  // Best-effort: a broken package is a diagnostic, skipped whole.
  const scanned = await scanPackages(configDir, fileConfig.packages ?? {});
  const packageDiagnostics = [...scanned.diagnostics];

  // Discover skills from the launch folder (the same root as AGENTS.md) and the
  // user scopes. Best-effort like AGENTS.md: problems are diagnostics, never
  // a failed startup. Disabled → no I/O at all.
  const skillsOn = skillsEnabled(fileConfig, env);
  const discovered = await discoverSkills({
    launchCwd,
    home,
    configDir,
    packageSkillRoots: scanned.packages.flatMap((p) => (p.skillsDir ? [p.skillsDir] : [])),
    enabled: skillsOn,
  });
  const skills = discovered.skills;
  const skillDiagnostics = discovered.diagnostics;

  // Project hooks (`.agents/hooks.json`, same walk as skills): best-effort,
  // a broken file is a diagnostic. Loaded here; trusted per session later.
  const {
    projectHooks,
    root: projectRoot,
    diagnostics: projectHooksDiagnostics,
  } = await discoverProjectHooks(launchCwd, home);

  const resolved = resolveConfig({
    fileConfig,
    env,
    defaultCwd: launchCwd,
    promptFromFile,
    agentsMd,
    skills,
    agentTaskDescription,
  });

  let apiKey = resolved.apiKey;
  if (resolved.apiKeySource === "command" && resolved.apiKeyCommand && options.podDaemon !== true) {
    try {
      apiKey = (await runCommand(resolved.apiKeyCommand)).trim();
    } catch (error) {
      // A no-terminal load (the relay) writes this to its log: the exit code alone,
      // like the entries' path; a terminal user keeps the stderr.
      if (options.modelKeysNoTerminal && error instanceof KeyCommandExit) {
        throw new ConfigError(`apiKeyCommand exited with code ${error.code}`);
      }
      throw error;
    }
    if (apiKey === "") {
      throw new ConfigError("apiKeyCommand produced an empty key");
    }
  }
  const models = await resolveModelKeys(
    resolved.models,
    { apiKey, apiKeyCommand: resolved.apiKeyCommand },
    options.podDaemon === true ? undefined : runCommand,
    options.modelKeysNoTerminal
      ? {
          published: new Set(publishedModelNames(resolved)),
          report: options.modelKeysNoTerminal.report,
          timeoutMs: options.modelKeysNoTerminal.timeoutMs ?? NO_TERMINAL_KEY_TIMEOUT_MS,
        }
      : undefined,
  );

  const cwd = resolvePath(expandTilde(resolved.cwd, home));
  const contributed = mergePackageContributions(
    resolved.mcpServers,
    resolved.hooks,
    scanned.packages,
  );
  packageDiagnostics.push(...contributed.diagnostics);

  return {
    provider: resolved.provider,
    baseURL: resolved.baseURL,
    model: resolved.model,
    autoTitle: resolved.autoTitle,
    ...(resolved.titleModel !== undefined ? { titleModel: resolved.titleModel } : {}),
    cwd,
    maxIterations: resolved.maxIterations,
    contextWindow: resolved.contextWindow,
    contextAwareness: resolved.contextAwareness,
    contextReset: resolved.contextReset,
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
    ...(resolved.maxImageBytes !== undefined ? { maxImageBytes: resolved.maxImageBytes } : {}),
    ...(resolved.images !== undefined ? { images: resolved.images } : {}),
    systemPrompt: resolved.systemPrompt,
    promptIdentity: resolved.promptIdentity,
    ...(agentsMd !== undefined ? { agentsMdContent: agentsMd } : {}),
    subagentsEnabled: resolved.subagentsEnabled,
    subagentMaxIterations: resolved.subagentMaxIterations,
    subagentExecution: resolved.subagentExecution,
    subagentMaxParallel: resolved.subagentMaxParallel,
    subagentsTwoWay: resolved.subagentsTwoWay,
    ...(resolved.agentTaskDescription !== undefined
      ? { agentTaskDescription: resolved.agentTaskDescription }
      : {}),
    models,
    subagentModels: resolved.subagentModels,
    selectableModels: resolved.selectableModels,
    maxInlineOutputChars: resolved.maxInlineOutputChars,
    toolOutputRetentionDays: resolved.toolOutputRetentionDays,
    redactSecrets: resolved.redactSecrets,
    summarizeLargeOutput: resolved.summarizeLargeOutput,
    dedupOutput: resolved.dedupOutput,
    tabulateJson: resolved.tabulateJson,
    autoWake: resolved.autoWake,
    toolExecution: resolved.toolExecution,
    writableDirs: resolved.writableDirs.map((d) => expandTilde(d, home)),
    ...(resolved.engine !== undefined ? { engine: resolved.engine } : {}),
    ...(resolved.rm !== undefined ? { rm: resolved.rm } : {}),
    ...(resolved.detach !== undefined ? { detach: resolved.detach } : {}),
    ...(resolved.mount !== undefined ? { mount: resolved.mount } : {}),
    ...(resolved.tui !== undefined ? { tui: resolved.tui } : {}),
    ...(resolved.sessions !== undefined ? { sessions: resolved.sessions } : {}),
    ...(resolved.apiKeyCommand !== undefined ? { apiKeyCommand: resolved.apiKeyCommand } : {}),
    hooks: contributed.hooks,
    mcpServers: contributed.mcpServers,
    packages: scanned.packages,
    packagesEnabled: fileConfig.packages ?? {},
    packageAgentDirs: scanned.packages.flatMap((p) => (p.agentsDir ? [p.agentsDir] : [])),
    packageDiagnostics,
    ...(apiKey !== undefined ? { apiKey } : {}),
    configDir,
    configPath,
    promptPath,
    promptFileRequired,
    agentsMdEnabled: agentsMdEnabled(fileConfig, env),
    skillsEnabled: skillsOn,
    ...(resolved.agentsMdLoaded && agentsFile ? { agentsPath: agentsFile } : {}),
    skills: resolved.skills,
    skillDiagnostics,
    ...(projectHooks !== undefined ? { projectHooks } : {}),
    projectHooksDiagnostics,
    projectDir: projectRoot ?? cwd,
    ...(profile !== undefined ? { profile } : {}),
    sources: { ...resolved.sources, apiKey: resolved.apiKeySource },
  };
}

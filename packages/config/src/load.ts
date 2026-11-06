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
export type CommandRunner = (command: string) => Promise<string>;

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
   * A pod daemon's load (`serve --model-proxy`, `--resident-status`,
   * `--resident-stop`): it neither runs `apiKeyCommand` nor reads
   * `agentTaskDescriptionFile`, the values the laptop decides that could fail a
   * load, so neither runs code in a pod nor stops the daemon for something it
   * never uses (docs/feat/config-carry.md).
   */
  readonly podDaemon?: boolean;
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
  /** A custom `agent_task` description, resolved (read by `feat/parallel-agents`; on a pod the laptop's, carried). */
  readonly agentTaskDescription?: string;
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
  /** The configured default engine of `run`/`attach` (file/profile); absent = unset. */
  readonly engine?: ResolvedConfig["engine"];
  /** The configured `run --keep` default (file/profile); absent = the CLI default (true). */
  readonly keep?: ResolvedConfig["keep"];
  /** `run --detach`'s settings (file/profile); absent = the relay's defaults. */
  readonly detach?: ResolvedConfig["detach"];
  /** The configured workspace-mount hide list (file/profile); absent = the CLI default list. */
  readonly mount?: ResolvedConfig["mount"];
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

/**
 * The user's cache dir for tentacle (`$XDG_CACHE_HOME/tentacle` or
 * `~/.cache/tentacle`), without creating it. `HOME` falls back to `os.homedir()`.
 */
export function cacheDirFromEnv(env: Env = process.env, home?: string): string {
  const h = home ?? env.HOME ?? homedir();
  if (env.XDG_CACHE_HOME) {
    return resolvePath(expandTilde(env.XDG_CACHE_HOME, h), "tentacle");
  }
  return join(h, ".cache", "tentacle");
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

async function defaultRunner(command: string): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new ConfigError(
      `apiKeyCommand exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
    );
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

  let parsedFile: FileConfig;
  if (await pathExists(configPath)) {
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
    parsedFile = parsed.data;
  } else {
    parsedFile = {};
  }

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
    apiKey = (await runCommand(resolved.apiKeyCommand)).trim();
    if (apiKey === "") {
      throw new ConfigError("apiKeyCommand produced an empty key");
    }
  }

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
    systemPrompt: resolved.systemPrompt,
    promptIdentity: resolved.promptIdentity,
    ...(agentsMd !== undefined ? { agentsMdContent: agentsMd } : {}),
    subagentsEnabled: resolved.subagentsEnabled,
    subagentMaxIterations: resolved.subagentMaxIterations,
    subagentExecution: resolved.subagentExecution,
    subagentMaxParallel: resolved.subagentMaxParallel,
    ...(resolved.agentTaskDescription !== undefined
      ? { agentTaskDescription: resolved.agentTaskDescription }
      : {}),
    maxInlineOutputChars: resolved.maxInlineOutputChars,
    toolOutputRetentionDays: resolved.toolOutputRetentionDays,
    redactSecrets: resolved.redactSecrets,
    summarizeLargeOutput: resolved.summarizeLargeOutput,
    dedupOutput: resolved.dedupOutput,
    tabulateJson: resolved.tabulateJson,
    autoWake: resolved.autoWake,
    toolExecution: resolved.toolExecution,
    ...(resolved.engine !== undefined ? { engine: resolved.engine } : {}),
    ...(resolved.keep !== undefined ? { keep: resolved.keep } : {}),
    ...(resolved.detach !== undefined ? { detach: resolved.detach } : {}),
    ...(resolved.mount !== undefined ? { mount: resolved.mount } : {}),
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

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
  PROMPT_FILENAME,
} from "./defaults.ts";
import { type ProjectHooks, discoverProjectHooks } from "./hooks-scan.ts";
import {
  type PackageHook,
  type PackageInfo,
  mergePackageContributions,
  scanPackages,
} from "./packages.ts";
import { applyProfile } from "./profile.ts";
import {
  type ApiKeySource,
  type Env,
  type ResolvedConfig,
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
}

export interface TentacleConfig {
  readonly provider: ResolvedConfig["provider"];
  readonly baseURL: string;
  readonly model: string;
  /** Whether a model names each session (default false; on a pod the laptop's value). */
  readonly autoTitle: boolean;
  /** The model id that names sessions when `autoTitle`; unset → `model`. */
  readonly titleModel?: string;
  readonly cwd: string;
  readonly maxIterations: number;
  readonly contextWindow: number;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly subagentsEnabled: boolean;
  readonly subagentMaxIterations: number;
  readonly maxInlineOutputChars: number;
  readonly redactSecrets: boolean;
  readonly summarizeLargeOutput: boolean;
  readonly dedupOutput: boolean;
  readonly tabulateJson: boolean;
  readonly autoWake: boolean;
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
  /** Resolved path of the auto-loaded AGENTS.md, if one was folded into the prompt. */
  readonly agentsPath?: string;
  /**
   * Discovered Agent Skills, after precedence (empty when disabled), including
   * the ones hidden from the model (`disable-model-invocation`). Built once:
   * a new skill needs a restart.
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
  const env = options.env ?? process.env;
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
  let promptPath: string;
  if (fileConfig.systemPromptFile) {
    const p = expandTilde(fileConfig.systemPromptFile, home);
    promptPath = isAbsolute(p) ? p : join(configDir, p);
  } else {
    promptPath = defaultPromptPath;
  }
  let promptFromFile: string | undefined;
  if (await pathExists(promptPath)) {
    promptFromFile = await readFile(promptPath, "utf8");
  } else if (fileConfig.systemPromptFile) {
    throw new ConfigError(`systemPromptFile not found: ${promptPath}`);
  }

  // Auto-load a per-repo AGENTS.md from the launch workspace (best-effort: an
  // unreadable file must never crash startup over an optional convenience). The
  // compose/enable decision is pure and lives in resolveConfig.
  const agentsFile = await findAgentsFile(launchCwd);
  let agentsMd: string | undefined;
  if (agentsFile) {
    try {
      agentsMd = await readFile(agentsFile, "utf8");
    } catch {
      agentsMd = undefined;
    }
  }

  // Installed packages (user scope: installing is the trust decision, D11).
  // Best-effort: a broken package is a diagnostic, skipped whole.
  const scanned = await scanPackages(configDir, fileConfig.packages ?? {});
  const packageDiagnostics = [...scanned.diagnostics];

  // Discover skills from the launch folder (the same root as AGENTS.md) and the
  // user scopes. Best-effort like AGENTS.md: problems are diagnostics, never
  // a failed startup. Disabled → no I/O at all.
  let skills: SkillInfo[] = [];
  const skillDiagnostics: string[] = [];
  if (skillsEnabled(fileConfig, env)) {
    const packageSkillRoots = scanned.packages.flatMap((p) => (p.skillsDir ? [p.skillsDir] : []));
    const scan = await scanSkills(await skillRoots(launchCwd, home, configDir, packageSkillRoots));
    const merged = mergeSkills(scan.candidates);
    skills = merged.skills;
    skillDiagnostics.push(...scan.diagnostics, ...merged.diagnostics);
    for (const capped of [catalogCapDiagnostic(skills), slashCapDiagnostic(skills)]) {
      if (capped) {
        skillDiagnostics.push(capped);
      }
    }
  }

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
  });

  let apiKey = resolved.apiKey;
  if (resolved.apiKeySource === "command" && resolved.apiKeyCommand) {
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
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
    systemPrompt: resolved.systemPrompt,
    subagentsEnabled: resolved.subagentsEnabled,
    subagentMaxIterations: resolved.subagentMaxIterations,
    maxInlineOutputChars: resolved.maxInlineOutputChars,
    redactSecrets: resolved.redactSecrets,
    summarizeLargeOutput: resolved.summarizeLargeOutput,
    dedupOutput: resolved.dedupOutput,
    tabulateJson: resolved.tabulateJson,
    autoWake: resolved.autoWake,
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

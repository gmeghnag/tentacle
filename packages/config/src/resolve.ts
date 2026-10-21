/**
 * Pure configuration merge: combine built-in defaults, the parsed config file,
 * and environment variables into a single resolved view, with per-field
 * provenance for diagnostics.
 *
 * This module performs NO I/O: file reading, scaffolding, and running the
 * `apiKeyCommand` all happen in `load.ts`. Keeping the merge pure makes the
 * precedence rules exhaustively testable without touching the filesystem.
 */
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_AUTO_WAKE,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DEDUP_OUTPUT,
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_REDACT_SECRETS,
  DEFAULT_SUBAGENTS_ENABLED,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  DEFAULT_SUMMARIZE_LARGE_OUTPUT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TABULATE_JSON,
} from "./defaults.ts";
import type { FileConfig, HookSpecConfig, McpServerConfig } from "./schema.ts";
import { type SkillInfo, renderSkillsCatalog } from "./skills.ts";

export type Env = Record<string, string | undefined>;

/** Where a resolved value came from. */
export type Source = "env" | "file" | "default";

/** How the API key will be obtained. */
export type ApiKeySource = "env" | "file" | "command" | "none";

export interface ResolvedConfig {
  readonly provider: "openai" | "anthropic";
  readonly baseURL: string;
  readonly model: string;
  readonly cwd: string;
  readonly maxIterations: number;
  readonly contextWindow: number;
  /** Max output tokens per response; unset → the provider's own default. */
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  /** Whether a per-repo AGENTS.md was folded into `systemPrompt`. */
  readonly agentsMdLoaded: boolean;
  /** Discovered skills (empty when disabled); the offered ones are cataloged in `systemPrompt`. */
  readonly skills: readonly SkillInfo[];
  readonly subagentsEnabled: boolean;
  /** Sub-agent step limit; a positive integer, or -1 (unlimited). */
  readonly subagentMaxIterations: number;
  /** Max characters of a tool result kept inline before spilling to a file. */
  readonly maxInlineOutputChars: number;
  /** Whether to mask secrets in tool output. */
  readonly redactSecrets: boolean;
  /** Whether to summarise large tool output with the model (vs a preview). */
  readonly summarizeLargeOutput: boolean;
  /** Whether to collapse repeated consecutive output lines. */
  readonly dedupOutput: boolean;
  /** Whether to render JSON array-of-objects results as a table. */
  readonly tabulateJson: boolean;
  /** Whether a background-job exit auto-starts a continuation turn while idle. */
  readonly autoWake: boolean;
  /** User hooks (file-only, no env form); empty when unset. */
  readonly hooks: readonly HookSpecConfig[];
  /** MCP servers to connect to (from the config file), keyed by name. */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Present when the key is known without running a command. */
  readonly apiKey?: string;
  /** Present when the key must be obtained by running this shell command. */
  readonly apiKeyCommand?: string;
  readonly apiKeySource: ApiKeySource;
  /** Per-field provenance (never includes secret values). */
  readonly sources: {
    readonly provider: Source;
    readonly baseURL: Source;
    readonly model: Source;
    readonly maxIterations: Source;
    readonly contextWindow: Source;
    readonly maxTokens: Source;
    readonly systemPrompt: Source;
    readonly subagentsEnabled: Source;
    readonly subagentMaxIterations: Source;
    readonly maxInlineOutputChars: Source;
    readonly redactSecrets: Source;
    readonly summarizeLargeOutput: Source;
    readonly dedupOutput: Source;
    readonly tabulateJson: Source;
    readonly autoWake: Source;
  };
}

export interface ResolveContext {
  readonly fileConfig: FileConfig;
  readonly env: Env;
  /** The workspace: always the launch directory (no env/file override). */
  readonly defaultCwd: string;
  /** Contents of the system-prompt file, if one was read. */
  readonly promptFromFile?: string | undefined;
  /** Contents of a per-repo AGENTS.md, if one was found and read (I/O in load.ts). */
  readonly agentsMd?: string | undefined;
  /** Discovered skills, after precedence (I/O in load.ts); ignored when disabled. */
  readonly skills?: readonly SkillInfo[] | undefined;
}

/** Header the auto-loaded AGENTS.md is appended under, after the identity prompt. */
const AGENTS_PROMPT_HEADER = "# Project rules (AGENTS.md)";

function pick<T>(
  envValue: T | undefined,
  fileValue: T | undefined,
  defaultValue: T,
): { value: T; source: Source } {
  if (envValue !== undefined) {
    return { value: envValue, source: "env" };
  }
  if (fileValue !== undefined) {
    return { value: fileValue, source: "file" };
  }
  return { value: defaultValue, source: "default" };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** A step limit: a positive integer, or -1 (unlimited). Else undefined. */
function parseIterationLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isInteger(n) && (n > 0 || n === -1) ? n : undefined;
}

/** Parse a provider env var; unset/unrecognised → undefined (fall through). */
function parseProvider(raw: string | undefined): "openai" | "anthropic" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  return v === "openai" || v === "anthropic" ? v : undefined;
}

/** Parse a boolean env var; unset/unrecognised → undefined (fall through). */
function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  return undefined;
}

/**
 * Whether skills are discovered: env `TENTACLE_NO_SKILLS` (truthy disables,
 * falsy enables; wins) > file `loadSkills` > enabled. Exported because
 * `load.ts` must know it BEFORE scanning (a disabled scan does no I/O).
 */
export function skillsEnabled(fileConfig: FileConfig, env: Env): boolean {
  const noSkillsEnv = parseBool(env.TENTACLE_NO_SKILLS);
  return noSkillsEnv !== undefined ? !noSkillsEnv : (fileConfig.loadSkills ?? true);
}

export function resolveConfig(ctx: ResolveContext): ResolvedConfig {
  const { fileConfig, env, defaultCwd, promptFromFile, agentsMd } = ctx;
  const model = fileConfig.model ?? {};

  const provider = pick<"openai" | "anthropic" | undefined>(
    parseProvider(env.TENTACLE_PROVIDER),
    model.provider,
    undefined,
  );
  const providerValue = provider.value ?? DEFAULT_PROVIDER;
  // The default endpoint follows the provider; an explicit baseURL always wins.
  const baseURL = pick(
    env.TENTACLE_MODEL_BASE_URL,
    model.baseURL,
    providerValue === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL,
  );
  const modelId = pick(env.TENTACLE_MODEL, model.model, DEFAULT_MODEL);
  // The workspace is the launch directory, as in Claude Code / opencode / pi:
  // rules (AGENTS.md), skills and tools all start from the same folder.
  const cwd = defaultCwd;
  const maxIterations = pick(
    parseIterationLimit(env.TENTACLE_MAX_ITERATIONS),
    fileConfig.maxIterations,
    DEFAULT_MAX_ITERATIONS,
  );
  const contextWindow = pick(
    parsePositiveInt(env.TENTACLE_CONTEXT_WINDOW),
    model.contextWindow,
    DEFAULT_CONTEXT_WINDOW,
  );
  const maxTokens = pick<number | undefined>(
    parsePositiveInt(env.TENTACLE_MAX_TOKENS),
    model.maxTokens,
    undefined,
  );
  // System prompt = identity (env | PROMPT.md | default). AGENTS.md, when
  // auto-loaded, is appended AFTER it as repo rules — additive, never replacing
  // the identity. Disable via env TENTACLE_NO_AGENTS_MD (truthy, wins) or file
  // `loadAgentsMd: false`. The `systemPrompt` source tracks the identity's
  // provenance; whether AGENTS.md was folded in is reported by `agentsMdLoaded`.
  const systemPrompt = pick(env.TENTACLE_SYSTEM_PROMPT, promptFromFile, DEFAULT_SYSTEM_PROMPT);
  const noAgentsEnv = parseBool(env.TENTACLE_NO_AGENTS_MD);
  const agentsEnabled =
    noAgentsEnv !== undefined ? !noAgentsEnv : (fileConfig.loadAgentsMd ?? true);
  const agentsMdLoaded = agentsEnabled && agentsMd !== undefined && agentsMd.trim() !== "";
  const withAgents = agentsMdLoaded
    ? `${systemPrompt.value.trimEnd()}\n\n${AGENTS_PROMPT_HEADER}\n\n${(agentsMd ?? "").trimEnd()}\n`
    : systemPrompt.value;
  // Skills: the catalog goes LAST (after the identity and AGENTS.md), and only
  // when one is offered — with none the prompt stays byte-identical.
  const skills = skillsEnabled(fileConfig, env) ? (ctx.skills ?? []) : [];
  const catalog = renderSkillsCatalog(skills);
  const systemPromptValue = catalog === "" ? withAgents : `${withAgents.trimEnd()}\n\n${catalog}\n`;
  const subagentsEnabled = pick(
    parseBool(env.TENTACLE_SUBAGENTS),
    fileConfig.subagents?.enabled,
    DEFAULT_SUBAGENTS_ENABLED,
  );
  const subagentMaxIterations = pick(
    parseIterationLimit(env.TENTACLE_SUBAGENT_MAX_ITERATIONS),
    fileConfig.subagents?.maxIterations,
    DEFAULT_SUBAGENT_MAX_ITERATIONS,
  );
  const maxInlineOutputChars = pick(
    parseNonNegativeInt(env.TENTACLE_MAX_OUTPUT_CHARS),
    fileConfig.tools?.maxInlineOutputChars,
    DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  );
  const redactSecrets = pick(
    parseBool(env.TENTACLE_REDACT_SECRETS),
    fileConfig.tools?.redactSecrets,
    DEFAULT_REDACT_SECRETS,
  );
  const summarizeLargeOutput = pick(
    parseBool(env.TENTACLE_SUMMARIZE_OUTPUT),
    fileConfig.tools?.summarizeLargeOutput,
    DEFAULT_SUMMARIZE_LARGE_OUTPUT,
  );
  const dedupOutput = pick(
    parseBool(env.TENTACLE_DEDUP_OUTPUT),
    fileConfig.tools?.dedupOutput,
    DEFAULT_DEDUP_OUTPUT,
  );
  const tabulateJson = pick(
    parseBool(env.TENTACLE_TABULATE_JSON),
    fileConfig.tools?.tabulateJson,
    DEFAULT_TABULATE_JSON,
  );
  const autoWake = pick(parseBool(env.TENTACLE_AUTO_WAKE), fileConfig.autoWake, DEFAULT_AUTO_WAKE);

  // API key precedence: env var > file `apiKey` > file `apiKeyCommand`.
  let apiKey: string | undefined;
  let apiKeyCommand: string | undefined;
  let apiKeySource: ApiKeySource = "none";
  if (env.TENTACLE_MODEL_API_KEY) {
    apiKey = env.TENTACLE_MODEL_API_KEY;
    apiKeySource = "env";
  } else if (model.apiKey) {
    apiKey = model.apiKey;
    apiKeySource = "file";
  } else if (model.apiKeyCommand) {
    apiKeyCommand = model.apiKeyCommand;
    apiKeySource = "command";
  }

  return {
    provider: providerValue,
    baseURL: baseURL.value,
    model: modelId.value,
    cwd,
    maxIterations: maxIterations.value,
    contextWindow: contextWindow.value,
    ...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
    systemPrompt: systemPromptValue,
    agentsMdLoaded,
    skills,
    subagentsEnabled: subagentsEnabled.value,
    subagentMaxIterations: subagentMaxIterations.value,
    maxInlineOutputChars: maxInlineOutputChars.value,
    redactSecrets: redactSecrets.value,
    summarizeLargeOutput: summarizeLargeOutput.value,
    dedupOutput: dedupOutput.value,
    tabulateJson: tabulateJson.value,
    autoWake: autoWake.value,
    hooks: fileConfig.hooks ?? [],
    // MCP servers are file-only (no env form); empty when unset.
    mcpServers: fileConfig.mcpServers ?? {},
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeyCommand !== undefined ? { apiKeyCommand } : {}),
    apiKeySource,
    sources: {
      provider: provider.source,
      baseURL: baseURL.source,
      model: modelId.source,
      maxIterations: maxIterations.source,
      contextWindow: contextWindow.source,
      maxTokens: maxTokens.source,
      systemPrompt: systemPrompt.source,
      subagentsEnabled: subagentsEnabled.source,
      subagentMaxIterations: subagentMaxIterations.source,
      maxInlineOutputChars: maxInlineOutputChars.source,
      redactSecrets: redactSecrets.source,
      summarizeLargeOutput: summarizeLargeOutput.source,
      dedupOutput: dedupOutput.source,
      tabulateJson: tabulateJson.source,
      autoWake: autoWake.source,
    },
  };
}

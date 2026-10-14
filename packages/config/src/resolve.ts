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
  DEFAULT_AUTO_WAKE,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DEDUP_OUTPUT,
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
  DEFAULT_REDACT_SECRETS,
  DEFAULT_SUBAGENTS_ENABLED,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  DEFAULT_SUMMARIZE_LARGE_OUTPUT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TABULATE_JSON,
} from "./defaults.ts";
import type { FileConfig, McpServerConfig } from "./schema.ts";

export type Env = Record<string, string | undefined>;

/** Where a resolved value came from. */
export type Source = "env" | "file" | "default";

/** How the API key will be obtained. */
export type ApiKeySource = "env" | "file" | "command" | "none";

export interface ResolvedConfig {
  readonly baseURL: string;
  readonly model: string;
  readonly cwd: string;
  readonly maxIterations: number;
  readonly contextWindow: number;
  readonly systemPrompt: string;
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
  /** MCP servers to connect to (from the config file), keyed by name. */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Present when the key is known without running a command. */
  readonly apiKey?: string;
  /** Present when the key must be obtained by running this shell command. */
  readonly apiKeyCommand?: string;
  readonly apiKeySource: ApiKeySource;
  /** Per-field provenance (never includes secret values). */
  readonly sources: {
    readonly baseURL: Source;
    readonly model: Source;
    readonly cwd: Source;
    readonly maxIterations: Source;
    readonly contextWindow: Source;
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
  /** Fallback workspace when neither env nor file sets `cwd`. */
  readonly defaultCwd: string;
  /** Contents of the system-prompt file, if one was read. */
  readonly promptFromFile?: string | undefined;
}

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

export function resolveConfig(ctx: ResolveContext): ResolvedConfig {
  const { fileConfig, env, defaultCwd, promptFromFile } = ctx;
  const model = fileConfig.model ?? {};

  const baseURL = pick(env.HARNESS_MODEL_BASE_URL, model.baseURL, DEFAULT_BASE_URL);
  const modelId = pick(env.HARNESS_MODEL, model.model, DEFAULT_MODEL);
  const cwd = pick(env.HARNESS_CWD, fileConfig.cwd, defaultCwd);
  const maxIterations = pick(
    parsePositiveInt(env.HARNESS_MAX_ITERATIONS),
    fileConfig.maxIterations,
    DEFAULT_MAX_ITERATIONS,
  );
  const contextWindow = pick(
    parsePositiveInt(env.HARNESS_CONTEXT_WINDOW),
    model.contextWindow,
    DEFAULT_CONTEXT_WINDOW,
  );
  const systemPrompt = pick(env.HARNESS_SYSTEM_PROMPT, promptFromFile, DEFAULT_SYSTEM_PROMPT);
  const subagentsEnabled = pick(
    parseBool(env.HARNESS_SUBAGENTS),
    fileConfig.subagents?.enabled,
    DEFAULT_SUBAGENTS_ENABLED,
  );
  const subagentMaxIterations = pick(
    parseIterationLimit(env.HARNESS_SUBAGENT_MAX_ITERATIONS),
    fileConfig.subagents?.maxIterations,
    DEFAULT_SUBAGENT_MAX_ITERATIONS,
  );
  const maxInlineOutputChars = pick(
    parseNonNegativeInt(env.HARNESS_MAX_OUTPUT_CHARS),
    fileConfig.tools?.maxInlineOutputChars,
    DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  );
  const redactSecrets = pick(
    parseBool(env.HARNESS_REDACT_SECRETS),
    fileConfig.tools?.redactSecrets,
    DEFAULT_REDACT_SECRETS,
  );
  const summarizeLargeOutput = pick(
    parseBool(env.HARNESS_SUMMARIZE_OUTPUT),
    fileConfig.tools?.summarizeLargeOutput,
    DEFAULT_SUMMARIZE_LARGE_OUTPUT,
  );
  const dedupOutput = pick(
    parseBool(env.HARNESS_DEDUP_OUTPUT),
    fileConfig.tools?.dedupOutput,
    DEFAULT_DEDUP_OUTPUT,
  );
  const tabulateJson = pick(
    parseBool(env.HARNESS_TABULATE_JSON),
    fileConfig.tools?.tabulateJson,
    DEFAULT_TABULATE_JSON,
  );
  const autoWake = pick(parseBool(env.HARNESS_AUTO_WAKE), fileConfig.autoWake, DEFAULT_AUTO_WAKE);

  // API key precedence: env var > file `apiKey` > file `apiKeyCommand`.
  let apiKey: string | undefined;
  let apiKeyCommand: string | undefined;
  let apiKeySource: ApiKeySource = "none";
  if (env.HARNESS_MODEL_API_KEY) {
    apiKey = env.HARNESS_MODEL_API_KEY;
    apiKeySource = "env";
  } else if (model.apiKey) {
    apiKey = model.apiKey;
    apiKeySource = "file";
  } else if (model.apiKeyCommand) {
    apiKeyCommand = model.apiKeyCommand;
    apiKeySource = "command";
  }

  return {
    baseURL: baseURL.value,
    model: modelId.value,
    cwd: cwd.value,
    maxIterations: maxIterations.value,
    contextWindow: contextWindow.value,
    systemPrompt: systemPrompt.value,
    subagentsEnabled: subagentsEnabled.value,
    subagentMaxIterations: subagentMaxIterations.value,
    maxInlineOutputChars: maxInlineOutputChars.value,
    redactSecrets: redactSecrets.value,
    summarizeLargeOutput: summarizeLargeOutput.value,
    dedupOutput: dedupOutput.value,
    tabulateJson: tabulateJson.value,
    autoWake: autoWake.value,
    // MCP servers are file-only (no env form); empty when unset.
    mcpServers: fileConfig.mcpServers ?? {},
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeyCommand !== undefined ? { apiKeyCommand } : {}),
    apiKeySource,
    sources: {
      baseURL: baseURL.source,
      model: modelId.source,
      cwd: cwd.source,
      maxIterations: maxIterations.source,
      contextWindow: contextWindow.source,
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

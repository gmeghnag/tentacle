/**
 * Zod schema for the on-disk `config.jsonc`.
 *
 * The schema is `.strict()` everywhere so that a typo'd key (e.g. `modle`)
 * is a loud validation error rather than a silently-ignored setting — the
 * behaviour an enterprise config system should have.
 */
import { z } from "zod";

export const ModelConfigSchema = z
  .object({
    /**
     * Provider kind. `"openai"` (default) targets `/v1/chat/completions`;
     * `"anthropic"` targets the native Messages API `/v1/messages`.
     */
    provider: z.enum(["openai", "anthropic"]).optional(),
    /** Base URL including the API version, e.g. `http://localhost:8080/v1`. */
    baseURL: z.string().url().optional(),
    /** Model id passed to the endpoint. */
    model: z.string().min(1).optional(),
    /**
     * Literal API key. Discouraged — prefer `apiKeyCommand` so the secret is
     * never stored in plaintext inside the config file.
     */
    apiKey: z.string().min(1).optional(),
    /**
     * Shell command whose stdout is the API key (e.g.
     * `"cat ~/.cache/llama-api-key"` or a password-manager read). Resolved
     * lazily at load time; its output is trimmed and never written to disk.
     */
    apiKeyCommand: z.string().min(1).optional(),
    /** Context-window size (tokens) for the TUI context-fill meter. */
    contextWindow: z.number().int().positive().optional(),
    /** Max output tokens per model response (`max_tokens` on the wire). */
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** A stdio MCP server: a command to spawn, exchanging JSON-RPC over stdio. */
const McpStdioServerSchema = z
  .object({
    type: z.literal("stdio"),
    /** Executable to spawn. */
    command: z.string().min(1),
    /** Arguments passed to the command. */
    args: z.array(z.string()).optional(),
    /** Extra environment variables for the server process. */
    env: z.record(z.string()).optional(),
    /** Working directory for the server process. */
    cwd: z.string().min(1).optional(),
  })
  .strict();

/** A remote MCP server reached over Streamable HTTP (one endpoint URL). */
const McpHttpServerSchema = z
  .object({
    type: z.literal("http"),
    /** The server's MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
    url: z.string().url(),
    /** Extra request headers (e.g. `Authorization`); sent only to `url`. */
    headers: z.record(z.string()).optional(),
  })
  .strict();

/**
 * An MCP server, discriminated by `type`. Omitted, it is inferred: `"http"` for
 * a `url` without a `command` (the shape other MCP clients use), else
 * `"stdio"` (so existing configs keep working). Discriminating before
 * validating keeps each branch's own issue first — a plain union would report
 * only "Invalid input".
 */
export const McpServerSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !("type" in value)
      ? { type: "url" in value && !("command" in value) ? "http" : "stdio", ...value }
      : value,
  z.discriminatedUnion("type", [McpStdioServerSchema, McpHttpServerSchema]),
);

export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** The settings a config file — and each of its profiles — can hold. */
const settingsShape = {
  model: ModelConfigSchema.optional(),
  /**
   * Path to a file holding the system prompt, relative to the config dir
   * (default `PROMPT.md`) or absolute.
   */
  systemPromptFile: z.string().min(1).optional(),
  /**
   * Auto-load a per-repo `AGENTS.md` (found by walking up from the workspace)
   * and append it to the system prompt after the identity prompt. Default:
   * enabled. Set `false`, or the env `TENTACLE_NO_AGENTS_MD`, to disable.
   */
  loadAgentsMd: z.boolean().optional(),
  /**
   * Discover Agent Skills (`SKILL.md`) in `.agents/skills/` (walking up from
   * the launch folder to the repo root), `<configDir>/skills/` and
   * `~/.agents/skills/`, list them in the system prompt and offer the `skill`
   * tool. Default: enabled. Set `false`, or the env `TENTACLE_NO_SKILLS`, to
   * disable.
   */
  loadSkills: z.boolean().optional(),
  /** Maximum model/tool iterations per turn. */
  maxIterations: z
    .number()
    .int()
    .refine((n) => n > 0 || n === -1, "must be a positive integer or -1 (unlimited)")
    .optional(),
  /** Sub-agents (the `agent_task` delegation tool). */
  subagents: z
    .object({
      /** Whether the agent may spawn sub-agents. Default: enabled. */
      enabled: z.boolean().optional(),
      /** Step limit for a sub-agent's loop; a positive integer, or -1 (unlimited). */
      maxIterations: z
        .number()
        .int()
        .refine((n) => n > 0 || n === -1, "must be a positive integer or -1 (unlimited)")
        .optional(),
    })
    .strict()
    .optional(),
  /**
   * Auto-wake: when a background job exits while the agent is idle, start a
   * continuation turn so it reacts without a user prompt. Default: enabled.
   */
  autoWake: z.boolean().optional(),
  /** MCP servers to connect to, keyed by name; their tools are added to the agent. */
  mcpServers: z.record(McpServerSchema).optional(),
  /** Tool-output handling. */
  tools: z
    .object({
      /**
       * Max characters of a tool result kept inline; larger output is spilled
       * to a file the model reads selectively. 0 disables spilling.
       */
      maxInlineOutputChars: z.number().int().nonnegative().optional(),
      /** Mask secrets (keys, tokens, …) in tool output. Default: enabled. */
      redactSecrets: z.boolean().optional(),
      /** Collapse runs of identical consecutive output lines. Default: enabled. */
      dedupOutput: z.boolean().optional(),
      /** Render a JSON array-of-objects result as a compact table. Default: disabled. */
      tabulateJson: z.boolean().optional(),
      /**
       * Replace large output with an LLM summary (full output still spilled to
       * a file) instead of a head/tail preview. Costs a model call per large
       * result. Default: disabled.
       */
      summarizeLargeOutput: z.boolean().optional(),
    })
    .strict()
    .optional(),
};

/**
 * A named profile (docs/feat/config-profiles.md): the same settings as the
 * file, merged over it when selected with `--profile <name>` /
 * `TENTACLE_PROFILE`. No nested `profiles`; an MCP server set to `null` is
 * removed from the base for this profile.
 */
export const ProfileSchema = z
  .object({
    ...settingsShape,
    mcpServers: z.record(McpServerSchema.nullable()).optional(),
  })
  .strict();

export type ProfileConfig = z.infer<typeof ProfileSchema>;

export const FileConfigSchema = z
  .object({
    /** JSON-schema pointer; accepted and ignored so editors can offer hints. */
    $schema: z.string().optional(),
    ...settingsShape,
    /** Named profiles, keyed by name; at most one is applied per launch. */
    profiles: z.record(ProfileSchema).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

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
    /** OpenAI-compatible base URL, e.g. `http://localhost:8080/v1`. */
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
  })
  .strict();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** A stdio MCP server: a command to spawn, exchanging JSON-RPC over stdio. */
export const McpServerSchema = z
  .object({
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

export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const FileConfigSchema = z
  .object({
    /** JSON-schema pointer; accepted and ignored so editors can offer hints. */
    $schema: z.string().optional(),
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
    /** Default workspace directory for tool execution. */
    cwd: z.string().min(1).optional(),
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
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

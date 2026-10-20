/**
 * Built-in defaults and the templates written when scaffolding a fresh
 * `~/.config/tentacle/` directory on first run.
 */
export const DEFAULT_BASE_URL = "http://localhost:8080/v1";
/** Base URL used when `provider` is `"anthropic"` and no `baseURL` is set. */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_MODEL = "default";
/** Provider kind: OpenAI-compatible `/v1/chat/completions` by default. */
export const DEFAULT_PROVIDER = "openai" as const;
export const DEFAULT_MAX_ITERATIONS = 16;
/** Sub-agents (the `agent_task` delegation tool) are available by default. */
export const DEFAULT_SUBAGENTS_ENABLED = true;
/**
 * Step limit for a sub-agent's own loop — more generous than the parent's, as a
 * delegated investigation/task often needs more tool rounds. `-1` = unlimited.
 */
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 50;
/**
 * When a background job exits while the agent is idle, auto-start a continuation
 * turn so the model reacts to the exit without the user prompting. On by default.
 */
export const DEFAULT_AUTO_WAKE = true;
/** Token budget used for the TUI context-fill meter. */
export const DEFAULT_CONTEXT_WINDOW = 128000;
/** Max characters of a tool result kept inline before it is spilled to a file. */
export const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 16000;
/** Secret redaction of tool output is on by default (security). */
export const DEFAULT_REDACT_SECRETS = true;
/** LLM summarisation of large output is off by default (costs a model call). */
export const DEFAULT_SUMMARIZE_LARGE_OUTPUT = false;
/** Collapsing repeated consecutive output lines is on by default. */
export const DEFAULT_DEDUP_OUTPUT = true;
/** Rendering JSON arrays as tables is off by default (opinionated). */
export const DEFAULT_TABULATE_JSON = false;
export const PROMPT_FILENAME = "PROMPT.md";
export const CONFIG_FILENAME = "config.jsonc";
/**
 * Per-repo agent rules file, auto-loaded from the workspace (walking up to the
 * repo root) and appended to the system prompt after the identity (`PROMPT.md`).
 * The same file Claude Code reads, so every agent/harness sees identical rules.
 */
export const AGENTS_FILENAME = "AGENTS.md";

/** Default system prompt, also written to `PROMPT.md` on first run. */
export const DEFAULT_SYSTEM_PROMPT = `You are a capable, precise software engineering agent.

Operating principles:
- Prefer reading the relevant files before editing; make the smallest change that fully solves the task.
- Use the provided tools to inspect and modify the workspace; never invent file contents you have not read.
- When editing, match the surrounding style. Explain what you changed, concisely.
- If a request is ambiguous or risky, state your assumption and proceed, or ask one focused question.
- Report outcomes faithfully: if something failed, say so with the error.
`;

/**
 * The commented `config.jsonc` written on first run. Every setting is present
 * but commented out, so the file documents itself and the defaults stay
 * authoritative until the user opts in.
 */
export const DEFAULT_CONFIG_JSONC = `{
  // tentacle configuration.
  //
  // Precedence (highest wins):  environment variables  >  the selected profile  >  this file  >  built-in defaults.
  // Uncomment a setting to override the default shown in the comment.

  "model": {
    // Provider kind: "openai" (default, any /v1/chat/completions endpoint) or
    // "anthropic" (native Messages API, /v1/messages).
    // "provider": "${DEFAULT_PROVIDER}",

    // Base URL including the API version. Default depends on the provider:
    // ${DEFAULT_BASE_URL} (openai) or ${DEFAULT_ANTHROPIC_BASE_URL} (anthropic).
    // "baseURL": "${DEFAULT_BASE_URL}",

    // Model id sent to the endpoint.
    // "model": "${DEFAULT_MODEL}",

    // API key. Prefer "apiKeyCommand" below so the secret is NOT stored here in plaintext.
    // "apiKey": "sk-...",

    // Shell command whose stdout is the API key (trimmed). Runs at startup.
    // "apiKeyCommand": "cat ~/.cache/llama-api-key",

    // Context-window size (tokens) used for the TUI context-fill meter.
    // "contextWindow": ${DEFAULT_CONTEXT_WINDOW},

    // Max output tokens per model response. Unset: omitted for openai, 64000
    // for anthropic (the API requires it). Lower it for a model with a smaller cap.
    // "maxTokens": 64000
  },

  // System prompt file, relative to this directory (or an absolute path).
  // "systemPromptFile": "${PROMPT_FILENAME}",

  // Max model/tool iterations per turn.
  // "maxIterations": ${DEFAULT_MAX_ITERATIONS}, // -1 = unlimited

  // Sub-agents: the \`agent_task\` tool that delegates work to an isolated child agent.
  // "subagents": { "enabled": ${DEFAULT_SUBAGENTS_ENABLED}, "maxIterations": ${DEFAULT_SUBAGENT_MAX_ITERATIONS} }, // maxIterations: -1 = unlimited

  // Auto-wake: when a background job exits while idle, automatically start a
  // turn so the agent reacts to it (reads output, continues). On by default;
  // set false to require a manual prompt instead.
  // "autoWake": ${DEFAULT_AUTO_WAKE},

  // MCP servers to connect to (keyed by name). Each is spawned over stdio and
  // its tools become available to the agent as \`mcp__<name>__<tool>\`.
  // "mcpServers": {
  //   "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  // },

  // Tool-output handling.
  //  - maxInlineOutputChars: a result longer than this is spilled to a file under
  //    .tentacle/tool-output/ and the model is told to read it selectively (0 = off).
  //  - redactSecrets: mask keys/tokens/credentials in tool output (on by default).
  //  - summarizeLargeOutput: replace large output with an LLM summary instead of a
  //    preview (full output still spilled to a file). Costs a model call; off by default.
  //  - dedupOutput: collapse runs of identical consecutive lines (log spam). On by default.
  //  - tabulateJson: render a JSON array-of-objects result as a compact table. Off by default.
  // "tools": { "maxInlineOutputChars": ${DEFAULT_MAX_INLINE_OUTPUT_CHARS}, "redactSecrets": ${DEFAULT_REDACT_SECRETS}, "summarizeLargeOutput": ${DEFAULT_SUMMARIZE_LARGE_OUTPUT}, "dedupOutput": ${DEFAULT_DEDUP_OUTPUT}, "tabulateJson": ${DEFAULT_TABULATE_JSON} },

  // Named profiles, applied with \`tentacle --profile <name>\` (or TENTACLE_PROFILE).
  // A profile holds the same settings as this file and is merged over them:
  //  - "model" merges per key, but provider/baseURL/apiKey/apiKeyCommand move as
  //    one unit: set any of them and the others are NOT inherited (a key is never
  //    sent to an endpoint it was not configured for);
  //  - "subagents"/"tools" merge per key; other settings replace;
  //  - "mcpServers" merge by name: a server is replaced whole, null removes it.
  // "profiles": {
  //   "anthropic": {
  //     "model": { "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyCommand": "cat ~/.cache/anthropic-key" },
  //     "mcpServers": { "filesystem": null }
  //   }
  // }
}
`;

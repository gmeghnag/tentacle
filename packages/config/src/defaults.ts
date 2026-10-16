/**
 * Built-in defaults and the templates written when scaffolding a fresh
 * `~/.config/tentacle/` directory on first run.
 */
export const DEFAULT_BASE_URL = "http://localhost:8080/v1";
export const DEFAULT_MODEL = "default";
export const DEFAULT_MAX_ITERATIONS = 16;
/** Sub-agents (the `task` delegation tool) are available by default. */
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
  // Precedence (highest wins):  environment variables  >  this file  >  built-in defaults.
  // Uncomment a setting to override the default shown in the comment.

  "model": {
    // OpenAI-compatible base URL.
    // "baseURL": "${DEFAULT_BASE_URL}",

    // Model id sent to the endpoint.
    // "model": "${DEFAULT_MODEL}",

    // API key. Prefer "apiKeyCommand" below so the secret is NOT stored here in plaintext.
    // "apiKey": "sk-...",

    // Shell command whose stdout is the API key (trimmed). Runs at startup.
    // "apiKeyCommand": "cat ~/.cache/llama-api-key",

    // Context-window size (tokens) used for the TUI context-fill meter.
    // "contextWindow": ${DEFAULT_CONTEXT_WINDOW}
  },

  // System prompt file, relative to this directory (or an absolute path).
  // "systemPromptFile": "${PROMPT_FILENAME}",

  // Default workspace directory for tools (defaults to the launch directory).
  // "cwd": "~/code/project",

  // Max model/tool iterations per turn.
  // "maxIterations": ${DEFAULT_MAX_ITERATIONS},

  // Sub-agents: the \`task\` tool that delegates work to an isolated child agent.
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
  // "tools": { "maxInlineOutputChars": ${DEFAULT_MAX_INLINE_OUTPUT_CHARS}, "redactSecrets": ${DEFAULT_REDACT_SECRETS}, "summarizeLargeOutput": ${DEFAULT_SUMMARIZE_LARGE_OUTPUT}, "dedupOutput": ${DEFAULT_DEDUP_OUTPUT}, "tabulateJson": ${DEFAULT_TABULATE_JSON} }
}
`;

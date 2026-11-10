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
/** How a parent's `agent_task` calls of one round may overlap (read by `feat/parallel-agents`). */
export const DEFAULT_SUBAGENT_EXECUTION = "parallel" as const;
/** At most this many sub-agents at once (read by `feat/parallel-agents`). */
export const DEFAULT_SUBAGENT_MAX_PARALLEL = 4;
/**
 * May a running background sub-agent message the agent (`agent_notify`, and
 * wake it)? Off by default: it changes what a child can do to its parent
 * (docs/feat/agent-message-two-way.md, owner Q3 a).
 */
export const DEFAULT_SUBAGENTS_TWO_WAY = false;
/** Max bytes of a custom `agent_task` description, after trimming. */
export const MAX_AGENT_TASK_DESCRIPTION_BYTES = 4096;
/**
 * When a background job exits while the agent is idle, auto-start a continuation
 * turn so the model reacts to the exit without the user prompting. On by default.
 */
export const DEFAULT_AUTO_WAKE = true;
/** Model-generated session titles are opt-in (docs/feat/session-titles.md). */
export const DEFAULT_AUTO_TITLE = false;
/** Token budget used for the TUI context-fill meter and the model's context line. */
export const DEFAULT_CONTEXT_WINDOW = 128000;
/** The model is told how full its context is (docs/feat/context-awareness.md). */
export const DEFAULT_CONTEXT_AWARENESS = true;
/** …once per this many percent of the window. */
export const DEFAULT_CONTEXT_STEP_PERCENT = 1;
/** The model may renew its own context with `context_reset` (docs/feat/context-reset-refresh.md). */
export const DEFAULT_CONTEXT_RESET_ENABLED = true;
/** Resets allowed per user message; `-1` = unlimited. */
export const DEFAULT_CONTEXT_RESET_MAX_PER_MESSAGE = -1;
/** Max characters of a tool result kept inline before it is spilled to a file. */
export const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 16000;
/** Days a spilled tool output is kept before the daemon's start-up sweep removes it; `0` or negative = never. */
export const DEFAULT_TOOL_OUTPUT_RETENTION_DAYS = 30;
/** Secret redaction of tool output is on by default (security). */
export const DEFAULT_REDACT_SECRETS = false;
/** LLM summarisation of large output is off by default (costs a model call). */
export const DEFAULT_SUMMARIZE_LARGE_OUTPUT = false;
/** Collapsing repeated consecutive output lines is on by default. */
export const DEFAULT_DEDUP_OUTPUT = true;
/** Rendering JSON arrays as tables is off by default (opinionated). */
export const DEFAULT_TABULATE_JSON = false;
/** A round's read-class tool calls run together; writes and shell alone (docs/feat/parallel-tools.md). */
export const DEFAULT_TOOL_EXECUTION = "read-only";
/** At most this many calls of a round at once. */
export const DEFAULT_TOOL_MAX_PARALLEL = 8;
/**
 * Where `fs_write` may write besides the project, by default
 * (docs/feat/write-tmpdir.md): the system temp dir — `os.tmpdir()`'s POSIX rule
 * (`TMPDIR` | `TMP` | `TEMP` | `/tmp`, trailing slash trimmed), read from the
 * given env so it stays pure — and `/tmp`, de-duplicated. Runtime state, so
 * computed at resolve time, not a constant.
 */
export function defaultWritableDirs(env: Readonly<Record<string, string | undefined>>): string[] {
  let tmp = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  if (tmp.length > 1 && tmp.endsWith("/")) {
    tmp = tmp.slice(0, -1);
  }
  return tmp === "/tmp" ? ["/tmp"] : [tmp, "/tmp"];
}
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

    // Ask a model to name each session after its first exchange. Off: the title
    // is the first message you typed (rename it with /rename). On a pod
    // (run/attach) this laptop's setting decides.
    // "autoTitle": ${DEFAULT_AUTO_TITLE},

    // Model id (same endpoint) that writes those titles when "autoTitle" is on,
    // e.g. a cheaper one. Unset: the model above.
    // "titleModel": "a-small-model",

    // API key. Prefer "apiKeyCommand" below so the secret is NOT stored here in plaintext.
    // "apiKey": "sk-...",

    // Shell command whose stdout is the API key (trimmed). Runs at startup.
    // "apiKeyCommand": "cat ~/.cache/llama-api-key",

    // Context-window size (tokens) used for the TUI context-fill meter and the
    // model's context line ("contextAwareness" below).
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
  // "subagents": { "enabled": ${DEFAULT_SUBAGENTS_ENABLED}, "maxIterations": ${DEFAULT_SUBAGENT_MAX_ITERATIONS}, "execution": "${DEFAULT_SUBAGENT_EXECUTION}", "maxParallel": ${DEFAULT_SUBAGENT_MAX_PARALLEL} }, // maxIterations: -1 = unlimited
  // execution: "parallel", "read-only" (only sub-agents that cannot write overlap) or "sequential". maxParallel: at most that many at once — set it to what your model server can run in parallel.
  // "agentTaskDescription" or "agentTaskDescriptionFile": replace the tool's description, at most ${MAX_AGENT_TASK_DESCRIPTION_BYTES} bytes.

  // Context awareness: tell the model how full its context is — a short line
  // ("[context: 82k / 128k tokens (64%)]") appended to the message that crosses
  // each new step of "stepPercent" (default 1%), never to the system prompt.
  // Counted from the provider's reported usage, an estimate when it reports none;
  // the window is model.contextWindow.
  // "contextAwareness": { "enabled": ${DEFAULT_CONTEXT_AWARENESS}, "stepPercent": ${DEFAULT_CONTEXT_STEP_PERCENT} },

  // Context reset: the model may renew its own context (the \`context_reset\` tool,
  // asked like any tool): the history is replaced by the system prompt (re-read
  // from disk) and a restart prompt the model writes. "maxPerMessage" caps the
  // resets per user message (-1 = unlimited).
  // "contextReset": { "enabled": ${DEFAULT_CONTEXT_RESET_ENABLED}, "maxPerMessage": ${DEFAULT_CONTEXT_RESET_MAX_PER_MESSAGE} },

  // Auto-wake: when a background job exits while idle, automatically start a
  // turn so the agent reacts to it (reads output, continues). On by default;
  // set false to require a manual prompt instead.
  // "autoWake": ${DEFAULT_AUTO_WAKE},

  // Default engine of \`tentacle run\` / \`tentacle attach\`: "kubernetes" (a pod),
  // "docker" or "podman" (a container). --engine and TENTACLE_ENGINE win.
  // "engine": "kubernetes",

  // Whether \`tentacle run\` removes its pod/container when the run ends. Default
  // false: it is kept and the re-attach command printed; true removes it.
  // --rm[=true|false] wins, then a profile.
  // "rm": false,

  // \`tentacle run --detach\`: on macOS, hold a sleep assertion (caffeinate) while a
  // turn runs, so the Mac does not idle-sleep under it. Closing the lid still sleeps it.
  // "detach": { "keepAwake": true },

  // The TUI's palette: "auto" (default) reads the terminal's background before the
  // first frame and picks a light or dark palette; "dark"/"light" force one and skip
  // that query (useful on a slow link, or when the guess is wrong).
  // "tui": { "theme": "auto" },

  // Session files (one log per conversation under <configDir>/sessions/): keep the
  // history a compaction or a context reset replaced in the file too (resume still
  // shows the current context). Default false: superseded history is not kept.
  // "sessions": { "keepSuperseded": false },

  // \`tentacle run --engine docker|podman\` mounts the current folder into the
  // container; these paths (dirs or files, "~/…" or absolute) are hidden when
  // inside it. "hide" REPLACES the default list (~/.ssh, ~/.aws, ~/.kube,
  // ~/.config/gcloud, ~/.docker/config.json, ~/.netrc), "hideExtra" ADDS to it.
  // tentacle's config dir and the apiKeyCommand key file are always hidden.
  // "mount": { "hideExtra": ["~/.pgpass"] },

  // Hooks: shell commands run on agent events, with a JSON input on stdin
  // (contract: docs/feat/hooks-core.md). "tool_call" can allow / ask / deny /
  // rewrite a call (exit 2 = deny, stderr = reason); "tool_result" can replace
  // a result. "matcher" is a tool name ("shell"), "a|b" names, or a regex
  // ("mcp__.*"). "onFailure": "ignore" (default) | "block". "turn_start" can
  // add context or stop the turn; "turn_end" can continue it (max 3 times);
  // "model_request" is a notification (docs/feat/hooks-turn.md). A profile's
  // "hooks" replaces this list.
  // "hooks": [
  //   { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-rm.sh" }
  // ],

  // MCP servers to connect to (keyed by name). A "command" server is spawned
  // over stdio; a "type": "http" server is reached over Streamable HTTP at its
  // "url" ("headers" are sent only to that url — e.g. a bearer token). Their
  // tools become available to the agent as \`mcp__<name>__<tool>\`.
  // "mcpServers": {
  //   "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  //   "remote": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer <token>" } }
  // },

  // Tool-output handling.
  //  - maxInlineOutputChars: a result longer than this is spilled to a file in your
  //    cache folder ($XDG_CACHE_HOME or ~/.cache, then tentacle/tool-output/; the system
  //    temp folder if that is not writable) and the model is told to read it selectively (0 = off).
  //  - outputRetentionDays: spilled files older than this are removed when the daemon
  //    starts (env TENTACLE_TOOL_OUTPUT_RETENTION_DAYS; 0 or negative = keep forever).
  //    They are also deleted with their session.
  //  - redactSecrets: mask keys/tokens/credentials in tool output. Off by default.
  //  - summarizeLargeOutput: replace large output with an LLM summary instead of a
  //    preview (full output still spilled to a file). Costs a model call; off by default.
  //  - dedupOutput: collapse runs of identical consecutive lines (log spam). On by default.
  //  - tabulateJson: render a JSON array-of-objects result as a compact table. Off by default.
  //  - execution: how a round's tool calls may overlap — "sequential", "read-only"
  //    (default: reads such as fs_read and read-only MCP tools together; writes and
  //    shell one at a time) or "parallel" (any calls on different files/resources).
  //    Env: TENTACLE_TOOL_EXECUTION. maxParallel: at most this many at once
  //    (env TENTACLE_TOOL_MAX_PARALLEL; 1 = sequential).
  //  - writableDirs: where fs_write/fs_edit may write besides this project (absolute
  //    or "~/…"). Default: the system temp dir ($TMPDIR) and /tmp. A list REPLACES
  //    that default; [] = this project only. "/" is ignored. Env
  //    TENTACLE_WRITABLE_DIRS (":"-separated, empty = []). Not carried to a pod
  //    (run/attach): there the pod's own temp dirs apply. The shell is not confined.
  //    e.g. "tools": { "writableDirs": ["/tmp", "~/scratch"] }
  // "tools": { "maxInlineOutputChars": ${DEFAULT_MAX_INLINE_OUTPUT_CHARS}, "outputRetentionDays": ${DEFAULT_TOOL_OUTPUT_RETENTION_DAYS}, "redactSecrets": ${DEFAULT_REDACT_SECRETS}, "summarizeLargeOutput": ${DEFAULT_SUMMARIZE_LARGE_OUTPUT}, "dedupOutput": ${DEFAULT_DEDUP_OUTPUT}, "tabulateJson": ${DEFAULT_TABULATE_JSON}, "execution": "${DEFAULT_TOOL_EXECUTION}", "maxParallel": ${DEFAULT_TOOL_MAX_PARALLEL} },

  // Named profiles, applied with \`--profile <name>\` on the command that starts the
  // session (\`tentacle --profile <name>\`, \`tentacle run … --profile <name>\`,
  // \`tentacle attach <name> --profile <name>\`) or with TENTACLE_PROFILE.
  // \`--model <id>\` picks just a model id on the active profile's endpoint.
  // A profile holds the same settings as this file and is merged over them:
  //  - "model" merges per key, but provider/baseURL/apiKey/apiKeyCommand move as
  //    one unit: set any of them and the others are NOT inherited (a key is never
  //    sent to an endpoint it was not configured for);
  //  - "subagents"/"tools"/"contextAwareness"/"contextReset" merge per key; other settings replace;
  //  - "mcpServers" merge by name: a server is replaced whole, null removes it.
  // "profiles": {
  //   "anthropic": {
  //     "model": { "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyCommand": "cat ~/.cache/anthropic-key" },
  //     "mcpServers": { "filesystem": null }
  //   }
  // }
}
`;

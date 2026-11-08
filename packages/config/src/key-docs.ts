/**
 * The one place a config key is documented: what it means, its type, its
 * default, its env var, its CLI flag, whether it is carried to a pod, its
 * scope, whether it holds a secret, and an example.
 *
 * The schema (`schema.ts`) keeps SHAPE only (docs/eval/config-cli.md, owner
 * answer Q1 = (b)). Every schema key must have an entry here — `T1` in
 * `test/key-docs.test.ts` fails otherwise, in both directions — and every fact
 * in an entry is pinned against the code that really behaves: the defaults by
 * `resolveConfig` (T2), the env names by `resolveConfig`'s provenance (T3), the
 * flags by `ARGS` (T5), `CARRIED` by `packages/cli` (T6), the secret set (T7).
 *
 * Sections have a `summary` too, so `tentacle explain <section>` can describe
 * itself; and a map's free segment is written `*` (`mcpServers.*.command`),
 * which is also how `explain` prints it.
 */
import {
  DEFAULT_AUTO_TITLE,
  DEFAULT_AUTO_WAKE,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_AWARENESS,
  DEFAULT_CONTEXT_RESET_ENABLED,
  DEFAULT_CONTEXT_RESET_MAX_PER_MESSAGE,
  DEFAULT_CONTEXT_STEP_PERCENT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DEDUP_OUTPUT,
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_REDACT_SECRETS,
  DEFAULT_SUBAGENTS_ENABLED,
  DEFAULT_SUBAGENT_EXECUTION,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  DEFAULT_SUBAGENT_MAX_PARALLEL,
  DEFAULT_SUMMARIZE_LARGE_OUTPUT,
  DEFAULT_TABULATE_JSON,
  DEFAULT_TOOL_EXECUTION,
  DEFAULT_TOOL_MAX_PARALLEL,
  DEFAULT_TOOL_OUTPUT_RETENTION_DAYS,
  defaultWritableDirs,
} from "./defaults.ts";
import type { ResolvedConfig } from "./resolve.ts";

/** A path that holds a single value (`model.model`) or children (`model`). */
export type KeyKind = "leaf" | "section";

/**
 * Where the path may be written: `user` = only the top level of
 * `config.jsonc`, `profile` = inside a profile, `both` = the same key in
 * either (every setting but `$schema`/`profiles`).
 */
export type KeyScope = "user" | "profile" | "both";

/**
 * Whether the laptop carries the key into a pod (`CARRIED`'s classes,
 * packages/cli/src/carried-settings.ts): `pinned` (P) the laptop decides,
 * `workspace` (W) the laptop's value is the lowest layer, `no` not carried —
 * the pod uses its own.
 */
export type KeyCarried = "pinned" | "workspace" | "no";

/** One key's documentation. */
export interface KeyDoc {
  /** One line: what it is. Required for every node, sections included. */
  readonly summary: string;
  readonly kind: KeyKind;
  /** Where it may be written. */
  readonly scope: KeyScope;
  /** Laptop → pod. Required on every entry, so T6 can compare a total set. */
  readonly carried: KeyCarried;
  /** `boolean`, `string`, `integer`, `number`, `enum`, `array`, `map`, `object`. */
  readonly type?: string;
  /** The allowed values, for an `enum`. */
  readonly values?: readonly string[];
  /** The value, or a map of values (`"values"`), must never be printed. */
  readonly secret?: true | "values";
  /**
   * The built-in default when the key is unset (a thunk reading the same
   * `DEFAULT_*` constants the loader uses). Absent: the key has none — it is
   * optional, or its default is "unset means X" (see `details`).
   */
  readonly default?: () => unknown;
  /**
   * The resolved field this key feeds, so T2 compares `default()` against a
   * real resolution instead of a hand-written value. Present exactly when
   * `default` is (except the four CLI-side defaults), which is what makes T2 a
   * total pin rather than a spot check.
   */
  readonly resolved?: (config: ResolvedConfig) => unknown;
  /** The `ResolvedConfig.sources` key this setting's provenance lands in (T3). */
  readonly sourceKey?: keyof ResolvedConfig["sources"];
  /** The env var that overrides it. */
  readonly env?: string;
  /** The env var is inverted: a truthy value turns the setting OFF. */
  readonly envInverts?: true;
  /** A short, VALID value for `env` — what T3 sets to prove the env is read. */
  readonly sample?: string;
  /** The CLI flag that overrides it, as written on a command line. */
  readonly flag?: string;
  /** The long form: behaviour, edge cases, why. */
  readonly details?: string;
  /** A JSONC value fragment, as it would appear in `config.jsonc`. */
  readonly example?: string;
}

const PROVIDER_VALUES = ["openai", "anthropic"] as const;
const EXECUTION_VALUES = ["sequential", "read-only", "parallel"] as const;
const THEME_VALUES = ["auto", "dark", "light"] as const;
const ENGINE_VALUES = ["kubernetes", "docker", "podman"] as const;

/**
 * Every key of the top-level file, before the `profiles.*` mirror is derived.
 * Order follows the schema, so `explain` reads like `config.jsonc`.
 */
const FILE_KEYS: Readonly<Record<string, KeyDoc>> = {
  $schema: {
    summary: "A JSON-schema pointer for editor completion; accepted and ignored.",
    kind: "leaf",
    type: "string",
    scope: "user",
    carried: "no",
    details:
      "Retained so editors can offer hints, and so a config copied from another machine keeps working. tentacle itself never reads it.",
    example: '"./config.schema.json"',
  },
  model: {
    summary: "The model endpoint: provider, URL, model id, key and token budget.",
    kind: "section",
    scope: "both",
    carried: "no",
    details:
      "In a profile, `model` merges per key — but provider/baseURL/apiKey/apiKeyCommand move as one unit: set any of them and none is inherited from the base (a key is never sent to an endpoint it was not configured for).",
  },
  "model.provider": {
    summary: "The API flavour: `openai` (chat/completions) or `anthropic` (Messages).",
    kind: "leaf",
    type: "enum",
    values: [...PROVIDER_VALUES],
    scope: "both",
    carried: "no",
    default: () => DEFAULT_PROVIDER,
    resolved: (c) => c.provider,
    sourceKey: "provider",
    env: "TENTACLE_PROVIDER",
    sample: "anthropic",
    details:
      "`openai` targets any `/v1/chat/completions` endpoint (llama.cpp, vLLM, OpenAI, Ollama); `anthropic` targets the native Messages API at `/v1/messages`. The default base URL follows this setting.",
    example: '"anthropic"',
  },
  "model.baseURL": {
    summary: "The endpoint, including its API version.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    default: () => DEFAULT_BASE_URL,
    resolved: (c) => c.baseURL,
    sourceKey: "baseURL",
    env: "TENTACLE_MODEL_BASE_URL",
    sample: "http://127.0.0.1:8080/v1",
    details:
      "Default depends on the provider: `http://localhost:8080/v1` for openai, `https://api.anthropic.com/v1` for anthropic. An explicit value always wins.",
    example: '"http://localhost:8080/v1"',
  },
  "model.model": {
    summary: "The model id sent to the endpoint.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    default: () => DEFAULT_MODEL,
    resolved: (c) => c.model,
    sourceKey: "model",
    env: "TENTACLE_MODEL",
    sample: "qwen3-coder-30b",
    flag: "--model",
    details:
      "`--model <id>` (on the commands that start a session) uses that id on the active profile's endpoint for that command only; it beats both this key and `TENTACLE_MODEL`.",
    example: '"qwen3-coder-30b"',
  },
  "model.autoTitle": {
    summary: "Ask a model to name each session after its first exchange.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_AUTO_TITLE,
    resolved: (c) => c.autoTitle,
    sourceKey: "autoTitle",
    details:
      "Off by default: the title is the first user message (rename it with `/rename`). Costs one small model call per session. On `run`/`attach` the LAPTOP's value decides, so a pod's own config never turns it on.",
    example: "true",
  },
  "model.titleModel": {
    summary: "The model id that writes those titles, e.g. a cheaper one.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    details:
      "Used only when `model.autoTitle` is on (a startup notice says so otherwise). Unset: the model above. The call rides the same endpoint and key; on a pod the laptop makes it.",
    example: '"qwen3-4b"',
  },
  "model.apiKey": {
    summary: "A literal API key — stored in plaintext (prefer `apiKeyCommand`).",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    secret: true,
    env: "TENTACLE_MODEL_API_KEY",
    sample: "s3cret",
    details:
      "Any copy of this file exposes the key. `TENTACLE_MODEL_API_KEY` beats it, and it beats the file's `apiKeyCommand` (precedence: env › apiKey › apiKeyCommand).",
    example: '"sk-…"',
  },
  "model.apiKeyCommand": {
    summary: "A shell command whose stdout is the key; never written to disk.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    secret: true,
    details:
      'Runs at startup (not for `connect`, which loads no model config), and its output is trimmed. Treat it as a secret: a command line can embed one (`curl -H "Authorization: Bearer …"`) where `pass show x` would not.',
    example: '"cat ~/.cache/llama-api-key"',
  },
  "model.contextWindow": {
    summary: "The context window in tokens: the fill meter and the model's context line.",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_CONTEXT_WINDOW,
    resolved: (c) => c.contextWindow,
    sourceKey: "contextWindow",
    env: "TENTACLE_CONTEXT_WINDOW",
    sample: "32000",
    details:
      "Used by the TUI's context meter and by `contextAwareness`. It does not truncate anything: it is the budget those two report against.",
    example: "128000",
  },
  "model.maxTokens": {
    summary: "Max output tokens per response (`max_tokens` on the wire).",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "no",
    resolved: (c) => c.maxTokens,
    sourceKey: "maxTokens",
    env: "TENTACLE_MAX_TOKENS",
    sample: "4096",
    details:
      "Unset: omitted for openai (the server decides), 64000 for anthropic (its API requires one). Lower it for a model with a smaller cap.",
    example: "64000",
  },
  hooks: {
    summary: "Shell commands run on agent events, with a JSON input on stdin.",
    kind: "leaf",
    type: "array",
    scope: "both",
    carried: "no",
    details:
      "Each object is `{ event, name?, matcher?, command, timeout?, onFailure? }`. `tool_call` may allow / ask / deny / rewrite a call (exit 2 = deny, stderr = the reason) and `tool_result` may replace a result; `turn_start`/`turn_end`/`model_request` are notifications (docs/feat/hooks-core.md). A failed hook is ignored unless `onFailure` is `block`; `timeout` defaults to 600 s. A profile's `hooks` REPLACES the base list; project hooks from a repo need a trust decision first.",
    example:
      '[\n    { "event": "tool_call", "matcher": "shell", "command": "~/.config/tentacle/hooks/no-rm.sh" }\n  ]',
  },
  systemPromptFile: {
    summary: "The system prompt file: relative to the config dir, or absolute.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    sourceKey: "systemPrompt",
    env: "TENTACLE_SYSTEM_PROMPT",
    sample: "hello",
    details:
      "Default `PROMPT.md` in the config dir (scaffolded on first run). `TENTACLE_SYSTEM_PROMPT` is NOT a path: it is the whole prompt, inline, and wins. The repo's `AGENTS.md` and the skills catalog are appended after it, never replacing it.",
    example: '"PROMPT.md"',
  },
  loadAgentsMd: {
    summary: "Auto-load a per-repo `AGENTS.md` into the system prompt.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => true,
    sourceKey: "loadAgentsMd",
    env: "TENTACLE_NO_AGENTS_MD",
    envInverts: true,
    sample: "0",
    details:
      "Found by walking up from the workspace to the repo root and appended after the identity prompt as project rules. `TENTACLE_NO_AGENTS_MD` is inverted: a truthy value disables it, so `0` means on.",
    example: "false",
  },
  loadSkills: {
    summary: "Discover Agent Skills and offer the `skill` tool.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => true,
    sourceKey: "loadSkills",
    env: "TENTACLE_NO_SKILLS",
    envInverts: true,
    sample: "0",
    details:
      "Scans `.agents/skills/` up to the repo root, `<configDir>/skills/` and `~/.agents/skills/`, and lists what it finds in the system prompt. `TENTACLE_NO_SKILLS` is inverted: a truthy value disables it.",
    example: "false",
  },
  maxIterations: {
    summary: "Max model/tool iterations per turn.",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_MAX_ITERATIONS,
    resolved: (c) => c.maxIterations,
    sourceKey: "maxIterations",
    env: "TENTACLE_MAX_ITERATIONS",
    sample: "32",
    details:
      "A positive integer, or -1 for no limit. Each model call and each round of tool calls counts.",
    example: "24",
  },
  subagents: {
    summary: "The `agent_task` sub-agent tool: whether, how many, how far.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "subagents.enabled": {
    summary: "Whether the agent may spawn sub-agents.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_SUBAGENTS_ENABLED,
    resolved: (c) => c.subagentsEnabled,
    sourceKey: "subagentsEnabled",
    env: "TENTACLE_SUBAGENTS",
    sample: "off",
    example: "false",
  },
  "subagents.maxIterations": {
    summary: "Step limit for a sub-agent's own loop.",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_SUBAGENT_MAX_ITERATIONS,
    resolved: (c) => c.subagentMaxIterations,
    sourceKey: "subagentMaxIterations",
    env: "TENTACLE_SUBAGENT_MAX_ITERATIONS",
    sample: "10",
    details:
      "A positive integer, or -1 for no limit. More generous than the parent's limit on purpose: a delegated investigation usually needs more tool rounds.",
    example: "50",
  },
  "subagents.execution": {
    summary: "How a round's `agent_task` calls may overlap.",
    kind: "leaf",
    type: "enum",
    values: [...EXECUTION_VALUES],
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_SUBAGENT_EXECUTION,
    resolved: (c) => c.subagentExecution,
    sourceKey: "subagentExecution",
    env: "TENTACLE_SUBAGENT_EXECUTION",
    sample: "sequential",
    details:
      "`parallel` (default): sub-agents share the workspace and run at once. `read-only`: only sub-agents that cannot write overlap. `sequential`: one at a time.",
    example: '"read-only"',
  },
  "subagents.maxParallel": {
    summary: "At most this many sub-agents at once.",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "pinned",
    default: () => DEFAULT_SUBAGENT_MAX_PARALLEL,
    resolved: (c) => c.subagentMaxParallel,
    sourceKey: "subagentMaxParallel",
    env: "TENTACLE_SUBAGENT_MAX_PARALLEL",
    sample: "2",
    details: "A llama.cpp endpoint's own slot count lowers it and never raises it.",
    example: "4",
  },
  "subagents.agentTaskDescription": {
    summary: "Replaces the `agent_task` tool's description (max 4096 bytes).",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "pinned",
    resolved: (c) => c.agentTaskDescription,
    sourceKey: "agentTaskDescription",
    details:
      "Trimmed, then capped at 4096 bytes. The list of sub-agent types is always appended. Not together with `agentTaskDescriptionFile`.",
    example: '"Delegate a self-contained investigation; it cannot ask you questions."',
  },
  "subagents.agentTaskDescriptionFile": {
    summary: "The same description, read once at start from a file.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    details:
      "Relative to the config dir, or absolute. Read at start, so an edit needs a restart. Not together with `agentTaskDescription`.",
    example: '"agent-task.md"',
  },
  contextAwareness: {
    summary: "Tell the model how full its context is, once per step of the window.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "contextAwareness.enabled": {
    summary: "Whether the model is told how full its context is.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_CONTEXT_AWARENESS,
    resolved: (c) => c.contextAwareness.enabled,
    sourceKey: "contextAwarenessEnabled",
    details:
      "A short line such as `[context: 82k / 128k tokens (64%)]` is appended to the message that crosses each new step. Counted from the provider's reported usage, or estimated when it reports none.",
    example: "false",
  },
  "contextAwareness.stepPercent": {
    summary: "A line per this many percent of the window (1–100).",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_CONTEXT_STEP_PERCENT,
    resolved: (c) => c.contextAwareness.stepPercent,
    sourceKey: "contextAwarenessStepPercent",
    example: "5",
  },
  contextReset: {
    summary: "The model may renew its own context with the `context_reset` tool.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "contextReset.enabled": {
    summary: "Whether the `context_reset` tool is offered.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_CONTEXT_RESET_ENABLED,
    resolved: (c) => c.contextReset.enabled,
    sourceKey: "contextResetEnabled",
    env: "TENTACLE_CONTEXT_RESET",
    sample: "off",
    details:
      "Asked like any other tool: the history is replaced by the system prompt (re-read from disk) and a restart prompt the model writes.",
    example: "false",
  },
  "contextReset.maxPerMessage": {
    summary: "Resets allowed per user message (-1 = unlimited).",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_CONTEXT_RESET_MAX_PER_MESSAGE,
    resolved: (c) => c.contextReset.maxPerMessage,
    sourceKey: "contextResetMaxPerMessage",
    env: "TENTACLE_CONTEXT_RESET_MAX",
    sample: "2",
    example: "-1",
  },
  autoWake: {
    summary: "Start a continuation turn when a background job exits while idle.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "no",
    default: () => DEFAULT_AUTO_WAKE,
    resolved: (c) => c.autoWake,
    sourceKey: "autoWake",
    env: "TENTACLE_AUTO_WAKE",
    sample: "off",
    details:
      "Read by the LAPTOP (the TUI, and a detached run's relay), never carried: a pod has no view of your background jobs.",
    example: "false",
  },
  engine: {
    summary: "Default engine of `run`/`attach`: kubernetes, docker or podman.",
    kind: "leaf",
    type: "enum",
    values: [...ENGINE_VALUES],
    scope: "both",
    carried: "no",
    default: () => "kubernetes",
    env: "TENTACLE_ENGINE",
    sample: "docker",
    flag: "--engine",
    details:
      "Not resolved into the config: the CLI layers `--engine` › `TENTACLE_ENGINE` › profile › this file › kubernetes, and refuses an unknown value instead of falling through.",
    example: '"docker"',
  },
  rm: {
    summary: "Whether `run` removes its pod/container when the run ends.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "no",
    default: () => false,
    flag: "--rm",
    details:
      "Off by default: the workload is KEPT and the re-attach command printed. `--rm` (or `--rm=true`) deletes it at the end, `--rm=false` overrides a configured `true`.",
    example: "true",
  },
  detach: {
    summary: "`run --detach`: what the relay holding the run may do.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "detach.keepAwake": {
    summary: "Hold a macOS sleep assertion while a turn of a detached run runs.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "no",
    default: () => true,
    details: "macOS only (caffeinate-like). Closing the lid still sleeps the machine. Unset: on.",
    example: "false",
  },
  tui: {
    summary: "The TUI's own display settings.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "tui.theme": {
    summary: "The palette: `auto` probes the terminal, `dark`/`light` force one.",
    kind: "leaf",
    type: "enum",
    values: [...THEME_VALUES],
    scope: "both",
    carried: "no",
    default: () => "auto",
    details:
      "`auto` reads the terminal's background before the first frame and picks a light or dark palette; the others skip that query (useful on a slow link, or when the guess is wrong). A display setting of this laptop — never carried to a pod.",
    example: '"dark"',
  },
  mount: {
    summary: "What a docker/podman run hides from the container's workspace mount.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "mount.hide": {
    summary: "The paths to hide — this list REPLACES the default one.",
    kind: "leaf",
    type: "array",
    scope: "both",
    carried: "no",
    details:
      "Directories or files, `~/…` or absolute. The default list is `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`. Tentacle's config dir and the `apiKeyCommand` key file are always hidden whatever this says.",
    example: '["~/.ssh", "~/.aws"]',
  },
  "mount.hideExtra": {
    summary: "Extra paths to hide, ADDED to the default list.",
    kind: "leaf",
    type: "array",
    scope: "both",
    carried: "no",
    details: "Same path rules as `mount.hide`; use this to keep the defaults and hide more.",
    example: '["~/.pgpass"]',
  },
  mcpServers: {
    summary: "MCP servers to connect to, keyed by name; their tools join the agent.",
    kind: "section",
    type: "map",
    scope: "both",
    carried: "no",
    details:
      'A server with `command` is spawned over stdio; one with `type: "http"` is reached at its `url`. Omitted, `type` is inferred: `http` for a `url` without a `command`, else `stdio`. Its tools are named `mcp__<name>__<tool>`.',
  },
  "mcpServers.*": {
    summary: "One MCP server: a stdio command, or an HTTP endpoint.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "mcpServers.*.type": {
    summary: "How the server is reached: `stdio` (spawned) or `http` (Streamable HTTP).",
    kind: "leaf",
    type: "enum",
    values: ["stdio", "http"],
    scope: "both",
    carried: "no",
    details:
      "Optional and inferred when omitted: `http` for an object with `url` and no `command`, else `stdio` — so an existing config keeps working.",
    example: '"http"',
  },
  "mcpServers.*.command": {
    summary: "The executable to spawn (a stdio server).",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    example: '"npx"',
  },
  "mcpServers.*.args": {
    summary: "Arguments passed to `command`.",
    kind: "leaf",
    type: "array",
    scope: "both",
    carried: "no",
    secret: "values",
    details: "Never printed by `tentacle config`: a token is often passed as an argument.",
    example: '["-y", "@modelcontextprotocol/server-filesystem", "."]',
  },
  "mcpServers.*.env": {
    summary: "Extra environment variables for the server process.",
    kind: "section",
    type: "map",
    scope: "both",
    carried: "no",
  },
  "mcpServers.*.env.*": {
    summary: "One variable of the server's environment.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    secret: true,
    details: "A server's env often carries a token. Never printed.",
    example: '"***"',
  },
  "mcpServers.*.cwd": {
    summary: "Working directory for the server process.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    example: '"."',
  },
  "mcpServers.*.readOnlyTools": {
    summary: "Which of the server's tools may run beside other reads.",
    kind: "leaf",
    type: "enum",
    values: ["hint", "none"],
    scope: "both",
    carried: "no",
    details:
      '`"hint"` (default) trusts the server\'s own `readOnlyHint`; `"none"` treats every tool of this server as a write; or give an array of the server\'s bare tool names that are reads.',
    example: '"none"',
  },
  "mcpServers.*.url": {
    summary: "The server's MCP endpoint (an http server).",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    example: '"https://mcp.example.com/mcp"',
  },
  "mcpServers.*.headers": {
    summary: "Extra request headers sent to `url`, e.g. `Authorization`.",
    kind: "section",
    type: "map",
    scope: "both",
    carried: "no",
  },
  "mcpServers.*.headers.*": {
    summary: "One header sent with the server's requests.",
    kind: "leaf",
    type: "string",
    scope: "both",
    carried: "no",
    secret: true,
    details: "A bearer token usually lives here. Never printed.",
    example: '"Bearer <token>"',
  },
  packages: {
    summary: 'Installed packages to switch off: `{ "<name>": false }`.',
    kind: "section",
    type: "map",
    scope: "both",
    carried: "no",
    details:
      "Every installed package (`<configDir>/packages/<name>`) is on unless its name is mapped to `false`. A profile's `packages` REPLACES the base map.",
  },
  "packages.*": {
    summary: "Whether this installed package is enabled.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "no",
    example: "false",
  },
  tools: {
    summary: "Tool-output handling: spilling, retention, redaction, overlap.",
    kind: "section",
    scope: "both",
    carried: "no",
  },
  "tools.maxInlineOutputChars": {
    summary: "Max characters of a tool result kept inline before it is spilled.",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_MAX_INLINE_OUTPUT_CHARS,
    resolved: (c) => c.maxInlineOutputChars,
    sourceKey: "maxInlineOutputChars",
    env: "TENTACLE_MAX_OUTPUT_CHARS",
    sample: "4000",
    details:
      "A larger result is written to a file in the cache dir (`$XDG_CACHE_HOME` or `~/.cache`, then `tentacle/tool-output/`) and the model is told to read it selectively. `0` disables spilling entirely.",
    example: "8000",
  },
  "tools.outputRetentionDays": {
    summary: "Days a spilled tool output is kept (swept when the daemon starts).",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "no",
    default: () => DEFAULT_TOOL_OUTPUT_RETENTION_DAYS,
    resolved: (c) => c.toolOutputRetentionDays,
    sourceKey: "toolOutputRetentionDays",
    env: "TENTACLE_TOOL_OUTPUT_RETENTION_DAYS",
    sample: "7",
    details: "`0` or negative: never swept. A spilled file is also deleted with its session.",
    example: "7",
  },
  "tools.redactSecrets": {
    summary: "Mask keys, tokens and credentials in tool output.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_REDACT_SECRETS,
    resolved: (c) => c.redactSecrets,
    sourceKey: "redactSecrets",
    env: "TENTACLE_REDACT_SECRETS",
    sample: "on",
    details:
      'OFF by default: masking runs a pattern pass over every tool result, so it is opt-in. Turn it on when tool output may quote a credential. (The comment above the schema\'s `redactSecrets` says "Default: enabled"; the constant and this entry say off — see docs/feat/config-explain.md, Execution.)',
    example: "true",
  },
  "tools.dedupOutput": {
    summary: "Collapse runs of identical consecutive output lines.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_DEDUP_OUTPUT,
    resolved: (c) => c.dedupOutput,
    sourceKey: "dedupOutput",
    env: "TENTACLE_DEDUP_OUTPUT",
    sample: "off",
    example: "false",
  },
  "tools.tabulateJson": {
    summary: "Render a JSON array-of-objects result as a compact table.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_TABULATE_JSON,
    resolved: (c) => c.tabulateJson,
    sourceKey: "tabulateJson",
    env: "TENTACLE_TABULATE_JSON",
    sample: "on",
    example: "true",
  },
  "tools.summarizeLargeOutput": {
    summary: "Replace large output with a model-written summary.",
    kind: "leaf",
    type: "boolean",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_SUMMARIZE_LARGE_OUTPUT,
    resolved: (c) => c.summarizeLargeOutput,
    sourceKey: "summarizeLargeOutput",
    env: "TENTACLE_SUMMARIZE_OUTPUT",
    sample: "on",
    details: "The full output is still spilled to a file. Costs one model call per large result.",
    example: "true",
  },
  "tools.execution": {
    summary: "How a round's tool calls may overlap.",
    kind: "leaf",
    type: "enum",
    values: [...EXECUTION_VALUES],
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_TOOL_EXECUTION,
    resolved: (c) => c.toolExecution.mode,
    sourceKey: "toolExecution",
    env: "TENTACLE_TOOL_EXECUTION",
    sample: "parallel",
    details:
      "`read-only` (default): reads (`fs_read`, read-only MCP tools) run together, every write and shell call alone. `sequential`: one at a time. `parallel`: any calls on different resources together.",
    example: '"parallel"',
  },
  "tools.maxParallel": {
    summary: "At most this many calls of a round at once (`1` = sequential).",
    kind: "leaf",
    type: "integer",
    scope: "both",
    carried: "workspace",
    default: () => DEFAULT_TOOL_MAX_PARALLEL,
    resolved: (c) => c.toolExecution.maxParallel,
    sourceKey: "toolMaxParallel",
    env: "TENTACLE_TOOL_MAX_PARALLEL",
    sample: "4",
    example: "16",
  },
  "tools.writableDirs": {
    summary: "Where `fs_write`/`fs_edit`/`fs_multi_edit` may write besides the project.",
    kind: "leaf",
    type: "array",
    scope: "both",
    carried: "no",
    default: () => defaultWritableDirs({}),
    resolved: (c) => c.writableDirs,
    sourceKey: "writableDirs",
    env: "TENTACLE_WRITABLE_DIRS",
    sample: "~/scratch",
    details:
      "Absolute or `~/…` dirs, matched by real path (a symlink out of one stays refused; a dangling or looping symlink, or a FIFO, is refused everywhere). Files are replaced atomically (a `0600` temp file, then the target's permission bits, then rename), so a planted hard link is never written through; like an editor's atomic save this breaks hard links and does not keep owner, group, ACLs or extended attributes. A file you could not write in place (read-only, or another user's) is still refused with `EACCES`. In a directory you cannot create files in, an existing writable file is written in place (no symlink followed, refused if hard-linked); a new file there is refused. Limit, on hosts shared with other users only: another user who controls a directory on the path (e.g. one they made in `/tmp`) can race a swap and make the content land in a new hidden file elsewhere; an existing file there is never written in place. The default is the system temp dir (`$TMPDIR`) and `/tmp`; a list REPLACES it, `[]` means the project only, and `/` and relative entries are ignored (and logged). Matched on the daemon's host, so NOT carried to a pod: there the pod's own temp dirs apply. Each write still asks unless auto-accept is on. The `shell` tool is not confined.",
    example: '["/tmp", "~/scratch"]',
  },
};

/** The two nodes that exist only in the top-level file. */
const CONTAINER_KEYS: Readonly<Record<string, KeyDoc>> = {
  profiles: {
    summary: "Named profiles: the same settings, merged over the file when selected.",
    kind: "section",
    type: "map",
    scope: "user",
    carried: "no",
    details:
      "Applied with `--profile <name>` on the command that starts the session, or `TENTACLE_PROFILE` (`--profile` wins). A profile holds every setting the file does except `$schema` and `profiles`. Merge rules: `model` per key, but provider/baseURL/apiKey/apiKeyCommand move as one unit; `subagents`, `tools`, `contextAwareness`, `contextReset` merge per key; every other setting replaces the base one; `mcpServers` merge by name, where `null` REMOVES a base server for that profile.",
  },
  "profiles.*": {
    summary: "One named profile's settings.",
    kind: "section",
    scope: "user",
    carried: "no",
    details:
      "`profiles.<name>` — any name works. A `null` MCP server removes the base one for this profile.",
  },
};

/** Where a slimmer, profile-only difference from the base entry is stated. */
const PROFILE_DETAILS: Readonly<Record<string, string>> = {
  "mcpServers.*":
    "In a profile, an entry set to `null` REMOVES that base server for the profile; otherwise servers merge by name and a replaced server is replaced whole.",
};

/**
 * Every key of the file plus the `profiles.*` mirror, derived so the two can
 * never describe the same setting differently. T1b pins that the mirror is
 * faithful to the base tree.
 */
export const KEY_DOCS: Readonly<Record<string, KeyDoc>> = derive();

function derive(): Readonly<Record<string, KeyDoc>> {
  const out: Record<string, KeyDoc> = {};
  for (const [path, doc] of Object.entries(FILE_KEYS)) {
    out[path] = doc;
  }
  for (const [path, doc] of Object.entries(CONTAINER_KEYS)) {
    out[path] = doc;
  }
  for (const [path, doc] of Object.entries(FILE_KEYS)) {
    // `$schema` is the one top-level-only key: a profile has no business there.
    if (doc.scope === "user") {
      continue;
    }
    const mirrored = `profiles.*.${path}`;
    const extra = PROFILE_DETAILS[path];
    out[mirrored] = {
      ...doc,
      scope: "profile",
      ...(extra !== undefined ? { details: extra } : {}),
    };
  }
  return out;
}

/** The registry's entry for a canonical path (`mcpServers.*.command`). */
export function keyDoc(path: string): KeyDoc | undefined {
  return KEY_DOCS[path];
}

/** Paths whose leaf really is a value (`--all`, the README table). */
export function leafPaths(): readonly string[] {
  return Object.keys(KEY_DOCS)
    .filter((path) => KEY_DOCS[path]?.kind === "leaf")
    .sort();
}

/** The keys the laptop carries into a pod (T6's total set). */
export function carriedDocPaths(): readonly string[] {
  return Object.keys(KEY_DOCS)
    .filter((path) => KEY_DOCS[path]?.carried !== "no")
    .sort();
}

const SEGMENT = (path: string): string[] => path.split(".");

/**
 * The DIRECT sub-keys of a node, as `explain <section>` lists them. A map's
 * free segment is transparent: `mcpServers`'s children are
 * `mcpServers.*.<field>`, and `profiles`'s are the profile settings — never a
 * bare `*`, which is not a path anyone can write.
 */
export function directChildren(path: string): readonly string[] {
  const prefix = path === "" ? "" : `${path}.`;
  const depth = path === "" ? 1 : SEGMENT(path).length + 1;
  const children: string[] = [];
  for (const candidate of Object.keys(KEY_DOCS)) {
    const parts = SEGMENT(candidate);
    if (parts.length !== depth || !candidate.startsWith(prefix)) {
      continue;
    }
    if (parts[parts.length - 1] === "*") {
      // A map's single child: list the fields of what it holds instead.
      children.push(...directChildren(candidate));
      continue;
    }
    children.push(candidate);
  }
  return [...new Set(children)];
}

/** The top-level keys, as `explain` with no argument lists them. */
export function topLevelKeys(): readonly string[] {
  return directChildren("").filter((path) => !path.startsWith("profiles.*."));
}

/** A default rendered short, for a one-line list or the README table. */
export function renderDefault(doc: KeyDoc): string | undefined {
  if (doc.default === undefined) {
    return undefined;
  }
  const value = doc.default();
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value);
}

/** The cell-safe form of text inside a Markdown table row. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The README's config table, generated from the registry (docs/feat/config-
 * explain.md task 3). Leaves only — a section is a grouping, not a setting —
 * and the `profiles.*` mirror is left out: it documents the same keys.
 */
export function renderConfigKeysTable(): string {
  const rows = leafPaths()
    .filter((path) => !path.startsWith("profiles.*."))
    .map((path) => {
      const doc = KEY_DOCS[path];
      if (doc === undefined) {
        return "";
      }
      const env =
        doc.env === undefined ? "—" : `\`${doc.env}\`${doc.envInverts ? " (inverted)" : ""}`;
      const fallback = renderDefault(doc) ?? "—";
      return `| \`${path}\` | ${env} | ${cell(fallback)} | ${cell(doc.summary)} |`;
    });
  return [
    "| Config key (`config.jsonc`) | Env override | Default | Meaning |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

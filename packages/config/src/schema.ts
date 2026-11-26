/**
 * Zod schema for the on-disk `config.jsonc`.
 *
 * The schema is `.strict()` everywhere so that a typo'd key (e.g. `modle`)
 * is a loud validation error rather than a silently-ignored setting — the
 * behaviour an enterprise config system should have.
 */
import { z } from "zod";
import { modelRefIssues } from "./models.ts";
import { toolEnabledIssues } from "./tool-groups.ts";

/**
 * The largest `liveActivity.startAfterSeconds` (one hour) and its default (20 s,
 * the plan's Owner Q3). Copies of the rules module's own numbers, pinned by a
 * test in `cli/test/live-activity-config.test.ts` (this package depends on zod
 * alone, so it cannot import them).
 */
export const LIVE_ACTIVITY_START_AFTER_MAX_SECONDS = 3600;
export const DEFAULT_LIVE_ACTIVITY_START_AFTER_SECONDS = 20;

/**
 * The largest `push.graceSeconds` (one hour). The same NUMBER is
 * `@tentacle/protocol`'s `PUSH_GRACE_MAX_SECONDS`, which this package cannot
 * import (it depends on zod alone); `config/test/push-config.test.ts` pins the
 * two against each other, so a drift is red rather than silent.
 */
export const PUSH_GRACE_MAX_SECONDS = 3_600;
/** The default grace a `serve` applies when neither the file nor a flag sets one. */
export const DEFAULT_PUSH_GRACE_SECONDS = 30;

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
     * Ask a model for each session's title after its first exchange. Default
     * false: the title is the first user message (and `/rename`). On a pod
     * (`run`/`attach`) the LAPTOP's value decides.
     */
    autoTitle: z.boolean().optional(),
    /**
     * Model id (same endpoint) that names sessions when `autoTitle` is on —
     * e.g. a cheaper one. Unset → `model`. On a pod the laptop serves the
     * title call with it (the pod never names a model).
     */
    titleModel: z.string().min(1).optional(),
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
    /**
     * Raw bytes one image may have on THIS model's wire (docs/feat/attachments-core.md,
     * review H1). Unset: the provider's documented default.
     */
    maxImageBytes: z.number().int().positive().optional(),
    /**
     * Whether this model takes images at all (docs/feat/attachments-prompt.md D4).
     * Unset keeps the provider's default (anthropic true, an OpenAI-compatible
     * endpoint false); `true` opts an openai endpoint in, `false` makes even
     * anthropic refuse image prompts. The one truth is `imageLimits()`.
     */
    images: z.boolean().optional(),
    /**
     * The detail `image_view` sends a picture at (docs/feat/image-view.md D6):
     * `auto` (default) lets the model choose per call; `low`/`high` force it.
     */
    imageDetail: z.enum(["auto", "low", "high"]).optional(),
    /**
     * Tokens one image costs the context estimate (docs/feat/image-view.md D7).
     * Unset: the provider's estimate (anthropic 1600, openai-compatible 3200).
     */
    imageTokens: z.number().int().positive().optional(),
  })
  .strict();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * A `models` entry (docs/feat/models-map.md): the shape of `model` — its
 * `autoTitle`/`titleModel` are accepted and have no effect (owner Q3) — plus a
 * `description` the agent reads when the entry is selectable.
 */
// `imageDetail`/`imageTokens` are the MAIN model's only (docs/feat/image-view.md
// Notes): the agent's counter and `image_view` are built once, from `model`.
export const ModelEntrySchema = ModelConfigSchema.omit({
  imageDetail: true,
  imageTokens: true,
}).extend({
  description: z.string().min(1).max(300).optional(),
});

export type ModelEntryConfig = z.infer<typeof ModelEntrySchema>;

/** A `models` name: no `.` (it would make a config path ambiguous), at most 64. */
export const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_NAME_MESSAGE =
  'models: a name may hold only letters, digits, "_" and "-" (at most 64 characters)';

/** An `a2a` harness instance name; its sub-agent type is `a2a:<name>` (docs/feat/a2a-client.md C1). */
export const A2A_INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * An agent card URL (C1): `https:`, or `http:` only for a loopback host (the
 * owner's own machine). No userinfo: a token never rides in the URL.
 */
function cardUrlOk(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname))
  );
}

/**
 * The SHAPE of a network `run` may put its container on (feat/run-network D3),
 * the one truth for the config file and the `--network` flag alike: a name, an
 * engine mode (`none`, `bridge`, `host`, `default`) or docker's
 * `container:<id>` form. Whether it EXISTS is the engine's — never cached here.
 */
export const NETWORK_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NETWORK_VALUE_MESSAGE =
  'network: use a network name, "none", "bridge", "host" or "container:<id>" (letters, digits, "_", ".", ":", "-"; at most 128)';

/**
 * A malformed network value → one line naming it, else `null`. The CLI's
 * `--network` and `TENTACLE_NETWORK` ask this before anything is created, so a
 * typo never reaches an engine (the file's own check is `NETWORK_VALUE`).
 */
export function networkValueProblem(value: string): string | null {
  return NETWORK_VALUE.test(value)
    ? null
    : `invalid network ${JSON.stringify(value)} — ${NETWORK_VALUE_MESSAGE.slice("network: ".length)}`;
}

/**
 * `__proto__` cannot be a name: the JSONC parser assigns it, swapping the map's
 * prototype (so the record check reads the entry's FIELDS as entries), and
 * `JSON.parse` keeps it as an own key the record then drops. Refused by name.
 */
function refuseProtoName(value: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype && !Object.hasOwn(value, "__proto__")) {
    return value;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'a model cannot be named "__proto__" (a reserved name): choose another',
  });
  return {};
}

/**
 * Which of a server's tools may run beside other reads in one round
 * (docs/feat/parallel-tools.md): `"hint"` (default) — those the server marks
 * `readOnlyHint`; `"none"` — none; a list — exactly those, by bare MCP name.
 */
const McpReadOnlyToolsSchema = z.union([
  z.literal("hint"),
  z.literal("none"),
  z.array(z.string().min(1)),
]);

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
    readOnlyTools: McpReadOnlyToolsSchema.optional(),
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
    readOnlyTools: McpReadOnlyToolsSchema.optional(),
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

const HookEventSchema = z.enum([
  "tool_call",
  "tool_result",
  "turn_start",
  "turn_end",
  "model_request",
]);

/** Plain tool names, optionally `a|b` alternatives: matched exactly, not as a regex. */
const PLAIN_MATCHER = /^[A-Za-z0-9_-]+(\|[A-Za-z0-9_-]+)*$/;

/**
 * One user hook (docs/feat/hooks-core.md): a shell command run on an agent
 * event with a JSON input on stdin. Structurally identical to core's `HookSpec`.
 */
export const HookSpecSchema = z
  .object({
    event: HookEventSchema,
    /** Shown in the TUI ("hook <name> blocked Bash") and in logs. Default: basename of the first word of `command`. */
    name: z.string().min(1).max(40).optional(),
    /** Tool events only: a name, `a|b` alternatives, or a JS regex (unanchored). Absent / "*" = all. */
    matcher: z.string().min(1).optional(),
    /** Run with /bin/sh -c in the session's working folder; JSON input on stdin. */
    command: z.string().min(1),
    /** Seconds; default 600. */
    timeout: z.number().int().positive().optional(),
    /** A failed hook (crash, timeout, bad output): "ignore" (default) or "block". */
    onFailure: z.enum(["ignore", "block"]).optional(),
  })
  .strict()
  .superRefine((h, ctx) => {
    const label = h.name ?? h.command;
    if (h.matcher === undefined) {
      return;
    }
    if (h.event !== "tool_call" && h.event !== "tool_result") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `hook "${label}": matcher is only valid on tool_call / tool_result`,
      });
      return;
    }
    if (h.matcher === "*" || PLAIN_MATCHER.test(h.matcher)) {
      return;
    }
    try {
      new RegExp(h.matcher);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `hook "${label}": invalid matcher regex ${JSON.stringify(h.matcher)} (${(err as Error).message})`,
      });
    }
  });

export type HookSpecConfig = z.infer<typeof HookSpecSchema>;

/** A `mount.hide` entry: `~/…` or an absolute path (a relative one has no anchor). */
const HidePathSchema = z
  .string()
  .min(1)
  .refine((path) => path.startsWith("~/") || path.startsWith("/"), {
    message: 'a hide path must start with "~/" or "/"',
  });

/** A `tools.writableDirs` entry: `~`, `~/…` or an absolute path (a relative one has no anchor). */
const WritableDirSchema = z
  .string()
  .min(1)
  .refine((path) => path === "~" || path.startsWith("~/") || path.startsWith("/"), {
    message: 'a writable dir must be "~", start with "~/" or be absolute',
  });

export type MountConfig = {
  readonly hide?: readonly string[];
  readonly hideExtra?: readonly string[];
};

/** The settings a config file — and each of its profiles — can hold. */
const settingsShape = {
  model: ModelConfigSchema.optional(),
  /** Named models for sub-agents (docs/feat/models-map.md); unset keys come from `model`. */
  models: z
    .preprocess(
      refuseProtoName,
      z.record(z.string().regex(MODEL_NAME, MODEL_NAME_MESSAGE), ModelEntrySchema),
    )
    .optional(),
  /**
   * User hooks: shell commands run on agent events (docs/feat/hooks-core.md).
   * A top-level setting, so a profile's `hooks` replaces the base list.
   */
  hooks: z.array(HookSpecSchema).optional(),
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
   * End every request's system prompt with the working directory and platform
   * the session's tools run on (docs/feat/system-prompt-cwd.md). Default:
   * enabled. File-only; read by the process that builds the agent (a pod's own
   * config in `run`/`attach`).
   */
  systemPromptEnvironment: z.boolean().optional(),
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
      /**
       * Token budget for a sub-agent's whole life (prompt + completion, summed
       * over its model calls); a positive integer, or -1 (unlimited)
       * (docs/feat/subagent-token-budget.md).
       */
      maxTokens: z
        .number()
        .int()
        .refine((n) => n > 0 || n === -1, "must be a positive integer or -1 (unlimited)")
        .optional(),
      /**
       * How a parent's `agent_task` calls of one round may overlap: `sequential`,
       * `read-only` or `parallel` (default). On `run`/`attach` the laptop's.
       */
      execution: z.enum(["sequential", "read-only", "parallel"]).optional(),
      /**
       * At most this many sub-agents at once. Default 4; the only limit (no
       * server is asked for its slots). Owner: as `execution`.
       */
      maxParallel: z.number().int().positive().optional(),
      /**
       * May a running background sub-agent message the agent (`agent_notify`)
       * and wake it? Default off. On `run`/`attach` the laptop's (pinned).
       */
      twoWay: z.boolean().optional(),
      /**
       * Replaces the `agent_task` tool's description (at most 4096 bytes, trimmed).
       * Owner: as `execution`. Not with `agentTaskDescriptionFile`.
       */
      agentTaskDescription: z.string().min(1).optional(),
      /** The same, read once at start from a file relative to the config dir, or absolute. */
      agentTaskDescriptionFile: z.string().min(1).optional(),
      /** Per-type settings, keyed by type name; `model` names a `models` entry. */
      types: z
        .record(z.string().min(1), z.object({ model: z.string().min(1).optional() }).strict())
        .optional(),
      /** `models` entries the agent may pick per `agent_task` call; absent or empty: off. */
      selectableModels: z.array(z.string().min(1)).optional(),
    })
    .strict()
    .superRefine((subagents, ctx) => {
      if (
        subagents.agentTaskDescription !== undefined &&
        subagents.agentTaskDescriptionFile !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subagents: set agentTaskDescription or agentTaskDescriptionFile, not both",
        });
      }
    })
    .optional(),
  /**
   * Other agent harnesses that run a sub-agent (docs/feat/subagent-harness-runners.md
   * D3/D6), keyed by INSTANCE name. Laptop/serve only: a pod ignores it (D5).
   * Only `claude-code` exists in this version.
   */
  harnesses: z
    .record(
      z.string().min(1),
      z.union([
        z
          .object({
            /** The adapter; defaults to the instance name. */
            adapter: z.literal("claude-code").optional(),
            /** Default on: the `claude` sub-agent type is offered when `command` is on PATH. */
            enabled: z.boolean().optional(),
            /** The executable (default `claude`). */
            command: z.string().min(1).optional(),
            /** The model when a call names none (default `opus`); passed verbatim. */
            model: z
              .string()
              .regex(
                /^[A-Za-z0-9._:[\]][A-Za-z0-9._:[\]-]{0,63}$/,
                "an alias or a model id: letters, digits, . _ : - [ ], at most 64, not starting with -",
              )
              .optional(),
            /** Hang guard: no output for this many minutes ends the run (default 15). */
            idleMinutes: z.number().positive().optional(),
          })
          .strict(),
        /**
         * A remote A2A agent (docs/feat/a2a-client.md C1). No literal token
         * field exists: the token only ever comes from `tokenCommand`.
         */
        z
          .object({
            adapter: z.literal("a2a"),
            /** Default on: the `a2a:<name>` sub-agent type is offered. */
            enabled: z.boolean().optional(),
            /** The agent card URL: `https:`, or `http:` only for a loopback host. */
            card: z
              .string()
              .min(1)
              .refine(cardUrlOk, "an https URL (http only for localhost / 127.0.0.1 / [::1])"),
            /** Prints the bearer token on stdout; run lazily, held in memory only. */
            tokenCommand: z.string().min(1).optional(),
            /** The owner's words, shown to the model first (C5). */
            description: z.string().min(1).max(500).optional(),
            /** Who answers the agent's questions (Owner A9); default `user`. */
            inputFrom: z.enum(["parent", "user", "both"]).optional(),
            /** Hang guard, minutes (default 30). */
            idleMinutes: z.number().positive().optional(),
          })
          .strict(),
      ]),
    )
    .superRefine((harnesses, ctx) => {
      for (const [name, entry] of Object.entries(harnesses)) {
        if (name === "claude-code") {
          if (entry.adapter === "a2a") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `harnesses: "claude-code" is the Claude Code harness, not an a2a agent`,
            });
          }
        } else if (entry.adapter !== "a2a") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `harnesses: unknown instance "${name}" (only "claude-code", or an entry with adapter "a2a")`,
          });
        } else if (!A2A_INSTANCE_NAME.test(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `harnesses: a2a instance name "${name}" must match [a-z0-9][a-z0-9-]{0,31}`,
          });
        }
      }
    })
    .optional(),
  /**
   * Context awareness (docs/feat/context-awareness.md): tell the model how full
   * its context is, a short line on the message that crosses each new step.
   */
  contextAwareness: z
    .object({
      /** Default: enabled. */
      enabled: z.boolean().optional(),
      /** A line per this many percent of the window; 1..100, default 1. */
      stepPercent: z.number().int().min(1).max(100).optional(),
    })
    .strict()
    .optional(),
  /** Context reset: the model renews its own context (docs/feat/context-reset-refresh.md). */
  contextReset: z
    .object({
      /** Default: enabled. */
      enabled: z.boolean().optional(),
      /** Resets allowed per user message; a positive integer, or -1 (unlimited, default). */
      maxPerMessage: z
        .number()
        .int()
        .refine((n) => n > 0 || n === -1, "must be a positive integer or -1 (unlimited)")
        .optional(),
    })
    .strict()
    .optional(),
  /** Smart compaction: lossless-first pruning of the model's copy (docs/feat/smart-compaction.md). */
  contextPrune: z
    .object({
      /** Default: disabled. */
      enabled: z.boolean().optional(),
      /** A batch once the request reaches this percent of the window; 1..100, default 60. */
      pruneAtPercent: z.number().int().min(1).max(100).optional(),
      /** …and only if it saves at least this percent of the window; 1..100, default 15. */
      minGainPercent: z.number().int().min(1).max(100).optional(),
      /** The last this-many assistant rounds are never pruned; >= 1, default 6. */
      keepRecentRounds: z.number().int().min(1).optional(),
      /** A shell output over this many chars keeps its head and tail; >= 1, default 2000. */
      pruneOutputChars: z.number().int().min(1).optional(),
    })
    .strict()
    .optional(),
  /**
   * Session hop (docs/feat/session-hop.md D9): the agent may PROPOSE moving this
   * session with `move_session`. It never moves anything itself — the owner is
   * asked, in the laptop's TUI, when the turn ends.
   */
  sessionHop: z
    .object({
      /** Default: enabled. */
      tool: z.boolean().optional(),
    })
    .strict()
    .optional(),
  /**
   * Workload shell (docs/fix/workload-shell-live.md, owner decision 1): the
   * agent may open a stateful `sh` on ANOTHER workload with `workload_shell`.
   * Default: DISABLED — it reaches the user's kubeconfig / docker endpoint.
   */
  workloadShell: z
    .object({
      /** Default: disabled. */
      tool: z.boolean().optional(),
    })
    .strict()
    .optional(),
  /**
   * Container previews (docs/feat/container-apps-devices.md): `serve` offers
   * `container_preview` (a container's web port, to the paired devices only,
   * asked every time). THIS host's setting, file-only, never carried.
   */
  previews: z
    .object({
      /** Default: disabled. */
      enabled: z.boolean().optional(),
    })
    .strict()
    .optional(),
  /**
   * Session apps (docs/feat/session-apps-publish.md D11): the agent may publish
   * an HTML page it presented as a public web page, asked every time. THIS
   * host's setting, file-only, never carried (a pod never publishes).
   */
  apps: z
    .object({
      /** Default: disabled. */
      enabled: z.boolean().optional(),
      /** The apps domain, a bare hostname; default `apps.tentacle.so`. */
      domain: z
        .string()
        .max(200)
        .regex(
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
          "a bare lowercase hostname (no scheme, port or path)",
        )
        .optional(),
    })
    .strict()
    .optional(),
  /**
   * Scheduled wakes (docs/feat/cron-tool.md D3, owner Q6): THIS host's limits on
   * the agent's `schedule_create`. File-only, never carried (a pod is never
   * offered the tools). Every key is checked when a wake is created.
   */
  schedules: z
    .object({
      /** Live wakes per session; 1..100, default 10. */
      maxJobs: z.number().int().min(1).max(100).optional(),
      /** The shortest `every`, in minutes; 1..1440, default 1. */
      minIntervalMinutes: z.number().int().min(1).max(1440).optional(),
      /** A recurring wake's life (and the longest `every`), in days; 1..30, default 7. */
      expiryDays: z.number().int().min(1).max(30).optional(),
      /** How far ahead an `at` may point, in days; 1..30, default 7. */
      maxAheadDays: z.number().int().min(1).max(30).optional(),
      /** The longest prompt; 1..20000, default 2000. */
      promptMaxChars: z.number().int().min(1).max(20_000).optional(),
    })
    .strict()
    .optional(),
  /**
   * Auto-wake: when a background job exits while the agent is idle, start a
   * continuation turn so it reacts without a user prompt. Default: enabled.
   */
  autoWake: z.boolean().optional(),
  /**
   * Default engine of `run`/`attach` (docs/feat/docker-engine-cli.md); the
   * `--engine` flag and `TENTACLE_ENGINE` win. Unset: `kubernetes`.
   */
  engine: z.enum(["kubernetes", "docker", "podman"]).optional(),
  /**
   * The network `run` puts its container on (feat/run-network): a name, or
   * `none` for an air-gapped workload. `--network` and `TENTACLE_NETWORK` win.
   * Unset: no `NetworkMode` in the create body (the engine's own default).
   * Refused on `--engine kubernetes` (a pod's network is the cluster's).
   */
  network: z.string().regex(NETWORK_VALUE, NETWORK_VALUE_MESSAGE).optional(),
  /**
   * Whether `run` removes its pod/container when the run ends (fix/run-rm-flag;
   * docs/feat/docker-engine-cli.md); `--rm[=true|false]` wins. Unset: false (kept).
   */
  rm: z.boolean().optional(),
  /**
   * `run --detach` (docs/feat/detached-relay-lifecycle.md): `keepAwake` holds a
   * macOS sleep assertion while a turn runs. Unset: true.
   */
  detach: z.object({ keepAwake: z.boolean().optional() }).strict().optional(),
  /**
   * The TUI's palette (docs/feat/tui-light-theme.md): `auto` (default) probes the
   * terminal's background before Ink mounts, `dark`/`light` force one and skip
   * the query. A LAPTOP-ONLY display setting: never carried to a pod.
   */
  tui: z
    .object({
      theme: z.enum(["auto", "dark", "light"]).optional(),
      /**
       * The plot's glyphs (docs/feat/model-charts.md D5): `braille` (default,
       * 2×4 dots per cell) or `blocks` (quadrant blocks, 2×2) for a font that
       * has no braille. A terminal cannot report a missing glyph, so it is a
       * setting. LAPTOP-ONLY display: never carried to a pod.
       */
      chartGlyphs: z.enum(["braille", "blocks"]).optional(),
    })
    .strict()
    .optional(),
  /**
   * Opt-in display features (docs/feat/shell-intent-line.md): `compactShell`
   * hides a described `shell` row's `$ command` row while it runs and on exit 0
   * (shown on failure; always in the ask and the expanded row). Unset: false.
   * LAPTOP-ONLY display: never carried to a pod.
   */
  beta: z.object({ compactShell: z.boolean().optional() }).strict().optional(),
  /**
   * The laptop's session logs (docs/feat/session-log-laptop-store.md):
   * `keepSuperseded` keeps the history a compaction or a `context_reset`
   * replaced in the session file (resume still shows the current one). Unset:
   * false (today's behaviour: superseded history is not kept). LAPTOP-ONLY:
   * never carried to a pod.
   */
  sessions: z.object({ keepSuperseded: z.boolean().optional() }).strict().optional(),
  /**
   * The voice dictation helper (docs/feat/voice-dictation.md): push-to-talk in
   * the LOCAL TUI on the Mac. Speech is recognised on this machine (the default
   * engine is Apple's built-in on-device recogniser; `parakeet` is the opt-in
   * alternative and needs a one-time `tentacle voice setup` download). LAPTOP-ONLY
   * and input-only: never carried to a pod, and no audio ever leaves the Mac or
   * is written to disk. Absent: OFF, Ctrl+R, `auto` language, auto-stop off —
   * `voice: { "enabled": true }` turns the terminal's voice features on.
   */
  voice: z
    .object({
      /**
       * Off by DEFAULT (feat/voice-off-by-default): `true` turns the terminal's
       * voice features on. While off the key is a one-line notice and the helper
       * is never spawned.
       */
      enabled: z.boolean().optional(),
      /** The toggle key, in the TUI's `ctrl+<letter>` spelling. */
      key: z
        .string()
        .regex(/^ctrl\+[a-z]$/, "key must be `ctrl+<letter>`, e.g. ctrl+r")
        .optional(),
      /** `auto` lets the engine detect it; `it`/`en` force one. */
      language: z.enum(["auto", "it", "en"]).optional(),
      /** The on-device recogniser: Apple's is the default (no download). */
      engine: z.enum(["apple", "parakeet"]).optional(),
      /**
       * Finish on a pause instead of on the key. Off by default: with the key
       * the user ends the dictation, so a comma pause can never cut it (V0's
       * 5/30 truncations). A floor below 300 ms is refused — that is inside the
       * measured comma-pause range (docs/feat/voice-dictation.md Execution, S1).
       */
      autoStop: z.boolean().optional(),
      autoStopSilenceMs: z.number().int().min(300).optional(),
      /** A hard stop, so a forgotten dictation ends (its text IS inserted). */
      maxSeconds: z.number().int().min(10).optional(),
      /** `builtin` avoids the AirPods HFP downgrade of other audio. */
      input: z.enum(["default", "builtin"]).optional(),
      /** AEC/AGC on the capture tap; off is for measurement only. */
      voiceProcessing: z.boolean().optional(),
      modelsDir: z.string().optional(),
      helperPath: z.string().optional(),
    })
    .strict()
    .optional(),
  /**
   * The mobile relay (docs/feat/mobile-relay.md R5a): `enabled` (default true)
   * lets a `serve` with paired devices dial OUT to the relay so a phone reaches
   * it from anywhere; `url` names the relay (`DEFAULT_RELAY_URL` when unset) and
   * must be `wss://` (or `ws://` to a loopback host) — the secret travels on that
   * socket. `serve --relay <url>` / `serve --no-relay` override both. LAPTOP-ONLY:
   * never carried to a pod (a pod daemon has no device route and never dials).
   */
  relay: z
    .object({ enabled: z.boolean().optional(), url: z.string().optional() })
    .strict()
    .optional(),
  /**
   * Push notifications (docs/feat/mobile-push.md Design 6): `enabled` (default
   * true) lets a `serve` push to its paired phones; `graceSeconds` (default 30,
   * range 0–3600) is how long an unanswered permission request waits before a
   * phone is buzzed. `serve --push-grace <seconds>` overrides the second. Push
   * needs the relay link: `--no-relay` / `relay.enabled: false` mean no push at
   * all. LAPTOP-ONLY: never carried to a pod (a pod daemon holds no token).
   */
  push: z
    .object({
      enabled: z.boolean().optional(),
      // The bounds are `@tentacle/protocol`'s `PUSH_GRACE_MAX_SECONDS` (3600):
      // this package depends on zod only, so the number is repeated here and the
      // agreement is PINNED by a test (`config/test/push-config.test.ts`), not
      // left to two files to drift.
      graceSeconds: z.number().int().min(0).max(PUSH_GRACE_MAX_SECONDS).optional(),
    })
    .strict()
    .optional(),
  /**
   * Live Activities (docs/feat/mobile-live-activity.md Design 3): `enabled`
   * (default true) lets a `serve` start a lock-screen activity for a paired
   * phone that is NOT attached to the session; `startAfterSeconds` (default 20,
   * range 0–3600) is how long a turn must run before it may. LAPTOP-ONLY: never
   * carried to a pod (a pod daemon holds no device route), and it needs the
   * relay link — `--no-relay` / `relay.enabled: false` mean no activity at all.
   */
  liveActivity: z
    .object({
      enabled: z.boolean().optional(),
      // The bounds are `@tentacle/daemon`'s rules module's own; this package
      // depends on zod only, so the numbers are repeated here and the agreement is
      // PINNED by a test (`cli/test/live-activity-config.test.ts`).
      startAfterSeconds: z
        .number()
        .int()
        .min(0)
        .max(LIVE_ACTIVITY_START_AFTER_MAX_SECONDS)
        .optional(),
    })
    .strict()
    .optional(),
  /**
   * What a docker/podman workspace mount hides from the container
   * (docs/feat/docker-workspace-mount.md): `hide` REPLACES the default list
   * (`~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`,
   * `~/.netrc`), `hideExtra` ADDS to it. Paths are `~/…` or absolute, dirs or
   * files. The tentacle config dir and the `apiKeyCommand` key file are always
   * hidden, whatever this says.
   */
  mount: z
    .object({
      hide: z.array(HidePathSchema).optional(),
      hideExtra: z.array(HidePathSchema).optional(),
    })
    .strict()
    .optional(),
  /** MCP servers to connect to, keyed by name; their tools are added to the agent. */
  mcpServers: z.record(McpServerSchema).optional(),
  /**
   * Installed packages (`<configDir>/packages/<name>`, docs/feat/packages.md)
   * to switch off: `{ "<name>": false }`. Default: every package enabled. A
   * top-level setting, so a profile's `packages` replaces the base map.
   */
  packages: z.record(z.boolean()).optional(),
  /** Tool-output handling. */
  tools: z
    .object({
      /**
       * Max characters of a tool result kept inline; larger output is spilled
       * to a file the model reads selectively. 0 disables spilling.
       */
      maxInlineOutputChars: z.number().int().nonnegative().optional(),
      /**
       * Days a spilled tool output is kept (swept when the daemon starts).
       * 0 or negative: never swept. Default: 30.
       */
      outputRetentionDays: z.number().int().optional(),
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
      /**
       * How a round's tool calls may overlap (docs/feat/parallel-tools.md):
       * `sequential` — one at a time; `read-only` (default) — read-class calls
       * (fs_read, read-only MCP tools) together, every write and shell call
       * alone; `parallel` — any calls on different resources together.
       */
      execution: z.enum(["sequential", "read-only", "parallel"]).optional(),
      /** At most this many calls of a round at once (`1` = sequential). Default 8. */
      maxParallel: z.number().int().positive().optional(),
      /**
       * Where `fs_write`/`fs_edit`/`fs_multi_edit` may write besides the project
       * (docs/feat/write-tmpdir.md). REPLACES the default (the system temp dir
       * and `/tmp`); `[]` = the project only. `/` is dropped. Matched by
       * realpath, on the daemon's host; NOT carried to a pod (its own default).
       */
      writableDirs: z.array(WritableDirSchema).optional(),
      /**
       * Built-in tools to switch off, by group (`subagents`, `shell`,
       * `schedule`, `visuals`, `context_reset`, `move_session`,
       * `workload_shell`) or by tool name: `{ "visuals": false }`
       * (docs/feat/tool-toggles.md). A single tool's entry beats its group's.
       * `skill` is always on; `true` never turns on a feature that is off.
       * A profile's map merges per key over the base's.
       */
      enabled: z.record(z.boolean()).optional(),
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
  .strict()
  // A `models` name used by `subagents.*` must exist, in the base and in each
  // profile's merged view (docs/feat/models-map.md A2). Here, so `loadConfig`
  // and `config set`'s whole-file validation both refuse it.
  .superRefine((file, ctx) => {
    for (const message of modelRefIssues(file)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    // Built-in tool switches name a known group or tool, never `skill`
    // (docs/feat/tool-toggles.md F1/F2), in the base and each merged profile.
    for (const message of toolEnabledIssues(file)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

export type FileConfig = z.infer<typeof FileConfigSchema>;

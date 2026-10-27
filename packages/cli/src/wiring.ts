/**
 * Builds a fully-wired `Agent` from a resolved `TentacleConfig`: the configured
 * model provider (OpenAI-compatible or native Anthropic), host execution
 * (writes confined to the workspace), the built-in tool-set, and a
 * `PermissionBroker` whose requester the frontend can attach at runtime.
 * Shared by the one-shot and interactive entry points.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Agent,
  type AgentType,
  type AskHooksTrust,
  BUILTIN_AGENT_TYPES,
  EMPTY_SKILL_LISTING,
  HookRunner,
  type ResultTransform,
  type SessionSkills,
  type SkillListing,
  collapseRepeatedLines,
  createSubagentRunner,
  exemptTools,
  mergeAgentTypes,
  parseAgentDefinition,
  redactSecrets,
  runResultHooks,
  spillLargeOutput,
  summarizeLargeOutput,
  summarizeText,
  tabulateJson,
  userRescanListing,
} from "@tentacle/agent";
import {
  type SkillInfo,
  type TentacleConfig,
  offeredSkills,
  rediscoverSkills,
  refreshSessionContext,
  slashSkills,
  splitFrontmatter,
} from "@tentacle/config";
import { type JobController, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { BackgroundJobs, HostExecution } from "@tentacle/exec";
import { type ConnectMcpResult, connectMcpServers } from "@tentacle/mcp";
import { HooksTrustParamsSchema } from "@tentacle/protocol";
import {
  SKILL_TOOL_NAME,
  type SkillBodyReader,
  ToolRegistry,
  builtinTools,
  createContextResetTool,
  createSkillActivator,
  createSkillTool,
  createTaskTool,
} from "@tentacle/tools";
import { logDaemonError } from "./daemon-log.ts";
import { createHooksTrustResolver, fileTrustStore } from "./hooks-trust.ts";
import { configuredModelProvider } from "./model-provider.ts";

/**
 * Load user-defined agent types from `<configDir>/agents/*.md`, then from each
 * package `agents/` dir (docs/feat/packages.md). A missing dir → none. On a
 * type-name clash the first wins and a diagnostic names both; an unreadable
 * package definition is a diagnostic (the user's own is skipped silently).
 */
export function loadUserAgentTypes(
  configDir: string,
  packageDirs: readonly string[] = [],
): { types: AgentType[]; diagnostics: string[] } {
  const types: AgentType[] = [];
  const diagnostics: string[] = [];
  const from = new Map<string, string>();
  for (const [index, dir] of [join(configDir, "agents"), ...packageDirs].entries()) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of entries.sort()) {
      const path = join(dir, file);
      let type: AgentType;
      try {
        const parsed = parseAgentDefinition(readFileSync(path, "utf8"), file.replace(/\.md$/, ""));
        type = parsed.type;
        // A dropped field (fix/agent-defs-warn): name the agent + path; the
        // field-scoped wording comes from the parser.
        for (const warning of parsed.warnings) {
          diagnostics.push(`agent "${type.name}" (${path}): ${warning}`);
        }
      } catch (error) {
        if (index > 0) {
          diagnostics.push(`${path}: skipped (${error instanceof Error ? error.message : error})`);
        }
        continue;
      }
      const prior = from.get(type.name);
      if (prior !== undefined) {
        diagnostics.push(
          `agent type "${type.name}" in ${path} ignored (already defined by ${prior})`,
        );
        continue;
      }
      if (index > 0 && BUILTIN_AGENT_TYPES.some((b) => b.name === type.name)) {
        diagnostics.push(`agent type "${type.name}" in ${path} replaces the built-in one`);
      }
      from.set(type.name, path);
      types.push(type);
    }
  }
  return { types, diagnostics };
}

/**
 * Read a skill's body at activation through the session env (in a pod: the
 * pod's filesystem, where discovery ran).
 */
export const readSkillBody: SkillBodyReader = async (skill, ctx) => {
  const { body, bodyLine } = splitFrontmatter(await ctx.env.readFile(skill.location));
  return { body, bodyLine };
};

/**
 * A session's skill set from a discovery. The tool offers exactly the cataloged
 * skills (one rule, `offeredSkills`); none → no tool. The activator behind every
 * activation (the user's `/name` round, the `/compact` re-read) knows the
 * offered skills plus the user's `slashSkills` (hidden-from-the-model ones
 * included, eval decision 5). The listing (`session/skills`, the TUI's `/` and
 * `/skills`) says the same with the same rules, plus the discovery's problems,
 * so a list can't disagree with what actually happens; raw: the daemon
 * (`toSessionSkills`) makes it wire-safe. Used at start (`buildAgent`), by a
 * context reset and by the user's rescan, each on its own discovery.
 */
export function buildSessionSkills(
  skills: readonly SkillInfo[],
  diagnostics: readonly string[],
  readBody: SkillBodyReader,
): SessionSkills {
  const offered = offeredSkills(skills);
  const userNames = new Set(slashSkills(skills).map((s) => s.name));
  const offeredNames = new Set(offered.map((s) => s.name));
  return {
    tool: createSkillTool(offered, readBody),
    activator: createSkillActivator(
      skills
        .filter((s) => offeredNames.has(s.name) || userNames.has(s.name))
        .map((s) => ({ ...s, userInvocable: userNames.has(s.name) })),
      readBody,
    ),
    listing: {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        user: userNames.has(s.name),
        model: offeredNames.has(s.name),
        location: s.location,
      })),
      problems: [...diagnostics],
    },
  };
}

/** One discovery: the skills and their problems. */
export interface SkillDiscovery {
  readonly skills: readonly SkillInfo[];
  readonly diagnostics: readonly string[];
}

/**
 * The skill scan a daemon's sessions share (docs/feat/skills-hot-reload.md):
 * every user rescan (any session's, or the `/name` list of a session not
 * created yet) goes through it, and a session created later starts its `/name`
 * activator from the `latest` one — so what the user was shown before the
 * first prompt is what that prompt is checked against. The MODEL's set of a
 * new session stays the start-up's (`config.skills`: its system prompt was
 * composed from it). Re-reads files only, with the start-up's settings (CR-Q2).
 *
 * Debt: the scan reads the DAEMON's `config.cwd`, while a reset reads the
 * session's `{...config, cwd}`. They are equal today (`SessionHost` builds
 * every agent at `defaultCwd`; `serve` is one project per daemon); if a
 * per-session cwd is ever honoured, rescans would read another project's skills.
 */
export interface SkillScan {
  /** The latest scan (before any: the start-up's discovery). */
  latest(): SkillDiscovery;
  /** Read the skill folders again; the result becomes `latest`. May throw. */
  scan(): Promise<SkillDiscovery>;
  /** A fresh scan seen from a session created now: what `session/skills` with no session answers. */
  newSession(): Promise<SkillListing>;
}

export function createSkillScan(
  config: Pick<
    TentacleConfig,
    "cwd" | "configDir" | "skillsEnabled" | "packages" | "skills" | "skillDiagnostics"
  >,
  // Injectable so a test can gate overlapping scans.
  rediscover: (c: typeof config) => Promise<SkillDiscovery> = rediscoverSkills,
): SkillScan {
  let latest: SkillDiscovery = { skills: config.skills, diagnostics: config.skillDiagnostics };
  // Scans may overlap (two sessions): `latest` is the one that STARTED last
  // among those that landed, never an older one landing late.
  let started = 0;
  let landed = 0;
  const modelAtStart = offeredSkills(config.skills).map((s) => s.name);
  const scan = async (): Promise<SkillDiscovery> => {
    const n = ++started;
    const fresh = await rediscover(config);
    if (n > landed) {
      landed = n;
      latest = fresh;
    }
    return fresh;
  };
  return {
    latest: () => latest,
    scan,
    newSession: async () => {
      const fresh = await scan();
      return userRescanListing(
        buildSessionSkills(fresh.skills, fresh.diagnostics, readSkillBody).listing ??
          EMPTY_SKILL_LISTING,
        modelAtStart,
      );
    },
  };
}

export interface WiredAgent {
  readonly agent: Agent;
  /** Headless by default (approves all); the TUI attaches an interactive requester. */
  readonly permissions: PermissionBroker;
  /** Background-job registry; the TUI subscribes to surface job exits live. */
  readonly jobs: JobController;
  /** The tool registry — MCP tools are registered into it after connecting. */
  readonly tools: ToolRegistry;
  /** The provider a daemon asks for the session's title (`AgentFactory.titleModel`); absent with `autoTitle` off. */
  readonly titleModel?: ModelProvider;
}

export interface BuildAgentOptions {
  /** Replace the configured provider — e.g. a proxy that tunnels model calls
   *  to a remote client (the pod reverse-tunnel, F4.d). Used for the main model
   *  and for sub-agents (per-type model overrides are ignored over the
   *  tunnel). */
  readonly modelOverride?: ModelProvider;
  /** The title's own override: the pod's tunnel that marks a call as a title one (`purpose: "title"`). */
  readonly titleModelOverride?: ModelProvider;
  /**
   * Reuse this broker instead of a fresh one: several agents behind ONE
   * frontend (one in-process agent per session) must share the broker the TUI
   * installs its prompt on — two brokers silently decouple (AGENTS §7).
   */
  readonly permissions?: PermissionBroker;
  /**
   * Daemon-side log for hook failures (`onFailure: "ignore"`). Never the
   * terminal while Ink owns it (AGENTS §7): a log file / the piped stderr.
   */
  readonly log?: (line: string) => void;
  /**
   * Daemon-side notices that are not failures (a context reset's scan
   * diagnostics). Same rule as `log`: never the terminal while Ink owns it.
   */
  readonly notice?: (line: string) => void;
  /**
   * Asks whether to run the project's hooks when a turn brings no asker (the
   * in-process TUI, which has no RPC). Absent → project hooks are declined.
   */
  readonly askHooksTrust?: AskHooksTrust;
  /**
   * The daemon's shared skill scan (`createSkillScan`): the session's `/name`
   * set starts from its latest result and its rescans go through it. Absent
   * (a one-shot) → the start-up's discovery, rescans read the folders directly.
   */
  readonly skillScan?: SkillScan;
}

export function buildAgent(config: TentacleConfig, options: BuildAgentOptions = {}): WiredAgent {
  const model = options.modelOverride ?? configuredModelProvider(config);
  const env = new HostExecution({ cwd: config.cwd, root: config.cwd });
  const tools = new ToolRegistry().registerAll(builtinTools);
  const permissions = options.permissions ?? new PermissionBroker();
  // Background jobs let the shell tools launch long-running processes (servers,
  // watchers) without blocking the turn; their exits surface on the next turn.
  const jobs = new BackgroundJobs(env);
  // The harness's value-add layer over raw tool output. Order matters: redact
  // secrets FIRST (so they never reach the context or the spilled file), then
  // handle large output — either an LLM summary (opt-in, costs a model call) or
  // a head/tail preview, both spilling the full output to a file.
  const largeOutput = config.summarizeLargeOutput
    ? summarizeLargeOutput({
        maxInlineChars: config.maxInlineOutputChars,
        summarize: (text, signal) => summarizeText(model, text, signal),
      })
    : spillLargeOutput({ maxInlineChars: config.maxInlineOutputChars });
  // A `skill` result is instructions the model asked for: never spilled,
  // summarised or reshaped (the tool bounds it itself) — but still redacted.
  const shaping = (t: ResultTransform): ResultTransform => exemptTools([SKILL_TOOL_NAME], t);
  // User hooks (docs/feat/hooks-core.md): `tool_call` runs in the gate,
  // `tool_result` right after redaction (a hook never sees a redacted secret)
  // and before shaping (unwrapped: a `skill` result reaches hooks too).
  // Project hooks (`.agents/hooks.json`) join them only once the session
  // trusts them (docs/feat/hooks-project-trust.md); they may `allow` only
  // where this process is local (D6): over the pod model tunnel, never.
  const project = config.projectHooks;
  const hooks =
    config.hooks.length > 0 || project !== undefined
      ? new HookRunner({
          specs: config.hooks,
          env,
          cwd: config.cwd,
          // Hooks find the repo from a subfolder (docs/feat/hook-env-dirs.md).
          projectDir: config.projectDir,
          ...(options.log ? { log: options.log } : {}),
          modelId: config.model,
          // Only when this process calls the provider itself: over the pod
          // model tunnel the request is built in the untrusted pod (D2).
          modelRequestHooks: options.modelOverride === undefined,
          ...(project !== undefined
            ? {
                project: {
                  specs: project.hooks,
                  folder: project.folder,
                  hash: project.hash,
                  files: project.files,
                  canAllow: options.modelOverride === undefined,
                },
              }
            : {}),
        })
      : undefined;
  const resultTransforms: ResultTransform[] = [
    ...(config.redactSecrets ? [redactSecrets()] : []),
    runResultHooks,
    ...(config.dedupOutput ? [shaping(collapseRepeatedLines())] : []),
    ...(config.tabulateJson ? [shaping(tabulateJson())] : []),
    shaping(largeOutput),
  ];

  // Skills: the `skill` tool and the activator, from the one builder a context
  // reset and the user's rescan also use (so they can never disagree). The
  // model's set is the start-up's (its system prompt was composed from it);
  // the user's `/name` set is the daemon's latest scan (docs/feat/skills-hot-reload.md).
  const modelSkills = buildSessionSkills(config.skills, config.skillDiagnostics, readSkillBody);
  if (modelSkills.tool) {
    tools.register(modelSkills.tool);
  }
  const start = options.skillScan?.latest();
  const userSkills = start
    ? buildSessionSkills(start.skills, start.diagnostics, readSkillBody)
    : modelSkills;
  const skillListing = userRescanListing(
    userSkills.listing ?? EMPTY_SKILL_LISTING,
    offeredSkills(config.skills).map((s) => s.name),
  );
  // The user's rescan reads the same folders as a reset, with no prompt file.
  const rescanSkills = async (): Promise<SessionSkills> => {
    const fresh = options.skillScan
      ? await options.skillScan.scan()
      : await rediscoverSkills(config);
    return buildSessionSkills(fresh.skills, fresh.diagnostics, readSkillBody);
  };

  // The model is told how full its context is (docs/feat/context-awareness.md),
  // on `model.contextWindow` (a pod daemon's is the laptop's: `--context-window`).
  // Each sub-agent counts its own history on the same window.
  const contextAwareness = config.contextAwareness.enabled
    ? { window: config.contextWindow, stepPercent: config.contextAwareness.stepPercent }
    : undefined;

  // Sub-agents: when enabled, register the `agent_task` delegation tool. Children
  // inherit the same confined env + permission requester; the runner filters
  // out `agent_task` itself so a sub-agent cannot spawn further sub-agents.
  if (config.subagentsEnabled) {
    const agentTypes = mergeAgentTypes(
      BUILTIN_AGENT_TYPES,
      loadUserAgentTypes(config.configDir, config.packageAgentDirs).types,
    );
    const { run, types } = createSubagentRunner({
      model,
      // Per-type model override: same endpoint, a different model id. Over a
      // model tunnel the override provider is used for every type.
      modelFor: (modelId) => options.modelOverride ?? configuredModelProvider(config, modelId),
      env,
      tools,
      requestPermission: (req, options) => permissions.request(req, options),
      maxIterations: config.subagentMaxIterations,
      types: agentTypes,
      resultTransforms,
      ...(hooks ? { hooks } : {}),
      ...(contextAwareness ? { contextAwareness } : {}),
    });
    tools.register(createTaskTool((opts, controls) => run(opts, controls), types));
  }

  // Context reset (docs/feat/context-reset.md): the model renews its own
  // context; the loop runs it. A reset re-reads THIS process's files — the
  // ones its system prompt and skill set were built from at start (in a pod:
  // the pod's). Scan problems go to the daemon log, never the terminal.
  const contextReset = config.contextReset.enabled
    ? {
        maxPerMessage: config.contextReset.maxPerMessage,
        refresh: async () => {
          const fresh = await refreshSessionContext(config);
          for (const line of fresh.skillDiagnostics) {
            options.notice?.(`context reset: ${line}`);
          }
          return {
            systemPrompt: fresh.systemPrompt,
            skills: buildSessionSkills(fresh.skills, fresh.skillDiagnostics, readSkillBody),
          };
        },
      }
    : undefined;
  if (contextReset) {
    tools.register(createContextResetTool());
  }

  const agent = new Agent({
    model,
    tools,
    env,
    jobs,
    resultTransforms,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
    requestPermission: (req, options) => permissions.request(req, options),
    ...(userSkills.activator ? { skills: userSkills.activator } : {}),
    skillListing,
    rescanSkills,
    ...(hooks ? { hooks } : {}),
    ...(options.askHooksTrust ? { askHooksTrust: options.askHooksTrust } : {}),
    ...(contextAwareness ? { contextAwareness } : {}),
    ...(contextReset ? { contextReset } : {}),
  });
  // Names the session after its first exchange (docs/feat/session-titles.md),
  // only with `model.autoTitle` (opt-in; off → no title model, no call):
  // `model.titleModel` on the same endpoint, else the main model. Over the pod
  // model tunnel the title tunnel answers — the laptop picks its model.
  const titleModel = config.autoTitle
    ? (options.titleModelOverride ??
      options.modelOverride ??
      (config.titleModel !== undefined
        ? configuredModelProvider(config, config.titleModel)
        : model))
    : undefined;
  return { agent, permissions, jobs, tools, ...(titleModel ? { titleModel } : {}) };
}

/**
 * The in-process TUI's agents: one per session (so a session's background
 * jobs end with it, decision D3), all on ONE broker — the one the TUI installs
 * its prompt on. A per-agent broker would silently auto-approve (AGENTS §7,
 * single-broker invariant), so the broker and the factory come as a pair.
 */
export function inProcessAgents(config: TentacleConfig): {
  readonly permissions: PermissionBroker;
  readonly build: () => WiredAgent;
} {
  const permissions = new PermissionBroker();
  // No RPC here: the agent asks the laptop's resolver directly — on the SAME
  // broker, with the laptop's store (the in-process fallback is local, D4).
  const resolve = createHooksTrustResolver({
    broker: permissions,
    interactive: true,
    store: fileTrustStore(config.configDir),
  });
  // The same gate as the wire: on RPC the peer validates `hooks/trust` against
  // `HooksTrustParamsSchema` before the laptop sees it. Here nothing does, so
  // check it the same way — hooks over the limits, or with control / bidi
  // characters, are never offered: the throw makes the runner decline and log.
  const askHooksTrust: AskHooksTrust = async ({ sessionId, ...request }, signal) => {
    const parsed = HooksTrustParamsSchema.safeParse({ sessionId, ...request });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      throw new Error(`invalid hooks/trust request (${where}${issue?.message ?? "invalid"})`);
    }
    return (await resolve(parsed.data, signal)).trusted;
  };
  // Hook lines (failures, a declined trust) go to the daemon error log, as in
  // the worker — never the terminal Ink owns (AGENTS §7).
  const log = (line: string): void => {
    logDaemonError(config.configDir, line);
  };
  // One scan for every session, as a daemon's (docs/feat/skills-hot-reload.md).
  const skillScan = createSkillScan(config);
  return {
    permissions,
    build: () => buildAgent(config, { permissions, askHooksTrust, log, skillScan }),
  };
}

/**
 * Connect the configured MCP servers and register their tools into `tools`.
 * Returns a handle to dispose the server subprocesses, plus any per-server
 * connection errors (a broken server is skipped, not fatal). A no-op when no
 * servers are configured.
 */
export async function connectConfiguredMcp(
  config: TentacleConfig,
  tools: ToolRegistry,
): Promise<ConnectMcpResult> {
  const result = await connectMcpServers(config.mcpServers);
  for (const tool of result.tools) {
    try {
      tools.register(tool);
    } catch {
      // A name clash with a built-in/other server: skip the duplicate.
    }
  }
  return result;
}

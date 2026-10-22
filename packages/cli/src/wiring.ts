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
  HookRunner,
  type ResultTransform,
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
} from "@tentacle/agent";
import {
  type TentacleConfig,
  offeredSkills,
  slashSkills,
  splitFrontmatter,
} from "@tentacle/config";
import { type JobController, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { BackgroundJobs, HostExecution } from "@tentacle/exec";
import { type ConnectMcpResult, connectMcpServers } from "@tentacle/mcp";
import { HooksTrustParamsSchema, type SkillListEntry } from "@tentacle/protocol";
import {
  SKILL_TOOL_NAME,
  type SkillBodyReader,
  ToolRegistry,
  builtinTools,
  createSkillActivator,
  createSkillTool,
  createTaskTool,
} from "@tentacle/tools";
import { logDaemonError } from "./daemon-log.ts";
import { createHooksTrustResolver, fileTrustStore } from "./hooks-trust.ts";
import { configuredModelProvider } from "./model-provider.ts";

/**
 * The daemon's `/name` catalog for `initialize` (`SessionHostOptions.skills`):
 * name + description of `slashSkills` — the same rule the agent's activator
 * uses for `userInvocable`, so the catalog and what `session/prompt{skill}`
 * accepts never disagree.
 */
export function skillCatalog(
  config: Pick<TentacleConfig, "skills">,
): { name: string; description: string }[] {
  return slashSkills(config.skills).map(({ name, description }) => ({ name, description }));
}

/**
 * Every discovered skill and who may invoke it, plus the discovery problems
 * (`skills/list`, the TUI's `/skills`; docs/feat/skills-panel.md). `user` and
 * `model` are the same rules the agent applies (`slashSkills`,
 * `offeredSkills`), so the panel can't disagree with what actually happens.
 * Raw: the daemon (`toSkillList`) makes it wire-safe.
 */
export function skillListing(config: Pick<TentacleConfig, "skills" | "skillDiagnostics">): {
  skills: SkillListEntry[];
  problems: string[];
} {
  const user = new Set(slashSkills(config.skills).map((s) => s.name));
  const model = new Set(offeredSkills(config.skills).map((s) => s.name));
  return {
    skills: config.skills.map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      user: user.has(s.name),
      model: model.has(s.name),
      location: s.location,
    })),
    problems: [...config.skillDiagnostics],
  };
}

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
        type = parseAgentDefinition(readFileSync(path, "utf8"), file.replace(/\.md$/, ""));
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

export interface WiredAgent {
  readonly agent: Agent;
  /** Headless by default (approves all); the TUI attaches an interactive requester. */
  readonly permissions: PermissionBroker;
  /** Background-job registry; the TUI subscribes to surface job exits live. */
  readonly jobs: JobController;
  /** The tool registry — MCP tools are registered into it after connecting. */
  readonly tools: ToolRegistry;
}

export interface BuildAgentOptions {
  /** Replace the configured provider — e.g. a proxy that tunnels model calls
   *  to a remote client (the pod reverse-tunnel, F4.d). Used for the main model
   *  and for sub-agents (per-type model overrides are ignored over the
   *  tunnel). */
  readonly modelOverride?: ModelProvider;
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
   * Asks whether to run the project's hooks when a turn brings no asker (the
   * in-process TUI, which has no RPC). Absent → project hooks are declined.
   */
  readonly askHooksTrust?: AskHooksTrust;
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

  // Skills: the tool offers exactly the cataloged skills (one rule,
  // `offeredSkills`); none → no tool. The body is read at activation through
  // the session env (in a pod: the pod's filesystem, where discovery ran).
  const readSkillBody: SkillBodyReader = async (skill, ctx) => {
    const { body, bodyLine } = splitFrontmatter(await ctx.env.readFile(skill.location));
    return { body, bodyLine };
  };
  const offered = offeredSkills(config.skills);
  const skillTool = createSkillTool(offered, readSkillBody);
  if (skillTool) {
    tools.register(skillTool);
  }
  // The activator behind every activation (the user's `/name` round, the
  // `/compact` re-read): the offered skills plus the user's `slashSkills`
  // (hidden-from-the-model ones included, eval decision 5).
  const userNames = new Set(slashSkills(config.skills).map((s) => s.name));
  const offeredNames = new Set(offered.map((s) => s.name));
  const skills = createSkillActivator(
    config.skills
      .filter((s) => offeredNames.has(s.name) || userNames.has(s.name))
      .map((s) => ({ ...s, userInvocable: userNames.has(s.name) })),
    readSkillBody,
  );

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
      requestPermission: (req) => permissions.request(req),
      maxIterations: config.subagentMaxIterations,
      types: agentTypes,
      resultTransforms,
      ...(hooks ? { hooks } : {}),
    });
    tools.register(createTaskTool((opts, controls) => run(opts, controls), types));
  }

  const agent = new Agent({
    model,
    tools,
    env,
    jobs,
    resultTransforms,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
    requestPermission: (req) => permissions.request(req),
    skills,
    ...(hooks ? { hooks } : {}),
    ...(options.askHooksTrust ? { askHooksTrust: options.askHooksTrust } : {}),
  });
  return { agent, permissions, jobs, tools };
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
  return {
    permissions,
    build: () => buildAgent(config, { permissions, askHooksTrust, log }),
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

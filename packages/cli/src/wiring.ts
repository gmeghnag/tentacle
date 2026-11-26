/**
 * Builds a fully-wired `Agent` from a resolved `TentacleConfig`: the configured
 * model provider (OpenAI-compatible or native Anthropic), host execution
 * (writes confined to the workspace + `tools.writableDirs`), the built-in tool-set, and a
 * `PermissionBroker` whose requester the frontend can attach at runtime.
 * Shared by the one-shot and interactive entry points.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type A2AAdapter,
  type A2AAgentCard,
  type A2ACommandRunner,
  type A2ALookup,
  Agent,
  type AgentType,
  type AskHooksTrust,
  BUILTIN_AGENT_TYPES,
  CLAUDE_CODE_CAPS,
  CLAUDE_CODE_ID,
  CLAUDE_DEFAULT_TOOLS,
  CLAUDE_TYPE_DESCRIPTION,
  EMPTY_SKILL_LISTING,
  type HarnessDeps,
  type HarnessInstance,
  HookRunner,
  NO_CAPABILITIES,
  PermissionGate,
  type ProcessGroups,
  type ResultTransform,
  SessionGrants,
  type SessionSkills,
  type SkillListing,
  type Spawner,
  type ToolOutputStore,
  type WorkflowContainerOutcome,
  type WorkflowContainerTarget,
  WorkflowDriver,
  cardBlurb,
  claudeModelNote,
  collapseRepeatedLines,
  createA2AAdapter,
  createClaudeCodeCodec,
  createProcessAdapter,
  createProposedAgent,
  createSubagentRunner,
  createToolOutputStore,
  exemptTools,
  fetchA2ACard,
  inspectProposedAgent,
  isModelShape,
  mergeAgentTypes,
  parseAgentDefinition,
  proposedAgentName,
  proposedAgentsFor,
  redactSecrets,
  reportHeader,
  resolveToolOutputRoot,
  resolveToolOutputTmpRoot,
  runResultHooks,
  spillLargeOutput,
  summarizeLargeOutput,
  summarizeText,
  tabulateJson,
  userRescanListing,
} from "@tentacle/agent";
import {
  type PublishedModels,
  type SkillInfo,
  type TentacleConfig,
  offeredSkills,
  rediscoverSkills,
  refreshSessionContext,
  slashSkills,
  splitFrontmatter,
  toolToggleNotices,
  unknownTypeModelWarnings,
} from "@tentacle/config";
import {
  AgentJobs,
  type ArtifactSink,
  type AttachmentSource,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequester,
  type ScheduleLimits,
  type ToolImageStore,
  browserDefaultOff,
} from "@tentacle/core";
import { BackgroundJobs, HostExecution, killGroup, trackGroup, untrackGroup } from "@tentacle/exec";
import { type ConnectMcpResult, connectMcpServers } from "@tentacle/mcp";
import { HooksTrustParamsSchema } from "@tentacle/protocol";
import { imageFileMaxEdge, imageLimits, imageTokenEstimate } from "@tentacle/providers";
import {
  NOTICES,
  type RunOutcome,
  SKILL_TOOL_NAME,
  type SkillBodyReader,
  ToolRegistry,
  WorkloadShellAborted,
  type WorkloadShellBackend,
  WorkloadShellRefused,
  WorkloadShells,
  builtinTools,
  chartTool,
  createA2AAddAgentTool,
  createAgentControlTool,
  createContextResetTool,
  createFsReadTool,
  createImageViewTool,
  createMoveSessionTool,
  createScheduleControlTool,
  createScheduleCreateTool,
  createSkillActivator,
  createSkillTool,
  createTaskTool,
  createWorkflowTool,
  createWorkloadShellTool,
  diagramTool,
  presentTool,
  shellTool,
  subagentExtraTools,
} from "@tentacle/tools";
import { logDaemonError } from "./daemon-log.ts";
import { createHooksTrustResolver, fileTrustStore } from "./hooks-trust.ts";
import {
  type ProviderFactory,
  configuredModelProvider,
  createModelProviders,
  subagentModelResolver,
  tunnelSubagentResolver,
} from "./model-provider.ts";
import { workflowApprovals } from "./workflow-approvals.ts";
import {
  loadWorkflowSource,
  removeWorkflowFile,
  workflowListing,
  writeWorkflowFiles,
} from "./workflow-files.ts";

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
  /** The background sub-agent runtime (docs/feat/subagent-background.md): one per session, carried across a rebuild. */
  readonly agentJobs: AgentJobs;
  /** The tool registry — MCP tools are registered into it after connecting. */
  readonly tools: ToolRegistry;
  /** The session's approvals (one store for its whole tree); handed over on a rebuild. */
  readonly grants: SessionGrants;
  /** The provider a daemon asks for the session's title (`AgentFactory.titleModel`); absent with `autoTitle` off. */
  readonly titleModel?: ModelProvider;
  /**
   * The session's shells (docs/feat/workload-shell.md D4): present only when
   * this build offered `workload_shell`, and disposed next to `jobs`.
   */
  readonly workloadShells?: { dispose(): Promise<void> };
  /** The workflow driver (docs/feat/agent-workflows.md D3): only with `workflows: true`, never tunnelled. */
  readonly workflows?: WorkflowDriver;
}

/**
 * The `claude` sub-agent type and its harness deps
 * (docs/feat/subagent-harness-runners.md D3/D6): only when `claude-code` is
 * enabled AND its command is on PATH (its version is probed at the first run).
 * The caller gates it on `!tunnelled` (D5).
 */
export function claudeHarness(
  config: TentacleConfig,
  options: NonNullable<BuildAgentOptions["harnesses"]>,
): { readonly deps: HarnessDeps; readonly type: AgentType; readonly note: string } | undefined {
  const h = config.harnesses[CLAUDE_CODE_ID];
  if (h === undefined || h.adapter !== "claude-code" || !h.enabled) {
    return undefined;
  }
  const path = (options.which ?? ((command: string) => Bun.which(command)))(h.command);
  if (path === null) {
    return undefined;
  }
  const adapter = createProcessAdapter({
    id: CLAUDE_CODE_ID,
    command: path,
    codec: createClaudeCodeCodec,
    caps: CLAUDE_CODE_CAPS,
    groups: options.groups ?? { track: trackGroup, untrack: untrackGroup, kill: killGroup },
    ...(options.spawner ? { spawner: options.spawner } : {}),
    defaultTools: CLAUDE_DEFAULT_TOOLS,
  });
  return {
    deps: {
      instances: new Map([
        [
          CLAUDE_CODE_ID,
          {
            adapter,
            model: h.model,
            idleMinutes: h.idleMinutes,
            resumeHint: (handle) => `${h.command} --resume ${handle.id}`,
          },
        ],
      ]),
      cwd: config.cwd,
    },
    type: {
      name: "claude",
      description: CLAUDE_TYPE_DESCRIPTION,
      prompt: "",
      tools: [],
      harness: { adapter: CLAUDE_CODE_ID, mode: "write" },
    },
    note: claudeModelNote(h.model),
  };
}

/** C5: how long the cards' text for the model may take, all cards together. */
export const A2A_CARD_BUDGET_MS = 2_000;

/** Card texts for the model (C5), by instance name: `undefined` = not loaded in time. */
export type A2ACards = ReadonlyMap<string, A2AAgentCard | undefined>;

function a2aEntries(config: TentacleConfig) {
  return Object.entries(config.harnesses).flatMap(([name, h]) =>
    h.adapter === "a2a" && h.enabled ? [{ name, h }] : [],
  );
}

/**
 * Read every enabled `adapter: "a2a"` instance's card for the model's type
 * list (docs/feat/a2a-client.md C5): in parallel, through the adapter's own
 * pinned-origin `fetch` (no token), and for at most `budgetMs` in total. The
 * map returned is a snapshot taken at the deadline: a card that arrives later
 * is not in it. The build freezes it into the `agent_task` text.
 */
export async function prefetchA2ACards(
  config: TentacleConfig,
  opts: {
    readonly fetch?: typeof fetch;
    readonly lookup?: A2ALookup;
    readonly budgetMs?: number;
  } = {},
): Promise<A2ACards> {
  const entries = a2aEntries(config);
  const got = new Map<string, A2AAgentCard>();
  if (entries.length === 0) return got;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve();
    }, opts.budgetMs ?? A2A_CARD_BUDGET_MS);
  });
  const reads = entries.map(async ({ name, h }) => {
    try {
      const card = await fetchA2ACard({
        cardUrl: h.card,
        signal: stop.signal,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
      });
      if (!stop.signal.aborted) got.set(name, card);
    } catch {
      // Unreadable: «(remote card not loaded)»; the probe reads it again at first use.
    }
  });
  await Promise.race([Promise.all(reads), deadline]);
  clearTimeout(timer);
  stop.abort();
  return new Map(entries.map(({ name }) => [name, got.get(name)]));
}

/** A long-lived host's card texts (docs/feat/a2a-client.md, owner decision (c)). */
export interface A2ACardCache {
  /** The snapshot the next build freezes into its `agent_task` text. */
  readonly cards: () => A2ACards;
  /** Read the cards again in the background (one read at a time); the NEXT build sees it. */
  readonly refresh: () => Promise<void>;
}

/**
 * Owner decision (c) for C5: a worker / `serve` awaits this ONCE before its
 * `SessionHost` (≤ the budget, and only when an `a2a` instance is configured:
 * none ⇒ no read, no wait), passes `cards()` into every build and calls
 * `refresh()` after each. A card a refresh cannot read keeps its last text:
 * a transient failure never turns a loaded card back into «not loaded».
 */
export async function startA2ACards(
  config: TentacleConfig,
  opts: Parameters<typeof prefetchA2ACards>[1] = {},
): Promise<A2ACardCache> {
  if (a2aEntries(config).length === 0) {
    const none: A2ACards = new Map();
    return { cards: () => none, refresh: () => Promise.resolve() };
  }
  let current = await prefetchA2ACards(config, opts);
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inFlight ??= prefetchA2ACards(config, opts).then(
      (fresh) => {
        current = new Map([...fresh].map(([name, card]) => [name, card ?? current.get(name)]));
        inFlight = undefined;
      },
      () => {
        inFlight = undefined;
      },
    );
    return inFlight;
  };
  return { cards: () => current, refresh };
}

/**
 * The `a2a:<name>` sub-agent types and their harness instances
 * (docs/feat/a2a-client.md C1/C2/C5): one per enabled `adapter: "a2a"`
 * instance. Each type's text is the owner's description, then the card's text
 * from `cards` (marked remote, one line, capped) — FROZEN here for the
 * session, so the `agent_task` text stays byte-stable. The caller gates it on
 * `!tunnelled` (C8), like `claudeHarness`.
 */
export function a2aHarnesses(
  config: TentacleConfig,
  options: NonNullable<BuildAgentOptions["harnesses"]>,
  notice?: (line: string) => void,
): { readonly instances: ReadonlyMap<string, HarnessInstance>; readonly types: AgentType[] } {
  const instances = new Map<string, HarnessInstance>();
  const types: AgentType[] = [];
  for (const { name, h } of a2aEntries(config)) {
    let adapter: A2AAdapter;
    try {
      adapter = createA2AAdapter({
        name,
        cardUrl: h.card,
        ...(h.tokenCommand !== undefined ? { tokenCommand: h.tokenCommand } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.lookup ? { lookup: options.lookup } : {}),
        ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      });
    } catch (err) {
      notice?.(`harnesses.${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const blurbOf = (card: A2AAgentCard | undefined): string =>
      cardBlurb({
        name,
        ...(h.description !== undefined ? { ownerDescription: h.description } : {}),
        ...(card !== undefined ? { card } : {}),
        origin: adapter.origin,
      });
    const frozenCard = options.a2aCards?.get(name);
    const frozen = blurbOf(frozenCard);
    const header = reportHeader(name, adapter.origin);
    instances.set(adapter.id, {
      adapter,
      idleMinutes: h.idleMinutes,
      inputFrom: h.inputFrom,
      origin: adapter.origin,
      // C5: the security checks read the LIVE card at first use; when its text
      // is not the one the model was shown this session, the report says so.
      reportHeader: () => {
        const live = adapter.card();
        return frozenCard !== undefined && live !== undefined && blurbOf(live) !== frozen
          ? `${header}\n(the remote card changed since this session started)`
          : header;
      },
    });
    types.push({
      name: adapter.id,
      // The type list reads `- <name>: <description>`: the blurb without its name.
      description: frozen.slice(adapter.id.length).replace(/^(?: — |\. )/, ""),
      prompt: "",
      tools: [],
      harness: { adapter: adapter.id, mode: "remote" },
    });
  }
  return { instances, types };
}

/**
 * What the worker hands `SessionHost` for one session. ONE function,
 * so a field cannot be forgotten at the call site: dropping `grants` made
 * `/clear` keep the session's approvals on the default local runtime
 * (docs/feat/clear-keeps-jobs.md, review H1). `tools` stays with the caller
 * (MCP tools are registered into it).
 */
export function workerSessionBuild(wired: WiredAgent) {
  return {
    agent: wired.agent,
    permissions: wired.permissions,
    jobs: wired.jobs,
    agentJobs: wired.agentJobs,
    grants: wired.grants,
    ...(wired.workflows ? { workflows: wired.workflows } : {}),
    // The main thread's config (the laptop's): absent with `autoTitle` off.
    ...(wired.titleModel ? { titleModel: wired.titleModel } : {}),
  };
}

let sharedToolOutput: ToolOutputStore | undefined;

/**
 * This process's ONE spill store (docs/fix/tool-output-location.md): the root
 * is probed once, so every session and sub-agent of this daemon shares the
 * answer. The cache of THIS host: a pod daemon's lives in the pod.
 */
export function toolOutputStore(): ToolOutputStore {
  sharedToolOutput ??= createToolOutputStore(resolveToolOutputRoot(), () =>
    resolveToolOutputTmpRoot(),
  );
  return sharedToolOutput;
}

/**
 * Daemon start: drop spilled files older than `tools.outputRetentionDays`.
 * Fire-and-forget and silent (Ink may own the terminal, AGENTS §7); `<= 0` =
 * never sweep.
 */
export function sweepToolOutput(
  config: Pick<TentacleConfig, "toolOutputRetentionDays">,
  store: ToolOutputStore = toolOutputStore(),
): void {
  void store.sweep(config.toolOutputRetentionDays).catch(() => undefined);
}

/** What `fs_read` says for a spilled file that is gone. */
export function toolOutputGoneHint(retentionDays: number): string {
  const when =
    retentionDays > 0
      ? `it is removed with its session and after ${retentionDays} days`
      : "it is removed with its session";
  return `tool output no longer available (${when}) — re-run the command if you still need it`;
}

export interface BuildAgentOptions {
  /** The spill store; default: this process's `toolOutputStore()`. Tests inject a temp root. */
  readonly toolOutput?: ToolOutputStore;
  /** Replace the configured provider — e.g. a proxy that tunnels model calls
   *  to a remote client (the pod reverse-tunnel, F4.d). Used for the main model
   *  and for every sub-agent the laptop published no model for. The config's
   *  own `models`, `subagents.types` and `selectableModels` are ignored over
   *  the tunnel, so no provider is built in a pod. */
  readonly modelOverride?: ModelProvider;
  /**
   * Over the tunnel: the provider for a name in `config.publishedModels`
   * (docs/feat/models-map-pod.md). The laptop decides whether it serves it.
   */
  readonly namedModelOverride?: (name: string) => ModelProvider;
  /** The title's own override: the pod's tunnel that marks a call as a title one (`purpose: "title"`). */
  readonly titleModelOverride?: ModelProvider;
  /**
   * Reuse this broker instead of a fresh one: several agents behind ONE
   * frontend (one agent per session) must share the broker the TUI
   * installs its prompt on — two brokers silently decouple (AGENTS §7).
   */
  readonly permissions?: PermissionBroker;
  /**
   * A live session's jobs and approvals, instead of fresh ones: its agent is
   * REBUILT by a settings sync (docs/feat/session-settings-apply.md), and its
   * running jobs and the approvals the user gave must carry over.
   */
  readonly jobs?: JobController;
  /** Likewise the background sub-agent runtime: its running children carry over. */
  readonly agentJobs?: AgentJobs;
  readonly grants?: SessionGrants;
  /**
   * Build the session's workflow driver and offer the `workflow` tool
   * (docs/feat/agent-workflows.md D3): the worker and `serve` only. Ignored
   * over a `modelOverride` (a tunnelled pod session never runs one).
   */
  readonly workflows?: true;
  /**
   * Offer the harness sub-agent types (docs/feat/subagent-harness-runners.md
   * D5): the worker and `serve` only, NEVER over a `modelOverride` (a pod never
   * runs another harness — it would act with the pod host's login, and the
   * pod is not trusted). `which` finds the command on PATH (default
   * `Bun.which`); `spawner` / `groups` default to the real ones. Tests inject.
   */
  readonly harnesses?: {
    readonly which?: (command: string) => string | null;
    readonly spawner?: Spawner;
    readonly groups?: ProcessGroups;
    /**
     * The `a2a` instances' cards for the model's type list
     * (docs/feat/a2a-client.md C5), read by `prefetchA2ACards`; frozen into
     * this build's `agent_task` text. Absent → «(remote card not loaded)».
     */
    readonly a2aCards?: A2ACards;
    /** The `a2a` adapters' network and token command (tests inject; default real). */
    readonly fetch?: typeof fetch;
    readonly lookup?: A2ALookup;
    readonly runCommand?: A2ACommandRunner;
  };
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
   * Asks whether to run the project's hooks when a turn brings no RPC peer to
   * ask (a build driven directly, not through `SessionHost`). Absent → project
   * hooks are declined.
   */
  readonly askHooksTrust?: AskHooksTrust;
  /**
   * The daemon's shared skill scan (`createSkillScan`): the session's `/name`
   * set starts from its latest result and its rescans go through it. Absent
   * (a one-shot) → the start-up's discovery, rescans read the folders directly.
   */
  readonly skillScan?: SkillScan;
  /**
   * How the agent's providers are built (main, title, `models` entries). Tests
   * inject a spy; default `createModelProvider`. Unused over a `modelOverride`.
   */
  readonly createProvider?: ProviderFactory;
  /**
   * Where this agent's provider reads an image ref's bytes
   * (docs/feat/attachments-prompt.md D4): the session's `AttachmentStore` when
   * THIS daemon runs the model. Absent → images are never resolvable here (an
   * `images: {source:"client"}` pod, where the laptop holds them, or a daemon
   * with no policy at all).
   */
  readonly attachments?: AttachmentSource;
  /**
   * The session's artifact store (docs/feat/model-artifacts.md D2/D4): set ⇒
   * the agent is offered `present`, writing into it. Every SESSION-hosting
   * build passes `AgentContext.artifacts` (the worker, `serve`, both pod
   * branches); a one-shot or a child agent never does, so they never offer it.
   */
  readonly artifacts?: ArtifactSink;
  /**
   * The session's tool-image store (docs/feat/image-view.md D1): the SAME object
   * as `attachments`, under its write-capable type. Set (and the model has
   * vision) ⇒ `fs_read` keeps a PDF's pictures and `image_view` is offered.
   * Only the worker and `serve` forward it — never a pod daemon, a one-shot or
   * a child: a forgotten hop turns the feature off, never opens a hole.
   */
  readonly toolImages?: ToolImageStore;
  /**
   * Offer this agent `move_session` (docs/feat/session-hop.md D9): the model may
   * PROPOSE moving its session, and nothing more — the laptop asks the owner at
   * the turn's end. Set by the runtimes that own a hoppable session (the local
   * worker, the pod daemon) and never by another kind of build (`serve`,
   * one-shot, a child agent: a proposal nobody would ask about).
   *
   * It is a flag of its own because `BuildAgentOptions` has no daemon KIND
   * (review M5), and this site is shared by every kind of build: a boolean is
   * what keeps the rule "only these two kinds" readable at each call site.
   *
   * A POD daemon sets it only from `AgentContext.hop` — the fact that the client
   * which created the session declared it can put the proposal to its owner
   * (H5 review finding 1): one pod serves `run`, `attach` and a hop target alike,
   * and only the last has a `/move` feed to ask through.
   */
  readonly moveSession?: true;
  /**
   * Offer this agent `workload_shell` (docs/feat/workload-shell.md D3): a
   * stateful, non-interactive `sh` on a workload, opened through this backend.
   *
   * Set ONLY where the daemon runs on the user's own host — the local worker and
   * `serve` — because it reads the user's kubeconfig / docker endpoint there. A
   * POD daemon never sets it: its own `shell` already IS in its workload, and
   * reaching other workloads would need cluster credentials inside the pod
   * (AGENTS §7, "a pod is not trusted").
   */
  /**
   * The session's scheduled wakes (docs/feat/cron-tool.md D1/D2): the LAZY link
   * `AgentContext.schedules` hands the factory. Present → the agent is offered
   * `schedule_create` (asks) and `schedule_control`. The host passes it ONLY
   * where it schedules — `serve` and the local worker; a pod daemon's host has
   * no table, so no link and no tools (owner Q4, AGENTS §7).
   */
  readonly schedules?: (() => import("@tentacle/core").ScheduleLink | null) | undefined;
  readonly workloadShell?:
    | { readonly backend: import("@tentacle/tools").WorkloadShellBackend }
    | undefined;
  /**
   * Offer the read-only `browser_*` tools (docs/feat/browser-inspect.md B4): the
   * daemon's ONE toolset over its hub link. Set ONLY where the daemon runs on
   * the user's own Mac — the worker and `serve` — never a pod daemon (Q1: a pod
   * is not trusted to act as the user on the web) and never a child agent
   * (`subagent.ts`'s filter). The group starts OFF in the session's switches
   * unless `tools.enabled` names it (`browserDefaultOff`).
   */
  readonly browser?: import("@tentacle/tools").BrowserToolset | undefined;
}

/**
 * A host's `schedules.*` config → the core's create limits (docs/feat/cron-tool.md
 * D3, owner Q6). Read from the HOST's own config (never carried): `serve` and the
 * worker pass the result as `SessionHostOptions.schedules.limits`.
 */
export function scheduleLimitsOf(config: TentacleConfig): ScheduleLimits {
  const minute = 60_000;
  const day = 86_400_000;
  return {
    maxJobs: config.schedules.maxJobs,
    minIntervalMs: config.schedules.minIntervalMinutes * minute,
    ttlMs: config.schedules.expiryDays * day,
    maxAheadMs: config.schedules.maxAheadDays * day,
    promptMaxChars: config.schedules.promptMaxChars,
  };
}

/** `agent_task`'s model list over the tunnel: the laptop's selectable names, with their text. */
function publishedOptions(
  published: PublishedModels | undefined,
): { readonly name: string; readonly description?: string }[] {
  return (published?.selectable ?? []).map((name) => {
    const description = published?.models.find((m) => m.name === name)?.description;
    return description !== undefined ? { name, description } : { name };
  });
}

/**
 * A `where: {docker: …}` run step's outcome (docs/feat/agent-workflows.md
 * Slice 5), from the workload seam's own `RunOutcome`. Only the notices that
 * say the command did NOT simply run to its end — killed by the timeout ladder
 * (whose exit code is then 0), a lost stream, a shell the command itself ended —
 * fail the step. A reopened shell (`newShell`, the cwd restore) is information:
 * an idle close between two steps of one run is normal. Information goes into
 * the output, never into the verdict.
 */
export function workflowContainerOutcome(
  outcome: Pick<RunOutcome, "exitCode" | "body" | "notices" | "shellStderr">,
  timeoutMs: number,
): WorkflowContainerOutcome {
  const seconds = Math.round(timeoutMs / 1000);
  const failing = new Set<string>([
    NOTICES.lost,
    NOTICES.shellExited,
    NOTICES.killedSurvived(seconds),
    NOTICES.killedRestarted(seconds),
  ]);
  const notes = outcome.notices.filter((n) => failing.has(n));
  const info = outcome.notices.filter((n) => !failing.has(n));
  const output = [...info, outcome.body, outcome.shellStderr ?? ""]
    .filter((s) => s !== "")
    .join("\n");
  return { exitCode: outcome.exitCode, output, notes };
}

/**
 * A `run` step's APPROVED command and workload, read from the gate's
 * `outcome.input` through the tool's own schema — which is what would validate
 * it in the agent loop, so a rewrite the loop could run is one a step can run.
 * A docker step is approved as the `workload_shell` call it is; a local one as
 * `shell`. A rewrite the schema rejects fails the step closed (never falls back
 * to the file's original: that one was not what the person approved).
 */
export function readApprovedCall(
  parsed:
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly message: string }[] };
      },
):
  | {
      readonly ok: true;
      readonly command?: string;
      readonly target?: WorkflowContainerTarget;
      /** The rewrite NAMED a target that a `run` step cannot express. */
      readonly badTarget?: string;
    }
  | { readonly ok: false; readonly why: string } {
  if (!parsed.success) {
    return { ok: false, why: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const data = parsed.data;
  if (typeof data !== "object" || data === null) {
    return { ok: false, why: "not an object" };
  }
  const record = data as { command?: unknown; target?: unknown };
  const command = typeof record.command === "string" ? record.command : undefined;
  const target = readApprovedTarget(record.target);
  // A rewrite that named a target this step cannot express is refused below:
  // reading it as "no target" would run the FILE's workload instead.
  const badTarget =
    record.target !== undefined && target === undefined ? "not a docker workload" : undefined;
  return {
    ok: true,
    ...(command !== undefined ? { command } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(badTarget !== undefined ? { badTarget } : {}),
  };
}

/** The `workload_shell` target of an approved call, as a `run` step's own. */
function readApprovedTarget(value: unknown): WorkflowContainerTarget | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const target = value as { engine?: unknown; name?: unknown };
  if (typeof target.name !== "string" || target.engine !== "docker") {
    return undefined;
  }
  // No `container`: a docker target has none, and the tool's own schema (which
  // just parsed this) already refuses one.
  return { engine: "docker", name: target.name };
}

export function buildAgent(config: TentacleConfig, options: BuildAgentOptions = {}): WiredAgent {
  const model =
    options.modelOverride ?? configuredModelProvider(config, config.model, options.createProvider);
  const outputs = options.toolOutput ?? toolOutputStore();
  const toolOutput = outputs.forProject(config.cwd);
  const env = new HostExecution({
    cwd: config.cwd,
    root: config.cwd,
    readHint: (abs) =>
      outputs.owns(abs) ? toolOutputGoneHint(config.toolOutputRetentionDays) : undefined,
    // docs/feat/write-tmpdir.md: this daemon's own config (never carried to a pod).
    writableDirs: config.writableDirs ?? [],
  });
  for (const dropped of env.droppedWritableDirs) {
    // Daemon-side, never the terminal while Ink owns it (AGENTS §7).
    (options.notice ?? options.log)?.(
      `tools.writableDirs: ignored ${JSON.stringify(dropped)} (not an absolute dir, or the filesystem root)`,
    );
  }
  // `true` only un-hides: a switch on a feature that is off says so (F3).
  for (const line of toolToggleNotices(config.toolsEnabled ?? {}, {
    subagents: config.subagentsEnabled,
    contextReset: config.contextReset.enabled,
    sessionHop: config.sessionHop.tool,
    workloadShell: config.workloadShell.tool,
  })) {
    (options.notice ?? options.log)?.(line);
  }
  const tools = new ToolRegistry().registerAll(builtinTools);
  const permissions = options.permissions ?? new PermissionBroker();
  // Background jobs let the shell tools launch long-running processes (servers,
  // watchers) without blocking the turn; their exits surface on the next turn.
  const jobs = options.jobs ?? new BackgroundJobs(env);
  // Background SUB-AGENTS share `subagents.maxParallel` with foreground ones
  // (one cap); a reused runtime takes the (possibly changed) cap of this build.
  const agentJobs = options.agentJobs ?? new AgentJobs(config.subagentMaxParallel);
  agentJobs.setCap(config.subagentMaxParallel);
  agentJobs.setTwoWay(config.subagentsTwoWay);
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
  // on `model.contextWindow` (a pod daemon's is the laptop's, carried).
  // Each sub-agent counts its own history on the same window.
  const contextAwareness = config.contextAwareness.enabled
    ? { window: config.contextWindow, stepPercent: config.contextAwareness.stepPercent }
    : undefined;
  // Smart compaction (docs/feat/smart-compaction.md) on the same window; each
  // sub-agent prunes its own history. Off unless `contextPrune.enabled`.
  const contextPrune = config.contextPrune.enabled
    ? {
        window: config.contextWindow,
        pruneAtPercent: config.contextPrune.pruneAtPercent,
        minGainPercent: config.contextPrune.minGainPercent,
        keepRecentRounds: config.contextPrune.keepRecentRounds,
        outputChars: config.contextPrune.pruneOutputChars,
      }
    : undefined;

  // One store of approvals and one ask at a time for this session's whole tree
  // (docs/feat/parallel-agents.md, Design 3). The ONE broker is still the only
  // requester: the lane only orders calls to it.
  const grants = options.grants ?? new SessionGrants();
  let workflows: WorkflowDriver | undefined;
  // The session's container shells, for a run step's `where: {docker: …}`
  // (docs/feat/agent-workflows.md Slice 5): the SAME registry `workload_shell`
  // uses, so a step and a model call share one shell per container, one idle
  // close and one timeout ladder. Built before the driver, which takes it;
  // registered as a tool further down, where every other tool is.
  const containers =
    options.workloadShell !== undefined && config.workloadShell.tool
      ? new WorkloadShells(options.workloadShell.backend)
      : undefined;

  // Sub-agents: when enabled, register the `agent_task` delegation tool. Children
  // inherit the same confined env + permission requester; the runner filters
  // out `agent_task` itself so a sub-agent cannot spawn further sub-agents.
  if (config.subagentsEnabled) {
    // A sub-agent's model (docs/feat/models-map.md): the call's selectable
    // `model` › `subagents.types.<t>.model` › the `agents/*.md` `model` › the
    // main model. Over the model tunnel (a pod) the same pick runs on what the
    // laptop published (docs/feat/models-map-pod.md): this pod's own `models`
    // are ignored, no provider is built here, and no key is touched.
    const tunnelled = options.modelOverride !== undefined;
    // Another agent harness (docs/feat/subagent-harness-runners.md D5): the
    // laptop or a `serve` the user owns, NEVER a pod — no type, no deps there.
    const harness =
      !tunnelled && options.harnesses !== undefined
        ? claudeHarness(config, options.harnesses)
        : undefined;
    // Remote A2A agents (docs/feat/a2a-client.md C8): the same gate, ONE
    // instances map with `claude`'s.
    const remote =
      !tunnelled && options.harnesses !== undefined
        ? a2aHarnesses(config, options.harnesses, options.notice)
        : undefined;
    // Remote agents the model proposes and the owner approves (C11): the same
    // gate — never in a pod. ONE registry per approvals store: a settings
    // rebuild keeps it, `/clear` empties it with the grants.
    const proposed =
      !tunnelled && options.harnesses !== undefined ? proposedAgentsFor(grants) : undefined;
    const harnessDeps: HarnessDeps | undefined =
      harness !== undefined ||
      proposed !== undefined ||
      (remote !== undefined && remote.instances.size > 0)
        ? {
            ...(harness?.deps ?? { cwd: config.cwd }),
            instances: new Map([...(harness?.deps.instances ?? []), ...(remote?.instances ?? [])]),
          }
        : undefined;
    if (tunnelled && Object.values(config.harnesses).some((h) => h.configured)) {
      options.notice?.(
        "harnesses: ignored in a pod — a harness sub-agent runs only on the laptop or a serve you own",
      );
    }
    const agentTypes = mergeAgentTypes(
      [...BUILTIN_AGENT_TYPES, ...(harness ? [harness.type] : []), ...(remote?.types ?? [])],
      loadUserAgentTypes(config.configDir, config.packageAgentDirs).types,
    );
    const published = tunnelled ? config.publishedModels : undefined;
    if (
      tunnelled &&
      (Object.keys(config.subagentModels).length > 0 || config.selectableModels.length > 0)
    ) {
      options.notice?.(
        "models: this pod's own models, subagents.types and selectableModels are ignored; the laptop's published models apply",
      );
    }
    const modelFor = !tunnelled
      ? subagentModelResolver(config, createModelProviders(config, options.createProvider))
      : published && options.namedModelOverride
        ? tunnelSubagentResolver(published, options.namedModelOverride)
        : undefined;
    const runnerDeps: Parameters<typeof createSubagentRunner>[0] = {
      model,
      ...(modelFor ? { modelFor } : {}),
      env,
      tools,
      requestPermission: (req, options) => permissions.request(req, options),
      maxIterations: config.subagentMaxIterations,
      maxTokens: config.subagentMaxTokens,
      types: agentTypes,
      // Owner Q1 (c): `search` belongs to `explore` ALONE. It is not a built-in
      // (that would offer it to the main agent and `general`, which keep
      // `shell`), so the child's own registry is where it is offered.
      extraTools: (type) => subagentExtraTools(type.name),
      resultTransforms,
      ...(hooks ? { hooks } : {}),
      ...(contextAwareness ? { contextAwareness } : {}),
      ...(contextPrune ? { contextPrune } : {}),
      grants,
      // A child's own rounds follow `tools.*` (task 7, owner decision 4).
      toolExecution: config.toolExecution,
      toolOutput,
      // Two-way (docs/feat/agent-message-two-way.md): the ONLY switch — with it
      // off, no runner gets a `notify`, so no child is offered `agent_notify`.
      ...(config.subagentsTwoWay ? { notify: (id, text) => agentJobs.notify(id, text) } : {}),
      // A child follows this session's capability switches LIVE
      // (docs/feat/session-capabilities.md): read at each child round, so
      // `agent` (built below) is always set by the time a child runs.
      capabilities: () => agent.capabilities(),
      ...(harnessDeps ? { harness: harnessDeps } : {}),
      ...(proposed ? { proposed } : {}),
    };
    const { run, types, readOnlyType } = createSubagentRunner(runnerDeps);
    // The types a harness runs (an `agents/*.md` of the same name replaces one):
    // their `model` is the harness's own string, shape-checked only (D3).
    // A remote agent chooses its own model (C5): its types take none.
    const harnessTypeNames = types
      .filter((t) => t.harness !== undefined && t.harness.mode !== "remote")
      .map((t) => t.name);
    const remoteTypeNames = types.filter((t) => t.harness?.mode === "remote").map((t) => t.name);
    if (published) {
      // Said here because only the pod knows its own types (the laptop cannot).
      for (const line of unknownTypeModelWarnings(
        Object.fromEntries(published.types.map((t) => [t.type, t.model])),
        types.map((t) => t.name),
      )) {
        options.notice?.(line);
      }
    }
    tools.register(
      createTaskTool((opts, controls) => run(opts, controls), types, {
        description: config.agentTaskDescription,
        mode: config.subagentExecution,
        readOnlyType,
        background: agentJobs,
        // What the parent reads has to match what the child can do: with
        // `subagents.twoWay` on, a background child may answer with
        // `agent_notify` (docs/feat/agent-message-two-way.md).
        twoWay: config.subagentsTwoWay,
        ...(harness && harnessTypeNames.length > 0
          ? {
              harnessModels: { types: harnessTypeNames, note: harness.note, isModel: isModelShape },
            }
          : {}),
        ...(remoteTypeNames.length > 0 ? { remoteTypes: remoteTypeNames } : {}),
        ...(proposed ? { proposedTypes: (name: string) => proposed.get(name) !== undefined } : {}),
        models: tunnelled
          ? publishedOptions(published)
          : config.selectableModels.map((name) => {
              const description = config.models[name]?.description;
              return description !== undefined ? { name, description } : { name };
            }),
      }),
    );
    if (proposed !== undefined) {
      const net = options.harnesses;
      const typeNames = new Set([
        ...types.map((t) => t.name),
        ...Object.keys(config.harnesses).map((name) => `a2a:${name}`),
      ]);
      tools.register(
        createA2AAddAgentTool({
          inspect: (cardUrl, signal) =>
            inspectProposedAgent(cardUrl, {
              signal,
              ...(net?.fetch ? { fetch: net.fetch } : {}),
              ...(net?.lookup ? { lookup: net.lookup } : {}),
            }),
          existing: (origin) => {
            const agent = proposed.forOrigin(origin);
            return agent && { type: agent.type.name, summary: agent.summary };
          },
          register: (checked) => {
            const agent = createProposedAgent({
              name: proposedAgentName(
                checked.host,
                (t) => typeNames.has(t) || proposed.get(t) !== undefined,
              ),
              checked,
              ...(net?.fetch ? { fetch: net.fetch } : {}),
              ...(net?.lookup ? { lookup: net.lookup } : {}),
            });
            proposed.add(agent);
            return { type: agent.type.name, summary: agent.summary };
          },
          // The add ask goes to the session's ONE broker (AGENTS §7).
          ask: (req, opts) => permissions.request(req, opts),
        }),
      );
    }
    // The model's ONE handle on a child it launched (docs/feat/agent-status.md,
    // "Merge into agent_control"): see it (`status`, read-only), write to it
    // (`message`) or stop it (`kill`). Registered only here, where `background`
    // is offered: without the runtime no child has an id to name. One tool, not
    // three, keeps each request's tool definitions ~1000 chars shorter.
    tools.register(createAgentControlTool(agentJobs, { twoWay: config.subagentsTwoWay }));
    // The two tool identities a `run` step's command is approved AS: a local
    // step asks like `shell`, a `docker` step like `workload_shell` (the
    // per-workload rule lives in the grants store only there). Only where the
    // container registry exists: without it the driver gets no `execOn` and
    // fails a docker step before any ask.
    const portWorkloads =
      containers !== undefined ? createWorkloadShellTool(containers) : undefined;
    // Workflows (docs/feat/agent-workflows.md D3): only where the caller asks
    // (the worker and `serve`) and NEVER tunnelled — a pod session's asks and
    // approvals are not the laptop's to keep (AGENTS §7). Same runner deps, the
    // step's requester as the asker (drift 2), the session's ONE broker below it.
    if (options.workflows === true && !tunnelled) {
      const gate = (requester: PermissionRequester) => new PermissionGate(requester, hooks, grants);
      workflows = new WorkflowDriver({
        load: async (name) => loadWorkflowSource(config.cwd, name),
        list: async () => workflowListing(config.cwd),
        // The ONE writer (docs/feat/workflow-editor.md D4), inside this block and
        // nowhere else: a `serve`/worker session can edit its own files, a pod
        // session (`tunnelled`) never gets it and answers `unavailable`. It
        // writes and nothing more — it never reaches the approval store.
        save: (plan, currentHash) => writeWorkflowFiles(config.cwd, plan, currentHash),
        // The ONE remover, beside the writer and for the same sessions only
        // (docs/feat/mobile-workflows-landing.md D3).
        remove: (name, expected, currentHash) =>
          removeWorkflowFile(config.cwd, name, expected, currentHash),
        context: () => ({
          models: Object.keys(config.models),
          agentTypes: types.map((t) => t.name),
          harnessTypes: harnessTypeNames,
        }),
        approvals: workflowApprovals(config.configDir, config.cwd),
        request: (req, opts) => permissions.request(req, opts),
        runnerFor: (requester) =>
          createSubagentRunner({ ...runnerDeps, requestPermission: requester }).run,
        commands: {
          authorize: async (command, requester, call) => {
            // A `docker` step is approved as the `workload_shell` call it IS: the
            // rule it can remember is keyed per workload (D6/session-grants), so
            // an "always" in one container never covers another.
            if (call.target !== undefined && portWorkloads === undefined) {
              return { allowed: false, reason: "no container backend in this session" };
            }
            const tool = call.target !== undefined && portWorkloads ? portWorkloads : shellTool;
            const input =
              call.target !== undefined
                ? { action: "run", target: call.target, command }
                : { command };
            const outcome = await gate(requester).authorize(tool, input, {
              sessionId: "",
              toolCallId: call.toolCallId,
              signal: call.signal,
            });
            if (!outcome.allowed) {
              return {
                allowed: false,
                reason: `not allowed${outcome.message !== undefined ? `: ${outcome.message}` : outcome.reason !== undefined ? `: ${outcome.reason}` : ""}`,
              };
            }
            // What the step runs is what was APPROVED: a `tool_call` hook may
            // rewrite the input (`effective = verdict.input`, and the ask shows
            // exactly that), and the agent loop runs `outcome.input` — so a
            // rewrite of the command or of the target must reach the step, or a
            // hook turning `rm -rf /work` into `echo blocked` would show the
            // safe form and run the dangerous one.
            const approved = readApprovedCall(tool.inputSchema.safeParse(outcome.input));
            if (!approved.ok) {
              return {
                allowed: false,
                reason: `the approved ${tool.name} input is unusable: ${approved.why}`,
              };
            }
            // No fallback to the file's own command: a rewrite that dropped it
            // approved something else, and running the original would be exactly
            // the mismatch this guards against. `workload_shell`'s own schema
            // allows an absent `command` (its other actions need none).
            if (approved.command === undefined) {
              return {
                allowed: false,
                reason: `the approved ${tool.name} input names no command`,
              };
            }
            if (approved.badTarget !== undefined) {
              return {
                allowed: false,
                reason: `the approved ${tool.name} target is unusable for a run step: ${approved.badTarget}`,
              };
            }
            return {
              allowed: true,
              command: approved.command,
              ...(approved.target !== undefined ? { target: approved.target } : {}),
            };
          },
          exec: (command, { signal, timeoutMs }) =>
            env.exec(command, { signal, timeoutMs, cwd: config.cwd }),
          // A `where: {docker: …}` step runs in the container through the SAME
          // registry `workload_shell` uses (one shell per target, one idle close,
          // one timeout ladder), so a step and a model call cannot disagree about
          // what is open where.
          ...(containers !== undefined
            ? {
                execOn: async (
                  target: WorkflowContainerTarget,
                  command: string,
                  { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
                ) => {
                  try {
                    const outcome = await containers.run(target, command, { signal, timeoutMs });
                    return workflowContainerOutcome(outcome, timeoutMs);
                  } catch (error) {
                    // The seam's own sentence is the step's reason: a refusal,
                    // the abort's notices, or the backend's explanation of a
                    // dial failure (no container, a stopped one, no /bin/sh).
                    if (error instanceof WorkloadShellRefused) throw error;
                    if (error instanceof WorkloadShellAborted) {
                      throw new Error(["aborted", ...error.notices].join(" "));
                    }
                    throw await containers.explain(error, target);
                  }
                },
              }
            : {}),
        },
        slots: { acquire: (description) => agentJobs.acquire(description) },
      });
      tools.register(createWorkflowTool(workflows));
    }
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
  // The model's chart (docs/feat/model-charts.md D3): a spec that rides the tool
  // call's own arguments, so every client draws it inline with no wire change
  // and no `artifacts` sink. Offered in every session-hosting build beside
  // `context_reset`; never to a child agent (its steps are not transcript rows —
  // `subagent.ts`'s "never a child" list, pinned by T2.5).
  tools.register(chartTool);
  // The model's Mermaid diagram (docs/feat/model-diagrams.md D2): chart's path —
  // the source rides the call's arguments; mermaid parses it daemon-side, loaded
  // on first use. Same scope as `chart`: every session-hosting build, never a child.
  tools.register(diagramTool);
  // Session hop (docs/feat/session-hop.md D9): the model's ONE way to ask for
  // its session to move. It has no daemon-side effect at all — the laptop watches
  // the turn's events and asks the owner at its end — so `serve`, one-shot and
  // child-agent builds pass no `moveSession` and never offer it
  // (nobody would ask, and a pod's own claim must never be enough).
  if (options.moveSession === true && config.sessionHop.tool) {
    tools.register(createMoveSessionTool());
  }
  // `present` (docs/feat/model-artifacts.md D2): only where a session store
  // exists to receive it. A sub-agent's registry drops it by name (subagent.ts).
  if (options.artifacts) {
    tools.register(presentTool);
  }
  // `image_view` (docs/feat/image-view.md D1/D5): the session's write handle AND
  // a model that takes images. `fs_read` becomes its image variant (one more
  // sentence; it keeps pictures only when its context carries the store).
  const imageLimitValues = imageLimits(config.provider, config);
  const toolImages =
    options.toolImages !== undefined && imageLimitValues.vision ? options.toolImages : undefined;
  if (toolImages !== undefined) {
    // An image FILE read (docs/feat/image-files.md D2): the model's own byte cap
    // and Q1's side bound, both from the same two places the providers use.
    tools.replace(
      "fs_read",
      createFsReadTool({
        images: true,
        maxImageBytes: imageLimitValues.maxBytes,
        maxEdge: imageFileMaxEdge(config.provider),
      }),
    );
    tools.register(createImageViewTool(config.imageDetail ?? "auto"));
  }
  // `workload_shell` (docs/feat/workload-shell.md D3): a stateful, non-interactive
  // `sh` reached through the LAPTOP's engine credentials. Offered only when the
  // caller passes a backend — the local worker and `serve`; never a pod daemon
  // (its own `shell` is already in its workload, and it may not hold cluster
  // credentials: AGENTS §7) — AND the host's owner has switched it on
  // (`workloadShell.tool`, off by default: docs/fix/workload-shell-live.md,
  // owner decision 1). The registry is session-owned and disposed beside `jobs`.
  if (containers !== undefined) {
    tools.register(createWorkloadShellTool(containers));
  }
  // The browser tools (docs/feat/browser-inspect.md B4): registered with this
  // model's image limits (a shot is stored like `image_view`'s pictures), and
  // switched off below unless the user's `tools.enabled` turns them on.
  if (options.browser !== undefined) {
    for (const tool of options.browser.tools({
      maxEdge: imageFileMaxEdge(config.provider),
      maxImageBytes: imageLimitValues.maxBytes,
      // B5: an acting tool asks `browser_action` through the session's ONE
      // broker — the same one the agent's gate uses (AGENTS §7 single broker).
      ask: (req, opts) => permissions.request(req, opts),
    })) {
      tools.register(tool);
    }
  }
  const disabledTools =
    options.browser !== undefined
      ? [
          ...new Set([
            ...(config.disabledTools ?? []),
            ...browserDefaultOff(config.toolsEnabled ?? {}),
          ]),
        ].sort()
      : (config.disabledTools ?? []);
  // Scheduled wakes (docs/feat/cron-tool.md D1/D2): only with the host's link —
  // `serve` and the worker. Never a pod daemon (no link), never a child agent
  // (`subagent.ts`'s filter). The link is looked up per call: the table is the
  // SESSION's, so a settings sync that rebuilds this agent keeps it.
  if (options.schedules !== undefined) {
    tools.register(createScheduleCreateTool(options.schedules));
    tools.register(createScheduleControlTool(options.schedules));
  }

  const agent = new Agent({
    model,
    // The id this provider was built for, when THIS process knows it: a pod's
    // main model is a tunnel to the laptop's (AGENTS §7), so a tunnelled agent
    // leaves it out and nobody invents one (docs/feat/subagent-panel.md, M2).
    ...(options.modelOverride === undefined ? { modelId: config.model } : {}),
    tools,
    env,
    jobs,
    agentJobs,
    // The session's bytes, where this side holds them (docs/feat/attachments-prompt.md D4).
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(toolImages !== undefined ? { toolImages } : {}),
    // The per-provider image cost of the loop's own counter (docs/feat/image-view.md D7).
    imageTokens: imageTokenEstimate(config.provider, config.imageTokens),
    resultTransforms,
    toolOutput,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
    requestPermission: (req, options) => permissions.request(req, options),
    ...(userSkills.activator ? { skills: userSkills.activator } : {}),
    skillListing,
    rescanSkills,
    ...(hooks ? { hooks } : {}),
    ...(options.askHooksTrust ? { askHooksTrust: options.askHooksTrust } : {}),
    ...(contextAwareness ? { contextAwareness } : {}),
    ...(contextPrune ? { contextPrune } : {}),
    ...(contextReset ? { contextReset } : {}),
    grants,
    toolExecution: config.toolExecution,
    subagentExecution: {
      mode: config.subagentExecution,
      // The user's ceiling, exactly: no server is asked for slots (owner 2026-11-08).
      maxParallel: config.subagentMaxParallel,
    },
    // `tools.enabled` seeds the state in ONE place, for every runtime (plain and
    // one-shot included): a hosted session starts from it (docs/feat/tool-toggles.md D4).
    capabilities: { ...NO_CAPABILITIES, disabledTools },
  });
  // Names the session after its first exchange (docs/feat/session-titles.md),
  // only with `model.autoTitle` (opt-in; off → no title model, no call):
  // `model.titleModel` on the same endpoint, else the main model. Over the pod
  // model tunnel the title tunnel answers — the laptop picks its model.
  const titleModel = config.autoTitle
    ? (options.titleModelOverride ??
      options.modelOverride ??
      (config.titleModel !== undefined
        ? configuredModelProvider(config, config.titleModel, options.createProvider)
        : model))
    : undefined;
  return {
    agent,
    permissions,
    jobs,
    agentJobs,
    tools,
    grants,
    ...(titleModel ? { titleModel } : {}),
    ...(containers !== undefined ? { workloadShells: containers } : {}),
    ...(workflows !== undefined ? { workflows } : {}),
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

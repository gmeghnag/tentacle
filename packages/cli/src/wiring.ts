/**
 * Builds a fully-wired `Agent` from a resolved `HarnessConfig`: OpenAI-compatible
 * model, host execution (writes confined to the workspace), the built-in tool-set,
 * and a `PermissionBroker` whose requester the frontend can attach at runtime.
 * Shared by the one-shot and interactive entry points.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Agent,
  type AgentType,
  BUILTIN_AGENT_TYPES,
  type ResultTransform,
  collapseRepeatedLines,
  createSubagentRunner,
  mergeAgentTypes,
  parseAgentDefinition,
  redactSecrets,
  spillLargeOutput,
  summarizeLargeOutput,
  summarizeText,
  tabulateJson,
} from "@agent-harness/agent";
import type { HarnessConfig } from "@agent-harness/config";
import { type JobController, PermissionBroker } from "@agent-harness/core";
import { BackgroundJobs, HostExecution } from "@agent-harness/exec";
import { type ConnectMcpResult, connectMcpServers } from "@agent-harness/mcp";
import { OpenAIProvider } from "@agent-harness/providers";
import { ToolRegistry, builtinTools, createTaskTool } from "@agent-harness/tools";

/** Load user-defined agent types from `<configDir>/agents/*.md` (missing dir → none). */
function loadUserAgentTypes(configDir: string): AgentType[] {
  const dir = join(configDir, "agents");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const types: AgentType[] = [];
  for (const file of entries.sort()) {
    try {
      const text = readFileSync(join(dir, file), "utf8");
      types.push(parseAgentDefinition(text, file.replace(/\.md$/, "")));
    } catch {
      // Skip an unreadable definition rather than failing startup.
    }
  }
  return types;
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

export function buildAgent(config: HarnessConfig): WiredAgent {
  const model = new OpenAIProvider({
    baseURL: config.baseURL,
    model: config.model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
  const env = new HostExecution({ cwd: config.cwd, root: config.cwd });
  const tools = new ToolRegistry().registerAll(builtinTools);
  const permissions = new PermissionBroker();
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
  const resultTransforms: ResultTransform[] = [
    ...(config.redactSecrets ? [redactSecrets()] : []),
    ...(config.dedupOutput ? [collapseRepeatedLines()] : []),
    ...(config.tabulateJson ? [tabulateJson()] : []),
    largeOutput,
  ];

  // Sub-agents: when enabled, register the `task` delegation tool. Children
  // inherit the same confined env + permission requester; the runner filters
  // out `task` itself so a sub-agent cannot spawn further sub-agents.
  if (config.subagentsEnabled) {
    const agentTypes = mergeAgentTypes(BUILTIN_AGENT_TYPES, loadUserAgentTypes(config.configDir));
    const { run, types } = createSubagentRunner({
      model,
      // Per-type model override: same endpoint, a different model id.
      modelFor: (modelId) =>
        new OpenAIProvider({
          baseURL: config.baseURL,
          model: modelId,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        }),
      env,
      tools,
      requestPermission: (req) => permissions.request(req),
      maxIterations: config.subagentMaxIterations,
      types: agentTypes,
      resultTransforms,
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
  });
  return { agent, permissions, jobs, tools };
}

/**
 * Connect the configured MCP servers and register their tools into `tools`.
 * Returns a handle to dispose the server subprocesses, plus any per-server
 * connection errors (a broken server is skipped, not fatal). A no-op when no
 * servers are configured.
 */
export async function connectConfiguredMcp(
  config: HarnessConfig,
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

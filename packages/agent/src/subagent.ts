/**
 * Sub-agents: delegating a self-contained task to a child `Agent` with its own
 * isolated conversation. The child runs to completion and only its final report
 * (its visible output) is returned to the parent — the parent's context is never
 * polluted by the child's intermediate steps.
 *
 * The child inherits the parent's model, confined execution environment, and
 * permission requester (so writes stay confined and approval prompts still reach
 * the user). Its tool-set is restricted by the chosen agent *type*, and the
 * spawn tool itself is always removed from the child (depth-1 guard — no runaway
 * recursion). This module builds the child; the `agent_task` tool (in
 * `@tentacle/tools`) is the model-facing surface that calls it.
 */
import {
  type ExecutionEnvironment,
  type ModelProvider,
  type PermissionRequester,
  type ToolProgressEvent,
  toolLabel,
} from "@tentacle/core";
import { CONTEXT_RESET_TOOL_NAME, ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentConfig, type AgentStopReason } from "./agent.ts";
import type { HookRunner } from "./hooks.ts";
import type { ResultTransform } from "./result-pipeline.ts";
import { classOf, isReadClass } from "./round-plan.ts";
import { SessionGrants } from "./session-grants.ts";

/** A kind of sub-agent: its system prompt and the tools it may use. */
export interface AgentType {
  readonly name: string;
  /** When to use it — shown to the model in the `agent_task` tool description. */
  readonly description: string;
  readonly prompt: string;
  /** Tool names the child may use; `"all"` = every parent tool (minus the spawn tool). */
  readonly tools: "all" | readonly string[];
  /** Optional model id override; resolved via `SubagentDeps.modelFor`. */
  readonly model?: string;
  /**
   * That model's context window (tokens), for the child's context line
   * (docs/feat/context-awareness.md). Absent → the parent's window.
   */
  readonly contextWindow?: number;
}

const GENERAL_PROMPT = `You are an autonomous sub-agent working on a focused task delegated by a
parent agent. Work independently to complete it end to end using the tools
available, then finish with a concise report of what you found or did — that
report is the ONLY thing the parent receives, so make it self-contained.`;

const EXPLORE_PROMPT = `You are a read-only investigator sub-agent. Search and read files to answer
the task; you cannot modify anything. Finish with a concise, self-contained
report of your findings, citing concrete file paths and line references — that
report is the only thing the parent receives.`;

/** The built-in sub-agent types. */
export const BUILTIN_AGENT_TYPES: readonly AgentType[] = [
  {
    name: "general-purpose",
    description:
      "General autonomous agent for multi-step tasks and open-ended work. Has the full tool-set.",
    prompt: GENERAL_PROMPT,
    tools: "all",
  },
  {
    name: "explore",
    description:
      "Read-only investigator: searches and reads files to answer a question. Cannot modify anything.",
    prompt: EXPLORE_PROMPT,
    tools: ["fs_read"],
  },
];

export interface SubagentRunOptions {
  readonly description: string;
  readonly prompt: string;
  /** The agent type name; falls back to the first type if unknown. */
  readonly type: string;
}

export interface SubagentResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: AgentStopReason;
}

export interface SubagentRunControls {
  readonly signal?: AbortSignal;
  /** Live progress sink (start, each child tool call, end). */
  readonly onEvent?: (event: ToolProgressEvent) => void;
  /** The parent's `agent_task` call id: the child's permission asks are attributed to it. */
  readonly toolCallId?: string;
  /**
   * The parent's session id: the child's spilled output is filed under it, so
   * it goes with the session (docs/fix/tool-output-location.md). Absent → the
   * child's throwaway id.
   */
  readonly sessionId?: string;
}

/**
 * A child's requester: the parent's, with each ask attributed to the parent's
 * `agent_task` call (`parentCallId`) and tagged with the asking sub-agent.
 * These fields WIN over the child gate's own: the child's call ids are unknown
 * to the parent history, so one must never escape — without a parent id the
 * ask carries no `toolCallId` at all.
 */
export function subagentRequester(
  requester: PermissionRequester,
  parentCallId: string | undefined,
  agent: { readonly type: string; readonly description: string },
): PermissionRequester {
  return (req, options) => {
    // A child's call ids are unknown to the parent history: never forwarded.
    const { toolCallId: _childCallId, groupStart: _childGroup, ...rest } = options ?? {};
    return requester(req, {
      ...rest,
      ...(parentCallId !== undefined ? { toolCallId: parentCallId } : {}),
      origin: "subagent",
      agent,
    });
  };
}

export type SubagentRunner = (
  opts: SubagentRunOptions,
  controls?: SubagentRunControls,
) => Promise<SubagentResult>;

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** A short label for a child tool call, for the nested progress tree. */
export function childToolLabel(name: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    return name;
  }
  const obj = asRecord(parsed);
  const str = (key: string): string | undefined =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;
  switch (name) {
    case "shell":
      return `$ ${str("command") ?? ""}`.trimEnd();
    case "fs_read":
      return `Read ${str("path") ?? ""}`.trimEnd();
    case "fs_write":
      return `Write ${str("path") ?? ""}`.trimEnd();
    case "fs_edit":
      return `Edit ${str("path") ?? ""}`.trimEnd();
    default:
      return toolLabel(name);
  }
}

export interface SubagentDeps {
  readonly model: ModelProvider;
  /** Build a provider for a type's `model` override; falls back to `model`. */
  readonly modelFor?: (modelId: string) => ModelProvider;
  readonly env: ExecutionEnvironment;
  /** The parent's registry; a child gets a filtered subset, never the spawn tool. */
  readonly tools: ToolRegistry;
  readonly requestPermission?: PermissionRequester;
  readonly maxIterations?: number;
  readonly types?: readonly AgentType[];
  /** The spawn tool's name, always excluded from children (default `agent_task`). */
  readonly spawnToolName?: string;
  /** Result transforms (e.g. spill large output) given to each child agent. */
  readonly resultTransforms?: readonly ResultTransform[];
  /** The parent's hook runner; each child gets one tagged with its identity (H2). */
  readonly hooks?: HookRunner;
  /** Each child's own context lines over its own history (the parent's window). */
  readonly contextAwareness?: AgentConfig["contextAwareness"];
  /**
   * The session tree's approvals and ask lane: one "always" covers the parent
   * and every child (docs/feat/parallel-agents.md, Design 3). Absent → one
   * store shared by this runner's children.
   */
  readonly grants?: SessionGrants;
  /**
   * `tools.execution` / `tools.maxParallel` for each child's own rounds. Safe:
   * a child's asks stay in its own phase 1 and it never reaches a `beforeRun`;
   * the parent's `inFlight` already covers it (docs/feat/parallel-agents.md,
   * Design 5). Absent → sequential.
   */
  readonly toolExecution?: AgentConfig["toolExecution"];
  /** Where a child's large output is spilled (the parent's sink). Absent → the child's `env`. */
  readonly toolOutput?: AgentConfig["toolOutput"];
}

/** Build a sub-agent runner plus the agent types it exposes. */
export function createSubagentRunner(deps: SubagentDeps): {
  run: SubagentRunner;
  types: readonly AgentType[];
  /**
   * Whether a type only reads: a closed list, every tool the registry has is
   * read-class. Asked live: MCP tools register after the runner is built.
   */
  readOnlyType(name: string): boolean;
} {
  const types = deps.types && deps.types.length > 0 ? deps.types : BUILTIN_AGENT_TYPES;
  const spawnToolName = deps.spawnToolName ?? "agent_task";
  const grants = deps.grants ?? new SessionGrants();

  const run: SubagentRunner = async (opts, controls) => {
    const type = types.find((t) => t.name === opts.type) ?? types[0];
    if (!type) {
      return { report: "no sub-agent type available", toolUses: 0, stopReason: "end_turn" };
    }
    const onEvent = controls?.onEvent;
    onEvent?.({ kind: "subagent_start", agentType: type.name, description: opts.description });

    // Restrict the child's tools to the type's allow-list, always dropping the
    // spawn tool so a sub-agent cannot spawn its own sub-agents.
    const childTools = new ToolRegistry();
    for (const tool of deps.tools.list()) {
      // Nor its context reset: a child's context is its own, and short-lived.
      if (tool.name === spawnToolName || tool.name === CONTEXT_RESET_TOOL_NAME) {
        continue;
      }
      if (type.tools === "all" || type.tools.includes(tool.name)) {
        childTools.register(tool);
      }
    }

    const model = type.model && deps.modelFor ? deps.modelFor(type.model) : deps.model;
    // The child counts against its own model's window when the type names one.
    const contextAwareness =
      deps.contextAwareness && type.contextWindow !== undefined
        ? { ...deps.contextAwareness, window: type.contextWindow }
        : deps.contextAwareness;
    const child = new Agent({
      model,
      tools: childTools,
      env: deps.env,
      systemPrompt: type.prompt,
      ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
      ...(deps.requestPermission
        ? {
            requestPermission: subagentRequester(deps.requestPermission, controls?.toolCallId, {
              type: type.name,
              description: opts.description,
            }),
          }
        : {}),
      grants,
      // A server may reuse call ids: two children must not share a spill file.
      spillScope: crypto.randomUUID().slice(0, 8),
      ...(deps.toolOutput
        ? {
            toolOutput: {
              // Under the PARENT's session when known: deleting it deletes this.
              write: (sid: string, tool: string, id: string, contents: string) =>
                deps.toolOutput?.write(controls?.sessionId ?? sid, tool, id, contents) ??
                Promise.resolve(null),
            },
          }
        : {}),
      ...(deps.toolExecution ? { toolExecution: deps.toolExecution } : {}),
      ...(deps.resultTransforms ? { resultTransforms: deps.resultTransforms } : {}),
      ...(contextAwareness ? { contextAwareness } : {}),
      ...(deps.hooks
        ? {
            hooks: deps.hooks.forAgent(
              { type: type.name, description: opts.description },
              type.model,
            ),
          }
        : {}),
    });

    let report = "";
    let toolUses = 0;
    let stopReason: AgentStopReason = "end_turn";
    try {
      for await (const event of child.run(
        crypto.randomUUID(),
        [{ role: "user", content: opts.prompt }],
        controls?.signal,
      )) {
        if (event.type === "text") {
          report += event.delta;
        } else if (event.type === "tool_start") {
          toolUses += 1;
          onEvent?.({ kind: "subagent_tool", label: childToolLabel(event.name, event.arguments) });
        } else if (event.type === "usage") {
          onEvent?.({
            kind: "subagent_usage",
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
          });
        } else if (event.type === "turn_end") {
          stopReason = event.reason;
        }
      }
    } catch (error) {
      // The tree must not keep its live row beside the call's error.
      onEvent?.({ kind: "subagent_end", toolUses, stopReason: "error" });
      throw error;
    }
    onEvent?.({ kind: "subagent_end", toolUses, stopReason });
    // Never hand the parent an empty report (the agent loop forces a final
    // summary even at the step limit, but a provider hiccup could still yield
    // nothing): a note explaining what happened beats silent emptiness.
    const trimmed = report.trim();
    const finalReport =
      trimmed !== ""
        ? trimmed
        : `(The ${type.name} sub-agent finished (${stopReason}) after ${toolUses} tool use(s) without producing a report. Try a narrower task or a higher step limit.)`;
    return { report: finalReport, toolUses, stopReason };
  };

  const readOnlyType = (name: string): boolean => {
    const type = types.find((t) => t.name === name);
    if (!type || type.tools === "all") {
      return false;
    }
    return type.tools.every((toolName) => {
      // Never given to a child, so they make it no less read-only.
      if (toolName === spawnToolName || toolName === CONTEXT_RESET_TOOL_NAME) {
        return true;
      }
      const tool = deps.tools.get(toolName);
      // The probe gives a path-keyed tool its key; other tools ignore it.
      return tool === undefined || isReadClass(classOf(tool, { path: "_" }));
    });
  };

  return { run, types, readOnlyType };
}

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
 * recursion). This module builds the child; the `task` tool (in
 * `@tentacle/tools`) is the model-facing surface that calls it.
 */
import type {
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequester,
  ToolProgressEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentStopReason } from "./agent.ts";
import type { ResultTransform } from "./result-pipeline.ts";

/** A kind of sub-agent: its system prompt and the tools it may use. */
export interface AgentType {
  readonly name: string;
  /** When to use it — shown to the model in the `task` tool description. */
  readonly description: string;
  readonly prompt: string;
  /** Tool names the child may use; `"all"` = every parent tool (minus the spawn tool). */
  readonly tools: "all" | readonly string[];
  /** Optional model id override; resolved via `SubagentDeps.modelFor`. */
  readonly model?: string;
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
      return name;
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
  /** The spawn tool's name, always excluded from children (default `task`). */
  readonly spawnToolName?: string;
  /** Result transforms (e.g. spill large output) given to each child agent. */
  readonly resultTransforms?: readonly ResultTransform[];
}

/** Build a sub-agent runner plus the agent types it exposes. */
export function createSubagentRunner(deps: SubagentDeps): {
  run: SubagentRunner;
  types: readonly AgentType[];
} {
  const types = deps.types && deps.types.length > 0 ? deps.types : BUILTIN_AGENT_TYPES;
  const spawnToolName = deps.spawnToolName ?? "task";

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
      if (tool.name === spawnToolName) {
        continue;
      }
      if (type.tools === "all" || type.tools.includes(tool.name)) {
        childTools.register(tool);
      }
    }

    const model = type.model && deps.modelFor ? deps.modelFor(type.model) : deps.model;
    const child = new Agent({
      model,
      tools: childTools,
      env: deps.env,
      systemPrompt: type.prompt,
      ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
      ...(deps.requestPermission ? { requestPermission: deps.requestPermission } : {}),
      ...(deps.resultTransforms ? { resultTransforms: deps.resultTransforms } : {}),
    });

    let report = "";
    let toolUses = 0;
    let stopReason: AgentStopReason = "end_turn";
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
      } else if (event.type === "turn_end") {
        stopReason = event.reason;
      }
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

  return { run, types };
}

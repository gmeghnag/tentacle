/**
 * The `agent_task` tool — the model-facing surface for delegating to a sub-agent.
 *
 * It owns no agent logic: a runner (built in the wiring layer, where the model
 * and registry live) is injected, so this package stays free of a dependency on
 * `@tentacle/agent`. The tool itself needs no permission — spawning is
 * safe; the child's own tools enforce their permissions and confinement.
 */
import type { AgentJobs, SpawnKind, Tool, ToolProgressEvent, ToolResult } from "@tentacle/core";
import { z } from "zod";

export interface TaskRunResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: string;
}

export interface TaskRunControls {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ToolProgressEvent) => void;
  /** This `agent_task` call's id: the sub-agent's permission asks are attributed to it. */
  readonly toolCallId?: string;
  /** The calling session's id: the sub-agent's spilled output is filed under it. */
  readonly sessionId?: string;
  /** Set on a BACKGROUND child: its `sa-N` id. Its permission asks are attributed to it. */
  readonly agentId?: string;
}

export type TaskRunner = (
  /** `model`: the call's requested `models` name, already checked against the list. */
  opts: { description: string; prompt: string; type: string; model?: string },
  controls?: TaskRunControls,
) => Promise<TaskRunResult>;

export interface TaskAgentType {
  readonly name: string;
  readonly description: string;
}

/** A model the agent may pick (`subagents.selectableModels`, docs/feat/models-map.md). */
export interface TaskModelOption {
  readonly name: string;
  readonly description?: string;
}

/** `subagents.execution`: how a round's `agent_task` calls may overlap. */
export type TaskExecutionMode = "sequential" | "read-only" | "parallel";

export interface TaskToolOptions {
  /** Whether a sub-agent type only reads (asked live). Absent → every type is a writer. */
  readonly readOnlyType?: (name: string) => boolean;
  /** `subagents.agentTaskDescription`: used as is, in every mode. Absent → the neutral text. */
  readonly description?: string | undefined;
  /** What the neutral text states about overlap. Absent → nothing, as `sequential`. */
  readonly mode?: TaskExecutionMode;
  /**
   * `subagents.selectableModels` with their descriptions. Absent or empty → no
   * `model` argument, and the tool is exactly what it was without `models`.
   */
  readonly models?: readonly TaskModelOption[];
  /**
   * The background runtime (docs/feat/subagent-background.md). Present → the
   * tool offers `background` and every child, foreground or background, takes
   * a slot of its ONE cap (`subagents.maxParallel`). Absent → neither.
   */
  readonly background?: AgentJobs;
}

const NEUTRAL_DESCRIPTION =
  "Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so use it to explore or offload work without filling your own context. Prefer it for open-ended search and read-heavy investigation.";

const OVERLAP_NOTE: Record<TaskExecutionMode, string> = {
  parallel:
    " Several agent_task calls in one message may run at the same time. They share one workspace: give each its own files, and do not have two of them commit, or run builds or tests that could overlap.",
  "read-only": " Read-only sub-agents in one message may run at the same time.",
  sequential: "",
};

/**
 * The tool's description: the custom text, or the neutral one, which states the
 * facts of `mode` and never asks for fan-out. The list of types always follows:
 * `subagent_type` is unusable without it.
 */
export function taskToolDescription(
  custom: string | undefined,
  mode: TaskExecutionMode,
  typeList: string,
  modelList = "",
): string {
  const text = custom ?? `${NEUTRAL_DESCRIPTION}${OVERLAP_NOTE[mode]}`;
  const models =
    modelList === ""
      ? ""
      : `\n\nAvailable models (optional \`model\` argument; omit it to use the sub-agent type's own model):\n${modelList}`;
  return `${text}\n\nAvailable sub-agent types:\n${typeList}${models}`;
}

/** One line per selectable model; a description's whitespace runs collapse to one space. */
function renderModelList(models: readonly TaskModelOption[]): string {
  return models
    .map((m) => {
      const about = m.description?.replace(/\s+/g, " ").trim();
      return about ? `- ${m.name}: ${about}` : `- ${m.name}`;
    })
    .join("\n");
}

/** Build the `agent_task` tool for the given runner and available sub-agent types. */
export function createTaskTool(
  run: TaskRunner,
  types: readonly TaskAgentType[],
  options: TaskToolOptions = {},
): Tool {
  const names = types.map((t) => t.name);
  const defaultType = names[0] ?? "general";
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const resolveType = (requested: string | undefined): string => {
    const name = requested ?? defaultType;
    return names.includes(name) ? name : defaultType;
  };

  const models = options.models ?? [];
  const modelNames = models.map((m) => m.name);
  const baseSchema = z.object({
    description: z.string().min(1).describe("A short (3-5 word) description of the task"),
    prompt: z.string().min(1).describe("The full task for the sub-agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe(`Which sub-agent to use (default ${defaultType})`),
  });
  // `model` only when the user made models selectable, `background` only when
  // the runtime is wired: otherwise the agent is never told they exist, and a
  // stray one is stripped like any unknown argument.
  const inputSchema = z.object({
    ...baseSchema.shape,
    ...(models.length > 0
      ? {
          model: z
            .string()
            .optional()
            .describe(
              `Which model runs the sub-agent: one of ${modelNames.join(", ")}. Omit it for the type's own model.`,
            ),
        }
      : {}),
    ...(options.background
      ? {
          background: z
            .boolean()
            .optional()
            .describe(
              "Run the sub-agent in the background: this call returns at once with its id (sa-N), you can keep working or end your turn, and its report arrives later as a [background] note that wakes you. Default false.",
            ),
        }
      : {}),
  });

  return {
    name: "agent_task",
    description: taskToolDescription(
      options.description,
      options.mode ?? "sequential",
      typeList,
      renderModelList(models),
    ),
    inputSchema,
    permission: "none",
    // Resolved as `execute` does. Bad input throws: not groupable.
    spawnKind(input): SpawnKind {
      const type = resolveType(inputSchema.parse(input).subagent_type);
      return options.readOnlyType?.(type) ? "read-only" : "writer";
    },
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as z.infer<typeof baseSchema> & { model?: string; background?: boolean };
      const type = resolveType(args.subagent_type);
      const model = models.length > 0 ? args.model : undefined;
      if (model !== undefined && !modelNames.includes(model)) {
        // No child starts: the agent learns the allowed names and may retry.
        return {
          content: `unknown model ${JSON.stringify(model.slice(0, 64))} for agent_task — use one of: ${modelNames.join(", ")}, or omit model`,
          isError: true,
        };
      }
      const runOpts = {
        description: args.description,
        prompt: args.prompt,
        type,
        ...(model !== undefined ? { model } : {}),
      };
      const bg = options.background;
      if (args.background === true && bg) {
        if (ctx.toolCallId === undefined) {
          // A blank callId would write a `subagent_background` the schema refuses.
          return {
            content: "background sub-agents need a tool call id: run it in the foreground",
            isError: true,
          };
        }
        const started = bg.start(
          { callId: ctx.toolCallId, agentType: type, description: args.description },
          async ({ signal, agentId }) => {
            let outcome: TaskRunResult;
            try {
              // NEVER `ctx.signal`: Esc on the launching turn must not stop the child.
              outcome = await run(runOpts, {
                signal,
                agentId,
                // The child's activity, folded into its row (the status line's
                // count and the panel read `bg.rows()`); it reaches no turn.
                onEvent: (event) => bg.progress(agentId, event),
                ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
                sessionId: ctx.sessionId,
              });
            } catch (error) {
              outcome = {
                report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
                toolUses: 0,
                stopReason: "error",
              };
            }
            // The same transforms as a foreground report: redaction, hooks, spill.
            const shaped = ctx.shapeResult
              ? await ctx.shapeResult({ content: outcome.report }, signal)
              : { content: outcome.report };
            return { ...outcome, report: shaped.content };
          },
        );
        return started.ok
          ? {
              content: `started in background as ${started.agentId}: ${args.description}. Its report will arrive later as a [background] note; you can keep working or end your turn.`,
            }
          : { content: started.reason, isError: true };
      }
      // A foreground child takes a slot of the same cap, or is refused at once.
      const slot = bg ? bg.acquire(args.description) : undefined;
      if (slot && !slot.ok) {
        return { content: slot.reason, isError: true };
      }
      let result: TaskRunResult;
      try {
        result = await run(runOpts, {
          signal: ctx.signal,
          ...(ctx.emitProgress ? { onEvent: ctx.emitProgress } : {}),
          ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
          sessionId: ctx.sessionId,
        });
      } finally {
        if (slot?.ok) {
          slot.release();
        }
      }
      const note =
        result.stopReason === "cancelled"
          ? "\n\n_(sub-agent cancelled)_"
          : result.stopReason === "max_iterations"
            ? "\n\n_(sub-agent hit its iteration cap)_"
            : "";
      const body = result.report.length > 0 ? result.report : "(the sub-agent produced no output)";
      return { content: `${body}${note}` };
    },
  };
}

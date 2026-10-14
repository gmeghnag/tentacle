/**
 * The `task` tool — the model-facing surface for delegating to a sub-agent.
 *
 * It owns no agent logic: a runner (built in the wiring layer, where the model
 * and registry live) is injected, so this package stays free of a dependency on
 * `@agent-harness/agent`. The tool itself needs no permission — spawning is
 * safe; the child's own tools enforce their permissions and confinement.
 */
import type { Tool, ToolProgressEvent, ToolResult } from "@agent-harness/core";
import { z } from "zod";

export interface TaskRunResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: string;
}

export interface TaskRunControls {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ToolProgressEvent) => void;
}

export type TaskRunner = (
  opts: { description: string; prompt: string; type: string },
  controls?: TaskRunControls,
) => Promise<TaskRunResult>;

export interface TaskAgentType {
  readonly name: string;
  readonly description: string;
}

/** Build the `task` tool for the given runner and available sub-agent types. */
export function createTaskTool(run: TaskRunner, types: readonly TaskAgentType[]): Tool {
  const names = types.map((t) => t.name);
  const defaultType = names[0] ?? "general-purpose";
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");

  const inputSchema = z.object({
    description: z.string().min(1).describe("A short (3-5 word) description of the task"),
    prompt: z.string().min(1).describe("The full task for the sub-agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe(`Which sub-agent to use (default ${defaultType})`),
  });

  return {
    name: "task",
    description: `Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so use it to explore or offload work without filling your own context. Prefer it for open-ended search and read-heavy investigation.\n\nAvailable sub-agent types:\n${typeList}`,
    inputSchema,
    permission: "none",
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as z.infer<typeof inputSchema>;
      const requested = args.subagent_type ?? defaultType;
      const type = names.includes(requested) ? requested : defaultType;
      const result = await run(
        { description: args.description, prompt: args.prompt, type },
        { signal: ctx.signal, ...(ctx.emitProgress ? { onEvent: ctx.emitProgress } : {}) },
      );
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

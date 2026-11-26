/**
 * `workflow` (docs/feat/agent-workflows.md D3): the model's ONE handle on the
 * session's workflow driver — `run` a project workflow, read its `status`, or
 * `stop` it. Registered only beside a driver (never on a tunnelled session,
 * never to a child). A run started here is asked like any other: its hash
 * approval and its approve steps are `workflow_approve` asks, never
 * auto-accepted, so the model cannot approve its own sequence.
 *
 * One flat object, like `agent_control`: which field an action needs is
 * checked in `execute`, so the repair is our own sentence.
 */
import { PROJECT_PATHS, type Tool } from "@tentacle/core";
import { z } from "zod";

export const WORKFLOW_TOOL_NAME = "workflow";

/** What the tool needs of the driver (`@tentacle/agent`'s `WorkflowDriver`). */
export interface WorkflowToolDriver {
  start(request: {
    readonly name: string;
    readonly inputs?: Readonly<Record<string, string>>;
    readonly by: "user" | "model";
  }): Promise<
    { readonly ok: true; readonly runId: string } | { readonly ok: false; readonly reason: string }
  >;
  stop(
    runId: string,
  ):
    | { readonly ok: true; readonly runId: string }
    | { readonly ok: false; readonly reason: string };
  rows(): readonly {
    readonly runId: string;
    readonly name: string;
    readonly state: string;
    readonly reason?: string;
    readonly tokens: number;
    readonly steps: readonly {
      readonly id: string;
      readonly state: string;
      readonly reason?: string;
    }[];
  }[];
}

const workflowInput = z.object({
  action: z.enum(["run", "status", "stop"]),
  name: z.string().max(64).optional(),
  inputs: z.record(z.string().max(4096)).optional(),
  run_id: z.string().max(32).optional(),
});

const DESCRIPTION = `Run a project workflow (${PROJECT_PATHS.workflows}/<name>.yaml): "run" (name, inputs) starts it and returns at once — the user approves it, its result arrives as a [workflow] note that wakes you; "status": the runs and their steps (read-only, never a way to wait); "stop" (run_id). A workflow's agent step ends only by calling the step_verdict tool (pass|fail + reason) — a child that ends without it is asked once more, then the step fails \`no verdict\`. Write that into the step's prompt; never ask for a text PASS line.`;

export function createWorkflowTool(
  driver: WorkflowToolDriver,
): Tool<z.infer<typeof workflowInput>> {
  return {
    name: WORKFLOW_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: workflowInput,
    permission: "none",
    async execute(input) {
      if (input.action === "run") {
        if (input.name === undefined) {
          return { content: 'action "run" needs name.', isError: true };
        }
        const started = await driver.start({
          name: input.name,
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          by: "model",
        });
        return started.ok
          ? {
              content: `started ${started.runId}: the user is asked to approve it; its result arrives as a [workflow ${started.runId} …] note.`,
              isError: false,
            }
          : { content: started.reason, isError: true };
      }
      if (input.action === "stop") {
        if (input.run_id === undefined) {
          return { content: 'action "stop" needs run_id.', isError: true };
        }
        const stopped = driver.stop(input.run_id);
        return stopped.ok
          ? { content: `stopping ${stopped.runId}`, isError: false }
          : { content: stopped.reason, isError: true };
      }
      const rows = driver.rows();
      if (rows.length === 0) {
        return { content: "no workflow runs in this session", isError: false };
      }
      const text = rows
        .map((r) => {
          const steps = r.steps.map((s) => `  ${s.id}: ${s.state}`).join("\n");
          return `${r.runId} ${r.name}: ${r.state}${r.reason !== undefined ? ` — ${r.reason}` : ""} · ${r.tokens} tok\n${steps}`;
        })
        .join("\n");
      return { content: text, isError: false };
    },
  };
}

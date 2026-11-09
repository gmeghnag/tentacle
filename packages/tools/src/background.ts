/**
 * Background-job tools: read the output of, and terminate, a job started by
 * `shell` with `run_in_background: true`. Both work against `ctx.jobs` (the
 * `JobController`); when it is not wired they report the capability as
 * unavailable rather than throwing.
 */
import type { AgentJobs, JobStatus, Tool } from "@tentacle/core";
import { z } from "zod";
import { jobCursorConcurrency } from "./concurrency.ts";

/** Human-readable status suffix including the exit code once a job has ended. */
function statusText(status: JobStatus, exitCode: number | null): string {
  if (status === "running") {
    return "running";
  }
  return exitCode !== null ? `${status} (exit=${exitCode})` : status;
}

const shellOutputInput = z.object({
  job_id: z.string().min(1).describe("Id returned by shell with run_in_background: true."),
});

export const shellOutputTool: Tool<z.infer<typeof shellOutputInput>> = {
  name: "shell_output",
  description:
    "Read output produced by a background shell job since the last read (incremental), along with its status and exit code once it has finished.",
  inputSchema: shellOutputInput,
  permission: "none",
  concurrency: jobCursorConcurrency,
  async execute(input, ctx) {
    if (!ctx.jobs) {
      return { content: "background jobs are not available here", isError: true };
    }
    const out = ctx.jobs.read(input.job_id);
    if (!out) {
      return { content: `no such background job: ${input.job_id}`, isError: true };
    }
    const body = [out.stdout, out.stderr]
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    const status = statusText(out.job.status, out.job.exitCode);
    return {
      content: `[${input.job_id} · ${status}]\n${body || "(no new output)"}`,
      isError: false,
    };
  },
};

const shellKillInput = z.object({
  job_id: z.string().min(1).describe("Id of the background job to terminate."),
});

export const shellKillTool: Tool<z.infer<typeof shellKillInput>> = {
  name: "shell_kill",
  description: "Terminate a background shell job started with run_in_background: true.",
  inputSchema: shellKillInput,
  permission: "none",
  async execute(input, ctx) {
    if (!ctx.jobs) {
      return { content: "background jobs are not available here", isError: true };
    }
    const killed = ctx.jobs.kill(input.job_id);
    return {
      content: killed
        ? `killed background job ${input.job_id}`
        : `background job ${input.job_id} was not running`,
      isError: false,
    };
  },
};

const agentKillInput = z.object({
  agent_id: z
    .string()
    .min(1)
    .describe("Id of the background sub-agent to stop (the sa-N `agent_task` returned)."),
});

/**
 * Stop a background sub-agent (docs/feat/subagent-background-ui.md, owner Q1 a):
 * the mirror of `shell_kill`, built only where the background runtime is wired
 * (without it no child has an id to name). Its exit reports `cancelled`, so the
 * agent learns how it ended from the usual `[background]` note.
 */
export function createAgentKillTool(jobs: AgentJobs): Tool<z.infer<typeof agentKillInput>> {
  return {
    name: "agent_kill",
    description:
      "Stop a background sub-agent started with agent_task{background: true}. Its report-so-far still arrives later as a [background] note, marked cancelled.",
    inputSchema: agentKillInput,
    permission: "none",
    async execute(input) {
      const killed = jobs.kill(input.agent_id);
      return {
        content: killed
          ? `killed background sub-agent ${input.agent_id}`
          : `background sub-agent ${input.agent_id} was not running`,
        isError: false,
      };
    },
  };
}

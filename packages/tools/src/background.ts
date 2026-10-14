/**
 * Background-job tools: read the output of, and terminate, a job started by
 * `shell` with `run_in_background: true`. Both work against `ctx.jobs` (the
 * `JobController`); when it is not wired they report the capability as
 * unavailable rather than throwing.
 */
import type { JobStatus, Tool } from "@agent-harness/core";
import { z } from "zod";

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

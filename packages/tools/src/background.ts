/**
 * Background-job tools: read the output of, and terminate, a job started by
 * `shell` with `run_in_background: true`. Both work against `ctx.jobs` (the
 * `JobController`); when it is not wired they report the capability as
 * unavailable rather than throwing.
 */
import type { AgentNotifyResult, JobStatus, Tool } from "@tentacle/core";
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
    // ONE stream, in ARRIVAL order (owner A): stdout and stderr interleaved the
    // way the process wrote them, so the model reads one timeline and never a
    // half. (Two concatenated buffers put every stdout line before every stderr
    // one, which reads as a different program's output.)
    const body = out.output.trim();
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

/**
 * The name the model USED to be offered for stopping a child (6a-2,
 * docs/feat/subagent-background-ui.md). It is no longer a tool: the merge into
 * `agent_control` (`action: "kill"`, docs/feat/agent-status.md) replaced it. The
 * constant stays because two things still need the name: the child filter and
 * `readOnlyType` list it (an old `agents/*.md` may name it), and an old session's
 * log/transcript still contains its calls, which render as plain names.
 */
export const AGENT_KILL_TOOL_NAME = "agent_kill";

export const AGENT_NOTIFY_TOOL_NAME = "agent_notify";

const agentNotifyInput = z.object({
  text: z.string().min(1).describe("What to tell the agent that launched you."),
});

/**
 * A running BACKGROUND child's way back to its parent agent
 * (docs/feat/agent-message-two-way.md, owner Q3 a): registered only on a child
 * that has an `sa-N` (`agent_task{background: true}`), and only where the
 * session's `subagents.twoWay` wired a `notify`. A reply, if any, arrives as
 * `[message from the parent agent]` at a later step — the child keeps working,
 * it never waits for one.
 */
export function createAgentNotifyTool(
  agentId: string,
  notify: (agentId: string, text: string) => AgentNotifyResult,
): Tool<z.infer<typeof agentNotifyInput>> {
  return {
    name: AGENT_NOTIFY_TOOL_NAME,
    description:
      "Send a short message to the agent that launched you, while you keep working. Use it for an intermediate finding or a question it must decide. It may wake it. Your final report is still what it gets when you finish. At most 8 per user message, 8000 characters each. A reply, if any, arrives as [message from the parent agent] before a later step. Do not stop and wait for one.",
    inputSchema: agentNotifyInput,
    permission: "none",
    async execute(input) {
      // `AgentJobs.notify` decides and delivers synchronously: a text it
      // refuses never reached the parent, so the child can retry or report it.
      const sent = notify(agentId, input.text);
      if (!sent.ok) {
        return { content: sent.reason, isError: true };
      }
      return { content: notifyResultText(sent.wakes), isError: false };
    },
  };
}

/** What the child reads after an accepted notify: how the parent will see it. */
function notifyResultText(wakes: boolean): string {
  return wakes
    ? "sent to the parent agent (it reads it at its next step, now if it is idle). Keep working."
    : "sent to the parent agent; it is not woken now (too many wakes since the user last wrote), it reads it at its next step. Keep working.";
}

/**
 * The name the model USED to be offered for writing into a child
 * (docs/feat/agent-message.md). No longer a tool — the merge into
 * `agent_control` (`action: "message"`, docs/feat/agent-status.md) replaced it.
 * The constant stays for the child filter / `readOnlyType` and for old logs.
 */
export const AGENT_MESSAGE_TOOL_NAME = "agent_message";

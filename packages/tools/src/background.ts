/**
 * Background-job tools: read the output of, and terminate, a job started by
 * `shell` with `run_in_background: true`. Both work against `ctx.jobs` (the
 * `JobController`); when it is not wired they report the capability as
 * unavailable rather than throwing.
 */
import type { AgentJobs, AgentNotifyResult, JobStatus, Tool } from "@tentacle/core";
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

export const AGENT_KILL_TOOL_NAME = "agent_kill";

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
    name: AGENT_KILL_TOOL_NAME,
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

export const AGENT_MESSAGE_TOOL_NAME = "agent_message";

const agentMessageInput = z.object({
  agent_id: z
    .string()
    .min(1)
    .describe(
      "Id of the background sub-agent to write to (the sa-N agent_task returned, or the id it moved to).",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "What to tell it. It reads this before its next model step, as a user message naming you as the sender.",
    ),
});

/**
 * Write into a RUNNING background sub-agent's context (docs/feat/agent-message.md,
 * owner decision B1), and it never wakes anything by itself (B3). Built only
 * where the background runtime is wired — without it no child has an id.
 *
 * Its result says "queued", never "delivered": a child waiting on a long tool
 * call or a permission ask reads the text after that call, and the report still
 * arrives as a `[background]` note. With `subagents.twoWay` on, the child may
 * also answer in between, through `agent_notify` (which can wake the parent) —
 * so both texts say so; with it off they are exactly what they were.
 */
export function createAgentMessageTool(
  jobs: AgentJobs,
  options: { readonly twoWay?: boolean } = {},
): Tool<z.infer<typeof agentMessageInput>> {
  const twoWay = options.twoWay === true;
  return {
    name: AGENT_MESSAGE_TOOL_NAME,
    description: twoWay
      ? "Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. It may answer with agent_notify meanwhile: that arrives as a [sub-agent sa-N → you] note and may wake you; its report still arrives later as a [background] note."
      : "Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. One-way: no reply comes back, and its report still arrives later as a [background] note. It does not wake you.",
    inputSchema: agentMessageInput,
    permission: "none",
    async execute(input) {
      // `AgentJobs.message` decides and pushes synchronously: a text it refuses
      // was never sent, so the agent can retry or go on.
      const sent = jobs.message(input.agent_id, input.text, "agent");
      return sent.ok
        ? {
            content: twoWay
              ? `queued for ${input.agent_id}: it reads it before its next model step. It may answer with agent_notify (a [sub-agent ${input.agent_id} → you] note that may wake you); its report still arrives as a [background] note.`
              : `queued for ${input.agent_id}: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.`,
            isError: false,
          }
        : { content: sent.reason, isError: true };
    },
  };
}

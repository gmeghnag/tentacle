/**
 * `agent_control` (docs/feat/agent-status.md, "Merge into agent_control"): the
 * MAIN agent's ONE parent-side tool for the sub-agents it launched in the
 * background — see one (`"status"`, read-only), write to one (`"message"`), or
 * stop one (`"kill"`).
 *
 * Why one tool instead of three: every tool costs its description plus its JSON
 * Schema at EVERY request (`ToolRegistry.definitions`), and three tools also cost
 * three `properties` blocks. One flat object is cheaper and — deliberately not a
 * discriminated union — readable by local OpenAI-compatible models, which handle
 * `oneOf` poorly. Which field an action needs is checked in `execute`, so the
 * repair is our own sentence rather than a zod message.
 *
 * Each action's BEHAVIOUR is the one its own tool had (same `AgentJobs` calls,
 * same texts, same refusals); `formatAgentStatus` keeps the status answer. The
 * old names survive only as display/log facts and as the child filter's entries
 * (`packages/agent/src/subagent.ts`).
 */
import type { AgentJobs, ResourceKey, Tool, ToolConcurrency } from "@tentacle/core";
import { z } from "zod";
import { formatAgentStatus, oneLine } from "./agent-status.ts";

export const AGENT_CONTROL_TOOL_NAME = "agent_control";

/** The three actions, as the schema's enum and the docs name them. */
export const AGENT_CONTROL_ACTIONS = ["status", "message", "kill"] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

/**
 * The description, `subagents.twoWay` off: a background child cannot answer, so
 * the message part says so (today's `agent_message` one-way facts). Kept to one
 * short block — it is paid for at every request.
 */
const DESCRIPTION_ONE_WAY =
  'Control a background sub-agent (agent_task{background:true}). "status": read-only, what it is doing and its last actions; never a way to wait — its report arrives as a [background] note that wakes you. "message" (agent_id, text): read before its next model step; one-way, no reply comes back. "kill" (agent_id): stops it; its report still arrives.';

/**
 * The same text with `subagents.twoWay` on: the child may answer through
 * `agent_notify`, so the parent must not be told there is no way back
 * (docs/feat/agent-message-two-way.md).
 */
const DESCRIPTION_TWO_WAY = DESCRIPTION_ONE_WAY.replace(
  "one-way, no reply comes back",
  "it may answer with agent_notify (a [sub-agent sa-N → you] note that may wake you)",
);

/** What the model is really given, for the flag: exported so a test pins both. */
export function agentControlDescription(twoWay: boolean): string {
  return twoWay ? DESCRIPTION_TWO_WAY : DESCRIPTION_ONE_WAY;
}

const agentControlInput = z.object({
  action: z
    .enum(AGENT_CONTROL_ACTIONS)
    .describe("status: read-only view. message: write to one. kill: stop one."),
  agent_id: z
    .string()
    .min(1)
    .optional()
    .describe("The sa-N agent_task returned. Required for message and kill."),
  text: z.string().min(1).optional().describe("What to tell it. Required for message."),
});

export type AgentControlInput = z.infer<typeof agentControlInput>;

/** One read key: a status call conflicts with nothing and serializes no round. */
const STATUS_READ: readonly ResourceKey[] = [{ mode: "read", resource: "subagents" }];

/**
 * A call's class, as a TOTAL function of its (unvalidated) input — the same
 * arrangement `spawnKind` uses, because `permission` is static on `Tool`. It
 * reproduces the three tools' own classes exactly: `agent_status` was
 * read-class, `agent_message`/`agent_kill` had no `concurrency` (hence
 * `"exclusive"`). Garbage → `"exclusive"` (AGENTS §7: never under-lock).
 */
const agentControlConcurrency: ToolConcurrency = (input) => {
  try {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === "status" ? STATUS_READ : "exclusive";
  } catch {
    return "exclusive";
  }
};

/**
 * Build the tool (docs/feat/agent-status.md). Registered only where the
 * background runtime is (`wiring.ts`), like the tools it replaces: without it no
 * child has an `sa-N` to name. NEVER given to a child — it would read and stop
 * its siblings (`packages/agent/src/subagent.ts`).
 *
 * `now` is injectable for tests; the real call uses `Date.now`.
 */
export function createAgentControlTool(
  jobs: AgentJobs,
  options: { readonly twoWay?: boolean; readonly now?: () => number } = {},
): Tool<AgentControlInput> {
  const twoWay = options.twoWay === true;
  const now = options.now ?? Date.now;
  return {
    name: AGENT_CONTROL_TOOL_NAME,
    description: agentControlDescription(twoWay),
    inputSchema: agentControlInput,
    permission: "none",
    concurrency: agentControlConcurrency,
    async execute(input) {
      switch (input.action) {
        case "status":
          return status(jobs, input, now);
        case "message":
          return message(jobs, input, twoWay);
        case "kill":
          return kill(jobs, input);
        default:
          // Unreachable through the registry (the enum refuses anything else);
          // a direct caller gets a tool error, never a throw.
          return {
            content: `unknown action: ${String((input as { action?: unknown }).action).slice(0, 32)} — use status, message or kill.`,
            isError: true,
          };
      }
    },
  };
}

/** `"status"`: today's `agent_status` answer, always its last 3 actions. */
function status(
  jobs: AgentJobs,
  input: AgentControlInput,
  now: () => number,
): { content: string; isError: boolean } {
  const text = formatAgentStatus({
    rows: jobs.rows(),
    pending: (id) => jobs.pending(id),
    now: now(),
    maxParallel: jobs.limit,
    ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
  });
  if (text === undefined) {
    return {
      content: `no such background sub-agent: ${oneLine(input.agent_id ?? "", 64)} — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.`,
      isError: true,
    };
  }
  return { content: text, isError: false };
}

/** `"message"`: today's `agent_message`, both variants of its result text. */
function message(
  jobs: AgentJobs,
  input: AgentControlInput,
  twoWay: boolean,
): { content: string; isError: boolean } {
  const agentId = input.agent_id;
  if (agentId === undefined || input.text === undefined) {
    return { content: 'action "message" needs agent_id and text.', isError: true };
  }
  // `AgentJobs.message` decides and pushes synchronously: a text it refuses was
  // never sent, so the agent can retry or go on.
  const sent = jobs.message(agentId, input.text, "agent");
  if (!sent.ok) {
    return { content: sent.reason, isError: true };
  }
  return {
    content: twoWay
      ? `queued for ${agentId}: it reads it before its next model step. It may answer with agent_notify (a [sub-agent ${agentId} → you] note that may wake you); its report still arrives as a [background] note.`
      : `queued for ${agentId}: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.`,
    isError: false,
  };
}

/** `"kill"`: today's `agent_kill`, verbatim — "not running" is never an error. */
function kill(jobs: AgentJobs, input: AgentControlInput): { content: string; isError: boolean } {
  const agentId = input.agent_id;
  if (agentId === undefined) {
    return { content: 'action "kill" needs agent_id.', isError: true };
  }
  const killed = jobs.kill(agentId);
  return {
    content: killed
      ? `killed background sub-agent ${agentId}`
      : `background sub-agent ${agentId} was not running`,
    isError: false,
  };
}

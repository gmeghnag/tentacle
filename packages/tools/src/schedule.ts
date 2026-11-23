/**
 * `schedule_create` / `schedule_control` (docs/feat/cron-tool.md D2): the model
 * registers its own wake-ups — recurring (`every`) or one-shot (`at`) — and
 * lists or deletes them. A fired wake starts a turn whose prompt is the job's
 * text; the session (`HostedSession`), not this module, owns the table and the
 * timer, reached through the LAZY `ScheduleLink` (P1: looked up per call, so a
 * rebuilt agent never holds a stale table).
 *
 * Two tools because permission is static per tool (P3): creating spends the
 * user's model budget unattended, so it ASKS (owner Q3); reading and removing
 * do not. Both are the flat `agent_control` shape — no `oneOf`, which local
 * models handle poorly — with the "exactly one of" rule answered by the core's
 * own repair sentence. Registered only where the host schedules (`serve` and
 * the worker; never a pod, D1) and never given to a child (`subagent.ts`).
 */
import {
  PROJECT_PATHS,
  type ResourceKey,
  type ScheduleCreateResult,
  type ScheduleLink,
  type ScheduledJob,
  type Tool,
  type ToolConcurrency,
  type ToolResult,
  shortHash,
} from "@tentacle/core";
import { z } from "zod";
import { oneLine } from "./agent-status.ts";

export const SCHEDULE_CREATE_TOOL_NAME = "schedule_create";
export const SCHEDULE_CONTROL_TOOL_NAME = "schedule_control";

/** The session's table, or `null` when this session schedules no more (it ended). */
export type ScheduleLinkSource = () => ScheduleLink | null;

/** How much of a job's prompt one `list` line quotes. */
const LIST_PROMPT_MAX = 60;

const UNAVAILABLE: ToolResult = {
  content: "scheduled wakes are not available in this session (it has ended).",
  isError: true,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `in 2d 3h` / `in 1h 59m` / `in 10m`: the two largest units, rounded down to the minute. */
function relative(ms: number): string {
  if (ms <= 0) return "due now";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const parts =
    days > 0
      ? [`${days}d`, hours > 0 ? `${hours}h` : ""]
      : hours > 0
        ? [`${hours}h`, minutes > 0 ? `${minutes}m` : ""]
        : [`${Math.max(minutes, 1)}m`];
  return `in ${parts.filter((part) => part !== "").join(" ")}`;
}

/**
 * An instant as the model reads it, in the HOST's zone (the tool runs where the
 * timer does, D3): `14:30 (in 10m)` today, `2026-11-18 17:20 (in 2d 3h)` later.
 */
export function scheduleClock(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const day = sameDay
    ? ""
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `;
  return `${day}${time} (${relative(at - now)})`;
}

const createInput = z.object({
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What you will be told when it fires. Self-sufficient: your context may be compacted by then. Give this OR workflow.",
    ),
  workflow: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Instead of a prompt: the workflow (${PROJECT_PATHS.workflows}/<name>.yaml) to START by itself when it fires — no turn, the file's current content is pinned.`,
    ),
  inputs: z
    .array(z.object({ name: z.string().min(1), value: z.string() }))
    .optional()
    .describe("The workflow's inputs, [{name, value}]. Only with workflow."),
  every: z.string().min(1).optional().describe("Recurring interval: 10m, 2h, 1d (at least 1m)."),
  daily: z
    .string()
    .min(1)
    .optional()
    .describe("Every day at this local time, HH:MM (03:00). Keeps the time across DST."),
  at: z
    .string()
    .min(1)
    .optional()
    .describe(
      'One-shot: an ISO time (2026-11-16T17:00, host\'s zone) or relative (in 20m). Prefer the relative form for "in N minutes/hours" — an ISO time you computed yourself is the wrong day more often than not.',
    ),
});

export type ScheduleCreateInput = z.infer<typeof createInput>;

const CREATE_DESCRIPTION =
  "Schedule a wake-up: when due, a new turn starts with your prompt (even with nobody watching) — or, with `workflow`, that workflow starts by itself (no turn). Give exactly one of `prompt` or `workflow`, and exactly one of `every` (recurring), `daily` (local time) or `at` (one-shot). The user is asked first. List or delete with schedule_control.";

/** The tool's reply for a created job: when it fires, and what happens then. */
function createdText(job: ScheduledJob, now: number): string {
  const expires =
    job.expiresAt >= Number.MAX_SAFE_INTEGER
      ? "no expiry"
      : `expires ${scheduleClock(job.expiresAt, now).replace(/ \(.*\)$/, "")}`;
  const when =
    job.kind === "at"
      ? `one-shot at ${scheduleClock(job.nextAt, now)}.`
      : `${job.spec}, next at ${scheduleClock(job.nextAt, now)}, ${expires}.`;
  const target = job.target?.workflow;
  if (target !== undefined) {
    return `Scheduled ${job.id}: ${when} It starts ${job.prompt} (hash ${shortHash(target.hash)}) by itself — no turn; if the file changes, it stops starting until the schedule is re-created. It lasts while this session runs.`;
  }
  return `Scheduled ${job.id}: ${when} When it fires you get: "[scheduled ${job.id} · ${job.spec} · fire N] ${job.prompt}". It lasts while this session runs.`;
}

/** Build `schedule_create` (D2). `permission: "ask"` through the session's single broker (D4). */
export function createScheduleCreateTool(link: ScheduleLinkSource): Tool<ScheduleCreateInput> {
  return {
    name: SCHEDULE_CREATE_TOOL_NAME,
    description: CREATE_DESCRIPTION,
    inputSchema: createInput,
    permission: "ask",
    async execute(input) {
      const schedules = link();
      if (schedules === null) return UNAVAILABLE;
      const request = {
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.workflow === undefined
          ? {}
          : { workflow: { name: input.workflow, inputs: input.inputs ?? [] } }),
        ...(input.every === undefined ? {} : { every: input.every }),
        ...(input.at === undefined ? {} : { at: input.at }),
        ...(input.daily === undefined ? {} : { daily: input.daily }),
      };
      // Both / neither of prompt|workflow: the core's own repair sentence (`create`).
      let result: ScheduleCreateResult;
      if (input.workflow !== undefined && input.prompt === undefined) {
        if (schedules.createWorkflow === undefined) {
          return { content: "workflows run only on a laptop or serve session", isError: true };
        }
        result = await schedules.createWorkflow(request);
      } else {
        result = schedules.create(request);
      }
      if (!result.ok) return { content: result.reason, isError: true };
      return { content: createdText(result.job, schedules.now()), isError: false };
    },
  };
}

const CONTROL_ACTIONS = ["list", "delete"] as const;

const controlInput = z.object({
  action: z.enum(CONTROL_ACTIONS).describe("list: your scheduled wakes. delete: remove one."),
  id: z.string().min(1).optional().describe("The sc-N to delete. Required for delete."),
});

export type ScheduleControlInput = z.infer<typeof controlInput>;

const LIST_READ: readonly ResourceKey[] = [{ mode: "read", resource: "schedules" }];
const DELETE_WRITE: readonly ResourceKey[] = [{ mode: "write", resource: "schedules" }];

/** A TOTAL function of the unvalidated input; garbage → `"exclusive"` (never under-lock). */
const controlConcurrency: ToolConcurrency = (input) => {
  try {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === "list" ? LIST_READ : action === "delete" ? DELETE_WRITE : "exclusive";
  } catch {
    return "exclusive";
  }
};

/** Build `schedule_control` (D2): `list` and `delete`, never asks. */
export function createScheduleControlTool(link: ScheduleLinkSource): Tool<ScheduleControlInput> {
  return {
    name: SCHEDULE_CONTROL_TOOL_NAME,
    description:
      'Your scheduled wakes (schedule_create). "list": each one\'s id, timing and prompt. "delete" (id): remove one.',
    inputSchema: controlInput,
    permission: "none",
    concurrency: controlConcurrency,
    async execute(input) {
      const schedules = link();
      if (schedules === null) return UNAVAILABLE;
      if (input.action === "list") {
        const now = schedules.now();
        const lines = schedules.list().map((job) => {
          const count = job.kind === "every" ? `fired ${job.fires}×` : "one-shot";
          return `${job.id} · ${job.spec} · next ${scheduleClock(job.nextAt, now)} · ${count} · "${oneLine(job.prompt, LIST_PROMPT_MAX)}"`;
        });
        return {
          content: lines.length > 0 ? lines.join("\n") : "No scheduled wakes in this session.",
          isError: false,
        };
      }
      if (input.action === "delete") {
        if (input.id === undefined) {
          return { content: 'action "delete" needs id (see list).', isError: true };
        }
        const id = oneLine(input.id, 32);
        return schedules.delete(input.id)
          ? { content: `Deleted ${id}.`, isError: false }
          : { content: `No schedule ${id} (see list).`, isError: true };
      }
      return {
        content: `unknown action: ${String((input as { action?: unknown }).action).slice(0, 32)} — use list or delete.`,
        isError: true,
      };
    },
  };
}

/**
 * The daemon side of a session's scheduled wakes (docs/feat/cron-tool.md S3),
 * pure: the wire rows, the `sc-N` counter's seed, the sidecar record's
 * validation and the fired turn's end as the failure budget counts it. The
 * table rules themselves (next slot, catch-up, caps) are `@tentacle/core`'s
 * `schedule.ts`; `HostedSession` only holds the table, its timer and the fire.
 */
import {
  type ChatMessage,
  SCHEDULE_ID_PREFIX,
  type ScheduleEnd,
  type ScheduleLast,
  type ScheduleOutcome,
  type ScheduleWorkflowTarget,
  type ScheduledJob,
  shortHash,
} from "@tentacle/core";
import { SCHEDULE_LABEL_MAX, type ScheduleRow } from "@tentacle/protocol";
import { wireLine } from "./mapping.ts";

/** A wire stamp: a non-negative integer (the row schema's), whatever the host clock said. */
const stamp = (value: number): number => Math.max(0, Math.floor(value));

/** The rows as the wire carries them, in creation order: one-line labels, cut to `SCHEDULE_LABEL_MAX`. */
export function scheduleRows(table: readonly ScheduledJob[]): ScheduleRow[] {
  return table.map((job) => ({
    id: wireLine(job.id, 64),
    kind: job.kind,
    spec: wireLine(job.spec, SCHEDULE_LABEL_MAX),
    prompt: wireLine(job.prompt, SCHEDULE_LABEL_MAX),
    nextAt: stamp(job.nextAt),
    // A one-shot does not outlive its fire: its grace is not a user-facing
    // expiry; a recurring workflow job has none (slice 10 decision 7).
    ...(job.kind !== "at" && job.expiresAt < Number.MAX_SAFE_INTEGER
      ? { expiresAt: stamp(job.expiresAt) }
      : {}),
    fires: job.fires,
    createdAt: stamp(job.createdAt),
    ...(job.target === undefined
      ? {}
      : {
          workflow: {
            name: wireLine(job.target.workflow.name, 64),
            inputs: job.target.workflow.inputs.map((input) =>
              wireLine(`${input.name}=${input.value}`, SCHEDULE_LABEL_MAX),
            ),
            hash: shortHash(job.target.workflow.hash),
          },
        }),
    ...(job.last === undefined
      ? {}
      : {
          last: {
            at: stamp(job.last.at),
            outcome: job.last.outcome,
            ...(job.last.reason !== undefined
              ? { reason: wireLine(job.last.reason, SCHEDULE_LABEL_MAX) }
              : {}),
            ...(job.last.runId !== undefined ? { runId: wireLine(job.last.runId, 32) } : {}),
          },
        }),
  }));
}

/** The same list, member by member: what makes a `schedules` frame unnecessary. */
export function sameScheduleRows(a: readonly ScheduleRow[], b: readonly ScheduleRow[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.kind === other.kind &&
      row.spec === other.spec &&
      row.prompt === other.prompt &&
      row.nextAt === other.nextAt &&
      row.expiresAt === other.expiresAt &&
      row.fires === other.fires &&
      row.createdAt === other.createdAt &&
      JSON.stringify(row.workflow) === JSON.stringify(other.workflow) &&
      JSON.stringify(row.last) === JSON.stringify(other.last)
    );
  });
}

const SEQ_PATTERN = new RegExp(`\\b${SCHEDULE_ID_PREFIX}(\\d{1,9})\\b`, "g");

/**
 * The highest `sc-N` this session has handed out, as far as it can know: the
 * table's ids and every id its history mentions (a fired prompt's
 * `[scheduled sc-3 · …]`, a create's result). Ids are never reused in a
 * session (D2): a reload, which keeps no counter, must not hand out an id the
 * model has already seen. Over-counting only skips numbers.
 */
export function scheduleSeqSeed(
  messages: readonly ChatMessage[],
  table: readonly ScheduledJob[],
): number {
  let highest = 0;
  const scan = (text: string): void => {
    for (const match of text.matchAll(SEQ_PATTERN)) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > highest) highest = n;
    }
  };
  for (const job of table) scan(job.id);
  for (const message of messages) scan(message.content);
  return highest;
}

/** A fired turn's `stopReason` as its job's failure budget counts it (core `scheduleSettled`). */
export function scheduleEndOf(stopReason: string): ScheduleEnd {
  return stopReason === "error" ? "error" : stopReason === "cancelled" ? "cancelled" : "ok";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isCount = isStamp;

const OUTCOMES: readonly ScheduleOutcome[] = [
  "started",
  "skipped",
  "missed",
  "changed",
  "unapproved",
  "invalid",
  "unavailable",
];
const DAILY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTarget(value: unknown): { workflow: ScheduleWorkflowTarget } | null {
  if (!isObject(value) || !isObject(value.workflow)) return null;
  const { name, hash, inputs } = value.workflow;
  if (typeof name !== "string" || name === "" || typeof hash !== "string" || hash === "") {
    return null;
  }
  if (!Array.isArray(inputs)) return null;
  const copied: { name: string; value: string }[] = [];
  for (const input of inputs) {
    if (!isObject(input) || typeof input.name !== "string" || typeof input.value !== "string") {
      return null;
    }
    copied.push({ name: input.name, value: input.value });
  }
  return { workflow: { name, hash, inputs: copied } };
}

function parseLast(value: unknown): ScheduleLast | null {
  if (!isObject(value) || !isStamp(value.at)) return null;
  const outcome = OUTCOMES.find((known) => known === value.outcome);
  if (outcome === undefined) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  if (value.runId !== undefined && typeof value.runId !== "string") return null;
  return {
    at: value.at,
    outcome,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

/**
 * A state file's `schedules`, validated member by member (copied), or null:
 * anything this build does not know is a REFUSAL of the session (its files are
 * left untouched), never a half-loaded table — the D6 rule. A workflow target
 * and the `daily` kind are v4 content (agent-workflows slice 10): a file of an
 * older version that carries them is not this build's own, and is refused.
 */
export function parseScheduleRecords(
  value: unknown,
  options: { readonly workflowTargets?: boolean } = {},
): ScheduledJob[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = new Set<string>();
  const jobs: ScheduledJob[] = [];
  for (const raw of value) {
    if (
      !isObject(raw) ||
      typeof raw.id !== "string" ||
      !raw.id.startsWith(SCHEDULE_ID_PREFIX) ||
      ids.has(raw.id) ||
      (raw.kind !== "every" &&
        raw.kind !== "at" &&
        !(raw.kind === "daily" && options.workflowTargets === true)) ||
      typeof raw.spec !== "string" ||
      typeof raw.prompt !== "string" ||
      raw.prompt === "" ||
      typeof raw.createdBy !== "string" ||
      !isStamp(raw.createdAt) ||
      !isStamp(raw.expiresAt) ||
      !isStamp(raw.nextAt) ||
      !isCount(raw.fires) ||
      !isCount(raw.failures)
    ) {
      return null;
    }
    // `every` needs its interval (the slot arithmetic); a one-shot has none.
    const every = raw.kind === "every";
    if (every ? !(isStamp(raw.intervalMs) && raw.intervalMs > 0) : raw.intervalMs !== undefined) {
      return null;
    }
    // `daily` needs its wall-clock time; no other kind carries one.
    const daily = raw.kind === "daily";
    if (
      daily ? !(typeof raw.daily === "string" && DAILY_RE.test(raw.daily)) : raw.daily !== undefined
    ) {
      return null;
    }
    let target: { workflow: ScheduleWorkflowTarget } | undefined;
    if (raw.target !== undefined) {
      const parsed = options.workflowTargets === true ? parseTarget(raw.target) : null;
      if (parsed === null) return null;
      target = parsed;
    }
    let last: ScheduleLast | undefined;
    if (raw.last !== undefined) {
      const parsed = parseLast(raw.last);
      if (parsed === null) return null;
      last = parsed;
    }
    ids.add(raw.id);
    jobs.push({
      id: raw.id,
      kind: raw.kind,
      spec: raw.spec,
      ...(every ? { intervalMs: raw.intervalMs as number } : {}),
      ...(daily ? { daily: raw.daily as string } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(last !== undefined ? { last } : {}),
      prompt: raw.prompt,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      nextAt: raw.nextAt,
      fires: raw.fires,
      failures: raw.failures,
      createdBy: raw.createdBy,
    });
  }
  return jobs;
}

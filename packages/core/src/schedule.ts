/**
 * The agent's own wake-ups (docs/feat/cron-tool.md, slice S1) — a session's
 * table of scheduled turns, pure: no timer, no clock, no I/O, no React.
 *
 * Who owns what: this module decides WHEN and WHAT (parse a request, pick the
 * next slot, catch up once, clamp a backwards clock, cap, expire, stop a job
 * that keeps failing). The daemon's `HostedSession` owns the ONE `setTimeout`
 * and the fire itself — the same `prompt()` a client uses, on the same busy
 * slot (§7, one session path). Every time here is epoch ms from the HOST's
 * injected clock, so a test drives time by passing it in.
 *
 * Load-bearing rules, in one place so they cannot drift:
 * - **at-most-once**: a fire ADVANCES the row (`nextAt`, `fires`) BEFORE the
 *   turn starts, in the same synchronous stretch, so a crash mid-turn never
 *   re-fires that slot.
 * - **catch-up ONCE**: after N missed slots (daemon down, laptop asleep, the
 *   session busy for hours) the job fires once and resumes from now — anacron,
 *   not a replay.
 * - **one pending fire per job**: a due job stays due while the slot is busy;
 *   it is never a queue, so nothing piles up.
 * - **bounded**: ≤ 10 live jobs, ≥ 1 m apart, ≤ 7 d ahead, 7-day expiry, and a
 *   job whose fired turns end `error` 3 times in a row is removed — a dead
 *   model key costs 3 turns, not one per interval forever.
 */
/** The `sc-` prefix of a schedule's id (`sc-1`, `sc-2`, …), never reused in a session. */
export const SCHEDULE_ID_PREFIX = "sc-";

export const SCHEDULE_MAX_JOBS = 10;
export const SCHEDULE_MIN_INTERVAL_MS = 60_000;
export const SCHEDULE_MAX_INTERVAL_MS = 7 * 86_400_000;
/** A recurring job's life, and also the one-shot grace past its `at` (so an asleep host still fires it once). */
export const SCHEDULE_TTL_MS = 7 * 86_400_000;
/** How far ahead an `at` may point. */
export const SCHEDULE_MAX_AHEAD_MS = 7 * 86_400_000;
export const SCHEDULE_PROMPT_MAX_CHARS = 2000;
/** Consecutive `error` ends of a fired turn before the job is removed. */
export const SCHEDULE_MAX_FAILURES = 3;

/**
 * The create-time limits a HOST applies (its own `schedules.*` config, never a
 * carried setting — docs/feat/cron-tool.md D3, owner Q6). Every one is checked
 * when a job is created (expiry is stamped then), so the table and `scheduleStep`
 * need none of them. `ttlMs` is also the longest `every`: an interval past the
 * job's life would never fire.
 */
export interface ScheduleLimits {
  readonly maxJobs: number;
  readonly minIntervalMs: number;
  readonly ttlMs: number;
  readonly maxAheadMs: number;
  readonly promptMaxChars: number;
}

/** Owner Q6's defaults: the constants above, as one value. */
export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = {
  maxJobs: SCHEDULE_MAX_JOBS,
  minIntervalMs: SCHEDULE_MIN_INTERVAL_MS,
  ttlMs: SCHEDULE_TTL_MS,
  maxAheadMs: SCHEDULE_MAX_AHEAD_MS,
  promptMaxChars: SCHEDULE_PROMPT_MAX_CHARS,
};
/**
 * The daemon re-arms its one timer to at most this: a sleep, a clock jump or a
 * long delay is noticed within 60 s, and the timer never meets `setTimeout`'s
 * 2³¹-ms limit.
 */
export const SCHEDULE_CHECK_INTERVAL_MS = 60_000;

/**
 * How late a fire of a WORKFLOW job may be and still start (agent-workflows
 * slice 10): past this the slot is recorded `missed` and skipped — heavy work
 * hours late at a time nobody chose is a surprise. Prompt jobs keep anacron.
 */
export const SCHEDULE_WORKFLOW_GRACE_MS = 15 * 60_000;
/** A `daily` slot further ahead than this is a back-jumped clock: recompute it. */
const DAILY_CLAMP_MS = 25 * 3_600_000;

/**
 * How a job repeats: a fixed interval, never (`at` = one-shot), or every day at
 * a local wall-clock time (`daily 03:00` — DST keeps 03:00; `every 1d` does not).
 */
export type ScheduleKind = "every" | "at" | "daily";

/** One `name=value` input of a scheduled workflow. */
export interface ScheduleWorkflowInput {
  readonly name: string;
  readonly value: string;
}

/** The workflow a job starts (slice 10). `hash` is PINNED at create: the schedule authorises THIS content. */
export interface ScheduleWorkflowTarget {
  readonly name: string;
  readonly inputs: readonly ScheduleWorkflowInput[];
  readonly hash: string;
}

/**
 * What one fire of a workflow job did. `started` = a run began (its verdict is
 * the workflow's, not the schedule's); `skipped` = a run was already in flight;
 * `missed` = later than the grace; the rest could not start for a reason the
 * human must fix (`changed` file, `unapproved` hash, `invalid` file/inputs,
 * `unavailable` = no workflow driver here).
 */
export type ScheduleOutcome =
  | "started"
  | "skipped"
  | "missed"
  | "changed"
  | "unapproved"
  | "invalid"
  | "unavailable";

export interface ScheduleLast {
  readonly at: number;
  readonly outcome: ScheduleOutcome;
  readonly reason?: string;
  readonly runId?: string;
}

/** Outcomes the human must fix: they count toward the failure stop and push `run_not_started`. */
export function scheduleOutcomeNeedsHuman(outcome: string): boolean {
  return (
    outcome === "changed" ||
    outcome === "unapproved" ||
    outcome === "invalid" ||
    outcome === "unavailable"
  );
}

/**
 * One scheduled wake. `spec` is the text as the model gave it (`every 10m`,
 * `at 2026-11-16T17:00`) — it is what the user sees and what the fired prompt
 * quotes, so a row always explains itself.
 */
export interface ScheduledJob {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly spec: string;
  /** Set for `every`: the fixed interval. */
  readonly intervalMs?: number;
  /** Set for `daily`: the local wall-clock time, `HH:MM`. */
  readonly daily?: string;
  /**
   * What the fired turn is told. Self-sufficient on purpose: the context may be
   * compacted by then. For a workflow job: the display label (`workflow <name> k=v…`).
   */
  readonly prompt: string;
  /** Absent = the prompt target (a model turn). Present = start this workflow, no turn. */
  readonly target?: { readonly workflow: ScheduleWorkflowTarget };
  /** The last fire of a workflow job, as the daemon recorded it. */
  readonly last?: ScheduleLast;
  readonly createdAt: number;
  /** Past this the job is removed (never fired). */
  readonly expiresAt: number;
  /** The next slot. */
  readonly nextAt: number;
  /** Fired turns so far (the fired prompt's ordinal). */
  readonly fires: number;
  /** Consecutive fired turns that ended `error`. */
  readonly failures: number;
  /** The turn that created it (audit only, never a rule). */
  readonly createdBy: string;
}

/**
 * What the model (or the user) may ask for: exactly one of `every`/`at`/`daily`
 * (owner Q2: no `cron` in v1) and exactly one of `prompt`/`workflow`. A workflow
 * request reaches `scheduleCreate` only with its `hash` filled by the host.
 */
export interface ScheduleRequest {
  readonly prompt?: string;
  readonly every?: string;
  readonly at?: string;
  readonly daily?: string;
  readonly workflow?: {
    readonly name: string;
    readonly inputs: readonly ScheduleWorkflowInput[];
    readonly hash?: string;
  };
}

const MINUTE_MS = 60_000;

/**
 * `10m` / `2h` / `7d` → ms. Null when the text is not an interval in
 * minutes/hours/days: `90s` is refused on purpose (D2) — a sub-minute wake
 * spends the model's budget without being useful.
 */
export function parseDurationMs(text: string): number | null {
  const match = /^(\d{1,4})([mhd])$/i.exec(text.trim());
  if (match === null) return null;
  const count = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isInteger(count) || count <= 0) return null;
  const ms = count * (unit === "m" ? MINUTE_MS : unit === "h" ? 60 * MINUTE_MS : 86_400_000);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** `86400000` → `1d`, `300000` → `5m`: a limit in the unit the model writes. */
function durationText(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / MINUTE_MS)}m`;
}

/** A parsed `every`/`at`, or why it was refused (the model reads the reason and repairs). */
export type ParsedSpec =
  | {
      readonly ok: true;
      readonly kind: ScheduleKind;
      /** The canonical display text (`every 10m`, `at 2026-11-16T17:00:00+01:00`). */
      readonly spec: string;
      readonly intervalMs?: number;
      readonly daily?: string;
      readonly nextAt: number;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: string };

const DAILY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The next local `HH:MM` strictly after `now`, built from local components (as
 * `parseAtMs` does) so a DST change keeps the wall-clock time. A local time DST
 * skips lands on the first valid instant after it (the `Date` constructor rolls
 * forward); a repeated hour fires once, because the next slot is computed
 * strictly after the fire — on the next day.
 */
export function dailyAfter(hhmm: string, now: number): number {
  const match = DAILY_RE.exec(hhmm);
  const hour = Number(match?.[1] ?? 0);
  const minute = Number(match?.[2] ?? 0);
  const today = new Date(now);
  for (let offset = 0; offset < 3; offset++) {
    const slot = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + offset,
      hour,
      minute,
      0,
    ).getTime();
    if (slot > now) return slot;
  }
  return now + 86_400_000;
}

/**
 * One accepted `at` syntax: a bare date (the host's local midnight), a local
 * date-time (`2026-11-16T17:00`, no offset = the daemon host's zone), or one
 * with an explicit offset. `in 20m` is the relative form.
 */
const AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * `at` → epoch ms. A local wall-clock time is built from its own components
 * (NOT `Date.parse`, which reads a bare date as UTC and a date-time as local —
 * one rule here is worth more than one fewer line), so the round-trip check
 * both validates the date and catches a local time that DST skips.
 */
function parseAtMs(text: string, now: number): number | { readonly reason: string } {
  const relative = /^(?:in)\s+(.+)$/i.exec(text.trim());
  if (relative !== null) {
    const delta = parseDurationMs(relative[1] ?? "");
    if (delta === null) {
      return {
        reason: "at: relative times are `in 20m` / `in 2h` / `in 1d` (minutes, hours, days)",
      };
    }
    return now + delta;
  }
  const match = AT_RE.exec(text.trim());
  if (match === null) {
    return {
      reason:
        "at: give an ISO time (`2026-11-16T17:00`, optional offset) or a relative one (`in 20m`)",
    };
  }
  const [, year, month, day, hour, minute, second, offset] = match;
  const parts = [
    Number(year),
    Number(month),
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  ] as const;
  if (offset !== undefined && hour !== undefined) {
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}${offset === "Z" ? "Z" : offset}`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed)
      ? { reason: `at: ${text.trim()} is not a valid date/time` }
      : parsed;
  }
  const [y, mo, d, h, mi, s] = parts;
  const local = new Date(y, mo - 1, d, h, mi, s);
  if (
    local.getFullYear() !== y ||
    local.getMonth() !== mo - 1 ||
    local.getDate() !== d ||
    local.getHours() !== h ||
    local.getMinutes() !== mi ||
    local.getSeconds() !== s
  ) {
    return { reason: `at: ${text.trim()} is not a valid date/time` };
  }
  return local.getTime();
}

/**
 * `2026-11-16T17:00` in the host's zone — how a resolved relative time is
 * displayed (the row must not keep saying `in 20m`).
 */
function localMinuteText(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The request → kind/next slot/expiry, or the repair sentence. Everything the
 * model can get wrong is answered with a reason, never a silent clamp (D3).
 */
export function parseScheduleSpec(
  request: { readonly every?: string; readonly at?: string; readonly daily?: string },
  now: number,
  limits: ScheduleLimits = DEFAULT_SCHEDULE_LIMITS,
): ParsedSpec {
  const kinds = [request.every, request.at, request.daily].filter(
    (value) => value !== undefined,
  ).length;
  if (kinds !== 1) {
    return {
      ok: false,
      reason:
        "give exactly one of `every` (recurring, 1m..7d, e.g. every 10m), `at` " +
        "(one-shot, an ISO time or `in 20m`) or `daily` (every day at a local time, " +
        "e.g. 03:00) — not two, not none",
    };
  }
  if (request.daily !== undefined) {
    const daily = request.daily.trim();
    if (!DAILY_RE.test(daily)) {
      return { ok: false, reason: "daily: a local time HH:MM, 24-hour (`03:00`, `18:30`)" };
    }
    return {
      ok: true,
      kind: "daily",
      spec: `daily ${daily}`,
      daily,
      nextAt: dailyAfter(daily, now),
      expiresAt: now + limits.ttlMs,
    };
  }
  if (request.every !== undefined) {
    const intervalMs = parseDurationMs(request.every);
    if (intervalMs === null) {
      return {
        ok: false,
        reason:
          "every: an interval in minutes/hours/days (`10m`, `2h`, `7d`); seconds are not supported",
      };
    }
    if (intervalMs < limits.minIntervalMs || intervalMs > limits.ttlMs) {
      return {
        ok: false,
        reason: `every: the interval must be at least ${durationText(limits.minIntervalMs)} and at most ${durationText(limits.ttlMs)}`,
      };
    }
    return {
      ok: true,
      kind: "every",
      spec: `every ${request.every.trim().toLowerCase()}`,
      intervalMs,
      nextAt: now + intervalMs,
      expiresAt: now + limits.ttlMs,
    };
  }
  const at = request.at ?? "";
  const parsed = parseAtMs(at, now);
  if (typeof parsed !== "number") return { ok: false, reason: parsed.reason };
  if (parsed <= now) {
    return {
      ok: false,
      reason: `at: ${at.trim()} is in the past — it is now ${localMinuteText(now)} here; give a future time, or use \`every <interval>\``,
    };
  }
  if (parsed - now > limits.maxAheadMs) {
    const limit = durationText(limits.maxAheadMs);
    return {
      ok: false,
      reason: `at: the time is more than ${limit} ahead (the limit is ${limit})`,
    };
  }
  return {
    ok: true,
    kind: "at",
    // A relative time is rendered as the instant it resolved to: `at in 20m`
    // would be a lie in a row read five minutes later.
    spec: `at ${/^(?:in)\s+/i.test(at.trim()) ? localMinuteText(parsed) : at.trim()}`,
    nextAt: parsed,
    // A one-shot keeps its grace, so a host that was asleep past its time still
    // fires it once instead of dropping it unseen.
    expiresAt: parsed + limits.ttlMs,
  };
}

/** What `scheduleCreate` answers: the new row and table, or the refusal the model reads. */
export type ScheduleCreateResult =
  | { readonly ok: true; readonly job: ScheduledJob; readonly table: readonly ScheduledJob[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Add one job. The id is minted by the caller (the daemon's `sc-N` counter), so
 * this stays clock- and state-free; the table is REPLACED, never mutated.
 */
export function scheduleCreate(
  table: readonly ScheduledJob[],
  request: ScheduleRequest,
  options: {
    readonly id: string;
    readonly now: number;
    readonly createdBy: string;
    /** The host's `schedules.*` limits; default owner Q6's. */
    readonly limits?: ScheduleLimits;
  },
): ScheduleCreateResult {
  const limits = options.limits ?? DEFAULT_SCHEDULE_LIMITS;
  const spec = parseScheduleSpec(request, options.now, limits);
  if (!spec.ok) return { ok: false, reason: spec.reason };
  if ((request.prompt === undefined) === (request.workflow === undefined)) {
    return {
      ok: false,
      reason:
        "give exactly one of `prompt` (what you are told when it fires) or `workflow` " +
        "(a workflow to start, no turn) — not both, not neither",
    };
  }
  const workflow = request.workflow;
  if (workflow !== undefined && (workflow.hash ?? "") === "") {
    return { ok: false, reason: `workflow: ${workflow.name} could not be checked here` };
  }
  const prompt = (
    workflow === undefined ? (request.prompt ?? "") : workflowLabel(workflow.name, workflow.inputs)
  ).trim();
  if (prompt === "") {
    return {
      ok: false,
      reason: "prompt: say what you should be told when this fires (it is all you get)",
    };
  }
  if (prompt.length > limits.promptMaxChars) {
    return {
      ok: false,
      reason: `prompt: at most ${limits.promptMaxChars} characters (${prompt.length} given) — make it a short instruction`,
    };
  }
  if (table.length >= limits.maxJobs) {
    return {
      ok: false,
      reason: `there are already ${limits.maxJobs} scheduled wakes in this session (the limit) — delete one with schedule_control {action: "delete"}`,
    };
  }
  const job: ScheduledJob = {
    id: options.id,
    kind: spec.kind,
    spec: spec.spec,
    ...(spec.intervalMs === undefined ? {} : { intervalMs: spec.intervalMs }),
    ...(spec.daily === undefined ? {} : { daily: spec.daily }),
    prompt,
    ...(workflow === undefined
      ? {}
      : {
          target: {
            workflow: {
              name: workflow.name,
              inputs: workflow.inputs.map((input) => ({ name: input.name, value: input.value })),
              hash: workflow.hash ?? "",
            },
          },
        }),
    createdAt: options.now,
    // A recurring workflow job has no time expiry (decision 7): it cannot loop
    // on the model; the failure stop, delete and archive bound it.
    expiresAt:
      workflow !== undefined && spec.kind !== "at" ? Number.MAX_SAFE_INTEGER : spec.expiresAt,
    nextAt: spec.nextAt,
    fires: 0,
    failures: 0,
    createdBy: options.createdBy,
  };
  return { ok: true, job, table: [...table, job] };
}

/** A workflow job's row label: what every reader (an older client too) can show. */
export function workflowLabel(name: string, inputs: readonly ScheduleWorkflowInput[]): string {
  return ["workflow", name, ...inputs.map((input) => `${input.name}=${input.value}`)].join(" ");
}

/** The next slot for `every`/`daily` strictly after `now`: missed slots are skipped, never replayed. */
function slotAfter(job: ScheduledJob, now: number): number {
  if (job.kind === "daily") {
    return job.nextAt > now ? job.nextAt : dailyAfter(job.daily ?? "", now);
  }
  const interval = job.intervalMs ?? SCHEDULE_MIN_INTERVAL_MS;
  if (job.nextAt > now) return job.nextAt;
  const missed = Math.floor((now - job.nextAt) / interval) + 1;
  return job.nextAt + missed * interval;
}

export interface ScheduleStep {
  /** The one job to fire now (post-advance: `fires` incremented, `nextAt` moved), or none. */
  readonly due: ScheduledJob | null;
  /** The table after this check — the value to persist and to publish as the row list. */
  readonly table: readonly ScheduledJob[];
  /** Jobs removed because they passed `expiresAt` (the caller notices them). */
  readonly expired: readonly ScheduledJob[];
  /**
   * Workflow jobs later than `SCHEDULE_WORKFLOW_GRACE_MS`: advanced WITHOUT
   * firing (post-advance rows, `last` = missed; a one-shot left the table).
   */
  readonly missed: readonly ScheduledJob[];
}

/**
 * Whether the session can start a fired turn right now. A BUSY check still
 * sweeps expiry, but it must never fire: it leaves every slot untouched, so a
 * job due while a turn runs stays due for the next idle check (D3 "busy →
 * coalesce"). Do not skip the check while busy — the timer's inputs say how to
 * re-arm instead (`scheduleCheckDelayMs`).
 */
export interface ScheduleStepOptions {
  readonly idle: boolean;
}

/**
 * One check of the table against `now`. Pure: it advances the model, and the
 * caller fires what it names (advance BEFORE firing — at-most-once). The
 * idle/busy flag is REQUIRED, not defaulted, on purpose: a caller that forgets
 * it would either spin the timer on a due job or silently burn a slot. Pass
 * `{ idle: false }` while a turn or a compaction holds the slot: expiry is
 * swept, nothing fires, and no slot is lost.
 */
export function scheduleStep(
  table: readonly ScheduledJob[],
  now: number,
  options: ScheduleStepOptions,
): ScheduleStep {
  const kept: ScheduledJob[] = [];
  const expired: ScheduledJob[] = [];
  const missed: ScheduledJob[] = [];
  // Expiry and the back-jump clamp first, in table order (the row order the
  // wire publishes is creation order, not the fire order).
  for (const job of table) {
    if (now >= job.expiresAt) {
      expired.push(job);
      continue;
    }
    // The clock went backwards: unclamped, a 10m job would stall for hours.
    const clamped =
      job.kind === "every" && job.nextAt - now > (job.intervalMs ?? 0)
        ? { ...job, nextAt: now + (job.intervalMs ?? 0) }
        : job.kind === "daily" && job.nextAt - now > DAILY_CLAMP_MS
          ? { ...job, nextAt: dailyAfter(job.daily ?? "", now) }
          : job;
    // A workflow job past its grace is skipped, not caught up (decision 5).
    if (clamped.target !== undefined && now - clamped.nextAt > SCHEDULE_WORKFLOW_GRACE_MS) {
      const last: ScheduleLast = { at: now, outcome: "missed" };
      if (clamped.kind === "at") {
        missed.push({ ...clamped, last });
        continue;
      }
      const advanced: ScheduledJob = { ...clamped, nextAt: slotAfter(clamped, now), last };
      missed.push(advanced);
      kept.push(advanced);
      continue;
    }
    kept.push(clamped);
  }
  // Then the ONE job to fire: the overdue job with the smallest `nextAt` (ties
  // go to table order). Picking the first overdue row instead would let a
  // short-interval job starve every longer one created after it.
  // A WORKFLOW job is eligible while a turn runs (decision 4): a run lives
  // between turns, and a long user turn must not delay the nightly.
  let picked = -1;
  for (let index = 0; index < kept.length; index++) {
    const job = kept[index];
    if (job === undefined || job.nextAt > now) continue;
    if (!options.idle && job.target === undefined) continue;
    const best = picked < 0 ? undefined : kept[picked];
    if (best === undefined || job.nextAt < best.nextAt) picked = index;
  }
  const chosen = picked < 0 ? undefined : kept[picked];
  if (chosen === undefined) return { due: null, table: kept, expired, missed };
  const fired: ScheduledJob = { ...chosen, fires: chosen.fires + 1 };
  if (chosen.kind === "at") {
    // A one-shot leaves the table the moment it fires; nothing to re-arm.
    return { due: fired, table: kept.filter((job) => job !== chosen), expired, missed };
  }
  const advanced: ScheduledJob = { ...fired, nextAt: slotAfter(fired, now) };
  return {
    due: advanced,
    table: kept.map((job) => (job === chosen ? advanced : job)),
    expired,
    missed,
  };
}

/** How a fired turn ended, as far as the job's failure budget cares (`cancelled` = the user's Esc). */
export type ScheduleEnd = "ok" | "error" | "cancelled";

/**
 * The end of a turn that a job fired: count an `error`, reset on a normal end,
 * ignore a cancel — and remove the job at `SCHEDULE_MAX_FAILURES` in a row.
 */
export function scheduleSettled(
  table: readonly ScheduledJob[],
  id: string,
  end: ScheduleEnd,
): { readonly table: readonly ScheduledJob[]; readonly removed: boolean } {
  const job = table.find((candidate) => candidate.id === id);
  if (job === undefined || end === "cancelled") return { table, removed: false };
  if (end === "ok") {
    return {
      table: table.map((candidate) =>
        candidate.id === id ? { ...candidate, failures: 0 } : candidate,
      ),
      removed: false,
    };
  }
  const failures = job.failures + 1;
  if (failures >= SCHEDULE_MAX_FAILURES) {
    return { table: table.filter((candidate) => candidate.id !== id), removed: true };
  }
  return {
    table: table.map((candidate) => (candidate.id === id ? { ...candidate, failures } : candidate)),
    removed: false,
  };
}

/**
 * Record one fire of a workflow job (`last`) and settle its failure budget: an
 * outcome the human must fix counts as an `error`, a started run resets the
 * count (a red nightly is the workflow's verdict, not the schedule's), and a
 * skip or a miss counts nothing (decision 8). `removed` = the failure stop.
 */
export function scheduleRecordFire(
  table: readonly ScheduledJob[],
  id: string,
  last: ScheduleLast,
): { readonly table: readonly ScheduledJob[]; readonly removed: boolean } {
  const recorded = table.map((job) => (job.id === id ? { ...job, last } : job));
  if (last.outcome === "started") return scheduleSettled(recorded, id, "ok");
  if (scheduleOutcomeNeedsHuman(last.outcome)) return scheduleSettled(recorded, id, "error");
  return { table: recorded, removed: false };
}

/** Delete by id. `deleted: false` means the id was not in this session (the model is told). */
export function scheduleDelete(
  table: readonly ScheduledJob[],
  id: string,
): { readonly table: readonly ScheduledJob[]; readonly deleted: boolean } {
  const next = table.filter((job) => job.id !== id);
  return { table: next, deleted: next.length !== table.length };
}

/**
 * The user message text of a fired turn: the job's identity PLUS the prompt.
 * This text is the durable truth (the titled row on screen is display only), so
 * a reload shows exactly what fired.
 */
export function schedulePromptText(job: ScheduledJob): string {
  return `[scheduled ${job.id} · ${job.spec} · fire ${job.fires}] ${job.prompt}`;
}

/**
 * A session's schedule table as its tools see it (docs/feat/cron-tool.md P1):
 * the LAZY link `AgentContext.schedules` returns, owned by the hosted session
 * (so a settings sync, which rebuilds the agent, keeps it). Every method is
 * synchronous. `null` from the link: this runtime does not schedule (a pod).
 */
export interface ScheduleLink {
  /** The host's clock (the one `nextAt` is on), for the tool's "in 10m" texts. */
  now(): number;
  /** Add one job; the id is minted by the session (`sc-N`, never reused). */
  create(request: ScheduleRequest): ScheduleCreateResult;
  /**
   * Add one WORKFLOW job (slice 10): the host validates the file and inputs and
   * pins the current hash (asynchronous: it reads the file). Absent = this
   * runtime runs no workflows.
   */
  createWorkflow?(request: ScheduleRequest): Promise<ScheduleCreateResult>;
  /** The live table, in creation order. */
  list(): readonly ScheduledJob[];
  /** Remove one job by id; `false` when it is not in this session. */
  delete(id: string): boolean;
}

/** The earliest armed slot, or null for an empty table (the daemon arms nothing). */
export function nextDueAt(table: readonly ScheduledJob[]): number | null {
  let earliest: number | null = null;
  for (const job of table) {
    if (earliest === null || job.nextAt < earliest) earliest = job.nextAt;
  }
  return earliest;
}

/**
 * How long the daemon's ONE timer should wait: to the next slot, capped at
 * `SCHEDULE_CHECK_INTERVAL_MS`, floored at 0 (overdue = check now).
 *
 * The idle/busy flag is REQUIRED, not defaulted: forgetting it is exactly the
 * spin below. While the session is BUSY (`{ idle: false }`) an overdue job
 * cannot fire, so the answer is a full check interval — never 0, which would
 * spin `setTimeout(0)` on every check for as long as the turn runs. The timer is
 * re-armed at the turn's end anyway (`kickWake`), so a slow poll while busy is
 * all that is needed.
 */
export function scheduleCheckDelayMs(
  table: readonly ScheduledJob[],
  now: number,
  options: ScheduleStepOptions,
): number | null {
  const next = nextDueAt(table);
  if (next === null) return null;
  if (!options.idle) {
    // Only a workflow job can fire while busy: wait for the next one of those.
    const workflowNext = nextDueAt(table.filter((job) => job.target !== undefined));
    return workflowNext === null
      ? SCHEDULE_CHECK_INTERVAL_MS
      : Math.min(Math.max(workflowNext - now, 0), SCHEDULE_CHECK_INTERVAL_MS);
  }
  return Math.min(Math.max(next - now, 0), SCHEDULE_CHECK_INTERVAL_MS);
}

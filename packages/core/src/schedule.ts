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
 * The daemon re-arms its one timer to at most this: a sleep, a clock jump or a
 * long delay is noticed within 60 s, and the timer never meets `setTimeout`'s
 * 2³¹-ms limit.
 */
export const SCHEDULE_CHECK_INTERVAL_MS = 60_000;

/** How a job repeats: a fixed interval, or never (`at` = one-shot). */
export type ScheduleKind = "every" | "at";

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
  /** What the fired turn is told. Self-sufficient on purpose: the context may be compacted by then. */
  readonly prompt: string;
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

/** What the model may ask for. Exactly one of `every`/`at` (owner Q2: no `cron` in v1). */
export interface ScheduleRequest {
  readonly prompt: string;
  readonly every?: string;
  readonly at?: string;
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

/** A parsed `every`/`at`, or why it was refused (the model reads the reason and repairs). */
export type ParsedSpec =
  | {
      readonly ok: true;
      readonly kind: ScheduleKind;
      /** The canonical display text (`every 10m`, `at 2026-11-16T17:00:00+01:00`). */
      readonly spec: string;
      readonly intervalMs?: number;
      readonly nextAt: number;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: string };

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
  request: { readonly every?: string; readonly at?: string },
  now: number,
): ParsedSpec {
  const kinds = [request.every, request.at].filter((value) => value !== undefined).length;
  if (kinds !== 1) {
    return {
      ok: false,
      reason:
        "give exactly one of `every` (recurring, 1m..7d, e.g. every 10m) or `at` " +
        "(one-shot, an ISO time or `in 20m`) — not both, not neither",
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
    if (intervalMs < SCHEDULE_MIN_INTERVAL_MS || intervalMs > SCHEDULE_MAX_INTERVAL_MS) {
      return { ok: false, reason: "every: the interval must be at least 1m and at most 7d" };
    }
    return {
      ok: true,
      kind: "every",
      spec: `every ${request.every.trim().toLowerCase()}`,
      intervalMs,
      nextAt: now + intervalMs,
      expiresAt: now + SCHEDULE_TTL_MS,
    };
  }
  const at = request.at ?? "";
  const parsed = parseAtMs(at, now);
  if (typeof parsed !== "number") return { ok: false, reason: parsed.reason };
  if (parsed <= now) {
    return {
      ok: false,
      reason: `at: ${at.trim()} is in the past — give a future time, or use \`every <interval>\``,
    };
  }
  if (parsed - now > SCHEDULE_MAX_AHEAD_MS) {
    return { ok: false, reason: "at: the time is more than 7d ahead (the limit is 7d)" };
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
    expiresAt: parsed + SCHEDULE_TTL_MS,
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
  options: { readonly id: string; readonly now: number; readonly createdBy: string },
): ScheduleCreateResult {
  const spec = parseScheduleSpec(request, options.now);
  if (!spec.ok) return { ok: false, reason: spec.reason };
  const prompt = request.prompt.trim();
  if (prompt === "") {
    return {
      ok: false,
      reason: "prompt: say what you should be told when this fires (it is all you get)",
    };
  }
  if (prompt.length > SCHEDULE_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `prompt: at most ${SCHEDULE_PROMPT_MAX_CHARS} characters (${prompt.length} given) — make it a short instruction`,
    };
  }
  if (table.length >= SCHEDULE_MAX_JOBS) {
    return {
      ok: false,
      reason: `there are already ${SCHEDULE_MAX_JOBS} scheduled wakes in this session (the limit) — delete one with schedule_control {action: "delete"}`,
    };
  }
  const job: ScheduledJob = {
    id: options.id,
    kind: spec.kind,
    spec: spec.spec,
    ...(spec.intervalMs === undefined ? {} : { intervalMs: spec.intervalMs }),
    prompt,
    createdAt: options.now,
    expiresAt: spec.expiresAt,
    nextAt: spec.nextAt,
    fires: 0,
    failures: 0,
    createdBy: options.createdBy,
  };
  return { ok: true, job, table: [...table, job] };
}

/** The next slot for `every` strictly after `now`: missed slots are skipped, never replayed. */
function slotAfter(job: ScheduledJob, now: number): number {
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
}

/**
 * One check of the table against `now`. Pure: it advances the model, and the
 * caller fires what it names (advance BEFORE firing — at-most-once).
 */
export function scheduleStep(table: readonly ScheduledJob[], now: number): ScheduleStep {
  const kept: ScheduledJob[] = [];
  const expired: ScheduledJob[] = [];
  let due: ScheduledJob | null = null;
  for (const job of table) {
    if (now >= job.expiresAt) {
      expired.push(job);
      continue;
    }
    // The clock went backwards: unclamped, a 10m job would stall for hours.
    const clamped =
      job.kind === "every" && job.nextAt - now > (job.intervalMs ?? 0)
        ? { ...job, nextAt: now + (job.intervalMs ?? 0) }
        : job;
    if (due !== null || clamped.nextAt > now) {
      kept.push(clamped);
      continue;
    }
    const fired: ScheduledJob = { ...clamped, fires: clamped.fires + 1 };
    if (job.kind === "at") {
      // A one-shot leaves the table the moment it fires; nothing to re-arm.
      due = fired;
      continue;
    }
    due = { ...fired, nextAt: slotAfter(fired, now) };
    kept.push(due);
  }
  return { due, table: kept, expired };
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
 */
export function scheduleCheckDelayMs(table: readonly ScheduledJob[], now: number): number | null {
  const next = nextDueAt(table);
  if (next === null) return null;
  return Math.min(Math.max(next - now, 0), SCHEDULE_CHECK_INTERVAL_MS);
}

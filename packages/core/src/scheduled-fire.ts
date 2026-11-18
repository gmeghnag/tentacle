/**
 * A fired scheduled wake as a timeline row (docs/feat/scheduled-fire-row.md):
 * `Wake 15:54 · <prompt>`. Pure, in core so the TUI and the phone share ONE
 * decision, and live = reload by construction: the row is derived from the
 * fired message itself (its `scheduled` field, or its durable text prefix),
 * never from a live-only ref.
 */

/**
 * The daemon's record of one fire, stamped when it actually fired
 * (`HostedSession.fireSchedule`). `at` is that instant (epoch ms, the
 * daemon's clock); `fire` the job's ordinal. Display only: it rides the
 * user `ChatMessage` the fire produces (fail-soft) and the live
 * `turn_start.schedule` ref, and the model never sees it.
 */
export interface ScheduledFire {
  readonly id: string;
  readonly spec: string;
  readonly fire: number;
  readonly at: number;
}

/** What a client may hold for a fired turn: the full record, or an older daemon's `{id, spec}` ref. */
export interface ScheduledRef {
  readonly id: string;
  readonly spec: string;
  readonly fire?: number;
  readonly at?: number;
}

/** The parts of `schedulePromptText`'s output, or null for any other text. */
export interface ScheduledPrompt {
  readonly id: string;
  readonly spec: string;
  readonly fire: number;
  readonly prompt: string;
}

/** A spec shown as the row's time is bounded: a free `at …` string is the model's. */
const SPEC_SHOWN_MAX = 32;

const PROMPT_PREFIX = /^\[scheduled (\S+) · (.+?) · fire (\d+)\] /;

/**
 * The inverse of `schedulePromptText` (`[scheduled sc-1 · every 10m · fire 5] …`):
 * anchored and strict, the prompt is the rest verbatim (any `]`, ` · ` or
 * newline in it is kept). Anything else is an ordinary message → null.
 */
export function scheduledPromptOf(text: string): ScheduledPrompt | null {
  const match = PROMPT_PREFIX.exec(text);
  if (match === null) {
    return null;
  }
  const [head, id = "", spec = "", fire = ""] = match;
  return { id, spec, fire: Number(fire), prompt: text.slice(head.length) };
}

/** The fired row's view: its time slot and the prompt (full; the renderer collapses it). */
export interface FiredWakeView {
  /** `15:54` / `17 Nov 15:54` (the fire instant), else the fallback of an older message. */
  readonly when: string;
  readonly prompt: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `15:54` when `date` is `today`, else `17 Nov 15:54` (owner Q5). */
function shortTime(
  date: { y: number; m: number; d: number; hh: number; mm: number },
  today: { y: number; m: number; d: number },
): string {
  const clock = `${pad2(date.hh)}:${pad2(date.mm)}`;
  if (date.y === today.y && date.m === today.m && date.d === today.d) {
    return clock;
  }
  return `${date.d} ${MONTHS[date.m - 1] ?? "?"} ${clock}`;
}

function localParts(ms: number): { y: number; m: number; d: number; hh: number; mm: number } {
  const t = new Date(ms);
  return {
    y: t.getFullYear(),
    m: t.getMonth() + 1,
    d: t.getDate(),
    hh: t.getHours(),
    mm: t.getMinutes(),
  };
}

/** A real instant, in the viewer's local clock: `15:54` today, `17 Nov 15:54` another day. */
export function wakeTimeText(at: number, now: number): string {
  return shortTime(localParts(at), localParts(now));
}

const AT_LOCAL_MINUTE = /^at (\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * An older message's time slot (no `scheduled` field): an `at` spec's own
 * wall-clock minute, reformatted as a STRING (never `new Date()`d: it has no
 * zone); `every …` → `#N` (no instant was ever recorded); any other shape →
 * the spec as given, bounded — never a guessed time.
 */
export function scheduleFallbackWhen(spec: string, fire: number, now: number): string {
  const at = AT_LOCAL_MINUTE.exec(spec);
  if (at !== null) {
    const [, y, m, d, hh, mm] = at.map(Number);
    return shortTime(
      { y: y ?? 0, m: m ?? 0, d: d ?? 0, hh: hh ?? 0, mm: mm ?? 0 },
      localParts(now),
    );
  }
  if (spec.startsWith("every ")) {
    return `#${fire}`;
  }
  const given = spec.startsWith("at ") ? spec.slice(3) : spec;
  const line = given.replace(/\s+/g, " ").trim();
  return line.length > SPEC_SHOWN_MAX ? `${line.slice(0, SPEC_SHOWN_MAX - 1)}…` : line;
}

function isInstant(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * The fired row a user message stands for, or null (an ordinary message).
 * Structural first (`scheduled`, the instant the daemon fired it), the
 * durable text prefix as the fallback (an older log, an older daemon) — the
 * `compactionOf` shape. The prompt is always the text minus the prefix.
 */
export function firedWakeOf(
  text: string,
  scheduled: ScheduledRef | undefined,
  now: number,
): FiredWakeView | null {
  const parsed = scheduledPromptOf(text);
  if (scheduled !== undefined && isInstant(scheduled.at)) {
    return { when: wakeTimeText(scheduled.at, now), prompt: parsed?.prompt ?? text };
  }
  if (parsed === null) {
    return null;
  }
  return { when: scheduleFallbackWhen(parsed.spec, parsed.fire, now), prompt: parsed.prompt };
}

/** The collapsed row's text: `Wake 15:54 · <the prompt on one line>` (the renderer truncates). */
export function firedWakeLine(view: FiredWakeView): string {
  const prompt = view.prompt.replace(/\s+/g, " ").trim();
  return prompt === "" ? `Wake ${view.when}` : `Wake ${view.when} · ${prompt}`;
}

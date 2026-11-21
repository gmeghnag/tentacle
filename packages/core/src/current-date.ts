/**
 * The model's "now" (docs/fix/prompt-current-date.md): a short
 * `[Fri 2026-11-20 13:42 CET]` line prefixed to a USER message when the model's
 * sense of the current time would otherwise be stale — the first message of a
 * session, the local day changing since the last stamp, or more than
 * `DATE_STAMP_MAX_AGE_MS` since the LAST STAMP (never only since the last
 * message: in a long burst the model's "now" must not drift).
 *
 * The line lives in the history as DATA (`ChatMessage.dateStamp`), never in
 * `content`: the agent loop renders it into the model's copy on every request
 * (`renderForModel`, the `contextUsage` shape), so a stamp the model once saw
 * stays in its prompt byte for byte (a stable cache prefix) while every reader
 * of `content` (the TUI, titles, hooks, steer matching) keeps the clean text.
 *
 * Pure and React-free: the loop/daemon decides WHEN with these functions.
 */

/**
 * How stale the model's "now" may get: since the LAST STAMP, not the last
 * message (owner decision, TODO.md 2026-11-20).
 */
export const DATE_STAMP_MAX_AGE_MS = 30 * 60_000;

/** An instant, and the IANA zone it must be rendered in (the LAPTOP's, never the pod's UTC). */
export interface DateStamp {
  readonly at: number;
  readonly zone: string;
}

/**
 * The zone to render in: `zone` when the runtime knows it, else the host's own
 * (an unknown zone from a client must never break a turn — and is never an
 * `InvalidParams` at `initialize`).
 */
export function zoneOrDefault(zone: string | undefined): string {
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone === undefined || zone === "") {
    return host;
  }
  try {
    // Throws RangeError for a zone this runtime does not know.
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return host;
  }
}

/**
 * The parts of `at` in `zone`, from ONE formatter with explicit fields:
 * never `toLocaleString`, whose comma/order shape varies by locale and runtime.
 */
function partsOf(
  at: number,
  zone: string,
): {
  weekday: string;
  date: string;
  time: string;
  zoneName: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone: zone,
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    zoneName: get("timeZoneName"),
  };
}

/** The line the model sees, e.g. `[Fri 2026-11-20 13:42 CET]`. */
export function dateStampText(stamp: DateStamp): string {
  const { weekday, date, time, zoneName } = partsOf(stamp.at, zoneOrDefault(stamp.zone));
  return `[${weekday} ${date} ${time} ${zoneName}]`;
}

/** What `renderForModel` prepends to the model's copy of a stamped message. */
export function dateStampPrefix(stamp: DateStamp): string {
  return `${dateStampText(stamp)}\n`;
}

/** The latest stamp in `history`, if any — the counting state, never stored apart. */
export function lastDateStamp(
  history: readonly { readonly dateStamp?: DateStamp }[],
): DateStamp | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const stamp = history[i]?.dateStamp;
    if (stamp !== undefined) {
      return stamp;
    }
  }
  return undefined;
}

/**
 * The stamp a message sent NOW must carry, or `null` when the model's sense of
 * the time is still fresh: nothing stamped yet (a first message, or a resume
 * from a log with none), the local DAY in `zone` changed since the last stamp,
 * or more than `DATE_STAMP_MAX_AGE_MS` since it. A clock that went backwards
 * (`now <= last.at`) re-stamps only on a day change — never a negative age.
 */
export function nextDateStamp(
  history: readonly { readonly dateStamp?: DateStamp }[],
  now: number,
  zone: string | undefined,
): DateStamp | null {
  const resolved = zoneOrDefault(zone);
  const last = lastDateStamp(history);
  if (last === undefined) {
    return { at: now, zone: resolved };
  }
  const today = partsOf(now, resolved).date;
  const lastDay = partsOf(last.at, resolved).date;
  if (today !== lastDay || now - last.at > DATE_STAMP_MAX_AGE_MS) {
    return { at: now, zone: resolved };
  }
  return null;
}

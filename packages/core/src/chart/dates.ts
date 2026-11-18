/**
 * ISO dates for charts, parsed with three honest KINDS (docs/feat/model-charts.md
 * D4, `dates.ts`). Pure: no I/O, no React, no locale.
 *
 * - **calendar** (`2026-03`, `2026-03-01`) — a day on a wall calendar, not an
 *   instant. Never shifted: a chart plots `2026-03-01` the same in Rome and in
 *   Tokyo, so the reader is never a day off.
 * - **instant** (`…Z`, `…+01:00`) — a real point in time; plotted on elapsed
 *   time, so a DST day is 23 or 25 hours long and the line stays proportional.
 * - **floating** (`2026-03-01T14:00`, no offset) — shown exactly as written,
 *   because the writer did not say which zone they meant.
 *
 * Mixing kinds in one chart is meaningless (a calendar day has no position
 * relative to an instant), so validation refuses it rather than guess.
 */

/** How a label names a date. */
export type DateKind = "calendar" | "instant" | "floating";

/** The finest field the label actually wrote (drives the tick/axis wording). */
export type DateGranularity = "year" | "month" | "day" | "minute" | "second";

/** A parsed ISO date label. */
export interface ParsedDate {
  /** The label exactly as the model wrote it. */
  readonly raw: string;
  readonly kind: DateKind;
  readonly granularity: DateGranularity;
  /** Milliseconds since the epoch (UTC for calendar/floating, real for instant). */
  readonly ms: number;
}

/** Longer than any accepted form (`2026-03-01T14:00:00.000+01:00` is 29). */
const LONGEST_ISO_DATE = 32;

const CALENDAR = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const TIME = "(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?";
const INSTANT = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})[T ]${TIME}(Z|[+-]\\d{2}:\\d{2})$`);
const FLOATING = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})[T ]${TIME}$`);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function inRange(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/**
 * Parse a label as an ISO date, or `null` when it is not one (the caller turns
 * that into the sentence the model reads).
 */
export function parseIsoDate(raw: string): ParsedDate | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > LONGEST_ISO_DATE) return null;

  const calendar = CALENDAR.exec(raw);
  if (calendar) {
    const [year, month, day] = [Number(calendar[1]), Number(calendar[2]), Number(calendar[3] ?? 1)];
    if (!inRange(year, month, day, 0, 0, 0)) return null;
    return {
      raw,
      kind: "calendar",
      granularity: calendar[3] === undefined ? "month" : "day",
      ms: Date.UTC(year, month - 1, day),
    };
  }

  for (const [pattern, kind] of [
    [FLOATING, "floating"],
    [INSTANT, "instant"],
  ] as const) {
    const m = pattern.exec(raw);
    if (!m) continue;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    if (!inRange(year, month, day, hour, minute, second)) return null;
    const millis = Number((m[7] ?? "0").padEnd(3, "0"));
    const granularity: DateGranularity = m[6] === undefined ? "minute" : "second";
    const ms =
      kind === "instant"
        ? Date.parse(raw.replace(" ", "T"))
        : Date.UTC(year, month - 1, day, hour, minute, second, millis);
    if (!Number.isFinite(ms)) return null;
    return { raw, kind, granularity, ms };
  }

  return null;
}

/**
 * The parsed labels of one chart, or `null` when any label is not an ISO date
 * (so the caller can name the first offender). Kinds are not mixed here — see
 * {@link mixedDateKinds}.
 */
export function parseIsoDates(raws: readonly unknown[]): ParsedDate[] | null {
  const out: ParsedDate[] = [];
  for (const raw of raws) {
    if (typeof raw !== "string") return null;
    const parsed = parseIsoDate(raw);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** The first kind that differs from the first label's, if the labels mix kinds. */
export function mixedDateKinds(
  dates: readonly ParsedDate[],
): { first: DateKind; other: DateKind } | null {
  const first = dates[0];
  if (!first) return null;
  const other = dates.find((d) => d.kind !== first.kind);
  return other ? { first: first.kind, other: other.kind } : null;
}

/**
 * Positions in `0..1` for plotting: proportional to elapsed time, so a DST day
 * is 23/25 hours and calendar days are exactly one apart. All equal → `0.5`
 * (a single point, or every label the same) rather than a division by zero.
 */
export function datePositions(dates: readonly ParsedDate[]): number[] {
  if (dates.length === 0) return [];
  const times = dates.map((d) => d.ms);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  if (hi === lo) return times.map(() => 0.5);
  return times.map((t) => (t - lo) / (hi - lo));
}

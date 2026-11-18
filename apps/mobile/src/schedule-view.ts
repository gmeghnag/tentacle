/**
 * The iPhone's scheduled-wakes wording (docs/feat/cron-tool.md S6, D8's M7/M8),
 * pure and React-free (AGENTS §7): the Session-info row, the session list's
 * count, and a fired turn's bubble head. `SessionInfoSheet.tsx`,
 * `TranscriptRow.tsx` and `session-list.ts` only place these strings.
 *
 * Every string here came from a MODEL (`spec`/`prompt`) or from a daemon's claim
 * (`id`), so each is made ONE line, its control characters removed, and bounded
 * BEFORE it is painted — the client already bounded what it forwards
 * (`client/schedules.ts`), and this is the phone's own gate, the rule
 * `sanitizeDisplay` applies to every other daemon string in the sheet.
 */
import { type ScheduledRef, firedWakeOf } from "@tentacle/core";
import type { ScheduleRow } from "@tentacle/protocol";
import { sanitizeDisplay } from "./session-info.ts";

/** The longest a row's title or meta may be on the phone (the client's own cap is 200). */
export const SCHEDULE_LABEL_MAX = 80;

/** Control characters (C0/C1 + DEL) become ONE space: a terminal's problem, and a lie about width. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** One label, safe to paint: no controls, no bidi, one line, bounded. */
export function scheduleLabel(text: string, max: number = SCHEDULE_LABEL_MAX): string {
  const clean = sanitizeDisplay(text.replace(CONTROL, " "));
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A clock in the VIEWER's zone (`14:30`): the row carries epoch ms, so each device renders its own. */
function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `today 17:00` when it is this device's own day, else the day and its month (`6 Dec 17:00`). */
function dayTime(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? `today ${clock(at)}`
    : `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${clock(at)}`;
}

/** The row's title: the wake's own prompt (a label — the fired turn's text is the truth). */
export function scheduleTitle(row: ScheduleRow): string {
  return scheduleLabel(row.prompt);
}

/**
 * The row's subtitle (M7): a recurring wake names its spec, its next fire and how
 * many times it has fired (`every 10m · next 14:30 · 4×`); a one-shot names its
 * own day and time and the word `one-shot`, NEVER a `×` — it fires once.
 *
 * A one-shot does not repeat its `spec`: `at 17:00` next to `today 17:00` is the
 * same fact twice, and the RENDERED time is the one in the person's own zone.
 */
export function scheduleMetaText(row: ScheduleRow, now: number): string {
  return row.kind === "every"
    ? `${scheduleLabel(row.spec, 40)} · next ${clock(row.nextAt)} · ${row.fires}×`
    : `${dayTime(row.nextAt, now)} · one-shot`;
}

/** The session list's badge (M8): `1 wake` / `2 wakes`, and `""` at none (no badge is drawn). */
export function wakesBadge(count: number): string {
  if (count <= 0) {
    return "";
  }
  return count === 1 ? "1 wake" : `${count} wakes`;
}

/** The session list's META line (the words a person actually reads, `session-groups.ts`). */
export function wakesMeta(count: number): string {
  return wakesBadge(count);
}

/** How long the fired row's one-line summary may be (the node line cuts it further). */
export const FIRED_HEAD_MAX = 80;

/** A fired scheduled wake as a timeline node: what `FiredRowView` draws. */
export interface FiredRow {
  /** `Wake 15:54` (the fire time; `#5` / the spec for an older message). */
  readonly name: string;
  /** The prompt on one line (collapsed, the default). */
  readonly subtitle: string;
  /** The prompt in full, shown only when tapped open. */
  readonly body: string;
  readonly a11yLabel: string;
}

/**
 * A user message that a scheduled wake fired, as a timeline node
 * (docs/feat/scheduled-fire-row.md): `◷ Wake 15:54 · <prompt…>`, ALWAYS
 * collapsed until tapped, never a bubble. The SAME decision live
 * (`schedule` = the trust-gated `turn_start.schedule` ref) and reloaded
 * (`schedule` = `ChatMessage.scheduled`): `firedWakeOf` reads the record first
 * and the durable `[scheduled …]` prefix as the fallback. Not a fired message
 * → null (the ordinary bubble).
 */
export function firedRowView(
  text: string,
  schedule: ScheduledRef | undefined,
  now: number,
): FiredRow | null {
  const view = firedWakeOf(text, schedule, now);
  if (view === null) {
    return null;
  }
  const name = scheduleLabel(`Wake ${view.when}`, FIRED_HEAD_MAX);
  const subtitle = scheduleLabel(view.prompt.replace(/\s+/g, " ").trim(), FIRED_HEAD_MAX);
  return {
    name,
    subtitle,
    // In full, as the ordinary bubble shows a message's text (an RN `<Text>`
    // paints no escapes); only the one-line labels are sanitized and cut.
    body: view.prompt,
    a11yLabel: subtitle === "" ? name : `${name}: ${subtitle}`,
  };
}

/** An id as a row's delete control names it (the wire bounds it at 64; a screen bounds it harder). */
export function scheduleIdLabel(id: string): string {
  return scheduleLabel(id, 24);
}

/** What an unprintable id falls back to, so a row still has a key (`""` is no identity). */
const WAKE_KEY = "wake";

/**
 * Each wake's row KEY (S6 fix round 1): the wake's own id, never its title.
 *
 * The title is the sanitized prompt, and nothing in core stops two wakes from
 * sharing one — `check CI` every 10m plus a one-shot `check CI` at 17:00 is a
 * perfectly legal table. A React key, the sheet's expansion state or a flow's
 * testID built from that title then collides, so a repaint (a delete, or a fire
 * changing `fires`/`nextAt`) can drop or duplicate rows, and a tap on the shared
 * testID is ambiguous.
 *
 * The id is bounded and sanitized like every other label here
 * (`scheduleIdLabel`), so it can ride into a testID and an accessibility label.
 * A repeated (or unprintable) label gets an ordinal: uniqueness is the contract,
 * and a daemon that repeats an id must not collapse a row.
 *
 * Returns each row WITH its key, so a caller never indexes one list by the
 * other's position (and never falls back to a raw, unpaintable id).
 */
export function keyedScheduleRows(
  rows: readonly ScheduleRow[],
): { readonly row: ScheduleRow; readonly key: string }[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const label = scheduleIdLabel(row.id);
    const base = label === "" ? WAKE_KEY : label;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return { row, key: ordinal === 1 ? base : `${base}#${ordinal}` };
  });
}

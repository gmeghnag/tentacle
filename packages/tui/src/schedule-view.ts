/**
 * The session's scheduled wakes as the TUI paints them (docs/feat/cron-tool.md
 * S5, D8's M2/M3/M4/M6): the dock row, the pill's word, the `/schedule` panel
 * with its cursor and delete, the fired turn's head, the quit warning, and the
 * notice a vanished row leaves.
 *
 * Pure: no React, no I/O, no clock of its own (`now` is always a parameter).
 * Every string here came from a MODEL on its way to a terminal (`spec`/`prompt`
 * are the daemon's labels; the id is a daemon's claim, AGENTS §7), so each is
 * `oneLine`d and cut in CELLS before it is painted — never left to Ink to wrap.
 */
import { cellWidth, truncateCells } from "./cells.ts";
import { oneLine, paletteWindow } from "./commands.ts";
import { formatDuration } from "./format.ts";
import { type PanelKeyState, type PanelView, fit, noteView } from "./tree-panel.ts";

/** The dock's title column, as a sub-agent row's (`background-list.ts`'s cap). */
export const SCHEDULE_TITLE_COLS = 56;
/** An id as a row's paint cuts it: the wire's bound has no say over a terminal's cells. */
export const SCHEDULE_QUIT_ID_MAX = 12;
/** The fired head's own cap: it rides ONE transcript row above the prompt. */
export const SCHEDULE_HEAD_MAX = 120;
/** A departure notice names an id; a hostile one is cut here, never wrapped. */
const NOTICE_ID_MAX = 40;

/**
 * One scheduled wake, as this TUI reads it. STRUCTURAL on purpose: the TUI
 * mirrors the wire types instead of importing `@tentacle/protocol`
 * (`background-view.ts`'s rule), so this is `ScheduleRow`'s shape and nothing
 * more.
 */
export interface ScheduleDockRow {
  readonly id: string;
  /** `every`, `at`, or a newer build's kind: painted as sent. */
  readonly kind: string;
  /** The request as the model gave it (`every 10m`): a one-line label. */
  readonly spec: string;
  /** What the fired turn is told: a label, never the truth. */
  readonly prompt: string;
  /** The next fire, on the daemon host's clock. */
  readonly nextAt: number;
  /** Absent for a one-shot. */
  readonly expiresAt?: number;
  readonly fires: number;
  readonly createdAt: number;
}

export interface SchedulesState {
  readonly cursor: number;
  /** The id a first `x` armed for deletion, or null. */
  readonly armed: string | null;
}

export const SCHEDULES_START: SchedulesState = { cursor: 0, armed: null };

/** The months a row's expiry names (`6 Dec`): English, as every other row here. */
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

/** A day and its month, in the VIEWER's zone (`6 Dec`), never a fixed month. */
function dayMonth(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`.trim();
}

/** The dock's title column: the prompt, one line, cut in cells. */
export function scheduleTitle(row: ScheduleDockRow): string {
  return truncateCells(oneLine(row.prompt), SCHEDULE_TITLE_COLS);
}

/** A clock in the VIEWER's zone (the rows carry epoch ms, so each client renders its own). */
function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `in 9m` / `in 2h 29m` / `now`, for a row's distance from `now`. */
function distance(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) {
    return "now";
  }
  return `in ${formatDuration(Math.floor(ms / 1000))}`;
}

/**
 * A row's right-hand figure (M2): `every 10m · next 14:30 · 4×` for a recurring
 * wake, `at 17:00 · in 2h 29m` for a one-shot (which fires once, so it has no
 * `×`). `spec` is the model's text, so it is `oneLine`d first.
 */
export function scheduleMeta(row: ScheduleDockRow, now: number): string {
  const spec = oneLine(row.spec);
  return row.kind === "every"
    ? `${spec} · next ${clock(row.nextAt)} · ${row.fires}×`
    : `${spec} · ${distance(row.nextAt, now)}`;
}

/** The pill's word for the armed wakes: `""` at none, `1 sched`, `2 sched`. */
export function schedulesLabel(count: number): string {
  return count <= 0 ? "" : `${count} sched`;
}

/** The rows a panel paints, in the daemon's order (creation order). */
export function scheduleRows(
  rows: readonly ScheduleDockRow[] | undefined,
): readonly ScheduleDockRow[] {
  return rows ?? [];
}

/** One wake's summary line (the row the cursor walks), in the panel's grammar. */
function summaryRow(row: ScheduleDockRow, now: number, selected: boolean): string {
  // `sc-1  every 10m   next 14:30 (in 9m)   fired 4×   expires 22 Nov`
  const expires = row.expiresAt === undefined ? "" : `   expires ${dayMonth(row.expiresAt)}`;
  return [
    selected ? "❯ " : "  ",
    fit(oneLine(row.id), 10).padEnd(10),
    fit(oneLine(row.spec), 12).padEnd(12),
    `next ${clock(row.nextAt)} (${distance(row.nextAt, now)})`.padEnd(26),
    row.kind === "every" ? `fired ${row.fires}×` : "one-shot",
    expires,
  ].join(" ");
}

/** One wake's quoted prompt, under its summary: a `child` row, never walked. */
function promptRow(row: ScheduleDockRow, selected: boolean): string {
  return `  ${" ".repeat(8)}"${oneLine(row.prompt)}"`;
}

/**
 * The `/schedule` panel: one summary row per wake plus its quoted prompt, or the
 * honest placeholder. `undefined` (the daemon never reported a table: a pod, an
 * older daemon) and `[]` (a real answer: nothing is armed) are DIFFERENT states
 * — a claim needs a report (`background-view.ts`'s rule).
 */
export function schedulesView(
  rows: readonly ScheduleDockRow[] | undefined,
  state: SchedulesState,
  now: number,
  width: number,
  maxBody: number,
): PanelView {
  if (rows === undefined) {
    return noteView("Scheduled wakes", "not supported by this computer's tentacle", width);
  }
  if (rows.length === 0) {
    return noteView("Scheduled wakes", "No scheduled wakes in this session.", width);
  }
  const cursor = Math.min(Math.max(0, state.cursor), rows.length - 1);
  // The window moves by WAKES (two lines each), so a wake is never split.
  const perWake = 2;
  const budget = Math.max(1, Math.floor(maxBody / perWake));
  const win = paletteWindow(rows.length, cursor, budget);
  const hint =
    state.armed === null
      ? `↑↓ select · x delete · esc close${
          win.end - win.start < rows.length
            ? ` · ${win.start + 1}–${win.end} of ${rows.length}`
            : ""
        }`
      : `delete ${fit(oneLine(state.armed), SCHEDULE_QUIT_ID_MAX)}? x again · esc cancel`;
  const out: { text: string; kind: "head" | "child"; selected: boolean }[] = [];
  for (let i = win.start; i < win.end; i += 1) {
    const row = rows[i];
    if (row === undefined) {
      continue;
    }
    const selected = i === cursor;
    out.push({ text: fit(summaryRow(row, now, selected), width), kind: "head", selected });
    out.push({ text: fit(promptRow(row, selected), width), kind: "child", selected: false });
  }
  return {
    title: `Scheduled wakes (${rows.length})`,
    rows: out,
    hint,
    start: win.start,
  };
}

/**
 * The panel's state over a NEW table (`refreshedSessions`' counterpart, fix round
 * 1 finding 2): the cursor kept in range — a wake that left must not leave the
 * cursor past the end, or the next `x` would address a row that is gone — and an
 * arm dropped when the row it names is no longer there (an arm must never be
 * able to delete a ghost).
 */
export function refreshedSchedules(
  state: SchedulesState,
  rows: readonly ScheduleDockRow[] | undefined,
): SchedulesState {
  const count = rows?.length ?? 0;
  const cursor = count === 0 ? 0 : Math.min(Math.max(0, state.cursor), count - 1);
  const still = state.armed !== null && (rows ?? []).some((row) => row.id === state.armed);
  return { cursor, armed: still ? state.armed : null };
}

export type ScheduleKeyAction = "up" | "down" | "delete" | "close" | "none";

/**
 * `/schedule`'s keys: the flat-list grammar `/sessions` uses, minus Enter — a
 * wake has no second surface to open (the prompt is already quoted under it).
 */
export function scheduleKey(input: string, key: PanelKeyState): ScheduleKeyAction {
  if (key.escape === true || input === "q") {
    return "close";
  }
  if (key.upArrow === true) {
    return "up";
  }
  if (key.downArrow === true) {
    return "down";
  }
  if (input === "x") {
    return "delete";
  }
  return "none";
}

/** The state after a move (wrapping, as the other flat list does); a move disarms. */
export function schedulesMove(
  state: SchedulesState,
  action: "up" | "down",
  count: number,
): SchedulesState {
  if (count <= 0) {
    return SCHEDULES_START;
  }
  const cursor = Math.min(Math.max(0, state.cursor), count - 1);
  const next = action === "up" ? (cursor - 1 + count) % count : (cursor + 1) % count;
  return { cursor: next, armed: null };
}

export type ScheduleDeleteStep =
  | { readonly kind: "arm"; readonly state: SchedulesState }
  | { readonly kind: "delete"; readonly id: string; readonly state: SchedulesState }
  | { readonly kind: "refused"; readonly text: string; readonly state: SchedulesState };

/**
 * The first `x` arms the row, the second deletes it (`/sessions`'s grammar), and
 * an `x` with no row under the cursor is an honest refusal — never a silent
 * no-op. The deletion itself is the daemon's: the row leaves when its
 * `schedules` frame says so, never on a local echo.
 */
export function scheduleDeleteStep(
  state: SchedulesState,
  row: ScheduleDockRow | undefined,
  _now: number,
): ScheduleDeleteStep {
  if (row === undefined) {
    return {
      kind: "refused",
      text: "No scheduled wake on that row.",
      state: { ...state, armed: null },
    };
  }
  if (state.armed === row.id) {
    return { kind: "delete", id: row.id, state: { ...state, armed: null } };
  }
  return { kind: "arm", state: { ...state, armed: row.id } };
}

/**
 * The fired turn's own head row (M4 option B): `◷ scheduled · sc-1 every 10m ·
 * fire 5`. The ORDINAL is read out of the durable prompt prefix, because the
 * wire's ref carries only `{id, spec}` and one source of truth is enough. No ref
 * (a reload, an older daemon) paints nothing at all: the durable prefix in the
 * prompt text is then the whole row (option A).
 */
export function firedScheduleHead(
  schedule: { readonly id: string; readonly spec: string } | undefined,
  text: string,
): string {
  if (schedule === undefined) {
    return "";
  }
  const fire = /\[scheduled [^\]]*?· fire (\d+)\]/.exec(text)?.[1];
  const id = fit(oneLine(schedule.id), SCHEDULE_QUIT_ID_MAX);
  const spec = truncateCells(oneLine(schedule.spec), 32);
  const head = `◷ scheduled · ${id} ${spec}`;
  const head_ = fire === undefined ? head : `${head} · fire ${fire}`;
  return truncateCells(head_, SCHEDULE_HEAD_MAX);
}

/**
 * The notice a row that LEFT the table leaves in the transcript (S3's drift 5,
 * carried to S5). Derived from the LIST DIFF, never a frame of its own, so it can
 * only state what the diff PROVES: that the row is gone. Past its `expiresAt` it
 * may name that expiry (the clock is evidence); nothing else is claimed, because
 * a departure is equally the user's own `x x`, a phone's delete, the model's
 * `schedule_control{delete}`, a one-shot's fire, or 3 failing turns — and a
 * guessed cause is a false statement, not a nicety (fix round 1, finding 1).
 *
 * `own` is the ids THIS TUI deleted: it already said `Deleted sc-N.`, so a second
 * line about the same wake is noise (and its cause would be wrong).
 */
export function departedScheduleNotice(
  before: readonly ScheduleDockRow[],
  after: readonly ScheduleDockRow[],
  now: number,
  own: ReadonlySet<string> = new Set(),
): string | null {
  const live = new Set(after.map((row) => row.id));
  const lines = before
    .filter((row) => !live.has(row.id) && !own.has(row.id))
    .map((row) => {
      const id = fit(oneLine(row.id), NOTICE_ID_MAX);
      if (row.expiresAt !== undefined && row.expiresAt <= now) {
        return `Schedule ${id} expired.`;
      }
      return `Schedule ${id} is no longer scheduled.`;
    });
  return lines.length === 0 ? null : lines.join("\n");
}

/** A panel line, cut to the panel's width (`tree-panel.ts`'s own measure). */
export const scheduleLine = (text: string, width: number): string => fit(text, width);

/** An id as a surface paints it: one line, bounded (`/schedule`'s hint, a notice). */
export const scheduleIdText = (id: string): string => fit(oneLine(id), SCHEDULE_QUIT_ID_MAX);

/** Cells a schedule row's title takes (the dock keeps its meta column-aligned). */
export const scheduleTitleCells = (row: ScheduleDockRow): number => cellWidth(scheduleTitle(row));

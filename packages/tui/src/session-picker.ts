/**
 * The `--resume` session picker's logic (docs/feat/resume-picker.md), React-free:
 * the rows to show, the selection, and which key does what. The component in
 * `components/SessionPicker.tsx` only renders what this computes.
 */

/**
 * One session the picker offers: mapped by the CLI from its `SessionRecord`
 * (the local store: a message count), or from a daemon's `session/list` entry
 * (`connect --resume`: what the daemon reports instead).
 */
export interface SessionChoice {
  readonly id: string;
  readonly title: string;
  /** Last save (local) or last conversation change (the daemon's clock), ms since the epoch. */
  readonly updatedAt: number;
  /** Messages in the visible transcript (the system prompt excluded); local only. */
  readonly messageCount?: number;
  /** A daemon's entry: a turn or a compaction runs. */
  readonly running?: boolean;
  /** A daemon's entry: clients attached right now. */
  readonly attached?: number;
  /** A daemon's entry: ended and kept (choosing it reopens it). */
  readonly archived?: boolean;
}

/** "N msgs" for the local store; for a daemon's entry what it reports: "running · on N devices", "archived", else "idle". */
export function choiceMeta(c: SessionChoice): string {
  if (c.messageCount !== undefined) {
    return `${c.messageCount} ${c.messageCount === 1 ? "msg" : "msgs"}`;
  }
  const marks = [
    ...(c.running === true ? ["running"] : []),
    ...(c.attached !== undefined && c.attached > 0
      ? [`on ${c.attached} ${c.attached === 1 ? "device" : "devices"}`]
      : []),
    ...(c.archived === true ? ["archived"] : []),
  ];
  return marks.length > 0 ? marks.join(" · ") : "idle";
}

/** The picker as the CLI uses it: the chosen id, or null when cancelled. */
export type SessionPick = (choices: readonly SessionChoice[]) => Promise<string | null>;

export interface PickerRow {
  readonly id: string;
  readonly title: string;
  readonly age: string;
  /** "N msgs". */
  readonly meta: string;
  readonly selected: boolean;
}

export interface PickerView {
  readonly rows: readonly PickerRow[];
  /** Choices hidden above / below the visible window. */
  readonly above: number;
  readonly below: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" · "5m ago" · "3h ago" · "2d ago" (under a week) · then the local date. */
export function pickerAge(updatedAt: number, now: number): string {
  const ago = Math.max(0, now - updatedAt);
  if (ago < MINUTE) {
    return "just now";
  }
  if (ago < HOUR) {
    return `${Math.floor(ago / MINUTE)}m ago`;
  }
  if (ago < DAY) {
    return `${Math.floor(ago / HOUR)}h ago`;
  }
  if (ago < 7 * DAY) {
    return `${Math.floor(ago / DAY)}d ago`;
  }
  const d = new Date(updatedAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Move the selection by `delta`, clamped to the list (no wrap). */
export function movePicker(selected: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(count - 1, Math.max(0, selected + delta));
}

/**
 * The rows to draw: at most `height` of them, a window centred on the
 * selection (clamped to the ends) so the selected row is always visible.
 */
export function pickerView(
  choices: readonly SessionChoice[],
  selected: number,
  now: number,
  height: number,
): PickerView {
  const size = Math.max(1, Math.floor(height));
  const maxStart = Math.max(0, choices.length - size);
  const start = Math.min(maxStart, Math.max(0, selected - Math.floor((size - 1) / 2)));
  const visible = choices.slice(start, start + size);
  return {
    rows: visible.map((c, i) => ({
      id: c.id,
      title: c.title,
      age: pickerAge(c.updatedAt, now),
      meta: choiceMeta(c),
      selected: start + i === selected,
    })),
    above: start,
    below: choices.length - start - visible.length,
  };
}

export type PickerAction = "up" | "down" | "choose" | "cancel" | "none";

/** The subset of Ink's `Key` the picker reads. */
export interface PickerKeyState {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly ctrl: boolean;
}

/** ↑/k up · ↓/j down · Enter choose · Esc or Ctrl+C cancel. */
export function pickerKey(input: string, key: PickerKeyState): PickerAction {
  if (key.ctrl && input === "c") {
    return "cancel";
  }
  if (key.escape) {
    return "cancel";
  }
  if (key.return) {
    return "choose";
  }
  if (key.upArrow || (!key.ctrl && input === "k")) {
    return "up";
  }
  if (key.downArrow || (!key.ctrl && input === "j")) {
    return "down";
  }
  return "none";
}

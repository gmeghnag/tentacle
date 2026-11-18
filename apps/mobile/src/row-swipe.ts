/**
 * Swipe-a-row-left-to-see-its-time, the pure half (docs/fix/mobile-open-at-end.md,
 * slice B). React-free and injected, so the gesture's RULES are unit-tested and
 * `SwipeTime.tsx` only renders (`AGENTS` §7).
 *
 * The decisions it owns:
 * - **which gesture a row claims**: only a clearly horizontal LEFTWARD move, and
 *   only on a row that has a time. A vertical drag belongs to the list's scroll,
 *   a rightward one to the native back-swipe (App.tsx's stack), and a tap (a
 *   tool row's expand, a text selection) has no movement at all — hence a
 *   move-only responder on the component's side.
 * - **how far the row travels**: with resistance, asymptotically capped at
 *   `REVEAL`, so no amount of finger travel drags it further than the label.
 * - **what it reveals**: the arrival time, formatted by an injected formatter
 *   (the device's locale decides 12/24 h).
 */
import type { Row } from "./transcript-rows.ts";

/** How far a row moves to reveal its time (points: the label's own width). */
export const REVEAL = 64;
/** The horizontal travel that must be exceeded before the pan is claimed. */
export const SLOP = 12;
/** The horizontal:vertical ratio a claimed pan must clear (a vertical scroll wins otherwise). */
export const RATIO = 2;

/**
 * Whether this movement claims the pan: a LEFT move past `SLOP`, at least
 * `RATIO` times its vertical component, on a row that actually has a time.
 * `hasTime` false → never, so a row with nothing to show does not move at all.
 */
export function claimsPan(
  delta: { readonly dx: number; readonly dy: number },
  hasTime: boolean,
): boolean {
  if (!hasTime || delta.dx >= -SLOP) {
    return false;
  }
  return Math.abs(delta.dx) >= RATIO * Math.abs(delta.dy);
}

/**
 * The row's `translateX` for a finger `dx`: `0` at rest (and for any rightward
 * move), then a resistance curve that approaches `-REVEAL` without reaching it.
 * Monotone, so the row never springs backwards mid-drag.
 */
export function revealOffset(dx: number): number {
  if (dx >= 0) {
    return 0;
  }
  return -REVEAL * (1 - Math.exp(dx / REVEAL));
}

/** The device's own time format (12 or 24 h by its locale): `HH:mm`-shaped. */
const deviceTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The label a row reveals: its arrival time, or `null` when nothing is known
 * (`undefined`, `0` — a message a reload re-logged — or a hostile negative), so
 * an unknown arrival never reads as 1970.
 */
export function timeLabel(
  at: number | undefined,
  fmt: (at: number) => string = (ms) => deviceTime.format(ms),
): string | null {
  return at === undefined || at <= 0 ? null : fmt(at);
}

/**
 * The label one ROW reveals: `timeLabel` of the time its kind carries. A notice,
 * a reasoning row and the turn indicator carry none at all (only a person's
 * message, an answer and a tool call have an arrival), so those rows never move.
 */
export function rowTimeLabel(row: Row, fmt?: (at: number) => string): string | null {
  const at =
    row.kind === "user" || row.kind === "assistant" || row.kind === "tool" ? row.at : undefined;
  return timeLabel(at, fmt);
}

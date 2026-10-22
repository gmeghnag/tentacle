/**
 * Spinner frames (from sindresorhus/cli-spinners) and the pure frame picker.
 * Every frame is a single width-1 cell, so the text after it never shifts.
 */
export interface Spinner {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

/** Queued (not yet delivered) messages: `arc`, distinct from Thinking's braille dots. */
export const ARC: Spinner = { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], intervalMs: 100 };

/** The frame shown `elapsedMs` after the spinner started. Pure. */
export function spinnerFrame(spinner: Spinner, elapsedMs: number): string {
  const n = spinner.frames.length;
  const i = Math.floor(Math.max(0, elapsedMs) / spinner.intervalMs) % n;
  return spinner.frames[i] ?? "";
}

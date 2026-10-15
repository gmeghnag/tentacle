/**
 * A single in-place status line with a braille spinner — the TTY presentation
 * for `run` startup (pod create → ready → inject → daemon). One line is
 * repainted as the phase changes: `\r<frame> <text>`, padded with spaces so a
 * shorter repaint erases the tail of the longer one.
 *
 * While active the terminal cursor is HIDDEN (the spinner is the activity
 * indicator; a blinking block at the end of the padding would just be noise)
 * and restored by `finish()` — or by an `exit` handler if the process dies
 * first (Ctrl+C mid-startup calls `process.exit`; SIGKILL can't be caught —
 * `reset` restores the cursor in that case).
 *
 * Pure presentation over `(text)` updates + a write sink. In piped mode
 * (log/CI/test) the caller does NOT use this class — it logs one discrete
 * line per phase instead, so captured transcripts stay readable.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** ANSI: hide / show the terminal cursor (DEC private mode 25). */
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface StatusLineOptions {
  /** The output sink (the caller's `log`). */
  readonly write: (text: string) => void;
  /** Spinner tick interval in ms. Default 80. */
  readonly intervalMs?: number;
}

export class StatusLine {
  private text = "";
  private frame = 0;
  /** The width (in cells) the last repaint covered, incl. its padding. */
  private lastWidth = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private cursorHidden = false;
  private exitHandler: (() => void) | null = null;
  private readonly write: (text: string) => void;
  private readonly intervalMs: number;

  constructor(options: StatusLineOptions) {
    this.write = options.write;
    this.intervalMs = options.intervalMs ?? 80;
  }

  /** Update the phase text (repaints immediately; starts the spinner lazily). */
  set(text: string): void {
    if (this.finished) {
      return;
    }
    this.text = text;
    this.hideCursor();
    this.repaint();
    this.start();
  }

  /** Stop the spinner, clear the line, and restore the cursor (idempotent). */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.stop();
    if (this.lastWidth > 0) {
      this.write(`\r${" ".repeat(this.lastWidth)}\r`);
      this.lastWidth = 0;
    }
    this.restoreCursor();
  }

  private hideCursor(): void {
    if (this.cursorHidden) {
      return;
    }
    this.cursorHidden = true;
    this.write(HIDE_CURSOR);
    // Safety net: if the process exits before `finish()` (Ctrl+C mid-startup
    // → `process.exit`, whose `exit` handlers still run), restore the cursor
    // so the shell isn't left cursor-less. A SIGKILL/crash can't be caught.
    this.exitHandler = (): void => {
      this.restoreCursor();
    };
    process.once("exit", this.exitHandler);
  }

  private restoreCursor(): void {
    if (this.cursorHidden) {
      this.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
    if (this.exitHandler) {
      process.off("exit", this.exitHandler);
      this.exitHandler = null;
    }
  }

  private start(): void {
    if (this.timer !== null || this.finished) {
      return;
    }
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.repaint();
    }, this.intervalMs);
    // Never keep the process alive (the `run` exits when the TUI closes).
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private repaint(): void {
    const line = `${SPINNER_FRAMES[this.frame]} ${this.text}`;
    // Overwrite the whole region the last repaint covered: pad up to the
    // wider of (this line, last width) so a shorter line erases the tail of
    // a longer one (and a longer line extends cleanly).
    const width = Math.max(line.length, this.lastWidth);
    const pad = " ".repeat(width - line.length);
    this.write(`\r${line}${pad}`);
    this.lastWidth = width;
  }
}

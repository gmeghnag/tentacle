/**
 * A single in-place status line with a braille spinner — the TTY presentation
 * for `run` startup (pod create → ready → inject → daemon). One line is
 * repainted as the phase changes: `\r ESC[2K <frame> <text>` — back to column 0,
 * erase the whole line, then the text CUT to `columns - 1` display cells. Never
 * padded: padding up to a longer earlier line (podman's `creating … in
 * unix:///…sock (…)` is wider than the terminal) made every later frame wrap, and
 * `\r` then returned only to the wrapped row — each frame on a NEW line.
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

/** Back to column 0 and erase the whole line (every repaint, and the final clear). */
const CLEAR_LINE = "\r\x1b[2K";

export interface StatusLineOptions {
  /** The output sink (the caller's `log`). */
  readonly write: (text: string) => void;
  /** Spinner tick interval in ms. Default 80. */
  readonly intervalMs?: number;
  /** The terminal width in cells (default: stdout's); unknown → the text is not cut. */
  readonly columns?: () => number | undefined;
}

/** Terminal cells of one code point: 0 combining/zero-width, 2 East Asian wide / emoji, else 1. */
function cellWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) {
    return 0;
  }
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/** `text` cut to at most `cells` terminal cells (by display width, not UTF-16 length). */
export function cutToCells(text: string, cells: number): string {
  let used = 0;
  let out = "";
  for (const ch of text) {
    const w = cellWidth(ch.codePointAt(0) ?? 0);
    if (used + w > cells) {
      break;
    }
    used += w;
    out += ch;
  }
  return out;
}

export class StatusLine {
  private text = "";
  private frame = 0;
  /** Something is painted on the line (so `finish` has to clear it). */
  private painted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private cursorHidden = false;
  private exitHandler: (() => void) | null = null;
  private readonly write: (text: string) => void;
  private readonly intervalMs: number;
  private readonly columns: () => number | undefined;

  constructor(options: StatusLineOptions) {
    this.write = options.write;
    this.intervalMs = options.intervalMs ?? 80;
    this.columns = options.columns ?? (() => process.stdout.columns);
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
    if (this.painted) {
      this.write(CLEAR_LINE);
      this.painted = false;
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
    const columns = this.columns();
    // One cell short of the width: a glyph some terminals draw wider than we
    // count (ambiguous width) must not wrap the line either.
    const shown = columns !== undefined && columns > 1 ? cutToCells(line, columns - 1) : line;
    this.write(`${CLEAR_LINE}${shown}`);
    this.painted = true;
  }
}

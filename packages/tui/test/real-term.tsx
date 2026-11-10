/**
 * A render harness whose terminal is the TEST's (docs/feat/subagent-panel.md,
 * Review round 3 M3): `ink-testing-library`'s `Stdout.columns` is the constant
 * 100, so a test that passes `columns={190}` only changes the App's own maths —
 * Ink still wraps at 100 cells, and the "190-column" assertions ran on a
 * 100-column frame (a rule split into a 100- and a 90-cell line).
 *
 * This renders through Ink with a `stdout` that reports the requested `columns`
 * and `rows` (the shape of the reviewer's `repro190.ts` and the owner's pty
 * repro), so the FRAME is what a terminal of that size really paints. The App
 * gets no `columns` prop: its size comes from the stream, as in production.
 */
import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type { ReactElement } from "react";

/** A `stdout` Ink writes to whose size is the test's (a real terminal's shape). */
class SizedStdout extends EventEmitter {
  readonly isTTY = true;
  readonly frames: string[] = [];
  columns: number;
  rows: number;
  private last: string | undefined;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string): boolean => {
    this.frames.push(frame);
    this.last = frame;
    return true;
  };
  lastFrame = (): string | undefined => this.last;
}

/** A `stderr` Ink writes to (a frame is only ever asserted on `stdout`). */
class QuietStderr {
  write = (): boolean => true;
}

/** `ink-testing-library`'s `Stdin`: keys go in, already captured ones come out. */
class TestStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (chunk: string): void => {
    this.data = chunk;
    this.emit("readable");
    this.emit("data", chunk);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const chunk = this.data;
    this.data = null;
    return chunk;
  };
}

export interface RealTerm {
  /** The last frame, SGR stripped: the plain text a terminal of this size shows. */
  readonly frame: () => string;
  /** The last frame WITH its SGR codes (a test that asserts on the paint). */
  readonly lastFrame: () => string;
  readonly stdin: { write(chunk: string): void };
  /** A terminal resize: the App re-reads the size from the stream and re-wraps. */
  readonly resize: (columns: number, rows: number) => void;
  readonly unmount: () => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Render `tree` in a terminal of exactly `columns` × `rows`. */
export function renderAt(
  tree: ReactElement,
  options: { readonly columns: number; readonly rows: number },
): RealTerm {
  const stdout = new SizedStdout(options.columns, options.rows);
  const stdin = new TestStdin();
  const instance = inkRender(tree, {
    stdout: stdout as never,
    stderr: new QuietStderr() as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    frame: () => stripAnsi(stdout.lastFrame() ?? ""),
    lastFrame: () => stdout.lastFrame() ?? "",
    stdin,
    resize: (columns, rows) => {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

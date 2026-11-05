/**
 * The CLI's two output streams (docs/fix/cli-output-streams.md). STDOUT carries
 * only the data a command produces (tables, `-q` names, `--help`/`--version`, a
 * one-shot's answer, result lines); STDERR carries everything else outside Ink
 * (progress, notes, warnings, errors, hints, the y/N prompt, logs).
 *
 * A line's style follows the stream it is WRITTEN to: `cmd 2>log` must get no
 * escape codes in the log, and `cmd >out` keeps its colours on the terminal.
 * This is the ONE place that reads a stream's terminal facts.
 */

/** The facts of a stream that decide its presentation (a `WriteStream`'s subset). */
export interface StreamFacts {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

/** What a writer may do on one stream. */
export interface StreamTerm {
  /** A terminal: a StatusLine spinner, a y/N prompt. */
  readonly tty: boolean;
  /** Colour/dim escapes are welcome: a terminal and no `NO_COLOR`. */
  readonly colour: boolean;
  /** Its width now, in cells (`undefined`: unknown). */
  readonly columns: () => number | undefined;
}

/** An injected sink (a test, a capture) is never a terminal. */
export const NOT_A_TERMINAL: StreamTerm = {
  tty: false,
  colour: false,
  columns: () => undefined,
};

/** The terminal facts of `stream`, read now (`columns` read at each call: a resize). */
export function termOf(
  stream: StreamFacts,
  env: Readonly<Record<string, string | undefined>> = process.env,
): StreamTerm {
  const tty = stream.isTTY === true;
  return {
    tty,
    colour: tty && !env.NO_COLOR,
    columns: () => stream.columns,
  };
}

/** SGR dim when `colour` is on (else the text unchanged). */
export function dimIf(text: string, colour: boolean): string {
  return colour ? `\x1b[2m${text}\x1b[22m` : text;
}

import type { AutoAcceptFeed } from "@tentacle/tui";

/**
 * `run --auto-accept[=true]` without `--detach` (docs/feat/run-prompt.md): the
 * TUI's own auto-accept state (the one Shift+Tab flips), started ON. It is a
 * plain `AutoAcceptFeed` held in memory: no other terminal shares it.
 */
export function localAutoAccept(initial: boolean): AutoAcceptFeed {
  let on = initial;
  return {
    current: () => on,
    set: (next) => {
      on = next;
    },
    onChange: () => () => {},
  };
}

const GREY = "\x1b[90m";
const GREY_OFF = "\x1b[39m";

/**
 * An informational status line in grey when `colour` is on (a TTY stdout, no
 * `NO_COLOR` — the caller decides). Grey is by EXPLICIT marking: only an emitter
 * that calls the `info` path reaches this; errors, refusals, warnings and the
 * daemon's stderr go through `write`/`log` and are never styled. A line that
 * already carries an escape sequence (a spinner frame) is left alone.
 */
export function styleInfo(line: string, colour: boolean): string {
  if (!colour || line.includes("\x1b")) {
    return line;
  }
  return line.endsWith("\n")
    ? `${GREY}${line.slice(0, -1)}${GREY_OFF}\n`
    : `${GREY}${line}${GREY_OFF}`;
}

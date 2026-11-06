export { BACKGROUND_QUERY, PROBE_TIMEOUT_MS };

/**
 * The terminal-background probe's DRIVER (docs/feat/tui-light-theme.md S6).
 *
 * Reads the terminal's background colour BEFORE Ink mounts, on the one stdin
 * every runtime shares. Thin on purpose: every decision lives in the pure
 * `terminal-background.ts`; this only wires a stream, a clock and the terminal's
 * lifecycle, so the whole thing is testable with fakes.
 *
 * The sequence, and why each step is where it is:
 *
 * 1. `setRawMode(true)` BEFORE the query. A tty in cooked mode ECHOES the reply
 *    to the screen; a fast terminal answers in well under a millisecond, so the
 *    order is not a detail — it was measured on a real pty (see the task doc's
 *    `late_cooked` scenario).
 * 2. `installTerminalRestore`, so a SIGTERM/SIGINT in this window leaves the tty
 *    cooked instead of stuck in raw mode.
 * 3. Write the query (`ESC]11;?` + DA1) and read with the same `readable`/`read()`
 *    loop Ink uses at mount.
 * 4. End on the sentinel or the timeout. Drop the listener and `unshift` every
 *    non-reply byte, so type-ahead reaches Ink in order and nothing is lost.
 * 5. Sentinel seen: nothing more can come (replies are ordered), so go cooked.
 *    TIMEOUT: STAY RAW. A late reply would otherwise be echoed by the tty, and no
 *    filter can catch that; Ink's own `setRawMode(true)` then takes over with no
 *    gap. The caller arms `stepLateFilter` for that case (`late: true`).
 *
 * No byte is ever written to the terminal except the query itself, which the
 * terminal consumes as a control sequence and never displays.
 */

import chalk from "chalk";
import {
  BACKGROUND_QUERY,
  PROBE_TIMEOUT_MS,
  type ProbeState,
  type Rgb,
  canProbe as canProbeNow,
  initialLateFilter,
  initialProbe,
  restOf,
  stepLateFilter,
  stepProbe,
} from "./terminal-background.ts";
import { type ProcessLike, installTerminalRestore } from "./terminal.ts";
import { type ThemeSetting, prepareTheme } from "./theme.ts";

/** The slice of `process.stdin` the probe needs; a fake stands in for it in tests. */
export interface ProbeStream {
  readonly isTTY?: boolean;
  setRawMode(enabled: boolean): unknown;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  read(): string | null;
  unshift(chunk: string): unknown;
}

/** The slice of the timer API the probe needs (a manual clock in tests). */
export interface ProbeTimer {
  set(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

/** What the probe learned. `late`: a reply may still arrive; guard the input. */
export interface ProbeResult {
  readonly color: Rgb | null;
  readonly late: boolean;
}

export interface ProbeOptions {
  readonly stdin: ProbeStream;
  /** Writes the query — `process.stdout.write` in production, a spy in tests. */
  readonly write: (text: string) => void;
  /** `canProbe`'s verdict, computed by the caller (pure, in the other module). */
  readonly canProbe: boolean;
  readonly timer: ProbeTimer;
  readonly now: () => number;
  /** For `installTerminalRestore`; `process` in production. */
  readonly proc?: ProcessLike;
  readonly timeoutMs?: number;
}

export interface ProbeHandle {
  /** Resolves when the probe is over: the sentinel, the timeout, or not probing. */
  wait(): Promise<ProbeResult>;
  /** Stop early (the caller needs the terminal): the TTY is restored first. */
  cancel(): void;
}

/**
 * Ask the terminal for its background colour, or return at once when probing is
 * pointless. The returned handle settles exactly once.
 */
export function probeBackground(options: ProbeOptions): ProbeHandle {
  const { stdin, write, timer, now } = options;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (!options.canProbe) {
    // No query: a pipe/CI/dumb terminal has nothing to answer with, and paying
    // 200 ms for the timeout would be the only cost. Mutation: write anyway → the
    // bytes land in whatever is reading stdout.
    return {
      wait: () => Promise.resolve({ color: null, late: false }),
      cancel: () => {},
    };
  }

  let state: ProbeState = initialProbe();
  let settled = false;
  let resolve: (result: ProbeResult) => void = () => {};
  const done = new Promise<ProbeResult>((r) => {
    resolve = r;
  });

  const onReadable = (): void => {
    if (settled) {
      return;
    }
    for (;;) {
      const chunk = stdin.read();
      if (chunk === null) {
        break;
      }
      state = stepProbe(state, chunk);
    }
    if (state.sentinel) {
      finish(false);
    }
  };

  const handle = timer.set(() => finish(true), timeoutMs);

  let uninstall: () => void = () => {};
  if (options.proc) {
    uninstall = installTerminalRestore(options.proc, () => {
      // A signal in the window: leave the tty usable, then let the signal handler
      // exit. Nothing is written; Ink never mounted.
      try {
        stdin.setRawMode(false);
      } catch {
        // The stream may already be gone; the exit still happens.
      }
    });
  }

  // Raw BEFORE the write (step 1): a fast reply must never be echoed.
  try {
    stdin.setRawMode(true);
  } catch {
    // A stream that cannot go raw (an odd pty): fall back to no probe at all.
    timer.clear(handle);
    uninstall();
    settled = true;
    resolve({ color: null, late: false });
    return { wait: () => done, cancel: () => {} };
  }
  stdin.on("readable", onReadable);
  write(BACKGROUND_QUERY);

  function finish(timedOut: boolean): void {
    if (settled) {
      return;
    }
    settled = true;
    timer.clear(handle);
    stdin.off("readable", onReadable);
    uninstall();
    // Every byte that was not part of a reply, in order — including a held prefix
    // that turned out to be type-ahead (the pure module gives it back).
    const rest = restOf(state);
    if (rest !== "") {
      stdin.unshift(rest);
    }
    if (!timedOut) {
      // Replies are ordered, so the sentinel means nothing more can come.
      try {
        stdin.setRawMode(false);
      } catch {
        // Already gone (a closed pty): the mount will fail on its own terms.
      }
    }
    // A TIMEOUT deliberately stays raw (step 5): dropping to cooked would make the
    // tty echo a late reply, and `stepLateFilter` handles it instead.
    resolve({ color: state.color, late: timedOut });
  }

  return {
    wait: () => done,
    cancel: () => finish(false),
  };
}

/**
 * The palette for this launch, on the real terminal: probe when it is worth it,
 * then let `prepareTheme` settle and apply the mode. Production wiring; every
 * collaborator is injectable for tests.
 */
export async function readThemeSetting(
  setting: ThemeSetting,
  io: ThemeProcessIo = processIo(),
): Promise<void> {
  await prepareTheme(setting, {
    canProbe: io.canProbe,
    probe: async () => {
      const handle = probeBackground({
        stdin: io.stdin,
        write: io.write,
        canProbe: io.canProbe,
        timer: io.timer,
        now: io.now,
        proc: io.proc,
      });
      return handle.wait();
    },
    colorFgBg: io.colorFgBg,
  });
}

/** Everything `readThemeSetting` needs from the process, in one place. */
export interface ThemeProcessIo {
  readonly stdin: ProbeStream;
  readonly write: (text: string) => void;
  readonly canProbe: boolean;
  readonly timer: ProbeTimer;
  readonly now: () => number;
  readonly proc: ProcessLike;
  readonly colorFgBg: string | undefined;
}

/** The real process, as the probe sees it. */
export function processIo(): ThemeProcessIo {
  const stdin = process.stdin as unknown as ProbeStream;
  const canProbe = canProbeNow({
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
    term: process.env.TERM,
    chalkLevel: (chalk as unknown as { level: number }).level,
  });
  return {
    stdin,
    write: (text) => process.stdout.write(text),
    canProbe,
    timer: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle),
    },
    now: () => Date.now(),
    proc: process as unknown as ProcessLike,
    colorFgBg: process.env.COLORFGBG,
  };
}

/**
 * Ink's stdin when the probe timed out: a `Proxy` over `process.stdin` whose
 * `read()` runs `stepLateFilter`, so a reply that arrives after the mount never
 * reaches the key parser. Everything else is the stream itself, bound.
 *
 * The normal path (`late: false`) hands Ink the real stream, so this is not in the
 * way of any launch that got an answer.
 */
export function lateGuard(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  let filter = initialLateFilter(Date.now());
  return new Proxy(stdin, {
    get(target, property, receiver) {
      if (property === "read") {
        return (...args: unknown[]) => {
          // Loop until a chunk survives the filter: Ink feeds `""` to its key
          // parser, which would be a spurious keystroke.
          for (;;) {
            const chunk = (target.read as (...a: unknown[]) => string | null).apply(target, args);
            if (chunk === null) {
              return null;
            }
            const step = stepLateFilter(filter, chunk, Date.now());
            filter = step.filter;
            if (step.pass !== "") {
              return args.length > 0 ? step.pass : step.pass;
            }
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

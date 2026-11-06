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
  residueOf,
  restOf,
  stepLateFilter,
  stepProbe,
} from "./terminal-background.ts";
import { type ProcessLike, installTerminalRestore } from "./terminal.ts";
import { type ThemeSetting, prepareTheme, themeProbeResidue, themeProbeWasLate } from "./theme.ts";

/** The slice of `process.stdin` the probe needs; a fake stands in for it in tests. */
export interface ProbeStream {
  readonly isTTY?: boolean;
  setRawMode(enabled: boolean): unknown;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  /** A fresh tty yields bytes (no previous Ink mount set an encoding). */
  read(): string | Buffer | null;
  /** Bytes, never a re-encoded string (Review fix round 2, MEDIUM 1). */
  unshift(chunk: string | Buffer): unknown;
}

/**
 * Bytes decoded as UTF-8, which is what stdin IS (owner decision Q-D, 2026-11-06;
 * Review fix round 2, MEDIUM 1).
 *
 * Fix round 1 decoded latin1 to keep the 8-bit C1 reply forms (`0x9d` OSC,
 * `0x9c` ST, `0x9b` CSI) as single bytes — but that made every typed non-ASCII
 * key mojibake, and it read a UTF-8 continuation byte (`0x9D` inside `😝`) as an
 * OSC introducer. Those forms are dropped, so the decode is the terminal's own.
 *
 * A chunk may END in the middle of a character: a tty `read()` returns whatever is
 * buffered, which can be one byte. Decoding such a chunk on its own yields a
 * replacement char and loses the continuation byte, so the incomplete tail is
 * carried into the next chunk — and handed back as BYTES if the probe ends first.
 * Valid UTF-8 then round-trips exactly, which is all a keyboard on a UTF-8 link
 * can produce.
 */
function splitUtf8(bytes: ArrayLike<number>): {
  readonly text: string;
  readonly carry: Uint8Array;
} {
  const buffer = new Uint8Array(bytes);
  // Find the start of a trailing INCOMPLETE sequence (at most 3 bytes back).
  let cut = buffer.length;
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      // A lead byte (or ASCII): does it announce more bytes than are here?
      const need = byte === undefined || byte < 0xc0 ? 0 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (need > back) {
        cut = buffer.length - back;
      }
      break;
    }
  }
  const decoder = new TextDecoder("utf-8");
  return {
    text: decoder.decode(buffer.subarray(0, cut)),
    carry: buffer.slice(cut),
  };
}

/** Two byte runs as one, without caring which `Uint8Array` flavour (`Buffer` is one). */
function joinBytes(head: ArrayLike<number>, tail: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
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
  /**
   * The HEAD of a reply the timeout cut in half, for `stepLateFilter`'s
   * `pending`: its tail arrives after the mount and must be stripped with it.
   * `""` when nothing was held (or the sentinel settled the reply).
   */
  readonly residue?: string;
}

export interface ProbeOptions {
  readonly stdin: ProbeStream;
  /** Writes the query — `process.stdout.write` in production, a spy in tests. */
  readonly write: (text: string) => void;
  /** `canProbe`'s verdict, computed by the caller (pure, in the other module). */
  readonly canProbe: boolean;
  readonly timer: ProbeTimer;
  /** For `installTerminalRestore`; `process` in production. */
  readonly proc?: ProcessLike;
  readonly timeoutMs?: number;
}

export interface ProbeHandle {
  /** Resolves when the probe is over: the sentinel, the timeout, or not probing. */
  wait(): Promise<ProbeResult>;
}

/**
 * Ask the terminal for its background colour, or return at once when probing is
 * pointless. The returned handle settles exactly once.
 */
export function probeBackground(options: ProbeOptions): ProbeHandle {
  const { stdin, write, timer } = options;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (!options.canProbe) {
    // No query: a pipe/CI/dumb terminal has nothing to answer with, and paying
    // 200 ms for the timeout would be the only cost. Mutation: write anyway → the
    // bytes land in whatever is reading stdout.
    return {
      wait: () => Promise.resolve({ color: null, late: false }),
    };
  }

  let state: ProbeState = initialProbe();
  /** Bytes of a character cut by a chunk boundary, decoded with the next chunk. */
  let carry: Uint8Array = new Uint8Array(0);
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
      if (typeof chunk === "string") {
        state = stepProbe(state, chunk);
        continue;
      }
      const split = splitUtf8(carry.length > 0 ? joinBytes(carry, chunk) : chunk);
      carry = split.carry;
      if (split.text !== "") {
        state = stepProbe(state, split.text);
      }
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
    return { wait: () => done };
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
    // Every byte that was not part of a reply, in order — a held prefix that
    // turned out to be type-ahead is given back by the pure module. Handed back as
    // BYTES, never as a re-encoded string: a `unshift("Ã¨")` on a stream with no
    // encoding set is written back as `C3 83 C2 A8`, so `è` reaches Ink as `Ã¨`
    // (Review fix round 2, MEDIUM 1). Valid UTF-8 round-trips exactly, which is
    // what a keyboard on a UTF-8 link produces.
    const rest = restOf(state);
    if (rest !== "" || carry.length > 0) {
      stdin.unshift(Buffer.from(joinBytes(Buffer.from(rest, "utf8"), carry)));
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
    // tty echo a late reply, and `stepLateFilter` handles it instead. A reply cut
    // by the timer is handed to that guard as its `pending`, so its tail is
    // stripped with it rather than landing in the prompt (MEDIUM 4).
    resolve({ color: state.color, late: timedOut, residue: timedOut ? residueOf(state) : "" });
  }

  return {
    wait: () => done,
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
  // Seeded with the HEAD of a reply the timeout cut in half (MEDIUM 4): its tail
  // arrives after the mount, and only this seed makes it the same reply.
  let filter = { ...initialLateFilter(Date.now()), pending: themeProbeResidue() };
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
              return step.pass;
            }
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

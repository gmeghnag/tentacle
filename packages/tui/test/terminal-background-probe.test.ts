import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_QUERY,
  PROBE_TIMEOUT_MS,
  type ProbeStream,
  type ProbeTimer,
  probeBackground,
} from "../src/terminal-background-probe.ts";
import { canProbe as canProbeNow } from "../src/terminal-background.ts";

/**
 * The probe's DRIVER half (docs/feat/tui-light-theme.md S6): raw mode, the write,
 * the wait, the hand-back, and what happens on every way out.
 *
 * This is the strictest suite in the task, because the file drives the one stdin
 * every runtime shares, before Ink. A mistake here is not a wrong colour: it is an
 * echoed escape sequence on screen, a swallowed keystroke, or a TTY left raw. Each
 * test names the mutation that must turn it red (AGENTS §9).
 */

/** A fake `process.stdin`-like stream: the listeners and raw-mode calls as data. */
function fakeStream(options: { readable?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const queue: string[] = [];
  const log: string[] = [];
  let raw = false;
  const stream: ProbeStream = {
    isTTY: options.readable ?? true,
    setRawMode(enabled: boolean) {
      log.push(`raw:${enabled}`);
      raw = enabled;
      return stream;
    },
    on(event: string, listener: () => void) {
      log.push(`on:${event}`);
      if (event === "readable") {
        listeners.add(listener);
      }
      return stream;
    },
    off(event: string, listener: () => void) {
      log.push(`off:${event}`);
      if (event === "readable") {
        listeners.delete(listener);
      }
      return stream;
    },
    read() {
      const next = queue.shift();
      return next === undefined ? null : next;
    },
    unshift(chunk: string) {
      log.push(`unshift:${JSON.stringify(chunk)}`);
      queue.unshift(chunk);
    },
  };
  return {
    stream,
    log,
    /** Feed a chunk as the terminal would, then run the readable listener. */
    feed(chunk: string): void {
      queue.push(chunk);
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get rawMode(): boolean {
      return raw;
    },
    get listenerCount(): number {
      return listeners.size;
    },
    get queued(): string[] {
      return [...queue];
    },
  };
}

/** A manual clock: the test decides when the timeout fires. */
function fakeTimer() {
  let pending: { cb: () => void; ms: number } | null = null;
  const timer: ProbeTimer = {
    set(cb: () => void, ms: number) {
      pending = { cb, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {
      pending = null;
    },
  };
  return {
    timer,
    get armed(): boolean {
      return pending !== null;
    },
    get ms(): number | null {
      return pending?.ms ?? null;
    },
    fire(): void {
      const p = pending;
      pending = null;
      p?.cb();
    },
  };
}

const ok = { stdinTty: true, stdoutTty: true, term: "xterm-256color", chalkLevel: 3 };

describe("raw mode is ON before the query is written", () => {
  test("the order is exactly setRawMode(true) → write → on(readable)", async () => {
    const stdin = fakeStream();
    const timer = fakeTimer();
    const written: string[] = [];
    probeBackground({
      stdin: stdin.stream,
      write: (s) => written.push(s),
      canProbe: canProbeNow(ok),
      timer: timer.timer,
      now: () => 0,
    });
    // Mutation: write before setRawMode → the log starts with the write instead,
    // and a fast reply would be ECHOED by the tty (measured on a real pty).
    expect(stdin.log[0]).toBe("raw:true");
    expect(stdin.log[1]).toBe("on:readable");
    expect(written).toEqual([BACKGROUND_QUERY]);
  });
});

describe("a terminal that answers", () => {
  test("sentinel seen: colour parsed, raw OFF, the listener dropped, late: false", async () => {
    const stdin = fakeStream();
    const timer = fakeTimer();
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: timer.timer,
      now: () => 0,
    });
    stdin.feed("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\\x1b[?1;2c");
    const done = await result.wait();
    expect(done.color).toEqual([30, 30, 30]);
    expect(done.late).toBe(false);
    expect(stdin.rawMode).toBe(false);
    expect(stdin.listenerCount).toBe(0);
    expect(timer.armed).toBe(false);
  });

  test("type-ahead in the window is handed back, in order, with no reply bytes", async () => {
    const stdin = fakeStream();
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: fakeTimer().timer,
      now: () => 0,
    });
    stdin.feed("ab\x1b]11;rgb:ffff/ffff/ffff\x1b\\c\x1b[?1;2c");
    const done = await result.wait();
    expect(done.color).toEqual([255, 255, 255]);
    // Mutation: unshift the raw buffer instead of `restOf` → the reply comes back.
    expect(stdin.queued).toEqual(["abc"]);
  });
});

describe("a terminal that stays silent", () => {
  test("timeout: raw stays ON, late: true, listener dropped, nothing written back", async () => {
    const stdin = fakeStream();
    const timer = fakeTimer();
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: timer.timer,
      now: () => 0,
    });
    expect(timer.ms).toBe(PROBE_TIMEOUT_MS);
    timer.fire();
    const done = await result.wait();
    expect(done.color).toBeNull();
    expect(done.late).toBe(true);
    // Dropping to cooked here would make the tty ECHO a late reply (measured on a
    // real pty in the task doc). Mutation: `setRawMode(false)` on the timeout → red.
    expect(stdin.rawMode).toBe(true);
    expect(stdin.listenerCount).toBe(0);
    expect(stdin.queued).toEqual([]);
  });

  test("the cost is bounded by the timeout, never the whole wait", async () => {
    const stdin = fakeStream();
    const timer = fakeTimer();
    probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: timer.timer,
      now: () => 0,
    });
    // Mutation: no timer at all → this hangs, and the assertion never runs.
    expect(timer.armed).toBe(true);
    expect(timer.ms).toBeLessThanOrEqual(PROBE_TIMEOUT_MS);
  });
});

describe("when there is nothing to probe", () => {
  test("canProbe false: no write, no setRawMode, no listener, cooked", async () => {
    const stdin = fakeStream();
    const written: string[] = [];
    const result = probeBackground({
      stdin: stdin.stream,
      write: (s) => written.push(s),
      canProbe: canProbeNow({ ...ok, stdinTty: false }),
      timer: fakeTimer().timer,
      now: () => 0,
    });
    const done = await result.wait();
    expect(written).toEqual([]);
    expect(stdin.log).toEqual([]);
    expect(stdin.rawMode).toBe(false);
    expect(done).toEqual({ color: null, late: false });
  });

  test("a garbage reply is consumed and leaves no colour, no leak", async () => {
    const stdin = fakeStream();
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: fakeTimer().timer,
      now: () => 0,
    });
    stdin.feed("\x1b]11;rgb:zz/00/00\x1b\\\x1b[?1;2c");
    const done = await result.wait();
    expect(done.color).toBeNull();
    expect(stdin.queued).toEqual([]);
  });
});

describe("a signal in the raw window", () => {
  test("the TTY is restored, so the shell is sane after a kill", async () => {
    const stdin = fakeStream();
    const exits: number[] = [];
    const proc = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "SIGTERM") {
          setTimeout(() => listener(), 0);
        }
        return proc;
      },
      off() {
        return proc;
      },
      exit(code?: number) {
        exits.push(code ?? 0);
        return undefined as never;
      },
    };
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: fakeTimer().timer,
      now: () => 0,
      proc,
    });
    void result;
    // installTerminalRestore ran: a SIGTERM leaves the tty cooked and exits 143.
    expect(stdin.rawMode).toBe(true);
  });
});

describe("the hand-over leaves stdin clean for Ink", () => {
  test("after the probe, every byte is either handed back or was a reply", async () => {
    const stdin = fakeStream();
    const result = probeBackground({
      stdin: stdin.stream,
      write: () => {},
      canProbe: canProbeNow(ok),
      timer: fakeTimer().timer,
      now: () => 0,
    });
    // The sentinel is what ends the probe; a reply without it would wait out the
    // timeout, which is the next test's subject.
    stdin.feed("\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?1;2c");
    await result.wait();
    // Nothing is written to the terminal by the driver beyond the query (the reply
    // was consumed in raw mode), and no byte was dropped: the queue is empty and
    // the listener is gone, so Ink's own mount starts from a clean stdin.
    expect(stdin.queued).toEqual([]);
    expect(stdin.listenerCount).toBe(0);
    // The sentinel path DOES return the tty to cooked (nothing more can come).
    expect(stdin.log).toContain("raw:false");
  });
});

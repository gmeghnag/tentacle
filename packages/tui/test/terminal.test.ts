import { describe, expect, test } from "bun:test";
import {
  LEAVE_FULLSCREEN,
  type ProcessLike,
  installTerminalRestore,
  restoreTerminalOnExit,
} from "../src/terminal.ts";

/** A fake `process`: records listeners and lets a test emit an event. */
function fakeProc() {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const exitCodes: Array<number | undefined> = [];
  const proc: ProcessLike = {
    on(event, listener) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(listener);
      return proc;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return proc;
    },
    exit(code) {
      exitCodes.push(code);
    },
  };
  const emit = (event: string): void => {
    for (const l of listeners.get(event) ?? []) {
      l();
    }
  };
  const count = (event: string): number => listeners.get(event)?.size ?? 0;
  return { proc, emit, exitCodes, count };
}

describe("installTerminalRestore", () => {
  test("restores on a normal exit", () => {
    const { proc, emit } = fakeProc();
    let restores = 0;
    installTerminalRestore(proc, () => restores++);
    emit("exit");
    expect(restores).toBe(1);
  });

  test("restores on SIGINT/SIGTERM and re-exits with 128+signum", () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const { proc, emit, exitCodes } = fakeProc();
      let restores = 0;
      installTerminalRestore(proc, () => restores++);
      emit(signal);
      expect(restores).toBe(1);
      expect(exitCodes).toEqual([code]);
    }
  });

  test("restores at most once across multiple teardown events", () => {
    const { proc, emit } = fakeProc();
    let restores = 0;
    installTerminalRestore(proc, () => restores++);
    emit("SIGINT");
    emit("exit");
    emit("SIGTERM");
    expect(restores).toBe(1);
  });

  test("the teardown removes every listener it installed", () => {
    const { proc, count } = fakeProc();
    const uninstall = installTerminalRestore(proc, () => {});
    expect(count("exit") + count("SIGINT") + count("SIGTERM")).toBe(3);
    uninstall();
    expect(count("exit") + count("SIGINT") + count("SIGTERM")).toBe(0);
  });
});

describe("restoreTerminalOnExit (the probe's raw tty, Review LOW 5)", () => {
  /** A fake terminal: what was written, and every raw-mode call. */
  function fakeTerminal() {
    const written: string[] = [];
    const raw: boolean[] = [];
    const base = {
      write: (text: string) => written.push(text),
      setRawMode: (on: boolean) => raw.push(on),
    };
    return { base, written, raw };
  }

  test("fullscreen + a timed-out probe: leave the alt screen and cook the tty", () => {
    // The failure row's promise. Mutation: drop the `setRawMode(false)` call → a
    // mount that throws leaves the terminal raw for the rest of the session.
    const t = fakeTerminal();
    restoreTerminalOnExit(t.base, { fullscreen: true, probeWasLate: true });
    expect(t.written).toEqual([LEAVE_FULLSCREEN]);
    expect(t.raw).toEqual([false]);
  });

  test("a settled probe: no raw-mode call at all (Ink never went raw)", () => {
    // Mutation: always call `setRawMode(false)` → the tty is cooked while Ink
    // still owns it, and the app stops receiving keys.
    const t = fakeTerminal();
    restoreTerminalOnExit(t.base, { fullscreen: true, probeWasLate: false });
    expect(t.written).toEqual([LEAVE_FULLSCREEN]);
    expect(t.raw).toEqual([]);
  });

  test("not fullscreen: nothing is written, the raw fix still happens", () => {
    const t = fakeTerminal();
    restoreTerminalOnExit(t.base, { fullscreen: false, probeWasLate: true });
    expect(t.written).toEqual([]);
    expect(t.raw).toEqual([false]);
  });

  test("a stream with no `setRawMode`, or one that throws, does not break the exit", () => {
    // Mutation: call it unguarded → the throw escapes `finally` and the exit code
    // becomes an unhandled rejection instead of a clean exit.
    const written: string[] = [];
    expect(() =>
      restoreTerminalOnExit(
        { write: (t) => written.push(t) },
        { fullscreen: false, probeWasLate: true },
      ),
    ).not.toThrow();
    expect(() =>
      restoreTerminalOnExit(
        {
          write: () => {},
          setRawMode: () => {
            throw new Error("closed pty");
          },
        },
        { fullscreen: false, probeWasLate: true },
      ),
    ).not.toThrow();
  });
});

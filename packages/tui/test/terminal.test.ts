import { describe, expect, test } from "bun:test";
import { type ProcessLike, installTerminalRestore } from "../src/terminal.ts";

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

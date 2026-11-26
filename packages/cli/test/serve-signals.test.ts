/**
 * The `serve` signal logic, with a fake process (docs/fix/daemon-records-stale.md).
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  SERVE_STOP_SIGNALS,
  type ServeStopSignal,
  type SignalHost,
  awaitServeShutdown,
  shutdownStep,
} from "../src/serve-signals.ts";

function fakeHost() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const host = {
    on: (signal: string, listener: () => void) => emitter.on(signal, listener),
    off: (signal: string, listener: () => void) => emitter.off(signal, listener),
    exit: (code: number) => {
      exits.push(code);
    },
  } as unknown as SignalHost;
  return { emitter, exits, host };
}

describe("shutdownStep", () => {
  const cases: [boolean, ServeStopSignal, ReturnType<typeof shutdownStep>][] = [
    [false, "SIGINT", { kind: "stop" }],
    [false, "SIGTERM", { kind: "stop" }],
    [false, "SIGHUP", { kind: "stop" }],
    [true, "SIGHUP", { kind: "exit", code: 129 }],
    [true, "SIGINT", { kind: "exit", code: 130 }],
    [true, "SIGTERM", { kind: "exit", code: 143 }],
  ];
  for (const [stopping, signal, step] of cases) {
    test(`stopping=${stopping} ${signal} -> ${step.kind}`, () => {
      expect(shutdownStep({ stopping }, signal)).toEqual(step);
    });
  }
});

describe("awaitServeShutdown", () => {
  for (const signal of SERVE_STOP_SIGNALS) {
    test(`a first ${signal} stops once and resolves done`, async () => {
      const { emitter, exits, host } = fakeHost();
      let stops = 0;
      const shutdown = awaitServeShutdown(host, async () => {
        stops++;
      });
      expect(stops).toBe(0);
      emitter.emit(signal);
      await shutdown.done;
      expect(stops).toBe(1);
      expect(exits).toEqual([]);
    });
  }

  test("a second signal during a hung stop exits 128+n, without stopping again", () => {
    const { emitter, exits, host } = fakeHost();
    let stops = 0;
    awaitServeShutdown(host, () => {
      stops++;
      return new Promise<void>(() => {});
    });
    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    expect(exits).toEqual([130]);
    expect(stops).toBe(1);
  });

  test("the second signal's number wins, whichever came first", () => {
    const { emitter, exits, host } = fakeHost();
    awaitServeShutdown(host, () => new Promise<void>(() => {}));
    emitter.emit("SIGHUP");
    emitter.emit("SIGTERM");
    expect(exits).toEqual([143]);
  });

  test("a rejecting stop still resolves done", async () => {
    const { emitter, host } = fakeHost();
    const shutdown = awaitServeShutdown(host, () => Promise.reject(new Error("disk")));
    emitter.emit("SIGTERM");
    await expect(shutdown.done).resolves.toBeUndefined();
  });

  test("dispose removes its own listeners and no one else's", () => {
    const { emitter, host } = fakeHost();
    const foreign = (): void => {};
    emitter.on("SIGINT", foreign);
    const shutdown = awaitServeShutdown(host, async () => {});
    for (const signal of SERVE_STOP_SIGNALS) {
      expect(emitter.listenerCount(signal)).toBe(signal === "SIGINT" ? 2 : 1);
    }
    shutdown.dispose();
    expect(emitter.listeners("SIGINT")).toEqual([foreign]);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
    expect(emitter.listenerCount("SIGHUP")).toBe(0);
  });
});

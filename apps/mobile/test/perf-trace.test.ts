/**
 * The `ptrace` lines (docs/fix/mobile-fan-jank-device.md): what a device capture
 * says about JS frame gaps and the hub fan's open — numbers and enums only.
 */
import { describe, expect, test } from "bun:test";
import { createAppLog } from "../src/app-log.ts";
import { createPerfProbe } from "../src/perf-probe.ts";
import { JANK_GAP_MS, PTRACE, createJankMeter, fanLine, usableTap } from "../src/perf-trace.ts";

describe("createJankMeter", () => {
  test("a smooth window writes nothing", () => {
    const m = createJankMeter();
    const lines = [];
    for (let t = 0; t <= 2000; t += 16) {
      lines.push(m.frame(t, true));
    }
    expect(lines.filter((l) => l !== null)).toEqual([]);
  });

  test("a window with gaps says how many, the worst, and what the screen did", () => {
    const m = createJankMeter();
    m.frame(0, false);
    m.fold();
    m.fold();
    m.notify();
    m.render(12.4);
    m.render(20.2);
    expect(m.frame(16, true)).toBeNull();
    expect(m.frame(116, true)).toBeNull(); // a 100 ms gap
    expect(m.frame(156, true)).toBeNull(); // a 40 ms gap
    const line = m.frame(1000, false); // closes the window with an 844 ms gap
    expect(line?.kind).toBe(PTRACE);
    expect(line?.fields).toEqual({
      ev: "jank",
      win: 1000,
      gaps: 3,
      worst: 844,
      lost: Math.round(100 + 40 + 844 - 3 * (1000 / 60)),
      stream: true,
      folds: 2,
      notifies: 1,
      renders: 2,
      renderMs: 33,
    });
  });

  test("a gap of exactly the threshold is not jank", () => {
    const m = createJankMeter();
    m.frame(0, false);
    m.frame(JANK_GAP_MS, false);
    expect(m.frame(1000 + JANK_GAP_MS, false)?.fields.gaps).toBe(1);
  });

  test("after a pause the first frame starts a fresh window (the idle gap is not jank)", () => {
    const m = createJankMeter();
    m.frame(0, false);
    m.pause();
    const lines = [];
    for (let t = 50_000; t <= 51_100; t += 16) {
      lines.push(m.frame(t, false));
    }
    expect(lines.filter((l) => l !== null)).toEqual([]);
  });
});

describe("fan line", () => {
  test("latencies are from the touch", () => {
    const line = fanLine({
      tapNative: 100,
      tapJs: 130,
      start: 150,
      settle: 700,
      starts: 1,
      streaming: true,
    });
    expect(line.fields).toEqual({
      ev: "fan",
      wait: 30,
      start: 50,
      settle: 600,
      starts: 1,
      stream: true,
    });
  });

  test("no usable touch time: from the handler, wait -1; never settled: settle -1", () => {
    const line = fanLine({
      tapNative: null,
      tapJs: 130,
      start: 150,
      settle: null,
      starts: 4,
      streaming: false,
    });
    expect(line.fields).toEqual({
      ev: "fan",
      wait: -1,
      start: 20,
      settle: -1,
      starts: 4,
      stream: false,
    });
  });

  test("a native timestamp on another clock is dropped, not reported", () => {
    expect(usableTap(100, 130)).toBe(100);
    expect(usableTap(200, 130)).toBeNull(); // after the handler
    expect(usableTap(1e12, 130)).toBeNull();
    expect(usableTap(undefined, 130)).toBeNull();
    expect(usableTap(Number.NaN, 130)).toBeNull();
  });
});

describe("createPerfProbe", () => {
  function probe() {
    let t = 0;
    const frames: ((t: number) => void)[] = [];
    const p = createPerfProbe(
      () => t,
      (fn) => frames.push(fn),
    );
    const log = createAppLog({ now: () => 0, capacity: 50 });
    p.attach(log);
    const step = (ms: number): void => {
      t += ms;
      const fn = frames.shift();
      fn?.(t);
    };
    return { p, log, step, frames };
  }

  test("no loop at rest", () => {
    const h = probe();
    h.p.streaming(false);
    expect(h.frames.length).toBe(0);
  });

  test("one fan line per open: touch → start → settle, counting restarts", () => {
    const h = probe();
    h.p.touch(undefined);
    h.p.fanOpen();
    h.step(16);
    h.p.fanStart();
    h.step(16);
    h.p.fanStart(); // a re-render restarted it
    h.p.fanSettle(false); // the restarted run's stop
    h.step(400);
    h.p.fanSettle(true);
    h.p.fanClose(); // already reported: nothing more
    const lines = h.log.entries().filter((e) => e.kind === PTRACE);
    expect(lines.map((e) => e.fields)).toEqual([
      { ev: "fan", wait: -1, start: 16, settle: 432, starts: 2, stream: false },
    ]);
  });

  test("a fan closed before it settled still reports, once", () => {
    const h = probe();
    h.p.touch(undefined);
    h.p.fanOpen();
    h.p.fanStart();
    h.p.fanClose();
    h.p.fanClose();
    expect(h.log.entries().map((e) => e.fields.settle)).toEqual([-1]);
  });

  test("the loop stops once nothing is streaming and no fan is opening", () => {
    const h = probe();
    h.p.streaming(true);
    h.step(16);
    h.step(16);
    expect(h.frames.length).toBe(1);
    h.p.streaming(false);
    h.step(16);
    expect(h.frames.length).toBe(0);
  });
});

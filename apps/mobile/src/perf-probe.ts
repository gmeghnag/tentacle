/**
 * The perf trace's runtime half (docs/fix/mobile-fan-jank-device.md): the ONE
 * probe the session screen and the hub report to, the `requestAnimationFrame`
 * loop that feeds `perf-trace.ts`'s meter, and the sink into the app's ONE log.
 * Every decision (what is a gap, what a line says) is `perf-trace.ts`'s.
 *
 * The loop runs ONLY while a turn streams or a fan is opening — never at rest,
 * so an idle app does not wake the JS thread every frame for a diagnostic.
 */
import type { AppLog } from "./app-log.ts";
import {
  FAN_REPORT_MAX_MS,
  type FanOpenFacts,
  type PerfLine,
  createJankMeter,
  fanLine,
  usableTap,
} from "./perf-trace.ts";

interface FanRecord {
  tapNative: number | null;
  tapJs: number;
  start: number | null;
  starts: number;
  streaming: boolean;
}

export interface PerfProbe {
  /** Where lines go (App wires the ONE log at start; before that, nothing is kept). */
  attach(log: AppLog): void;
  /** Whether a turn is streaming on the screen in front (starts/stops the loop). */
  streaming(on: boolean): void;
  /** The session screen rendered (render start → commit, ms). */
  render(ms: number): void;
  /** The session screen was handed a new state. */
  notify(): void;
  /** A streamed delta was folded. */
  fold(): void;
  /** A touch on the hub reached JS (its native timestamp, when the event has one). */
  touch(nativeTimestamp: number | undefined): void;
  /** The fan opened (the last `touch` is its tap). */
  fanOpen(): void;
  /** The fan's items' opening animation was started (again). */
  fanStart(): void;
  /** The opening animation ended (`finished`: it ran to the end). */
  fanSettle(finished: boolean): void;
  /** The fan closed. */
  fanClose(): void;
  /** The clock every reading uses. */
  now(): number;
}

export function createPerfProbe(
  clock: () => number = () => globalThis.performance.now(),
  frame: (fn: (t: number) => void) => unknown = (fn) => globalThis.requestAnimationFrame(fn),
): PerfProbe {
  let log: AppLog | null = null;
  const meter = createJankMeter();
  let isStreaming = false;
  let looping = false;
  let lastTouch: { native: number | undefined; js: number } | null = null;
  let fan: FanRecord | null = null;
  const write = (line: PerfLine | null): void => {
    if (line !== null) {
      log?.log(line.level, line.kind, line.fields);
    }
  };
  const report = (settle: number | null): void => {
    if (fan === null) {
      return;
    }
    const facts: FanOpenFacts = { ...fan, settle };
    fan = null;
    write(fanLine(facts));
  };
  const active = (): boolean => isStreaming || fan !== null;
  const tick = (): void => {
    if (!active()) {
      looping = false;
      meter.pause();
      return;
    }
    const t = clock();
    write(meter.frame(t, isStreaming));
    // A fan that never settles still reports, once it is surely over.
    if (fan !== null && t - fan.tapJs > FAN_REPORT_MAX_MS) {
      report(null);
    }
    frame(tick);
  };
  const loop = (): void => {
    if (!looping && active()) {
      looping = true;
      frame(tick);
    }
  };
  return {
    attach(next) {
      log = next;
    },
    streaming(on) {
      isStreaming = on;
      loop();
    },
    render: (ms) => meter.render(ms),
    notify: () => meter.notify(),
    fold: () => meter.fold(),
    touch(nativeTimestamp) {
      lastTouch = { native: nativeTimestamp, js: clock() };
    },
    fanOpen() {
      const tapJs = lastTouch?.js ?? clock();
      fan = {
        tapNative: usableTap(lastTouch?.native, tapJs),
        tapJs,
        start: null,
        starts: 0,
        streaming: isStreaming,
      };
      loop();
    },
    fanStart() {
      if (fan !== null) {
        fan.starts += 1;
        fan.start = fan.start ?? clock();
      }
    },
    fanSettle(finished) {
      if (finished) {
        report(clock());
      }
    },
    fanClose() {
      report(null);
    },
    now: clock,
  };
}

/** The app's ONE probe (App attaches the log at start). */
export const PERF: PerfProbe = createPerfProbe();

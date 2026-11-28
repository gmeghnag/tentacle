/**
 * The on-device perf trace (docs/fix/mobile-fan-jank-device.md): the `ptrace`
 * lines a real phone's exported log needs to say WHY the hub fan opens in jerks
 * while a turn streams — the simulator does not reproduce it, so the evidence
 * has to come from the device (`grep ptrace tentacle-logs-*.txt`).
 *
 * Three kinds of line, all numbers and short enums only (app-log D7/F16):
 * - `ev=panes` — one per stream, when it stops: the renders of the screen's
 *   shell and of each of its panes while it ran (mobile-ui-fluidity-s3).
 * - `ev=jank` — one per 1 s window in which the JS thread missed a frame (a
 *   `requestAnimationFrame` gap > `JANK_GAP_MS`): how many gaps, the worst, the
 *   time lost, whether a turn was streaming, and what the screen did in that
 *   window (stream folds, state notifications, renders and their cost). A
 *   window with no gap logs nothing, so a smooth session writes no line.
 * - `ev=fan` — one per fan open: touch → JS handler (`wait`), touch → the
 *   items' animation started (`start`), touch → the items finished opening
 *   (`settle`), and how many times the opening animation was (re)started
 *   (`starts`: 1 is right; more means a re-render restarted it mid-flight).
 *
 * Pure and React-free (AGENTS §7): the clock readings are handed in; the rAF
 * loop and the log sink live in `perf-probe.ts`.
 */
import type { AppLogEntry, AppLogField } from "./app-log.ts";

/** The app-log kind every trace line carries (the owner's grep). */
export const PTRACE = "ptrace";

/** A JS frame gap longer than this is a missed frame (two 60 Hz vsyncs). */
export const JANK_GAP_MS = 32;

/** How long one jank window is. */
export const JANK_WINDOW_MS = 1000;

/** A fan that never settles (closed first, or still opening) reports at most this late. */
export const FAN_REPORT_MAX_MS = 5000;

/** The session screen's panes, as `ev=panes` names them. */
export const PANES = ["header", "composer", "hub", "sheets"] as const;
export type PaneName = (typeof PANES)[number];

/** One line, ready for `AppLog.log`. */
export interface PerfLine {
  readonly level: AppLogEntry["level"];
  readonly kind: typeof PTRACE;
  readonly fields: Readonly<Record<string, AppLogField>>;
}

const round = (ms: number): number => Math.round(ms);

/**
 * The JS-thread meter: fed every animation frame's time plus the screen's own
 * counts, it answers a `jank` line when a window that missed a frame closes.
 */
export interface JankMeter {
  /** One `requestAnimationFrame` callback at `t` (ms, monotonic). */
  frame(t: number, streaming: boolean): PerfLine | null;
  /** The session screen rendered; `ms` is render start → commit. */
  render(ms: number): void;
  /** The screen was notified of a new state. */
  notify(): void;
  /** A streamed delta was folded. */
  fold(): void;
  /** The loop stopped: the next frame starts a fresh window (its gap is not jank). */
  pause(): void;
}

export function createJankMeter(
  gapMs: number = JANK_GAP_MS,
  windowMs: number = JANK_WINDOW_MS,
): JankMeter {
  let last: number | null = null;
  let opened: number | null = null;
  let gaps = 0;
  let worst = 0;
  let lost = 0;
  let streamed = false;
  let renders = 0;
  let renderMs = 0;
  let notifies = 0;
  let folds = 0;
  const reset = (t: number | null): void => {
    opened = t;
    gaps = 0;
    worst = 0;
    lost = 0;
    streamed = false;
    renders = 0;
    renderMs = 0;
    notifies = 0;
    folds = 0;
  };
  return {
    frame(t, streaming) {
      if (last === null || opened === null) {
        last = t;
        reset(t);
        return null;
      }
      const gap = t - last;
      last = t;
      if (gap > gapMs) {
        gaps += 1;
        worst = Math.max(worst, gap);
        // The time beyond one frame's budget: what the eye lost.
        lost += gap - 1000 / 60;
      }
      streamed = streamed || streaming;
      if (t - opened < windowMs) {
        return null;
      }
      const line: PerfLine | null =
        gaps === 0
          ? null
          : {
              level: "info",
              kind: PTRACE,
              fields: {
                ev: "jank",
                win: round(t - opened),
                gaps,
                worst: round(worst),
                lost: round(lost),
                stream: streamed,
                folds,
                notifies,
                renders,
                renderMs: round(renderMs),
              },
            };
      reset(t);
      return line;
    },
    render(ms) {
      renders += 1;
      renderMs += ms;
    },
    notify() {
      notifies += 1;
    },
    fold() {
      folds += 1;
    },
    pause() {
      last = null;
      opened = null;
    },
  };
}

/** What one fan open measured (every time on the same monotonic clock as `tapJs`). */
export interface FanOpenFacts {
  /** The touch's own timestamp (the native event's), or null when it is unusable. */
  readonly tapNative: number | null;
  /** When the JS handler saw the touch that opened the fan. */
  readonly tapJs: number;
  /** When the items' opening animation was FIRST started, or null (never). */
  readonly start: number | null;
  /** When the opening animation finished, or null (closed or cut first). */
  readonly settle: number | null;
  /** How many times the opening animation was started during this open. */
  readonly starts: number;
  readonly streaming: boolean;
}

/**
 * Whether a native touch timestamp is on the JS clock: it must be at or before
 * the handler, and not absurdly old. Anything else (another clock base) is
 * dropped rather than reported as a wrong latency.
 */
export function usableTap(tapNative: number | undefined, tapJs: number): number | null {
  if (tapNative === undefined || !Number.isFinite(tapNative)) {
    return null;
  }
  const wait = tapJs - tapNative;
  return wait >= 0 && wait <= FAN_REPORT_MAX_MS ? tapNative : null;
}

/** The `fan` line: latencies from the touch (or, failing that, from the handler). */
export function fanLine(f: FanOpenFacts): PerfLine {
  const base = f.tapNative ?? f.tapJs;
  const since = (t: number | null): number => (t === null ? -1 : round(t - base));
  return {
    level: "info",
    kind: PTRACE,
    fields: {
      ev: "fan",
      wait: f.tapNative === null ? -1 : round(f.tapJs - f.tapNative),
      start: since(f.start),
      settle: since(f.settle),
      starts: f.starts,
      stream: f.streaming,
    },
  };
}

/**
 * The `panes` line (docs/feat/mobile-ui-fluidity-s3.md): over ONE stream, how
 * often the screen's shell rendered and how often each pane did. A pane near the
 * shell's figure follows the stream.
 */
export function panesLine(shell: number, panes: Readonly<Record<PaneName, number>>): PerfLine {
  return { level: "info", kind: PTRACE, fields: { ev: "panes", shell, ...panes } };
}

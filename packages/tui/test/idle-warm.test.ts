import { describe, expect, spyOn, test } from "bun:test";
import * as format from "../src/format.ts";
import {
  IDLE_WARM_DELAY_MS,
  type IdleWarmState,
  type WarmTimers,
  otherViewOpts,
  startIdleWarm,
} from "../src/idle-warm.ts";
import * as renderLines from "../src/render-lines.ts";
import { layoutTranscript } from "../src/render-lines.ts";
import type { DisplayItem, ToolItem } from "../src/state.ts";

/** Manual timers: nothing fires until `runNext()`, so the schedule is deterministic. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: WarmTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    /** Fire the oldest pending timer; false when none. */
    runNext(): boolean {
      const first = pending.entries().next();
      if (first.done) {
        return false;
      }
      const [id, { fn }] = first.value;
      pending.delete(id);
      fn();
      return true;
    },
    runAll(): number {
      let n = 0;
      while (this.runNext()) {
        n += 1;
      }
      return n;
    },
  };
}

const body = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join("\n");
const mkTool = (id: string): ToolItem => ({
  kind: "tool",
  id,
  name: "shell",
  args: '{"command":"ls"}',
  status: "ok",
  durationMs: 500,
  resultText: body,
});
const mkItems = (n: number, prefix: string): DisplayItem[] =>
  Array.from({ length: n }, (_, i) => mkTool(`${prefix}${i}`));

const state = (
  items: readonly DisplayItem[],
  over: Partial<IdleWarmState> = {},
): IdleWarmState => ({
  items,
  opts: { expandAll: false, width: 40 },
  running: false,
  busy: false,
  ...over,
});

describe("otherViewOpts (when and which)", () => {
  test("the opposite view, same width", () => {
    expect(otherViewOpts(state(mkItems(1, "a")))?.expandAll).toBe(true);
    expect(otherViewOpts(state(mkItems(1, "b"), { opts: { expandAll: true, width: 55 } }))).toEqual(
      { expandAll: false, width: 55 },
    );
  });

  test("never while a turn runs, nor while another warm is in flight", () => {
    expect(otherViewOpts(state(mkItems(1, "c"), { running: true }))).toBeNull();
    expect(otherViewOpts(state(mkItems(1, "d"), { busy: true }))).toBeNull();
  });

  test("nothing to warm without a tool item", () => {
    const items: DisplayItem[] = [{ kind: "assistant", text: "hi" }];
    expect(otherViewOpts(state(items))).toBeNull();
    expect(otherViewOpts(state([]))).toBeNull();
  });
});

describe("startIdleWarm", () => {
  test("after the warm, a Ctrl+O toggle lays out no item again", () => {
    const items = mkItems(5, "w");
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { expandAll: false, width: 40 }); // what is shown
      expect(spy.mock.calls.length).toBe(5);
      const clock = fakeTimers();
      let done = -1;
      startIdleWarm(state(items), {
        timers: clock.timers,
        chunkMs: 0, // one item per chunk: several chunks
        onDone: (chunks) => {
          done = chunks;
        },
      });
      expect(spy.mock.calls.length).toBe(5); // nothing before the quiet delay
      expect([...clock.pending.values()][0]?.ms).toBe(IDLE_WARM_DELAY_MS);
      clock.runAll();
      expect(done).toBe(5);
      expect(spy.mock.calls.length).toBe(10); // the expanded view, filled by the warm
      layoutTranscript(items, { expandAll: true, width: 40 });
      layoutTranscript(items, { expandAll: false, width: 40 });
      expect(spy.mock.calls.length).toBe(10); // the toggles are all hits
    } finally {
      spy.mockRestore();
    }
  });

  test("cancelling (a new update, a resize, Ctrl+O) stops the warm mid-way", () => {
    const items = mkItems(5, "x");
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { expandAll: false, width: 40 });
      const clock = fakeTimers();
      let done = false;
      const cancel = startIdleWarm(state(items), {
        timers: clock.timers,
        chunkMs: 0,
        onDone: () => {
          done = true;
        },
      });
      clock.runNext(); // delay elapsed
      clock.runNext(); // chunk 1 done... (one item each)
      const warmed = spy.mock.calls.length;
      expect(warmed).toBeGreaterThan(5);
      expect(warmed).toBeLessThan(10);
      cancel();
      expect(clock.pending.size).toBe(0);
      expect(clock.runAll()).toBe(0);
      expect(spy.mock.calls.length).toBe(warmed); // no further work
      expect(done).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("cancelling before the delay elapses does no work at all", () => {
    const items = mkItems(3, "y");
    const spy = spyOn(format, "formatDurationMs");
    try {
      const clock = fakeTimers();
      startIdleWarm(state(items), { timers: clock.timers })();
      clock.runAll();
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("delayMs 0 still waits for a timer; nothing runs synchronously (Review F4)", () => {
    // `main` scheduled the first tick through `timers.set` whatever the delay, so a
    // 0 ms warm did its work after the call returned, never inside it.
    const items = mkItems(3, "d");
    const spy = spyOn(format, "formatDurationMs");
    try {
      const clock = fakeTimers();
      let done = -1;
      startIdleWarm(state(items), {
        timers: clock.timers,
        delayMs: 0,
        onDone: (chunks) => {
          done = chunks;
        },
      });
      expect(spy.mock.calls.length).toBe(0); // no layout inside the call
      expect(done).toBe(-1); // and no commit inside the call
      expect([...clock.pending.values()][0]?.ms).toBe(0);
      clock.runAll();
      expect(spy.mock.calls.length).toBe(3);
      expect(done).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("no timer is even scheduled while a turn runs", () => {
    const clock = fakeTimers();
    startIdleWarm(state(mkItems(3, "z"), { running: true }), { timers: clock.timers });
    expect(clock.pending.size).toBe(0);
  });

  test("a chunk that throws after the delay reaches `onError`, not an unhandled rejection (R1)", async () => {
    // The idle warm's chunks all run in timers and nothing reads `done`, so an
    // unhandled rejection would be the only report. `onError` is the site's
    // surface: it must see the real error. Mutation: drop `onError` from
    // `startIdleWarm` (idle-warm.ts) → red (`bun test` fails the file on the
    // unhandled rejection and `seen` stays empty).
    const items = mkItems(5, "e");
    const clock = fakeTimers();
    const seen: string[] = [];
    let calls = 0;
    const spy = spyOn(renderLines, "warmRowsChunk").mockImplementation((_items, _opts, from) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("boom-idle-chunk-2");
      }
      return from + 1;
    });
    try {
      startIdleWarm(state(items), {
        timers: clock.timers,
        chunkMs: 0,
        onError: (error) => seen.push(String(error)),
      });
      clock.runAll();
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual(["Error: boom-idle-chunk-2"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a warm for the other width does not serve a stale layout", () => {
    // Warm at width 40; Ctrl+O at width 30 still lays out (correct rows, not 40's).
    const items = mkItems(2, "s");
    const clock = fakeTimers();
    startIdleWarm(state(items), { timers: clock.timers });
    clock.runAll();
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { expandAll: true, width: 30 });
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

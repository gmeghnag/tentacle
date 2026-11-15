/**
 * Slice 2 of docs/feat/session-hop-ux: the hop's ONE live progress line.
 *
 * The defect (Repro 2 in the task doc): a hop builds with `HOP_TERM = {tty:false}`,
 * so `statusLineFor` returns `null` and every phase, every 10% of the transfer and
 * the resolver's verbose log becomes its own transcript notice — ~13 of them. The
 * interactive contract already exists (a single line updated in place); the hop
 * just needs a way to select it without a TTY.
 *
 * `createHopLiveLine` is that way: it is a `StatusLine`-shaped sink (`set`/
 * `finish`) the engine treats exactly as it treats its own spinner, and it emits
 * through the hop's status row. The throttle is here, not in the engine, because
 * the transfer reports ~130 times for 8 MB: an Ink re-render per tick would jank
 * the frame the hop is drawing into.
 */
import { describe, expect, test } from "bun:test";
import { HOP_LIVE_LINE_MS, createHopLiveLine } from "../src/hop-live-line.ts";

/** A clock and a timer set the test drives: no real waiting, no flakiness. */
function fakeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) {
          timers.splice(at, 1);
        }
      };
    },
    /** Advance time, running every timer that comes due (in order). */
    advance: (ms: number) => {
      now += ms;
      for (
        let due = timers.find((t) => t.at <= now);
        due !== undefined;
        due = timers.find((t) => t.at <= now)
      ) {
        const at = timers.indexOf(due);
        timers.splice(at, 1);
        due.fn();
      }
    },
    pending: () => timers.length,
  };
}

const rig = () => {
  const clock = fakeClock();
  const emitted: Array<string | null> = [];
  const line = createHopLiveLine({
    emit: (text) => emitted.push(text),
    now: clock.now,
    schedule: clock.schedule,
  });
  return { line, clock, emitted };
};

describe("slice 2: the hop's live line is throttled, latching, and last-text-wins", () => {
  test("the FIRST text goes out at once (the row must appear, not lag)", () => {
    const { line, emitted } = rig();
    line.set("[pod] resolving…");
    expect(emitted).toEqual(["[pod] resolving…"]);
  });

  test("at most one emit per HOP_LIVE_LINE_MS, and the LATEST text is the one that lands", () => {
    // Mutation: emit every call → `emitted` has 4 entries; emit only on a timer
    // (no leading edge) → the first row is missing.
    const { line, clock, emitted } = rig();
    line.set("a");
    line.set("b");
    line.set("c");
    expect(emitted).toEqual(["a"]);
    clock.advance(HOP_LIVE_LINE_MS);
    // The trailing text — never `b`, which was superseded inside the window.
    expect(emitted).toEqual(["a", "c"]);
  });

  test("a trailing timer is armed ONCE per window, so a long run cannot pile timers up", () => {
    const { line, clock, emitted } = rig();
    line.set("a");
    for (let i = 0; i < 50; i += 1) {
      line.set(`tick ${i}`);
    }
    expect(clock.pending()).toBe(1);
    clock.advance(HOP_LIVE_LINE_MS);
    expect(emitted).toEqual(["a", "tick 49"]);
    expect(clock.pending()).toBe(0);
  });

  test("identically repeated text is dropped (the transfer re-reports the same percent)", () => {
    const { line, clock, emitted } = rig();
    line.set("same");
    clock.advance(HOP_LIVE_LINE_MS);
    line.set("same");
    clock.advance(HOP_LIVE_LINE_MS);
    line.set("same");
    expect(emitted).toEqual(["same"]);
  });

  test("finish() clears the timer and latches: nothing is emitted afterwards", () => {
    // Mutation: drop the latch → the trailing text lands after `finish`, i.e. a
    // hop's phase row reappears after the row was taken down (settle).
    const { line, clock, emitted } = rig();
    line.set("a");
    line.set("b");
    line.finish();
    expect(clock.pending()).toBe(0);
    clock.advance(HOP_LIVE_LINE_MS * 10);
    line.set("late");
    clock.advance(HOP_LIVE_LINE_MS * 10);
    expect(emitted).toEqual(["a"]);
  });

  test("the row is UPDATED in place, never cleared per phase (no flicker, one line)", () => {
    const { line, clock, emitted } = rig();
    for (const text of ["one", "two", "three", "four", "five"]) {
      line.set(text);
      clock.advance(HOP_LIVE_LINE_MS);
    }
    // Every emit is text: a `null` here would clear the row between phases and the
    // owner would see the line blink (and the App re-allocates the frame).
    expect(emitted.every((text) => typeof text === "string")).toBe(true);
  });

  test("a SECOND line (a second build) is independent, not a shared latch", () => {
    const clock = fakeClock();
    const first: string[] = [];
    const second: string[] = [];
    const a = createHopLiveLine({
      emit: (t) => first.push(t),
      now: clock.now,
      schedule: clock.schedule,
    });
    const b = createHopLiveLine({
      emit: (t) => second.push(t),
      now: clock.now,
      schedule: clock.schedule,
    });
    a.set("a1");
    a.finish();
    b.set("b1");
    expect(first).toEqual(["a1"]);
    expect(second).toEqual(["b1"]);
  });
});

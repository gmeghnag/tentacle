/**
 * docs/feat/mobile-ui-fluidity-s2.md: the owned clocks' pure half — the two
 * label formats (pinned by the SAME vector table the Swift `ClockCoreTests`
 * reads) and the one app-wide sampler behind the JS fallback.
 */
import { describe, expect, test } from "bun:test";
import { type ClockFormat, createClockSampler, elapsedSince, formatClock } from "../src/clock.ts";
import { thinkingElapsed } from "../src/thinking-motion.ts";
import { liveElapsed } from "../src/tool-summary.ts";
import vectors from "./fixtures/clock-format-v1.json";

const FORMATS: readonly ClockFormat[] = ["thinking", "step"];

function table(format: ClockFormat): readonly (readonly [number, string])[] {
  return vectors[format] as unknown as readonly (readonly [number, string])[];
}

describe("formatClock: the shared vector table", () => {
  for (const format of FORMATS) {
    test(`${format}: every vector`, () => {
      expect(table(format).length).toBeGreaterThanOrEqual(14);
      expect(table(format).map(([ms]) => [ms, formatClock(format, ms)])).toEqual(
        table(format).map(([ms, label]) => [ms, label]),
      );
    });
  }

  test("the old names are the same clock", () => {
    for (const [ms] of [...table("thinking"), ...table("step")]) {
      expect(thinkingElapsed(ms)).toBe(formatClock("thinking", ms));
      expect(liveElapsed(ms)).toBe(formatClock("step", ms));
    }
  });
});

describe("elapsedSince", () => {
  test("the distance from the stamp, never negative (a phone behind the Mac)", () => {
    expect(elapsedSince(1_000, 4_500)).toBe(3_500);
    expect(elapsedSince(5_000, 4_000)).toBe(0);
  });
});

/** A fake clock and scheduler: `pending` is what is armed right now. */
function fake(start: number) {
  let now = start;
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    advance(to: number) {
      now = to;
    },
    deps: {
      now: () => now,
      schedule(fn: () => void, ms: number) {
        const entry = { fn, ms };
        pending.push(entry);
        return () => {
          const i = pending.indexOf(entry);
          if (i >= 0) {
            pending.splice(i, 1);
          }
        };
      },
    },
    fire() {
      pending.shift()?.fn();
    },
  };
}

describe("createClockSampler", () => {
  test("one scheduled callback for five subscribers, none after the last leaves", () => {
    const clock = fake(10_000);
    const sampler = createClockSampler(clock.deps, 250);
    expect(clock.pending.length).toBe(0);
    let calls = 0;
    const offs = Array.from({ length: 5 }, () =>
      sampler.subscribe(() => {
        calls++;
      }),
    );
    expect(clock.pending.length).toBe(1);
    clock.advance(10_250);
    clock.fire();
    expect(calls).toBe(5);
    expect(clock.pending.length).toBe(1);
    for (const off of offs.slice(0, 4)) {
      off();
    }
    expect(clock.pending.length).toBe(1);
    offs[4]?.();
    expect(clock.pending.length).toBe(0);
  });

  test("a late wake is re-aimed at the next boundary, not carried forward", () => {
    const clock = fake(10_100);
    const sampler = createClockSampler(clock.deps, 250);
    sampler.subscribe(() => {});
    expect(clock.pending[0]?.ms).toBe(150);
    // The wake was due at 10 250 and lands 900 ms late.
    clock.advance(11_150);
    clock.fire();
    expect(clock.pending.map((p) => p.ms)).toEqual([100]);
    // Exactly on a boundary: a whole period, never 0.
    clock.advance(11_250);
    clock.fire();
    expect(clock.pending.map((p) => p.ms)).toEqual([250]);
  });

  test("every subscriber leaving DURING a wake leaves nothing armed; a new one re-arms", () => {
    const clock = fake(0);
    const sampler = createClockSampler(clock.deps, 250);
    const offs: (() => void)[] = [];
    offs.push(sampler.subscribe(() => offs[0]?.()));
    clock.fire();
    expect(clock.pending.length).toBe(0);
    const off = sampler.subscribe(() => {});
    expect(clock.pending.length).toBe(1);
    // Unsubscribing twice (the first handle again) must not disarm the new one.
    offs[0]?.();
    expect(clock.pending.length).toBe(1);
    off();
    expect(clock.pending.length).toBe(0);
  });

  test("the same function subscribed twice stays until both handles are used", () => {
    const clock = fake(0);
    const sampler = createClockSampler(clock.deps, 250);
    const fn = () => {};
    const first = sampler.subscribe(fn);
    const second = sampler.subscribe(fn);
    first();
    expect(clock.pending.length).toBe(1);
    second();
    expect(clock.pending.length).toBe(0);
  });

  test("now() reads the injected clock", () => {
    const clock = fake(42);
    const sampler = createClockSampler(clock.deps, 250);
    clock.advance(43);
    expect(sampler.now()).toBe(43);
  });
});

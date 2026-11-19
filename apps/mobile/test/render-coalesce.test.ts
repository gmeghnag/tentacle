/**
 * Render coalescing (docs/fix/mobile-fan-jank-device.md): a stream of deltas
 * notifies the screen at most once per window; anything else notifies at once;
 * nothing is ever dropped.
 */
import { describe, expect, test } from "bun:test";
import { STREAM_RENDER_MS, createRenderCoalescer } from "../src/render-coalesce.ts";

function harness(windowMs?: number) {
  let t = 1000;
  let fires = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const c = createRenderCoalescer({
    fire: () => {
      fires += 1;
    },
    clock: () => t,
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    ...(windowMs === undefined ? {} : { windowMs }),
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) {
        break;
      }
      t = next.at;
      next.live = false;
      next.fn();
    }
    t = end;
  };
  return { c, advance, fires: () => fires, live: () => timers.filter((x) => x.live).length };
}

describe("createRenderCoalescer", () => {
  test("the first delta after a quiet stretch shows at once", () => {
    const h = harness();
    h.c.soon();
    expect(h.fires()).toBe(1);
    expect(h.c.pending()).toBe(false);
  });

  test("100 deltas at 10 ms intervals notify ~once per window, not 100 times", () => {
    const h = harness();
    for (let i = 0; i < 100; i++) {
      h.c.soon();
      h.advance(10);
    }
    h.advance(STREAM_RENDER_MS);
    // 1 s of stream at a 100 ms window: the leading fire plus one per window.
    expect(h.fires()).toBeGreaterThanOrEqual(10);
    expect(h.fires()).toBeLessThanOrEqual(11);
    expect(h.c.pending()).toBe(false);
  });

  test("the LAST delta is always shown: a pending notification fires by the window's end", () => {
    const h = harness();
    h.c.soon();
    h.advance(5);
    h.c.soon();
    expect(h.fires()).toBe(1);
    expect(h.c.pending()).toBe(true);
    h.advance(STREAM_RENDER_MS - 6);
    expect(h.fires()).toBe(1);
    h.advance(1);
    expect(h.fires()).toBe(2);
    expect(h.c.pending()).toBe(false);
  });

  test("an urgent change fires at once and absorbs the pending one (no double render)", () => {
    const h = harness();
    h.c.soon();
    h.advance(10);
    h.c.soon();
    expect(h.c.pending()).toBe(true);
    h.c.now();
    expect(h.fires()).toBe(2);
    expect(h.c.pending()).toBe(false);
    expect(h.live()).toBe(0);
    h.advance(1000);
    expect(h.fires()).toBe(2);
  });

  test("an urgent change is never delayed, even right after a fire", () => {
    const h = harness();
    h.c.soon();
    h.c.now();
    h.c.now();
    expect(h.fires()).toBe(3);
  });

  test("a delta right after an urgent fire waits out that window", () => {
    const h = harness();
    h.c.now();
    h.advance(30);
    h.c.soon();
    expect(h.fires()).toBe(1);
    h.advance(STREAM_RENDER_MS - 30);
    expect(h.fires()).toBe(2);
  });

  test("dispose drops the pending notification", () => {
    const h = harness();
    h.c.soon();
    h.c.soon();
    h.c.dispose();
    h.advance(1000);
    expect(h.fires()).toBe(1);
    expect(h.c.pending()).toBe(false);
  });

  test("the window is injectable", () => {
    const h = harness(16);
    h.c.soon();
    h.c.soon();
    h.advance(16);
    expect(h.fires()).toBe(2);
  });
});

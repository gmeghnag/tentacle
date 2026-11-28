/**
 * Stream batching (12b "Tests", plan F23): the BATCHED final state equals the
 * UNBATCHED fold of the same events, on an injected clock.
 *
 * That equality is the whole contract: this module decides WHEN the fold sees an
 * event, never what it means. So the assertions are "same rows as unbatched"
 * plus the window discipline (prose merges inside a window, a non-prose event
 * flushes first, order is preserved).
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { GAP_MS, SLICE_MS, createBatcher, createSlicer } from "../src/stream-batch.ts";
import { type State, apply, initialState } from "../src/transcript.ts";

const prose = (delta: string): SessionEvent => ({ type: "text", delta });
const think = (delta: string): SessionEvent => ({ type: "reasoning", delta });

function foldPlain(events: readonly SessionEvent[]): State {
  return events.reduce<State>((state, event) => apply(state, event), initialState);
}

function foldBatched(events: readonly SessionEvent[], stepMs: number): State {
  const batcher = createBatcher(50);
  let state = initialState;
  let now = 0;
  for (const event of events) {
    now += stepMs;
    for (const out of batcher.push(event, now)) {
      state = apply(state, out);
    }
  }
  for (const out of batcher.flush()) {
    state = apply(state, out);
  }
  return state;
}

const STREAM: readonly SessionEvent[] = [
  prose("Hel"),
  prose("lo, "),
  prose("world"),
  think("thinking"),
  think(" harder"),
  prose("Done."),
  { type: "tool_start", id: "c1", name: "shell", arguments: "{}" },
  { type: "tool_result", id: "c1", name: "shell", result: { content: "ok" } },
  prose("All good."),
];

describe("the slicer (a backlog's time budget)", () => {
  /** One event: arrives at `t`, its fold ends `cost` later. */
  const step = (slicer: ReturnType<typeof createSlicer>, t: number, cost: number): boolean => {
    slicer.arrive(t);
    return slicer.done(t + cost);
  };

  test("continuous folds report spent at SLICE_MS, not before", () => {
    const slicer = createSlicer();
    for (let t = 0; t < SLICE_MS - 1; t += 1) {
      expect(step(slicer, t, 1)).toBe(false);
    }
    expect(step(slicer, SLICE_MS - 1, 1)).toBe(true);
  });

  test("a gap of GAP_MS or more starts a new slice", () => {
    const slicer = createSlicer();
    expect(step(slicer, 0, SLICE_MS - 1)).toBe(false);
    // The loop waited: the old slice's time does not count against this one.
    expect(step(slicer, SLICE_MS - 1 + GAP_MS, SLICE_MS - 1)).toBe(false);
    expect(step(slicer, 1000, SLICE_MS - 1)).toBe(false);
  });

  test("a 1 ms tick (below GAP_MS) is not a wait", () => {
    const slicer = createSlicer();
    expect(step(slicer, 0, 4)).toBe(false);
    expect(step(slicer, 5, 3)).toBe(true);
  });

  test("reset starts over", () => {
    const slicer = createSlicer();
    expect(step(slicer, 0, SLICE_MS - 1)).toBe(false);
    slicer.reset();
    expect(step(slicer, SLICE_MS - 1, 1)).toBe(false);
    expect(step(slicer, SLICE_MS, SLICE_MS)).toBe(true);
  });
});

describe("batched equals unbatched", () => {
  test("a fast stream (every push inside one window)", () => {
    expect(foldBatched(STREAM, 1).rows).toEqual(foldPlain(STREAM).rows);
  });

  test("a slow stream (every push in its own window)", () => {
    expect(foldBatched(STREAM, 500).rows).toEqual(foldPlain(STREAM).rows);
  });

  test("a mixed stream", () => {
    expect(foldBatched(STREAM, 30).rows).toEqual(foldPlain(STREAM).rows);
  });

  test("a stream that is only prose", () => {
    const only = [prose("a"), prose("b"), prose("c"), prose("d")];
    expect(foldBatched(only, 1).rows).toEqual(foldPlain(only).rows);
  });
});

describe("the window", () => {
  test("prose inside one window is ONE commit", () => {
    const batcher = createBatcher(50);
    expect(batcher.push(prose("a"), 0)).toEqual([]);
    expect(batcher.push(prose("b"), 10)).toEqual([]);
    expect(batcher.push(prose("c"), 20)).toEqual([]);
    expect(batcher.flush()).toEqual([{ type: "text", delta: "abc" }]);
  });

  test("a push past the window releases what was held", () => {
    const batcher = createBatcher(50);
    batcher.push(prose("a"), 0);
    expect(batcher.push(prose("b"), 50)).toEqual([{ type: "text", delta: "a" }]);
    expect(batcher.flush()).toEqual([{ type: "text", delta: "b" }]);
  });

  test("a non-prose event flushes first, so order is never reordered", () => {
    const batcher = createBatcher(50);
    batcher.push(prose("before"), 0);
    const out = batcher.push({ type: "empty_turn" }, 5);
    expect(out).toEqual([{ type: "text", delta: "before" }, { type: "empty_turn" }]);
    expect(batcher.pending()).toBe(false);
  });

  test("a reasoning→answer switch is a boundary, not a merge", () => {
    const batcher = createBatcher(50);
    batcher.push(think("hm"), 0);
    expect(batcher.push(prose("a"), 5)).toEqual([{ type: "reasoning", delta: "hm" }]);
    expect(batcher.flush()).toEqual([{ type: "text", delta: "a" }]);
  });

  test("flush with nothing held is empty", () => {
    expect(createBatcher(50).flush()).toEqual([]);
  });

  test("a 10 000-chunk stream folds to the same rows with a fraction of the commits", () => {
    const many: SessionEvent[] = Array.from({ length: 10_000 }, (_, at) => prose(`${at % 10}`));
    let commitsUnbatched = 0;
    for (const event of many) {
      apply(initialState, event);
      commitsUnbatched += 1;
    }
    const batcher = createBatcher(50);
    let commits = 0;
    let state = initialState;
    let now = 0;
    for (const event of many) {
      now += 1; // ~1 ms per chunk
      for (const out of batcher.push(event, now)) {
        state = apply(state, out);
        commits += 1;
      }
    }
    for (const out of batcher.flush()) {
      state = apply(state, out);
      commits += 1;
    }
    expect(commitsUnbatched).toBe(10_000);
    expect(commits).toBeLessThan(commitsUnbatched / 10);
    expect(state.rows.map((row) => row.kind === "assistant" && row.text)).toEqual([
      many.map((event) => (event.type === "text" ? event.delta : "")).join(""),
    ]);
  });
});

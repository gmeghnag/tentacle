/**
 * T5.6 — `chart-scrub.ts`, the press-and-hold scrub machine
 * (docs/feat/model-charts.md D6, failure mode "Scrub vs scroll conflict").
 */
import { describe, expect, test } from "bun:test";
import {
  HOLD_MS,
  SCRUB_IDLE,
  SLOP,
  type ScrubEffect,
  type ScrubEvent,
  type ScrubState,
  reduceScrub,
} from "../src/chart-scrub.ts";

/** 10 indices, 30 pt apart, clamped at the edges — the layout's `hit`. */
const hit = (x: number): number => Math.min(9, Math.max(0, Math.round(x / 30)));

function run(events: readonly ScrubEvent[]): { state: ScrubState; effects: ScrubEffect[] } {
  let state = SCRUB_IDLE;
  const effects: ScrubEffect[] = [];
  for (const event of events) {
    const step = reduceScrub(state, event, hit);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const ticks = (effects: readonly ScrubEffect[]): number =>
  effects.filter((e) => e.kind === "haptic" && e.cue === "tick").length;

describe("chart-scrub (T5.6)", () => {
  test("a vertical pan before the hold scrolls and never scrubs, even after the timer", () => {
    const { state, effects } = run([
      { type: "down", p: { x: 60, y: 50 }, t: 0 },
      { type: "move", p: { x: 61, y: 50 + SLOP + 2 }, t: 120 },
      { type: "timer", t: HOLD_MS },
      { type: "move", p: { x: 200, y: 80 }, t: 400 },
    ]);
    expect(state.kind).toBe("yielded");
    expect(effects).toEqual([{ kind: "yield" }]);
    expect(
      run([
        { type: "down", p: { x: 0, y: 0 }, t: 0 },
        { type: "move", p: { x: 0, y: 40 }, t: 10 },
        { type: "up" },
      ]).state,
    ).toEqual(SCRUB_IDLE);
  });

  test("a press released before the hold is nothing (a tap — the full screen's, not ours)", () => {
    const { state, effects } = run([
      { type: "down", p: { x: 60, y: 50 }, t: 0 },
      { type: "timer", t: HOLD_MS - 1 },
      { type: "up" },
    ]);
    expect(state).toEqual(SCRUB_IDLE);
    expect(effects).toEqual([]);
  });

  test("a wobble under SLOP before the hold still scrubs at the down point", () => {
    const { state, effects } = run([
      { type: "down", p: { x: 60, y: 50 }, t: 0 },
      { type: "move", p: { x: 64, y: 54 }, t: 100 },
      { type: "timer", t: HOLD_MS },
    ]);
    expect(state).toEqual({ kind: "scrubbing", index: 2 });
    expect(effects).toEqual([
      { kind: "index", index: 2 },
      { kind: "haptic", cue: "tick" },
    ]);
  });

  test("hold then horizontal: one tick per index change, none while the index repeats", () => {
    const { state, effects } = run([
      { type: "down", p: { x: 0, y: 50 }, t: 0 },
      { type: "timer", t: HOLD_MS },
      { type: "move", p: { x: 5, y: 50 }, t: 300 }, // still 0
      { type: "move", p: { x: 31, y: 90 }, t: 320 }, // 1 (vertical drift is fine once scrubbing)
      { type: "move", p: { x: 40, y: 50 }, t: 340 }, // still 1
      { type: "move", p: { x: 95, y: 50 }, t: 360 }, // 3 (a skipped index: one tick, not two)
      { type: "move", p: { x: 400, y: 50 }, t: 380 }, // clamped to 9
      { type: "move", p: { x: 999, y: 50 }, t: 400 }, // still 9
    ]);
    expect(state).toEqual({ kind: "scrubbing", index: 9 });
    expect(effects.filter((e) => e.kind === "index")).toEqual([
      { kind: "index", index: 0 },
      { kind: "index", index: 1 },
      { kind: "index", index: 3 },
      { kind: "index", index: 9 },
    ]);
    expect(ticks(effects)).toBe(4);
  });

  test("release and system cancel both return to idle with one release", () => {
    for (const end of [{ type: "up" }, { type: "cancel" }] as const) {
      const { state, effects } = run([
        { type: "down", p: { x: 30, y: 0 }, t: 0 },
        { type: "timer", t: HOLD_MS },
        end,
      ]);
      expect(state).toEqual(SCRUB_IDLE);
      expect(effects[effects.length - 1]).toEqual({ kind: "release" });
      expect(effects.filter((e) => e.kind === "release")).toHaveLength(1);
    }
  });

  test("a chart that does not scrub (`hit` → null) never enters the scrub", () => {
    const step = reduceScrub(
      { kind: "pressing", down: { x: 1, y: 1 }, t0: 0 },
      { type: "timer", t: HOLD_MS },
      () => null,
    );
    expect(step.state).toEqual(SCRUB_IDLE);
    expect(step.effects).toEqual([]);
  });
});

/**
 * `hub-scroll-dim.ts` — owner 2 B of docs/feat/mobile-hub-center.md: while the
 * transcript scrolls, the hub fades to 20 % and lets taps through; it comes back
 * 600 ms after the finger's scroll stops, on the same 150 ms fade as show/hide.
 *
 * Pure (AGENTS §7): the transition table and the presence rule live here; the
 * screen owns the ONE timer, the component only animates the level it returns.
 * Orchestrator O4: only a scroll the FINGER makes counts — a streaming turn's
 * follow-scroll never dims the hub (Stop lives there).
 */
import { describe, expect, test } from "bun:test";
import {
  SCROLL_DIM_LEVEL,
  SCROLL_REST_MS,
  type ScrollDim,
  type ScrollEvent,
  hubPresence,
  scrollDimStep,
} from "../src/hub-scroll-dim.ts";

describe("the numbers are the owner's", () => {
  test("20 %, back 600 ms after scrolling stops", () => {
    expect(SCROLL_DIM_LEVEL).toBe(0.2);
    expect(SCROLL_REST_MS).toBe(600);
  });
});

/** The D4 table, row by row. `timer` says what the caller does with its ONE timer. */
describe("scrollDimStep: one step, and what the caller's timer does", () => {
  const cases: { from: ScrollDim; event: ScrollEvent; to: ScrollDim; timer: string }[] = [
    { from: "rest", event: "begin", to: "scrolling", timer: "disarm" },
    { from: "scrolling", event: "begin", to: "scrolling", timer: "disarm" },
    { from: "settling", event: "begin", to: "scrolling", timer: "disarm" },
    { from: "scrolling", event: "end", to: "settling", timer: "arm" },
    { from: "settling", event: "end", to: "settling", timer: "arm" },
    { from: "rest", event: "end", to: "rest", timer: "keep" },
    { from: "settling", event: "elapsed", to: "rest", timer: "keep" },
    { from: "rest", event: "elapsed", to: "rest", timer: "keep" },
    { from: "scrolling", event: "elapsed", to: "scrolling", timer: "keep" },
    { from: "rest", event: "reset", to: "rest", timer: "disarm" },
    { from: "scrolling", event: "reset", to: "rest", timer: "disarm" },
    { from: "settling", event: "reset", to: "rest", timer: "disarm" },
  ];
  for (const c of cases) {
    test(`${c.from} + ${c.event} → ${c.to} (${c.timer})`, () => {
      expect(scrollDimStep(c.from, c.event)).toEqual({ state: c.to, timer: c.timer as never });
    });
  }

  test("a drag then a fling: begin, end, begin → scrolling, its timer disarmed", () => {
    // `onScrollEndDrag` fires when the finger lifts, `onMomentumScrollBegin` when
    // the fling starts: between them the screen must not start its 600 ms.
    const a = scrollDimStep("rest", "begin");
    const b = scrollDimStep(a.state, "end");
    const c = scrollDimStep(b.state, "begin");
    expect(b).toEqual({ state: "settling", timer: "arm" });
    expect(c).toEqual({ state: "scrolling", timer: "disarm" });
  });

  test("the full round trip ends at rest: begin, end, elapsed", () => {
    let state: ScrollDim = "rest";
    for (const event of ["begin", "end", "elapsed"] as const) {
      state = scrollDimStep(state, event).state;
    }
    expect(state).toBe("rest");
  });

  test("a programmatic scroll's lone momentum-END in rest is a no-op, and does NOT arm " +
    "[mutation: make `end` in rest arm → this fails]", () => {
    // Orchestrator O4: the follow-scroll of a streaming turn, the jump pill and
    // "Show in chat" produce at most this. Arming here would make a turn's own
    // scroll dim the hub (and Stop) for 600 ms after every appended row.
    expect(scrollDimStep("rest", "end")).toEqual({ state: "rest", timer: "keep" });
  });
});

/** Orchestrator O5: when the dim applies, and whether the button takes touches. */
describe("hubPresence: the button's outer level and whether it takes touches", () => {
  const base = { shown: true, scroll: "rest", voiceOver: false, busy: false } as const;

  test("hidden → nothing, and no touches", () => {
    expect(hubPresence({ ...base, shown: false })).toEqual({ level: 0, touchable: false });
    expect(hubPresence({ ...base, shown: false, scroll: "scrolling" })).toEqual({
      level: 0,
      touchable: false,
    });
  });

  test("at rest and shown → solid, touchable", () => {
    expect(hubPresence(base)).toEqual({ level: 1, touchable: true });
    expect(hubPresence({ ...base, scroll: "settling" })).toEqual({
      level: SCROLL_DIM_LEVEL,
      touchable: false,
    });
  });

  test("scrolling → 20 %, and taps go through", () => {
    expect(hubPresence({ ...base, scroll: "scrolling" })).toEqual({
      level: SCROLL_DIM_LEVEL,
      touchable: false,
    });
  });

  test("VoiceOver → NO dim, still touchable [mutation: drop the guard → this fails]", () => {
    // O5: a VoiceOver user must always be able to reach the button, and does not
    // scroll the transcript with a drag.
    for (const scroll of ["scrolling", "settling"] as const) {
      expect(hubPresence({ ...base, scroll, voiceOver: true })).toEqual({
        level: 1,
        touchable: true,
      });
    }
  });

  test("engaged (a finger on it, a drag, the fan open) → solid, touchable", () => {
    // `busy` is the caller's verdict: the gesture machine is not idle, or the fan
    // is open. A press already granted is never cut off by a scroll elsewhere.
    for (const scroll of ["scrolling", "settling"] as const) {
      expect(hubPresence({ ...base, scroll, busy: true })).toEqual({ level: 1, touchable: true });
    }
  });
});

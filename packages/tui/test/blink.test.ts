import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import {
  BLANK,
  BLINK_HALF_MS,
  BLINK_IDLE,
  BULLET,
  type BlinkClock,
  advanceBlink,
  blinkOn,
  blinkPhase,
  blinkState,
  syncBlink,
  toolBullet,
} from "../src/blink.ts";
import type { DisplayItem } from "../src/state.ts";

// `string-width` is the width function Ink's own layout uses (render-lines.ts
// imports it too); the blink tests measure with it rather than counting code
// points.

const running = (id: string): DisplayItem => ({
  kind: "tool",
  id,
  name: "shell",
  args: "{}",
  status: "running",
});
const done = (id: string): DisplayItem => ({
  kind: "tool",
  id,
  name: "shell",
  args: "{}",
  status: "ok",
  resultText: "x",
  durationMs: 5,
});

describe("blinkOn", () => {
  test("is ON for the first half of every one-second cycle", () => {
    expect(BLINK_HALF_MS).toBe(500);
    for (const phase of [0, 1, 250, 499, 1000, 1001, 1499, 2000]) {
      expect(blinkOn(phase)).toBe(true);
    }
  });

  test("is OFF for the second half of every cycle", () => {
    for (const phase of [500, 501, 750, 999, 1500, 1999]) {
      expect(blinkOn(phase)).toBe(false);
    }
  });

  test("treats negative and non-finite input as ON (never a surprise blank row)", () => {
    expect(blinkOn(-1)).toBe(true);
    expect(blinkOn(Number.NaN)).toBe(true);
    expect(blinkOn(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("toolBullet", () => {
  test("a running call blinks: the bullet on the ON half, the blank on the OFF half", () => {
    expect(toolBullet("running", 0)).toBe(BULLET);
    expect(toolBullet("running", 499)).toBe(BULLET);
    expect(toolBullet("running", 500)).toBe(BLANK);
    expect(toolBullet("running", 999)).toBe(BLANK);
    expect(toolBullet("running", 1000)).toBe(BULLET);
  });

  test("the OFF glyph measures exactly the same width as the ON glyph (finding 1)", () => {
    // The exact property the row depends on. Measured with `string-width` — the
    // width function Ink's own layout uses — NOT `[...glyph].length`, which
    // counts code points and called the two phases equal while `⏺` was 2 columns
    // and `" "` was 1 (the round-1 width bug: the row re-wrapped at 1 Hz).
    expect(stringWidth(BULLET)).toBe(2); // the premise, measured, not assumed
    expect(stringWidth(toolBullet("running", 500))).toBe(stringWidth(BULLET));
    expect(stringWidth(toolBullet("running", 0))).toBe(stringWidth(BULLET));
  });

  test("a finished call never blanks, at any phase (ok and error)", () => {
    for (const phase of [0, 250, 500, 750, 1000, 1250]) {
      expect(toolBullet("ok", phase)).toBe(BULLET);
      expect(toolBullet("error", phase)).toBe(BULLET);
    }
  });
});

describe("the clock rule (AGENTS §7: no decision left in the App)", () => {
  test("runs only while the TURN runs and a call is unanswered (finding 2)", () => {
    // A dead call — `running` item, turn over — must NOT keep the clock: the
    // reducer leaves such an item behind after a failed turn / a lost link.
    expect(blinkState([running("a")], true)).toEqual({ calls: 1, running: true });
    expect(blinkState([running("a")], false)).toEqual({ calls: 1, running: false });
    // Nothing unanswered: nothing to blink, even with the turn running.
    expect(blinkState([done("a")], true)).toEqual({ calls: 1, running: false });
    expect(blinkState([], true)).toEqual({ calls: 0, running: false });
  });

  test("the call COUNT rises on a new call and never on a result (that is the restart key)", () => {
    // Owner decision 1: the clock restarts ON whenever a NEW tool call starts.
    // `calls` is unchanged by a result landing, so a result cannot restart it.
    const one = blinkState([done("a"), running("b")], true);
    const two = blinkState([done("a"), done("b"), running("c")], true);
    expect(one.calls).toBe(2);
    expect(two.calls).toBe(3);
  });

  test("a new call starts ON in the frame that sees it, even mid-OFF (finding 3)", () => {
    // Armed for a 1-call transcript, already in the OFF half.
    const armed: BlinkClock = advanceBlink({ calls: 1, tick: 0 }, 1);
    expect(blinkPhase(armed, { calls: 1, running: true })).toBe(BLINK_HALF_MS); // OFF
    // A second call starts: same tick, but a different call set ⇒ phase 0 (ON).
    expect(blinkPhase(armed, { calls: 2, running: true })).toBe(0);
    // The next half-period of the new cycle is OFF: the ON half it rendered was
    // a full one, so no half-period is ever shown twice or skipped.
    expect(blinkPhase(advanceBlink(armed, 2), { calls: 2, running: true })).toBe(BLINK_HALF_MS);
  });

  test("a stopped clock is ON (0), so a later call starts solid and no frame is left blank", () => {
    const armed: BlinkClock = advanceBlink({ calls: 1, tick: 0 }, 1);
    expect(blinkPhase(armed, { calls: 1, running: false })).toBe(0);
    expect(blinkPhase(BLINK_IDLE, { calls: 0, running: false })).toBe(0);
  });
});

describe("the timer lifecycle (findings 4/E/F/G)", () => {
  // The App only relays: `blinkState` says whether to arm, `advanceBlink` is the
  // single tick. This pins the rule those mutations deleted, without a component.
  const tick = (clock: BlinkClock, state: { calls: number; running: boolean }): BlinkClock =>
    state.running ? advanceBlink(clock, state.calls) : BLINK_IDLE;

  test("idle: the clock stays at the idle value, so nothing would arm a timer (F)", () => {
    let clock = BLINK_IDLE;
    for (let i = 0; i < 5; i++) {
      clock = tick(clock, { calls: 1, running: false });
    }
    expect(clock).toEqual(BLINK_IDLE);
    expect(blinkPhase(clock, { calls: 1, running: false })).toBe(0);
  });

  test("while running it advances by exactly one half-period per tick", () => {
    let clock = BLINK_IDLE;
    const phases: number[] = [];
    for (let i = 0; i < 4; i++) {
      clock = tick(clock, { calls: 1, running: true });
      phases.push(blinkPhase(clock, { calls: 1, running: true }));
    }
    expect(phases).toEqual([500, 1000, 1500, 2000]);
  });

  test("the clock returns to idle when the turn ends — no reset left to forget (E/G)", () => {
    let clock = tick(BLINK_IDLE, { calls: 1, running: true });
    expect(clock).not.toEqual(BLINK_IDLE);
    clock = tick(clock, { calls: 1, running: false });
    expect(clock).toEqual(BLINK_IDLE);
    // A next turn's first call therefore starts ON, not on the old OFF half.
    expect(blinkPhase(tick(clock, { calls: 2, running: true }), { calls: 2, running: true })).toBe(
      BLINK_HALF_MS,
    );
    expect(blinkPhase(clock, { calls: 2, running: true })).toBe(0); // its first frame
  });

  test("a stopped clock goes back to IDLE, so no stale half survives the turn (E)", () => {
    // `syncBlink` is the App's only clock write besides a tick. Deleting its
    // "not running → idle" branch leaves the stale tick in place: the next
    // call set that happens to have the same size (a failed turn leaves a
    // `running` item behind, so the count is unchanged) would then start on the
    // dead turn's OFF half. Mutation E (red, verified): drop that branch.
    const armed = advanceBlink({ calls: 1, tick: 0 }, 1);
    expect(blinkPhase(armed, { calls: 1, running: true })).toBe(BLINK_HALF_MS); // OFF
    const stopped = syncBlink(armed, { calls: 1, running: false });
    expect(stopped).toEqual(BLINK_IDLE);
    // Non-vacuous: the same call set, running again, starts ON from there.
    expect(blinkPhase(stopped, { calls: 1, running: true })).toBe(0);
    // Same object when nothing changes → the App's sync effect cannot loop.
    expect(syncBlink(BLINK_IDLE, { calls: 1, running: false })).toBe(BLINK_IDLE);
    // A new call set while running re-arms at tick 0, not at the old tick.
    expect(syncBlink(armed, { calls: 2, running: true })).toEqual({ calls: 2, tick: 0 });
    // A running clock already armed for this set is left alone.
    expect(syncBlink(armed, { calls: 1, running: true })).toBe(armed);
  });

  test("a call joining mid-cycle restarts the shared clock ON (owner decision 1)", () => {
    // Two calls: the first armed the clock and it is in its OFF half.
    const clock = tick(BLINK_IDLE, { calls: 1, running: true });
    expect(blinkPhase(clock, { calls: 1, running: true })).toBe(BLINK_HALF_MS);
    // A second call starts while the first is still running.
    const restarted = tick(clock, { calls: 2, running: true });
    expect(blinkPhase(restarted, { calls: 2, running: true })).toBe(BLINK_HALF_MS);
    // ...but its FIRST frame (before a tick) is ON, in step with the new call.
    expect(blinkPhase(clock, { calls: 2, running: true })).toBe(0);
  });
});

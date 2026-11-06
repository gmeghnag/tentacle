import { describe, expect, test } from "bun:test";
import { type WakeGate, initialWake, wakeDue, wakeStep } from "../src/auto-wake.ts";

const open: WakeGate = { enabled: true, idle: true, blocked: false };
const pending = wakeStep(initialWake, { type: "exit" });

describe("wakeStep", () => {
  test("an exit pends; N exits are still one pending", () => {
    expect(initialWake.pending).toBe(false);
    expect(pending.pending).toBe(true);
    expect(wakeStep(wakeStep(pending, { type: "exit" }), { type: "exit" })).toEqual(pending);
  });

  test("any turn start clears it: its start flushes every exit", () => {
    expect(wakeStep(pending, { type: "turn_started" }).pending).toBe(false);
  });

  test("a refused wake pends again", () => {
    const started = wakeStep(pending, { type: "turn_started" });
    expect(wakeStep(started, { type: "refused" }).pending).toBe(true);
  });

  test("another session: the old one's exit is not ours", () => {
    expect(wakeStep(pending, { type: "reset" }).pending).toBe(false);
  });
});

describe("wakeDue", () => {
  test("true only with a pending wake and every gate open", () => {
    expect(wakeDue(pending, open)).toBe(true);
    expect(wakeDue(initialWake, open)).toBe(false);
  });

  test("each leg of the gate alone says no", () => {
    expect(wakeDue(pending, { ...open, enabled: false })).toBe(false);
    expect(wakeDue(pending, { ...open, idle: false })).toBe(false);
    expect(wakeDue(pending, { ...open, blocked: true })).toBe(false);
  });
});

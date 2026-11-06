import { describe, expect, test } from "bun:test";
import { type WakeGate, daemonWakeGate, initialWake, wakeDue, wakeStep } from "../src/auto-wake.ts";

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

describe("daemonWakeGate (a serve daemon, docs/feat/serve-autowake.md)", () => {
  const free = { enabled: true, attached: 0, busy: false, lastEndBad: false, closed: false };

  test("open only for an idle session nobody watches, after a normal end", () => {
    expect(daemonWakeGate(free)).toEqual(open);
    expect(wakeDue(pending, daemonWakeGate(free))).toBe(true);
  });

  test("each condition alone says no", () => {
    expect(wakeDue(pending, daemonWakeGate({ ...free, enabled: false }))).toBe(false);
    expect(wakeDue(pending, daemonWakeGate({ ...free, attached: 1 }))).toBe(false);
    expect(wakeDue(pending, daemonWakeGate({ ...free, attached: 2 }))).toBe(false);
    expect(wakeDue(pending, daemonWakeGate({ ...free, busy: true }))).toBe(false);
    expect(wakeDue(pending, daemonWakeGate({ ...free, lastEndBad: true }))).toBe(false);
    expect(wakeDue(pending, daemonWakeGate({ ...free, closed: true }))).toBe(false);
  });

  test("nothing pending: no wake, gate open or not", () => {
    expect(wakeDue({ pending: false }, daemonWakeGate(free))).toBe(false);
  });
});

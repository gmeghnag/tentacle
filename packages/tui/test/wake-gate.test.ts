/**
 * S13 (`feat/app-decomp-13-pure-residue`): the TUI session's autonomous-wake
 * decision, out of `App.tsx`'s two copies of it.
 *
 * The model and the rule are `@tentacle/core`'s (`wakeStep`/`wakeDue`) and stay
 * there; what lives HERE is the App's derivation of the three gate fields from
 * its own live refs, plus the store-and-execute step both call sites need. The
 * point of the pin is that the two sites cannot drift: `idle` is the NEGATION of
 * `running`, and `blocked` is the `/clear` latch (review H2 — a wake over a
 * clear's in-flight history wipes its rows).
 */
import { describe, expect, test } from "bun:test";
import { initialWake } from "@tentacle/core";
import { type WakeFacts, sessionWakeGate, tryWake } from "../src/wake-gate.ts";

const PENDING = { pending: true };
const idle: WakeFacts = { enabled: true, running: false, clearing: false };

describe("sessionWakeGate: the App's three fields, derived in one place", () => {
  test("idle is the NEGATION of running, never the same value", () => {
    expect(sessionWakeGate({ ...idle, running: false }).idle).toBe(true);
    expect(sessionWakeGate({ ...idle, running: true }).idle).toBe(false);
  });

  test("blocked is the `/clear` latch, passed through (not inverted)", () => {
    expect(sessionWakeGate({ ...idle, clearing: false }).blocked).toBe(false);
    expect(sessionWakeGate({ ...idle, clearing: true }).blocked).toBe(true);
  });

  test("enabled is the user's setting, passed through", () => {
    expect(sessionWakeGate({ ...idle, enabled: false }).enabled).toBe(false);
  });
});

describe("tryWake: one attempt, the model to store, and whether a turn starts", () => {
  test("pending + enabled + idle + no clear ⇒ wake, and `pending` is consumed", () => {
    const attempt = tryWake(PENDING, idle);
    expect(attempt.wake).toBe(true);
    expect(attempt.model).toEqual({ pending: false });
  });

  test("a running turn defers: no wake, and `pending` SURVIVES for the next check", () => {
    const attempt = tryWake(PENDING, { ...idle, running: true });
    expect(attempt.wake).toBe(false);
    expect(attempt.model).toEqual(PENDING);
  });

  test("a `/clear` in flight blocks it, and `pending` survives too", () => {
    const attempt = tryWake(PENDING, { ...idle, clearing: true });
    expect(attempt.wake).toBe(false);
    expect(attempt.model).toEqual(PENDING);
  });

  test("the setting off never wakes, whatever else is true", () => {
    const attempt = tryWake(PENDING, { enabled: false, running: false, clearing: false });
    expect(attempt.wake).toBe(false);
    expect(attempt.model).toEqual(PENDING);
  });

  test("nothing pending never wakes (an idle tick is not a wake)", () => {
    const attempt = tryWake(initialWake, idle);
    expect(attempt.wake).toBe(false);
    expect(attempt.model).toEqual(initialWake);
  });
});
